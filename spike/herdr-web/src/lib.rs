//! Browser host for Herdr pane surfaces.
//!
//! The window shows one `herdr_pane_view::PaneView`, the element herdr-gpui's
//! painter, selection, links, and find live in. This module only bridges it:
//! daemon bytes from the embedding page (see `host`) go into the sans-IO
//! `herdr_core::Core` in this same module, so cells never cross into
//! JavaScript; the view's events go out as daemon frames or host events.

mod host;

use futures::{StreamExt, channel::mpsc::UnboundedReceiver};
use gpui::{
    AnyWindowHandle, App, AppContext, Context, Entity, Focusable, IntoElement, ParentElement,
    Render, Styled, Subscription, Window, WindowOptions, canvas, div,
};
use herdr_core::Core;
use herdr_pane_view::{
    LinkActivation, PaneCommand, PaneView, PaneViewEvent, PaneViewStyle,
    terminal::{CELL_HEIGHT, FONT_SIZE, InputTarget},
    theme::Theme,
};
use herdr_protocol::{
    ClientMessage, ClientSurfaceSize, RequestFailure, decode_scrollback_response,
};
use host::{Host, HostEvent, Inbound};
use serde_json::{Value, json};
use std::{borrow::Cow, cell::Cell, collections::HashMap, rc::Rc};
use wasm_bindgen::{JsCast, prelude::*};

/// Counters a test harness reads from the page.
fn publish(name: &str, value: f64) {
    if let Some(window) = web_sys::window() {
        let _ = js_sys::Reflect::set(&window, &JsValue::from_str(name), &JsValue::from_f64(value));
    }
}

fn read(name: &str) -> f64 {
    web_sys::window()
        .and_then(|window| js_sys::Reflect::get(&window, &JsValue::from_str(name)).ok())
        .and_then(|value| value.as_f64())
        .unwrap_or(0.)
}

struct Bridge {
    core: Core,
    host: Host,
    view: Entity<PaneView>,
    open: bool,
    hello_sent: bool,
    size: Option<(ClientSurfaceSize, u32, u32)>,
    /// Core request ids of the view's requests, to route answers back.
    tokens: HashMap<String, u64>,
    /// The herdr tab this view shows. Each connection keeps its own location,
    /// so editors on different tabs do not move each other.
    tab_id: Option<String>,
    /// A `tab.focus` was sent and the snapshot has not shown the tab yet.
    focusing: bool,
    tab_closed: bool,
    visible: bool,
    _events: Subscription,
}

impl Bridge {
    fn new(
        host: Host,
        mut inbox: UnboundedReceiver<Inbound>,
        style: PaneViewStyle,
        tab_id: Option<String>,
        window_handle: AnyWindowHandle,
        cx: &mut Context<Self>,
    ) -> Self {
        let view = cx.new(|cx| PaneView::new(style, cx));
        let events = cx.subscribe(&view, |bridge, _, event: &PaneViewEvent, cx| {
            bridge.view_event(event, cx)
        });
        cx.spawn(async move |this, cx| {
            while let Some(message) = inbox.next().await {
                let delivered = cx.update_window(window_handle, |_, window, cx| {
                    this.update(cx, |bridge, cx| bridge.inbound(message, window, cx))
                });
                if !matches!(delivered, Ok(Ok(()))) {
                    break;
                }
            }
        })
        .detach();
        Self {
            core: Core::new(),
            host,
            view,
            open: false,
            hello_sent: false,
            size: None,
            tokens: HashMap::new(),
            tab_id,
            focusing: false,
            tab_closed: false,
            visible: true,
            _events: events,
        }
    }

    fn send(&self, message: &ClientMessage) {
        match Core::encode(message) {
            Ok(frame) => self.host.send(&frame),
            Err(error) => self.status(format!("encode: {}", error.0)),
        }
    }

    fn status(&self, text: String) {
        self.host.event(json!({ "type": "status", "text": text }));
    }

