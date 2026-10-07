//! The pointer over a pane surface. A mouse-reporting application owns its
//! gestures unless Shift keeps one local; the link modifier (Cmd on macOS,
//! Ctrl elsewhere) claims only a press on a link; anything else selects. A
//! forwarded drag stays with the target it was pressed in. Mirrors herdr-gpui's
//! window mouse handling without its splits and menus; scrollbars are in
//! `scrollbar`.
use super::{LinkActivation, PaneView, PaneViewEvent};
use crate::terminal::{RowTarget, Selection, WheelTarget, pane_link_at, wheel_target};
use gpui::{
    Bounds, Context, Modifiers, ModifiersChangedEvent, MouseButton, MouseDownEvent, MouseMoveEvent,
    MouseUpEvent, Pixels, Point, ScrollWheelEvent, Window, point, px, size,
};
use herdr_protocol::{ClientMouseButton, ClientMouseKind};
use std::ops::Range;

/// The cells of each row a link covers, in frame coordinates.
type LinkCells = Vec<(u16, Range<u16>)>;

/// A press a mouse-reporting application owns until its release.
pub(super) struct Gesture {
    hit: WheelTarget,
    button: MouseButton,
}

/// A press on a link, opened if released where it went down.
pub(super) struct PressedLink {
    link: LinkActivation,
    position: Point<Pixels>,
}

fn button(button: MouseButton) -> Option<ClientMouseButton> {
    match button {
        MouseButton::Left => Some(ClientMouseButton::Left),
        MouseButton::Right => Some(ClientMouseButton::Right),
        MouseButton::Middle => Some(ClientMouseButton::Middle),
        _ => None,
    }
}

impl PaneView {
    fn local(&self, position: Point<Pixels>) -> (f32, f32) {
        let local = position - self.bounds.origin;
        (f32::from(local.x), f32::from(local.y))
    }

    /// `position` over the grid, with the padding left of it taken as the first
    /// column, so a press at the very edge still selects or reaches the app.
    fn over_grid(&self, position: Point<Pixels>) -> Option<Point<Pixels>> {
        let padding = px(self.padding_left);
        let reach = Bounds::new(
            point(self.bounds.left() - padding, self.bounds.top()),
            size(self.bounds.size.width + padding, self.bounds.size.height),
        );
        reach
            .contains(&position)
            .then(|| point(position.x.max(self.bounds.left()), position.y))
    }

    fn hit(&self, position: Point<Pixels>) -> Option<WheelTarget> {
        let (x, y) = self.local(self.over_grid(position)?);
        wheel_target(
            self.surface.as_deref()?,
            x,
            y,
            self.cell_width,
            self.cell_height(),
        )
    }

    /// The pane link under the pointer, with the cells it covers.
    pub(super) fn link_at(&self, position: Point<Pixels>) -> Option<(LinkActivation, LinkCells)> {
        if !self.bounds.contains(&position) {
            return None;
        }
        let (x, y) = self.local(position);
        let link = pane_link_at(
            self.surface.as_deref()?,
            x,
            y,
            self.cell_width,
            self.cell_height(),
        )?;
        let rows = vec![(link.link.row, link.link.columns.clone())];
        let activation = match link.link.target {
            RowTarget::Web(url) => LinkActivation::Web(url),
            RowTarget::Path(path) => LinkActivation::Path {
                pane_id: link.pane_id,
                path,
            },
        };
        Some((activation, rows))
    }

    fn emit_mouse(
        &self,
        hit: &WheelTarget,
        kind: ClientMouseKind,
        modifiers: Modifiers,
        cx: &mut Context<Self>,
    ) {
        cx.emit(PaneViewEvent::Input {
            target: hit.target.clone(),
            events: vec![hit.mouse_event(kind, modifiers)],
        });
    }

    fn focus_pane_of(&self, hit: &WheelTarget, cx: &mut Context<Self>) {
        if let crate::terminal::InputTarget::Pane(id) = &hit.target
            && self.focused_pane.as_deref() != Some(id)
        {
            cx.emit(PaneViewEvent::FocusPane(id.clone()));
        }
    }

    /// Ends an application's drag that lost its button or its target.
    fn cancel_gesture(&mut self, cx: &mut Context<Self>) {
        if let Some(gesture) = self.gesture.take()
            && let Some(button) = button(gesture.button)
        {
            self.emit_mouse(
                &gesture.hit,
                ClientMouseKind::Up(button),
                Modifiers::default(),
                cx,
            );
        }
    }

    /// The gesture's target under the pointer, clamped into the bounds it was
    /// pressed in so a drag past the edge keeps reporting its boundary.
    fn gesture_hit(&self, gesture: &Gesture, position: Point<Pixels>) -> Option<WheelTarget> {
        let bounds = gesture.hit.bounds;
        let (x, y) = self.local(position);
        let x = x.clamp(
            f32::from(bounds.left()),
            f32::from(bounds.right()).next_down(),
        );
        let y = y.clamp(
            f32::from(bounds.top()),
            f32::from(bounds.bottom()).next_down(),
        );
        let hit = wheel_target(
            self.surface.as_deref()?,
            x,
            y,
            self.cell_width,
            self.cell_height(),
        )?;
        (hit.target == gesture.hit.target && hit.mouse_reporting).then_some(hit)
    }

