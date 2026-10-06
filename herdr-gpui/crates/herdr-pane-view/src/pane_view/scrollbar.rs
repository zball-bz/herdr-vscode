//! Scrolling with a pane's scrollbar, the strip on the view's edge (`strip`)
//! or the thin thumb in herdr's column, as desktop scrollbars behave: the
//! thumb drags from where it was grabbed, a press on the track pages toward
//! the pointer and Shift+press jumps there, the strip's buttons step a line,
//! and steps and pages repeat while held. One `pane.scroll` is in flight at a
//! time and only the latest wanted offset waits behind it, so a fast drag
//! never queues up stale positions.

use super::strip::{self, Strip, StripPart, StripState};
use super::{PaneView, Pending};
use crate::terminal::Scrollbar;
use crate::time::Duration;
use gpui::{Context, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, Pixels, Point};

const REPEAT_DELAY: Duration = Duration::from_millis(400);
const REPEAT_INTERVAL: Duration = Duration::from_millis(50);

pub(super) struct ScrollGesture {
    pane: String,
    part: StripPart,
    motion: Motion,
    held: bool,
    /// Distinguishes this gesture's repeat timer from earlier ones.
    generation: u64,
    /// The latest offset from the bottom not yet sent.
    want: Option<u64>,
    /// The token of the request in flight.
    sent: Option<u64>,
}

#[derive(Clone, Copy)]
enum Motion {
    /// The thumb follows the pointer, `grab` below the thumb's top.
    Drag { grab: f32 },
    /// `lines` at a time (positive: back into the history) up to `stop`.
    Step {
        lines: i64,
        target: u64,
        max: u64,
        stop: Option<u64>,
    },
}

/// A press on some pane's scrollbar.
struct Hit {
    pane: String,
    part: StripPart,
    bar: Option<Scrollbar>,
}

impl PaneView {
    /// The strips on the view's edge for the current surface.
    pub(super) fn strips(&self) -> Vec<Strip> {
        self.surface.as_deref().map_or_else(Vec::new, |surface| {
            strip::strips(
                surface,
                self.bounds.size,
                self.cell_width,
                self.cell_height(),
            )
        })
    }

    /// The scrollbar under `position`: a strip, else a thin thumb's column.
    /// A popup covers them all.
    fn scrollbar_at(&self, position: Point<Pixels>) -> Option<Hit> {
        let surface = self.surface.as_deref()?;
        if surface.popup.is_some() || !self.bounds.contains(&position) {
            return None;
        }
        let local = position - self.bounds.origin;
        if let Some(hit) = self.strips().into_iter().find_map(|strip| {
            let part = strip.part_at(local)?;
            Some(Hit {
                pane: strip.pane_id,
                part,
                bar: strip.bar,
            })
        }) {
            return Some(hit);
        }
        surface.panes.iter().find_map(|pane| {
            let bar = Scrollbar::new(pane, self.cell_width, self.cell_height())?;
            bar.track.contains(&local).then(|| Hit {
                pane: pane.pane_id.clone(),
                part: if bar.thumb.contains(&local) {
                    StripPart::Thumb
                } else {
                    StripPart::Track
                },
                bar: Some(bar),
            })
        })
    }

    /// The thumb a pane's scrolling follows: its strip's, or its column's.
    fn bar_of(&self, pane_id: &str) -> Option<Scrollbar> {
        if let Some(strip) = self
            .strips()
            .into_iter()
            .find(|strip| strip.pane_id == pane_id)
        {
            return strip.bar;
        }
        let pane = self
            .surface
            .as_deref()?
            .panes
            .iter()
            .find(|pane| pane.pane_id == pane_id)?;
        Scrollbar::new(pane, self.cell_width, self.cell_height())
    }

    /// The pane whose scrollbar is held or else hovered, to paint it active.
    pub(super) fn active_scrollbar(&self) -> Option<&str> {
        self.scroll_gesture
            .as_ref()
            .filter(|gesture| gesture.held)
            .map(|gesture| gesture.pane.as_str())
            .or(self
                .hovered_scrollbar
                .as_ref()
                .map(|(pane, _)| pane.as_str()))
    }

    /// How the pointer is on `pane_id`'s strip.
    pub(super) fn strip_state(&self, pane_id: &str) -> StripState {
        StripState {
            hovered: self
                .hovered_scrollbar
                .as_ref()
                .filter(|(pane, _)| pane == pane_id)
                .map(|(_, part)| *part),
            pressed: self
                .scroll_gesture
                .as_ref()
                .filter(|gesture| gesture.held && gesture.pane == pane_id)
                .map(|gesture| gesture.part),
        }
    }

    pub(super) fn scrollbar_mouse_down(
        &mut self,
        event: &MouseDownEvent,
        cx: &mut Context<Self>,
    ) -> bool {
        if event.button != MouseButton::Left {
            return false;
        }
        let Some(hit) = self.scrollbar_at(event.position) else {
            return false;
        };
        // Without scrollback there is nothing to move, but the press is the strip's.
        let Some(bar) = hit.bar else {
            return true;
        };
        let y = f32::from(event.position.y - self.bounds.origin.y);
        let thumb = f32::from(bar.thumb.size.height);
        let scroll = bar.scroll();
        let step = |lines: i64, stop| Motion::Step {
            lines,
            target: scroll.offset_from_bottom,
            max: scroll.max_offset_from_bottom,
            stop,
        };
        let motion = match hit.part {
            StripPart::Thumb => Motion::Drag {
                grab: y - f32::from(bar.thumb.top()),
            },
            StripPart::Track if event.modifiers.shift => Motion::Drag { grab: thumb / 2. },
            StripPart::Track => {
                let page = i64::try_from(scroll.viewport_rows.saturating_sub(1).max(1))
                    .unwrap_or(i64::MAX);
                let older = y < f32::from(bar.thumb.top());
                step(
                    if older { page } else { -page },
                    Some(bar.offset_at(y - thumb / 2.)),
                )
            }
            StripPart::Up => step(1, None),
            StripPart::Down => step(-1, None),
        };
        self.scroll_generation += 1;
        self.scroll_gesture = Some(ScrollGesture {
            pane: hit.pane,
            part: hit.part,
            motion,
            held: true,
            generation: self.scroll_generation,
            want: None,
            sent: None,
        });
        match motion {
            Motion::Drag { .. } => self.drag_scrollbar(event.position, cx),
            Motion::Step { .. } => {
                if self.step_scrollbar(cx) {
                    self.repeat_scrollbar(self.scroll_generation, cx);
                }
            }
        }
        cx.notify();
        true
    }

