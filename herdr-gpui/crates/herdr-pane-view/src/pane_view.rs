//! A composed pane surface as one interactive element: painting, keys and IME,
//! application mouse reporting, selection, links, and find. It owns no
//! connection: input, daemon requests, and editor actions leave as
//! [`PaneViewEvent`]s, and the host feeds surfaces and answers back in. The same
//! element runs in a native window and in a browser (`wasm32`) canvas.

mod find_bar;
mod keys;
mod link_hover;
mod pointer;
mod scrollbar;
mod strip;

use crate::{
    terminal::{HeldKeys, Selection},
    terminal::{
        InputTarget, WheelAccumulator, input_area, input_cursor_bounds, popup_origin, viewport,
    },
    terminal_painter::{
        Highlight, ImageTarget, PlacedImages, TerminalPainter, Tint, snap_to_device,
    },
    theme::Theme,
};
use find_bar::FindBar;
use gpui::{
    App, Bounds, Context, CursorStyle, EventEmitter, FocusHandle, Focusable, Font, IntoElement,
    MouseButton, ParentElement, Pixels, Point, Render, Styled, Window, canvas, div, prelude::*,
    rgb,
};
use herdr_protocol::{
    ClientPaneInputEvent, ClientSurfaceSize, PaneSurfaceFrame, RequestFailure, ScrollbackResponse,
    SurfaceImages,
};
pub use link_hover::HoveredLink;
use pointer::{Gesture, PressedLink};
use scrollbar::ScrollGesture;
use std::{cell::RefCell, collections::HashMap, rc::Rc, sync::Arc};
use strip::{StripColors, StripPart};

/// How the view looks and which conventions its keys follow.
#[derive(Clone, Debug, PartialEq)]
pub struct PaneViewStyle {
    pub font: Font,
    pub font_size: f32,
    pub cell_height: f32,
    pub theme: Theme,
    /// Whether Option/Alt combinations reach the pane as Meta keys.
    pub alt_keys: bool,
    /// Copy a mouse selection when it is released, as Herdr's `copy_on_select`.
    pub copy_on_select: bool,
    /// Commit plain typed characters from the key event instead of waiting for
    /// the platform input handler. GPUI's browser backend paints handler text a
    /// frame later (measured 24 ms key-to-paint against 8 ms for key events);
    /// IME compositions still go through the handler, since their key events
    /// carry no character. Native hosts leave this off so dead keys and the
    /// system input method keep working.
    pub commit_text_on_key_down: bool,
}

/// What a link click asks the host to open.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LinkActivation {
    /// A web address that passed `WebUrl` validation.
    Web(String),
    /// A path as the pane printed it (possibly relative or `~/`, possibly with a
    /// `:line:col` suffix), to resolve against the pane's working directory.
    Path { pane_id: String, path: String },
}

/// Editor actions routed to the view.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PaneCommand {
    Find,
    FindNext,
    FindPrevious,
    CloseFind,
    Copy,
    ClearSelection,
    /// Return the focused pane to its live bottom.
    ScrollToBottom,
}

/// What the view asks of its host.
#[derive(Clone, Debug, PartialEq)]
pub enum PaneViewEvent {
    /// Semantic input for a pane or popup.
    Input {
        target: InputTarget,
        events: Vec<ClientPaneInputEvent>,
    },
    /// The grid the view can show, to send as the client's surface size.
    Resize {
        size: ClientSurfaceSize,
        cell_width_px: u32,
        cell_height_px: u32,
    },
    /// A click landed in a pane that is not focused.
    FocusPane(String),
    /// A link-modifier click on a link.
    OpenLink(LinkActivation),
    /// The link under the pointer changed, for a host's hover toolbar.
    LinkHovered(Option<HoveredLink>),
    /// Text for the clipboard.
    Copy(String),
    /// The user asked to paste; answer with [`PaneView::paste`].
    PasteRequested,
    /// An endpoint request; answer scrollback methods with [`PaneView::answer`].
    Request {
        token: u64,
        method: &'static str,
        params: serde_json::Value,
    },
}