    /// Sends the hello once the transport is open and the view has measured its
    /// grid, and a resize whenever the grid changes afterwards.
    fn sync_size(&mut self) {
        let (Some((size, cell_width, cell_height)), true) = (self.size, self.open) else {
            return;
        };
        let frame = if self.hello_sent {
            self.core
                .resize(size.cols, size.rows, cell_width, cell_height)
        } else {
            self.core
                .hello(size.cols, size.rows, cell_width, cell_height, self.visible)
        };
        if let Ok(frame) = frame {
            self.host.send(&frame);
            self.hello_sent = true;
        }
    }

    fn flush_requests(&mut self) {
        while let Some(frame) = self.core.next_request_frame() {
            self.host.send(&frame);
        }
    }

    /// A link as the host opens it: path links carry their pane's working
    /// directory, to resolve relative paths against.
    fn link_json(&self, link: &LinkActivation) -> Value {
        match link {
            LinkActivation::Web(url) => json!({ "kind": "web", "target": url }),
            LinkActivation::Path { pane_id, path } => json!({
                "kind": "path",
                "target": path,
                "paneId": pane_id,
                "cwd": self.pane_cwd(pane_id),
            }),
        }
    }

    fn pane_cwd(&self, pane_id: &str) -> Option<String> {
        let pane = self
            .core
            .snapshot()?
            .panes
            .iter()
            .find(|pane| pane.pane_id == pane_id)?;
        pane.foreground_cwd.clone().or_else(|| pane.cwd.clone())
    }

    fn view_event(&mut self, event: &PaneViewEvent, _: &mut Context<Self>) {
        match event {
            PaneViewEvent::Input { target, events } => {
                if !self.hello_sent {
                    return;
                }
                if let Some(now) = web_sys::window()
                    .and_then(|w| w.performance())
                    .map(|p| p.now())
                {
                    publish("__herdrInputAt", now);
                }
                let events = events.clone();
                self.send(&match target {
                    InputTarget::Pane(pane_id) => ClientMessage::ClientShellPaneInput {
                        pane_id: pane_id.clone(),
                        events,
                    },
                    InputTarget::Popup(terminal_id) => ClientMessage::ClientShellPopupInput {
                        terminal_id: terminal_id.clone(),
                        events,
                    },
                });
            }
            PaneViewEvent::Resize {
                size,
                cell_width_px,
                cell_height_px,
            } => {
                self.size = Some((*size, *cell_width_px, *cell_height_px));
                self.sync_size();
            }
            PaneViewEvent::FocusPane(pane_id) => {
                self.core
                    .request("pane.focus", json!({ "pane_id": pane_id }));
                self.flush_requests();
            }
            PaneViewEvent::OpenLink(link) => {
                let mut event = self.link_json(link);
                event["type"] = json!("openLink");
                self.host.event(event);
            }
            // For the host's hover toolbar: the link and its cells in CSS pixels.
            PaneViewEvent::LinkHovered(hovered) => {
                let mut event = json!({});
                if let Some(hovered) = hovered {
                    let bounds = hovered.bounds;
                    event = self.link_json(&hovered.link);
                    event["x"] = json!(f32::from(bounds.origin.x));
                    event["y"] = json!(f32::from(bounds.origin.y));
                    event["width"] = json!(f32::from(bounds.size.width));
                    event["height"] = json!(f32::from(bounds.size.height));
                }
                event["type"] = json!("linkHover");
                self.host.event(event);
            }
            PaneViewEvent::Copy(text) => self.host.event(json!({ "type": "copy", "text": text })),
            PaneViewEvent::PasteRequested => self.host.event(json!({ "type": "requestPaste" })),
            PaneViewEvent::Request {
                token,
                method,
                params,
            } => {
                let id = self.core.request(method, params.clone());
                self.tokens.insert(id, *token);
                self.flush_requests();
            }
        }
    }