    /// Follows a held drag, or tracks which scrollbar part the pointer is over.
    pub(super) fn scrollbar_mouse_move(
        &mut self,
        event: &MouseMoveEvent,
        cx: &mut Context<Self>,
    ) -> bool {
        if let Some(gesture) = self.scroll_gesture.as_mut().filter(|gesture| gesture.held) {
            if event.pressed_button == Some(MouseButton::Left) {
                if matches!(gesture.motion, Motion::Drag { .. }) {
                    self.drag_scrollbar(event.position, cx);
                }
                return true;
            }
            // Released outside the view, where no mouse-up arrived.
            gesture.held = false;
            self.flush_scrollbar(cx);
            cx.notify();
        }
        let hovered = self
            .scrollbar_at(event.position)
            .map(|hit| (hit.pane, hit.part));
        if hovered != self.hovered_scrollbar {
            self.hovered_scrollbar = hovered;
            cx.notify();
        }
        self.hovered_scrollbar.is_some() && event.pressed_button.is_none()
    }

    pub(super) fn scrollbar_mouse_up(
        &mut self,
        event: &MouseUpEvent,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(gesture) = self
            .scroll_gesture
            .as_mut()
            .filter(|gesture| gesture.held && event.button == MouseButton::Left)
        else {
            return false;
        };
        gesture.held = false;
        self.flush_scrollbar(cx);
        cx.notify();
        true
    }

    fn drag_scrollbar(&mut self, position: Point<Pixels>, cx: &mut Context<Self>) {
        let Some(ScrollGesture {
            pane,
            motion: Motion::Drag { grab },
            ..
        }) = &self.scroll_gesture
        else {
            return;
        };
        let grab = *grab;
        // The pane closed or lost its scrollback mid-drag.
        let Some(bar) = self.bar_of(pane) else {
            self.scroll_gesture = None;
            return;
        };
        let top = f32::from(position.y - self.bounds.origin.y) - grab;
        if let Some(gesture) = &mut self.scroll_gesture {
            gesture.want = Some(bar.offset_at(top));
        }
        self.flush_scrollbar(cx);
    }

    /// Moves a held step or page once; false once it has reached its end.
    fn step_scrollbar(&mut self, cx: &mut Context<Self>) -> bool {
        let Some(ScrollGesture {
            motion:
                Motion::Step {
                    lines,
                    target,
                    max,
                    stop,
                },
            want,
            ..
        }) = &mut self.scroll_gesture
        else {
            return false;
        };
        let max_target = i64::try_from(*max).unwrap_or(i64::MAX);
        let mut next = i64::try_from(*target)
            .unwrap_or(i64::MAX)
            .saturating_add(*lines)
            .clamp(0, max_target);
        if let Some(stop) = stop.and_then(|stop| i64::try_from(stop).ok()) {
            next = if *lines > 0 {
                next.min(stop)
            } else {
                next.max(stop)
            };
        }
        let next = u64::try_from(next).unwrap_or_default();
        if next == *target {
            return false;
        }
        *target = next;
        *want = Some(next);
        self.flush_scrollbar(cx);
        true
    }

    /// Steps again while the press that started `generation` is held.
    fn repeat_scrollbar(&mut self, generation: u64, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            let mut delay = REPEAT_DELAY;
            loop {
                cx.background_executor().timer(delay).await;
                delay = REPEAT_INTERVAL;
                let more = this
                    .update(cx, |view, cx| {
                        let held = view.scroll_gesture.as_ref().is_some_and(|gesture| {
                            gesture.held && gesture.generation == generation
                        });
                        held && view.step_scrollbar(cx)
                    })
                    .unwrap_or(false);
                if !more {
                    break;
                }
            }
        })
        .detach();
    }

    /// Sends the latest wanted offset once the previous request has answered,
    /// and retires a released gesture when nothing is left to send.
    fn flush_scrollbar(&mut self, cx: &mut Context<Self>) {
        let Some(gesture) = &mut self.scroll_gesture else {
            return;
        };
        if gesture.sent.is_some() {
            return;
        }
        let Some(offset) = gesture.want.take() else {
            if !gesture.held {
                self.scroll_gesture = None;
            }
            return;
        };
        let params = serde_json::json!({ "pane_id": gesture.pane, "offset_from_bottom": offset });
        let token = self.request(Pending::Scrollbar, "pane.scroll", params, cx);
        if let Some(gesture) = &mut self.scroll_gesture {
            gesture.sent = Some(token);
        }
    }

    /// The daemon answered a scroll; failures need no handling, since the
    /// next surface shows where the pane really is.
    pub(super) fn scrollbar_answered(&mut self, token: u64, cx: &mut Context<Self>) {
        if let Some(gesture) = self
            .scroll_gesture
            .as_mut()
            .filter(|gesture| gesture.sent == Some(token))
        {
            gesture.sent = None;
            self.flush_scrollbar(cx);
        }
    }
}