/// Why a request was sent, so its answer reaches the part that asked.
enum Pending {
    Find,
    SelectionCopy,
    /// A scrollbar drag's `pane.scroll`, which gates the next one.
    Scrollbar,
    /// No answer is needed (scrolling a match into view).
    Ignore,
}

pub struct PaneView {
    style: PaneViewStyle,
    painter: Rc<RefCell<TerminalPainter>>,
    focus: FocusHandle,
    surface: Option<Arc<PaneSurfaceFrame>>,
    images: Arc<SurfaceImages>,
    focused_pane: Option<String>,
    report_all: bool,
    bounds: Bounds<Pixels>,
    cell_width: f32,
    /// The style's cell height, snapped to device pixels when painted.
    cell_height: f32,
    reported: Option<(ClientSurfaceSize, u32, u32)>,
    /// IME composition not yet committed.
    marked: String,
    held: HeldKeys,
    wheel: WheelAccumulator,
    gesture: Option<Gesture>,
    selection: Option<Selection>,
    pressed_link: Option<PressedLink>,
    scroll_gesture: Option<ScrollGesture>,
    scroll_generation: u64,
    /// The scrollbar part under the pointer, with its pane.
    hovered_scrollbar: Option<(String, StripPart)>,
    /// Whether herdr keeps a scrollbar column at the grid's edge, which the
    /// strip covers; the grid then takes one column more (`strip`).
    reserve_strip: bool,
    /// Link cells under the pointer while the link modifier is held.
    hovered_link: Vec<(u16, std::ops::Range<u16>)>,
    /// The pointer over the view, while no button is held.
    pointer: Option<Point<Pixels>>,
    /// The link under `pointer`, as last reported.
    hovered_link_target: Option<HoveredLink>,
    find: Option<FindBar>,
    /// Caret cell and composition length the platform IME was last told about.
    ime_anchor: Option<(u16, u16, usize)>,
    next_token: u64,
    pending: HashMap<u64, Pending>,
}

impl EventEmitter<PaneViewEvent> for PaneView {}

impl Focusable for PaneView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl PaneView {
    pub fn new(style: PaneViewStyle, cx: &mut Context<Self>) -> Self {
        Self {
            cell_height: style.cell_height,
            style,
            painter: Rc::new(RefCell::new(TerminalPainter::default())),
            focus: cx.focus_handle(),
            surface: None,
            images: Arc::default(),
            focused_pane: None,
            report_all: false,
            bounds: Bounds::default(),
            cell_width: 0.,
            reported: None,
            marked: String::new(),
            held: HeldKeys::default(),
            wheel: WheelAccumulator::default(),
            gesture: None,
            selection: None,
            pressed_link: None,
            scroll_gesture: None,
            scroll_generation: 0,
            hovered_scrollbar: None,
            reserve_strip: true,
            hovered_link: Vec::new(),
            pointer: None,
            hovered_link_target: None,
            find: None,
            ime_anchor: None,
            next_token: 0,
            pending: HashMap::new(),
        }
    }

    pub fn set_style(&mut self, style: PaneViewStyle, cx: &mut Context<Self>) {
        if self.style != style {
            self.style = style;
            self.reported = None;
            cx.notify();
        }
    }

    /// The latest composed surface, its images, and the pane keyboard input goes
    /// to when no popup is open.
    pub fn set_surface(
        &mut self,
        surface: Option<Arc<PaneSurfaceFrame>>,
        images: Arc<SurfaceImages>,
        focused_pane: Option<String>,
        cx: &mut Context<Self>,
    ) {
        if let Some(reserves) = surface.as_deref().and_then(strip::reserves_edge_column) {
            self.reserve_strip = reserves;
        }
        self.surface = surface;
        self.images = images;
        self.focused_pane = focused_pane;
        // Hovered cells were read from the previous frame.
        self.hovered_link.clear();
        if self.pointer.is_some() {
            self.hover_link_at(self.pointer, cx);
        }
        self.refresh_find(cx);
        cx.notify();
    }

    /// Herdr's `ClientShellKeyboardReportAll`: the focused pane wants releases.
    pub fn set_keyboard_report_all(&mut self, report_all: bool) {
        self.report_all = report_all;
    }