    fn inbound(&mut self, message: Inbound, window: &mut Window, cx: &mut Context<Self>) {
        match message {
            Inbound::Host(HostEvent::Open) => {
                // A reconnect is a new session: it needs a hello and owes
                // nothing. Requests of the old one fail, so a find or a
                // scrollbar drag waiting on them moves on.
                self.core = Core::new();
                for (_, token) in self.tokens.drain().collect::<Vec<_>>() {
                    let failure = RequestFailure::Client("connection reset".into());
                    self.view
                        .update(cx, |view, cx| view.answer(token, Err(failure), cx));
                }
                self.focusing = false;
                self.hello_sent = false;
                self.open = true;
                self.sync_size();
            }
            Inbound::Host(HostEvent::Closed { reason }) => {
                self.open = false;
                self.hello_sent = false;
                self.status(format!("disconnected: {reason}"));
            }
            Inbound::Host(HostEvent::Paste { text }) => {
                self.view.update(cx, |view, cx| view.paste(text, cx));
            }
            Inbound::Host(HostEvent::Focus { focused }) => {
                if self.hello_sent {
                    self.send(&ClientMessage::ClientShellFocus { focused });
                }
            }
            Inbound::Host(HostEvent::Command { name }) => {
                let command = match name.as_str() {
                    "find" => PaneCommand::Find,
                    "findNext" => PaneCommand::FindNext,
                    "findPrevious" => PaneCommand::FindPrevious,
                    "closeFind" => PaneCommand::CloseFind,
                    "copy" => PaneCommand::Copy,
                    "clearSelection" => PaneCommand::ClearSelection,
                    "scrollToBottom" => PaneCommand::ScrollToBottom,
                    other => return self.status(format!("unknown command {other}")),
                };
                self.view
                    .update(cx, |view, cx| view.command(command, window, cx));
            }
            Inbound::Host(HostEvent::Visibility { visible }) => {
                self.visible = visible;
                if self.hello_sent {
                    self.core
                        .request("client_shell.surface.set", json!({ "active": visible }));
                    self.flush_requests();
                }
            }
            Inbound::Bytes(bytes) => self.feed(&bytes, cx),
        }
    }

    /// Keeps this connection on its tab: asks for it until the snapshot shows
    /// it, asks again if something else moved the connection, and tells the host
    /// once the tab is gone.
    fn follow_tab(&mut self) {
        let (Some(tab_id), Some(snapshot)) = (self.tab_id.clone(), self.core.snapshot()) else {
            return;
        };
        if !snapshot.tabs.iter().any(|tab| tab.tab_id == tab_id) {
            if !self.tab_closed {
                self.tab_closed = true;
                self.host
                    .event(json!({ "type": "tabClosed", "tabId": tab_id }));
            }
            return;
        }
        if snapshot.focused_tab_id.as_deref() == Some(tab_id.as_str()) {
            self.focusing = false;
        } else if !self.focusing {
            self.focusing = true;
            self.core.request("tab.focus", json!({ "tab_id": tab_id }));
        }
    }

    /// Whether the latest surface is this view's tab (always, without a tab).
    fn shows_own_tab(&self) -> bool {
        self.tab_id.as_ref().is_none_or(|tab_id| {
            self.core
                .snapshot()
                .and_then(|snapshot| snapshot.focused_tab_id.as_ref())
                == Some(tab_id)
        })
    }