    pub(super) fn mouse_down(
        &mut self,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        window.focus(&self.focus, cx);
        self.cancel_gesture(cx);
        self.pressed_link = None;
        self.hover_link_at(None, cx);
        if self.scrollbar_mouse_down(event, cx) {
            self.selection = None;
            cx.stop_propagation();
            return;
        }
        if event.button == MouseButton::Left
            && event.modifiers.secondary()
            && let Some((link, _)) = self.link_at(event.position)
        {
            self.pressed_link = Some(PressedLink {
                link,
                position: event.position,
            });
            cx.stop_propagation();
            return;
        }
        let Some(position) = self.over_grid(event.position) else {
            return;
        };
        let Some(hit) = self.hit(position) else {
            return;
        };
        if hit.mouse_reporting && !event.modifiers.shift {
            self.selection = None;
            if let Some(pressed) = button(event.button) {
                self.emit_mouse(&hit, ClientMouseKind::Down(pressed), event.modifiers, cx);
                self.gesture = Some(Gesture {
                    hit,
                    button: event.button,
                });
            }
            cx.stop_propagation();
            cx.notify();
            return;
        }
        if event.button == MouseButton::Left
            && let Some(surface) = self.surface.as_deref()
        {
            let (x, y) = self.local(position);
            self.selection = Selection::begin(
                surface,
                x,
                y,
                self.cell_width,
                self.cell_height(),
                event.click_count,
            );
            self.focus_pane_of(&hit, cx);
            cx.stop_propagation();
            cx.notify();
        }
    }

    pub(super) fn mouse_move(
        &mut self,
        event: &MouseMoveEvent,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let hovered = if event.modifiers.secondary() {
            self.link_at(event.position)
                .map(|(_, rows)| rows)
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        if hovered != self.hovered_link {
            self.hovered_link = hovered;
            cx.notify();
        }
        let resting = event.pressed_button.is_none() && self.scroll_gesture.is_none();
        self.hover_link_at(resting.then_some(event.position), cx);
        if self.scrollbar_mouse_move(event, cx) {
            return;
        }
        if let Some(gesture) = &self.gesture {
            if event.pressed_button != Some(gesture.button) {
                self.cancel_gesture(cx);
                return;
            }
            match (
                self.gesture_hit(gesture, event.position),
                button(gesture.button),
            ) {
                (Some(hit), Some(pressed)) => {
                    self.emit_mouse(&hit, ClientMouseKind::Drag(pressed), event.modifiers, cx);
                    if let Some(gesture) = &mut self.gesture {
                        gesture.hit = hit;
                    }
                }
                _ => self.cancel_gesture(cx),
            }
            return;
        }
        if let Some(selection) = &mut self.selection
            && selection.dragging()
            && let Some(surface) = self.surface.as_deref()
        {
            let local = event.position - self.bounds.origin;
            if selection.extend(
                surface,
                f32::from(local.x),
                f32::from(local.y),
                self.cell_width,
                self.cell_height,
            ) {
                cx.notify();
            }
            return;
        }
        if event.pressed_button.is_none()
            && !event.modifiers.shift
            && let Some(hit) = self.hit(event.position).filter(|hit| hit.mouse_reporting)
        {
            self.emit_mouse(&hit, ClientMouseKind::Moved, event.modifiers, cx);
        }
    }

    pub(super) fn mouse_up(
        &mut self,
        event: &MouseUpEvent,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.hover_link_at(Some(event.position), cx);
        if self.scrollbar_mouse_up(event, cx) {
            cx.stop_propagation();
            return;
        }
        if let Some(pressed) = self.pressed_link.take() {
            let moved = (event.position.x - pressed.position.x).abs() > px(4.)
                || (event.position.y - pressed.position.y).abs() > px(4.);
            if event.button == MouseButton::Left && !moved {
                cx.emit(PaneViewEvent::OpenLink(pressed.link));
            }
            cx.stop_propagation();
            return;
        }
        if let Some(gesture) = self
            .gesture
            .take_if(|gesture| gesture.button == event.button)
        {
            if let (Some(hit), Some(released)) = (
                self.gesture_hit(&gesture, event.position),
                button(event.button),
            ) {
                self.emit_mouse(&hit, ClientMouseKind::Up(released), event.modifiers, cx);
                // The first click in an inactive split still reaches its app.
                self.focus_pane_of(&hit, cx);
            } else {
                self.gesture = Some(gesture);
                self.cancel_gesture(cx);
            }
            cx.stop_propagation();
            return;
        }
        if let Some(selection) = &mut self.selection
            && selection.release()
        {
            if self.style.copy_on_select {
                self.copy_selection(cx);
            }
            cx.notify();
        }
    }

    /// Releasing the link modifier drops the underline even when the pointer
    /// stays put.
    pub(super) fn modifiers_changed(
        &mut self,
        event: &ModifiersChangedEvent,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !event.modifiers.secondary() && !self.hovered_link.is_empty() {
            self.hovered_link.clear();
            cx.notify();
        }
    }

    pub(super) fn scroll_wheel(
        &mut self,
        event: &ScrollWheelEvent,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(hit) = self.hit(event.position) else {
            self.wheel = Default::default();
            return;
        };
        let lines = self.wheel.lines(&hit.target, event, self.cell_height());
        cx.stop_propagation();
        if lines != 0 {
            cx.emit(PaneViewEvent::Input {
                target: hit.target.clone(),
                events: vec![hit.event(lines, event.modifiers)],
            });
        }
    }
}