    /// Forgets the size last reported, so the next layout reports it again (a
    /// reconnect starts a new session that has not heard it).
    pub fn reset_reported_size(&mut self, cx: &mut Context<Self>) {
        self.reported = None;
        cx.notify();
    }

    /// The answer to a [`PaneViewEvent::Request`].
    pub fn answer(
        &mut self,
        token: u64,
        response: Result<ScrollbackResponse, RequestFailure>,
        cx: &mut Context<Self>,
    ) {
        match self.pending.remove(&token) {
            Some(Pending::Find) => self.find_answer(token, response, cx),
            Some(Pending::SelectionCopy) => {
                if let Ok(ScrollbackResponse::PaneSelection(result)) = response {
                    cx.emit(PaneViewEvent::Copy(result.text));
                }
            }
            Some(Pending::Scrollbar) => self.scrollbar_answered(token, cx),
            Some(Pending::Ignore) | None => {}
        }
    }

    /// Text the host read from its clipboard, for the focused pane or popup.
    pub fn paste(&mut self, text: String, cx: &mut Context<Self>) {
        if let Some(find) = &mut self.find {
            find.insert(&text);
            self.refresh_find(cx);
            return;
        }
        if !text.is_empty() {
            self.send(vec![ClientPaneInputEvent::Paste(text)], cx);
        }
    }

    pub fn command(&mut self, command: PaneCommand, window: &mut Window, cx: &mut Context<Self>) {
        match command {
            PaneCommand::Find => self.open_find(window, cx),
            PaneCommand::FindNext => self.step_find(find_bar::Direction::Newer, cx),
            PaneCommand::FindPrevious => self.step_find(find_bar::Direction::Older, cx),
            PaneCommand::CloseFind => self.close_find(cx),
            PaneCommand::Copy => {
                self.copy_selection(cx);
            }
            PaneCommand::ClearSelection => {
                self.selection = None;
                cx.notify();
            }
            PaneCommand::ScrollToBottom => {
                if let Some(pane_id) = self.focused_pane.clone() {
                    let params = serde_json::json!({ "pane_id": pane_id, "offset_from_bottom": 0 });
                    self.request(Pending::Ignore, "pane.scroll", params, cx);
                }
            }
        }
    }

    fn cell_height(&self) -> f32 {
        self.cell_height
    }

    /// The measured cell width in logical pixels, once painted.
    pub fn cell_width(&self) -> f32 {
        self.cell_width
    }

    /// Where keyboard input goes: an open popup, else the focused pane.
    fn keyboard_target(&self) -> Option<InputTarget> {
        let surface = self.surface.as_deref()?;
        if let Some(popup) = &surface.popup {
            return Some(InputTarget::Popup(popup.terminal_id.clone()));
        }
        self.focused_pane.clone().map(InputTarget::Pane)
    }

    fn send(&mut self, events: Vec<ClientPaneInputEvent>, cx: &mut Context<Self>) {
        if let Some(target) = self.keyboard_target() {
            cx.emit(PaneViewEvent::Input { target, events });
        }
    }

    fn request(
        &mut self,
        pending: Pending,
        method: &'static str,
        params: serde_json::Value,
        cx: &mut Context<Self>,
    ) -> u64 {
        self.next_token += 1;
        let token = self.next_token;
        self.pending.insert(token, pending);
        cx.emit(PaneViewEvent::Request {
            token,
            method,
            params,
        });
        token
    }

    /// Reports the grid the bounds hold whenever it, or the cell size, changes.
    fn layout(&mut self, bounds: Bounds<Pixels>, cx: &mut Context<Self>) {
        self.bounds = bounds;
        if self.cell_width <= 0. {
            return;
        }
        // With a strip over herdr's scrollbar column, that column lies under it.
        let strip = if self.reserve_strip {
            strip::strip_width(self.cell_width) - self.cell_width
        } else {
            0.
        };
        let size = viewport(
            f32::from(bounds.size.width) - strip,
            f32::from(bounds.size.height),
            self.cell_width,
            self.cell_height(),
        );
        let report = (
            size,
            self.cell_width.round().max(1.) as u32,
            self.cell_height().round().max(1.) as u32,
        );
        if self.reported != Some(report) {
            self.reported = Some(report);
            cx.emit(PaneViewEvent::Resize {
                size,
                cell_width_px: report.1,
                cell_height_px: report.2,
            });
        }
    }