    fn feed(&mut self, bytes: &[u8], cx: &mut Context<Self>) {
        let events: Vec<Value> = match self.core.feed(bytes) {
            Ok(events) => serde_json::from_str(&events).unwrap_or_default(),
            Err(error) => return self.status(format!("protocol: {error:?}")),
        };
        let kind = |event: &Value| event["type"].as_str().unwrap_or_default().to_owned();
        if events.iter().any(|event| kind(event) == "snapshot") {
            self.follow_tab();
        }
        if events
            .iter()
            .any(|event| matches!(kind(event).as_str(), "surface" | "snapshot"))
            && self.shows_own_tab()
        {
            let surface = self.core.surface().cloned();
            if let Some(surface) = &surface {
                publish("__herdrRevision", surface.surface_revision as f64);
                if let Some(scroll) = surface.panes.first().and_then(|pane| pane.scroll) {
                    publish("__herdrScrollOffset", scroll.offset_from_bottom as f64);
                }
            }
            let (images, focused) = (self.core.images(), self.core.focused_pane_id());
            self.view.update(cx, |view, cx| {
                view.set_surface(surface, images, focused, cx)
            });
        }
        if events
            .iter()
            .any(|event| kind(event) == "keyboard_report_all")
        {
            let report_all = self.core.keyboard_report_all();
            self.view
                .update(cx, |view, _| view.set_keyboard_report_all(report_all));
        }
        for (id, envelope) in self.core.take_responses() {
            if let Some(token) = self.tokens.remove(&id) {
                let answer = decode_scrollback_response(&envelope);
                self.view
                    .update(cx, |view, cx| view.answer(token, answer, cx));
            }
        }
        self.flush_requests();
        cx.notify();
    }
}

impl Render for Bridge {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let revision = self
            .core
            .surface()
            .map_or(0., |surface| surface.surface_revision as f64);
        publish(
            "__herdrCellWidth",
            f64::from(self.view.read(cx).cell_width()),
        );
        publish(
            "__herdrPaddingLeft",
            f64::from(self.view.read(cx).padding_left()),
        );
        publish(
            "__herdrCellHeight",
            f64::from(self.size.map_or(0, |(_, _, height)| height)),
        );
        div().relative().size_full().child(self.view.clone()).child(
            // Paint counters for test harnesses, after the view painted.
            canvas(
                |_, _, _| {},
                move |_, _, _, _| {
                    publish("__herdrPaints", read("__herdrPaints") + 1.);
                    publish("__herdrPaintedRevision", revision);
                    if let Some(now) = web_sys::window()
                        .and_then(|w| w.performance())
                        .map(|p| p.now())
                    {
                        publish("__herdrPaintAt", now);
                    }
                },
            )
            .absolute()
            .size_0(),
        )
    }
}

/// GPUI's browser platform never calls back when neither WebGPU nor WebGL2
/// starts; it only appends a paragraph to the page. Watch for that (or for no
/// start at all) so the host can say why the view is blank instead of retrying.
fn watch_graphics(host: Host, launched: Rc<Cell<bool>>) {
    const PREFIX: &str = "Failed to initialize browser graphics";
    const POLL_MS: i32 = 250;
    const GIVE_UP_MS: i32 = 10_000;
    fn failure_text() -> Option<String> {
        let paragraphs = web_sys::window()?.document()?.get_elements_by_tag_name("p");
        (0..paragraphs.length())
            .filter_map(|index| paragraphs.item(index)?.text_content())
            .find(|text| text.starts_with(PREFIX))
    }
    fn poll(host: Host, launched: Rc<Cell<bool>>, waited: i32) {
        if launched.get() {
            return;
        }
        let failure = failure_text().or_else(|| {
            (waited >= GIVE_UP_MS)
                .then(|| format!("{PREFIX}: no window after {} s", GIVE_UP_MS / 1000))
        });
        if let Some(text) = failure {
            host.event(json!({ "type": "error", "kind": "graphics", "text": text }));
            return;
        }
        let next = Closure::once_into_js(move || poll(host, launched, waited + POLL_MS));
        if let Some(window) = web_sys::window() {
            let _ = window.set_timeout_with_callback_and_timeout_and_arguments_0(
                next.unchecked_ref(),
                POLL_MS,
            );
        }
    }
    poll(host, launched, 0);
}

fn field(object: &JsValue, name: &str) -> JsValue {
    js_sys::Reflect::get(object, &JsValue::from_str(name)).unwrap_or(JsValue::UNDEFINED)
}

/// An array field of `config`, or an empty one when absent.
fn array(config: &JsValue, name: &str) -> js_sys::Array {
    field(config, name).dyn_into().unwrap_or_default()
}

/// A built-in theme name, or `{ background, foreground, cursor, palette: [16] }`
/// as 0xRRGGBB numbers (typically the editor's terminal colors); missing values
/// keep the default theme.
fn theme(value: &JsValue) -> Theme {
    if let Some(name) = value.as_string() {
        return Theme::builtin(&name).unwrap_or_default();
    }
    let mut theme = Theme::default();
    let color = |name| field(value, name).as_f64().map(|v| v as u32);
    if let Some(background) = color("background") {
        theme.background = background;
    }
    if let Some(foreground) = color("foreground") {
        theme.foreground = foreground;
    }
    theme.cursor = color("cursor").unwrap_or(theme.foreground);
    let palette = js_sys::Array::from(&field(value, "palette"));
    for (index, color) in palette.iter().take(16).enumerate() {
        if let Some(color) = color.as_f64() {
            theme.palette[index] = color as u32;
        }
    }
    theme.derive_chrome();
    theme
}

/// Starts the view. `config` carries what a browser build cannot read itself:
/// `{ fonts: Uint8Array[], family, fallbacks: string[], fontSize, cellHeight,
/// theme, copyOnSelect, tabId }`. `host` is `{ send(Uint8Array), event(json) }`;
/// it receives `ready` once graphics start, or `error` (`kind: "graphics"`) if
/// they cannot.
#[wasm_bindgen]
pub fn run(config: JsValue, host: JsValue) -> Result<(), JsValue> {
    console_error_panic_hook::set_once();
    gpui_web::init_logging();
    let host = Host::new(&host)?;
    // Open the inbox before the app starts: the host may deliver events (the
    // transport opening) before GPUI creates the view.
    let inbox = host::inbox();
    // Optional: a family without bytes is drawn with the browser's fonts.
    let fonts: Vec<Cow<'static, [u8]>> = array(&config, "fonts")
        .iter()
        .map(|bytes| Cow::Owned(js_sys::Uint8Array::new(&bytes).to_vec()))
        .collect();
    let family = field(&config, "family")
        .as_string()
        .unwrap_or_else(|| "monospace".into());
    let fallbacks: Vec<String> = array(&config, "fallbacks")
        .iter()
        .filter_map(|name| name.as_string())
        .collect();
    let font_size = field(&config, "fontSize")
        .as_f64()
        .map_or(FONT_SIZE, |v| v as f32);
    let cell_height = field(&config, "cellHeight")
        .as_f64()
        .map_or(CELL_HEIGHT, |v| v as f32);
    let copy_on_select = field(&config, "copyOnSelect").as_bool().unwrap_or(false);
    let tab_id = field(&config, "tabId").as_string();
    let theme = theme(&field(&config, "theme"));
    let launched = Rc::new(Cell::new(false));
    watch_graphics(host.clone(), launched.clone());
    let platform = Rc::new(gpui_web::WebPlatform::new(false));
    gpui::Application::with_platform(platform).run(move |cx: &mut App| {
        launched.set(true);
        host.event(json!({ "type": "ready" }));
        if let Err(error) = cx.text_system().add_fonts(fonts) {
            web_sys::console::error_1(&format!("fonts: {error:?}").into());
        }
        let mut font = gpui::font(family);
        if !fallbacks.is_empty() {
            font.fallbacks = Some(gpui::FontFallbacks::from_fonts(fallbacks));
        }
        let style = PaneViewStyle {
            font,
            font_size,
            cell_height,
            theme,
            // A glyph reaching left of the first column (a bullet in some
            // fonts) would otherwise be cut off at the page's edge.
            padding_left: 4.,
            alt_keys: true,
            copy_on_select,
            commit_text_on_key_down: true,
        };
        let opened = cx.open_window(WindowOptions::default(), |window, cx| {
            let handle = window.window_handle();
            let bridge = cx.new(|cx| Bridge::new(host, inbox, style, tab_id, handle, cx));
            let focus = bridge.read(cx).view.read(cx).focus_handle(cx);
            window.focus(&focus, cx);
            bridge
        });
        if let Err(error) = opened {
            web_sys::console::error_1(&format!("window: {error:?}").into());
        }
    });
    Ok(())
}