    /// Asks the platform to move its IME panel when the caret or the
    /// composition moved. Platforms that push the panel position (the browser,
    /// Linux) need this; macOS pulls it through `bounds_for_range` anyway.
    fn sync_ime_anchor(&mut self, window: &mut Window) {
        let anchor = self.surface.as_deref().and_then(|surface| {
            let cursor = surface
                .popup
                .as_ref()
                .map_or(surface.frame.cursor.as_ref(), |popup| {
                    popup.frame.cursor.as_ref()
                })?;
            Some((cursor.x, cursor.y, self.marked.len()))
        });
        if anchor != self.ime_anchor {
            self.ime_anchor = anchor;
            window.invalidate_character_coordinates();
        }
    }

    fn selection_highlights(&self, popup: bool) -> Vec<Highlight> {
        let (Some(surface), Some(selection)) = (self.surface.as_deref(), &self.selection) else {
            return Vec::new();
        };
        let owned = match &surface.popup {
            Some(open) if popup => selection.in_popup(&open.terminal_id),
            _ if popup => false,
            _ => selection.in_panes(),
        };
        if !owned {
            return Vec::new();
        }
        selection
            .rows(surface, self.cell_width, self.cell_height())
            .map(|(row, columns)| Highlight {
                row,
                columns,
                tint: Tint::Selection,
            })
            .collect()
    }

    fn copy_selection(&mut self, cx: &mut Context<Self>) -> bool {
        let (Some(surface), Some(selection)) = (self.surface.clone(), self.selection.as_ref())
        else {
            return false;
        };
        if let Some((pane_id, range)) =
            selection.offscreen_range(&surface, self.cell_width, self.cell_height())
        {
            let params = herdr_protocol::SelectionReadParams {
                pane_id: pane_id.to_owned(),
                anchor: range.start,
                cursor: range.end,
                content_revision: None,
            };
            if let Ok(params) = serde_json::to_value(params) {
                self.request(Pending::SelectionCopy, "pane.selection.read", params, cx);
                return true;
            }
        }
        match selection.text(&surface, self.cell_width, self.cell_height()) {
            Ok(text) if !text.is_empty() => {
                cx.emit(PaneViewEvent::Copy(text));
                true
            }
            _ => false,
        }
    }
}

impl Render for PaneView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let style = self.style.clone();
        self.cell_height = snap_to_device(style.cell_height, window.scale_factor());
        self.painter.borrow_mut().set_appearance(
            style.font_size,
            self.cell_height,
            style.theme.clone(),
        );
        self.cell_width = self
            .painter
            .borrow_mut()
            .cell_width(&style.font, window, cx);
        // The width the strip reservation adds right of the grid: edge cells'
        // backgrounds fill it where no strip covers it (the alternate screen).
        let margin = if self.reserve_strip {
            strip::strip_width(self.cell_width) - self.cell_width
        } else {
            0.
        };
        self.painter.borrow_mut().set_edge_margin(margin);
        self.sync_ime_anchor(window);
        let cell_width = self.cell_width;
        let cell_height = self.cell_height;
        let entity = cx.entity();
        let input_entity = entity.clone();
        let painter = self.painter.clone();
        let focus = self.focus.clone();
        let surface = self.surface.clone();
        let images = self.images.clone();
        let mut highlights = self.selection_highlights(false);
        highlights.extend(self.find_highlights());
        let popup_highlights = self.selection_highlights(true);
        let link_rows = self.hovered_link.clone();
        let marked = (!self.marked.is_empty()).then(|| self.marked.clone());
        let font = style.font.clone();
        let active_scrollbar = self.active_scrollbar().map(str::to_owned);
        let cursor = if !link_rows.is_empty() {
            CursorStyle::PointingHand
        } else if active_scrollbar.is_some() {
            CursorStyle::Arrow
        } else {
            CursorStyle::IBeam
        };
        let find_bar = self.find.as_ref().map(|find| find.render(&style.theme));
        let strip_colors = StripColors::new(&style.theme);
        let strips: Vec<_> = self
            .strips()
            .into_iter()
            .map(|strip| {
                let state = self.strip_state(&strip.pane_id);
                (strip, state)
            })
            .collect();
        div()
            .id("herdr-pane")
            .relative()
            .size_full()
            // Chrome such as the find bar inherits the terminal font: a browser
            // build has no system UI font to fall back to.
            .font(style.font.clone())
            .text_size(gpui::px(style.font_size))
            .bg(rgb(style.theme.background))
            .track_focus(&self.focus)
            .key_context("HerdrPane")
            .cursor(cursor)
            .on_key_down(cx.listener(Self::key_down))
            .on_key_up(cx.listener(Self::key_up))
            .on_mouse_down(MouseButton::Left, cx.listener(Self::mouse_down))
            .on_mouse_down(MouseButton::Right, cx.listener(Self::mouse_down))
            .on_mouse_down(MouseButton::Middle, cx.listener(Self::mouse_down))
            .on_mouse_move(cx.listener(Self::mouse_move))
            .on_mouse_up(MouseButton::Left, cx.listener(Self::mouse_up))
            .on_mouse_up(MouseButton::Right, cx.listener(Self::mouse_up))
            .on_mouse_up(MouseButton::Middle, cx.listener(Self::mouse_up))
            .on_scroll_wheel(cx.listener(Self::scroll_wheel))
            .on_modifiers_changed(cx.listener(Self::modifiers_changed))
            .on_hover(cx.listener(|view, hovered: &bool, _, cx| {
                if !*hovered {
                    view.hover_link_at(None, cx);
                }
            }))
            .child(
                canvas(
                    move |bounds, _, cx| entity.update(cx, |view, cx| view.layout(bounds, cx)),
                    move |bounds, _, window, cx| {
                        window.handle_input(
                            &focus,
                            gpui::ElementInputHandler::new(bounds, input_entity.clone()),
                            cx,
                        );
                        let Some(surface) = &surface else {
                            return;
                        };
                        let mut painter = painter.borrow_mut();
                        painter.set_active_scrollbar(active_scrollbar.as_deref());
                        painter.paint_frame(
                            &surface.frame,
                            bounds.origin,
                            Some(bounds.size),
                            cell_width,
                            &font,
                            &highlights,
                            &surface.panes,
                            None,
                            Some(PlacedImages {
                                placements: &surface.graphics.placements,
                                images: &images,
                                target: ImageTarget::Main,
                            }),
                            window,
                            cx,
                        );
                        painter.paint_link(
                            &surface.frame,
                            bounds.origin,
                            cell_width,
                            &link_rows,
                            window,
                        );
                        for (strip, state) in &strips {
                            strip::paint(strip, bounds.origin, strip_colors, *state, window);
                        }
                        if let Some(popup) = &surface.popup {
                            let offset =
                                popup_origin(&surface.frame, &popup.frame, cell_width, cell_height);
                            painter.paint_frame(
                                &popup.frame,
                                bounds.origin + offset,
                                None,
                                cell_width,
                                &font,
                                &popup_highlights,
                                &[],
                                None,
                                Some(PlacedImages {
                                    placements: &surface.graphics.placements,
                                    images: &images,
                                    target: ImageTarget::Popup(&popup.terminal_id),
                                }),
                                window,
                                cx,
                            );
                        }
                        if let Some(marked) = &marked {
                            let live = Some(surface.as_ref());
                            painter.paint_composition(
                                marked,
                                input_cursor_bounds(live, bounds.origin, cell_width, cell_height)
                                    .origin,
                                input_area(live, bounds, cell_width, cell_height),
                                &font,
                                window,
                            );
                        }
                    },
                )
                .size_full(),
            )
            .when_some(find_bar, |view, bar| view.child(bar))
    }
}

#[cfg(test)]
mod tests;
