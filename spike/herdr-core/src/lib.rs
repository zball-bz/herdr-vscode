//! Sans-IO herdr gen1 endpoint client core.
//!
//! The host (extension host or webview worker) owns the transport: it writes the bytes returned by
//! `hello`/`input_*`/`resize`/`ping` and passes every received chunk to `feed`. The core reassembles
//! frames, performs the gen1 handshake checks, keeps the snapshot and the retained pane surface,
//! applies full surfaces, patches and the optional scroll/delta/reuse encodings, and exports the
//! surface as a flat `u32` cell array for a GPU renderer. Session rules mirror herdr-gpui's
//! `herdr-client` session (Apache-2.0), minus clocks and images, which the host owns.

mod images;

use herdr_protocol::{endpoint::*, *};
use images::ImageStore;
use std::{
    collections::{HashMap, VecDeque},
    sync::Arc,
};
use serde_json::json;
use wasm_bindgen::prelude::*;

/// Words per exported cell: symbol, fg, bg, flags.
pub const CELL_WORDS: usize = 4;
/// Bytes one endpoint response may assemble to.
const MAX_RESPONSE_BYTES: usize = 8 << 20;
/// Symbol word flag: the low 31 bits index `take_new_symbols()` instead of being a codepoint.
pub const SYMBOL_INTERNED: u32 = 0x8000_0000;
const FLAG_SKIP: u32 = 1 << 16;
const FLAG_HYPERLINK: u32 = 1 << 17;

#[derive(Debug)]
pub struct CoreError(pub String);

impl<E: std::fmt::Display> From<E> for CoreError {
    fn from(error: E) -> Self {
        Self(error.to_string())
    }
}

impl From<CoreError> for JsValue {
    fn from(error: CoreError) -> Self {
        JsValue::from_str(&error.0)
    }
}

type CoreResult<T> = std::result::Result<T, CoreError>;

#[derive(Default, Clone, Copy)]
struct Encodings {
    reuse: bool,
    delta: bool,
    scroll: bool,
}

#[wasm_bindgen]
#[derive(Default)]
pub struct Core {
    inbound: Vec<u8>,
    read: usize,
    welcome: Option<EndpointServerWelcome>,
    encodings: Encodings,
    snapshot: Option<ClientShellSnapshot>,
    /// Shared with the view that paints it; a patch copies it only while the
    /// view still holds the previous one.
    surface: Option<Arc<PaneSurfaceFrame>>,
    keyboard_report_all: bool,
    /// Rows touched since the last export; `None` means everything.
    dirty_rows: Option<Vec<u16>>,
    images: ImageStore,
    published_images: Arc<SurfaceImages>,
    cells: Vec<u32>,
    symbol_ids: HashMap<String, u32>,
    new_symbols: Vec<String>,
    /// Endpoint requests: the daemon holds one per connection, so later ones wait.
    request_seq: u64,
    queued_requests: VecDeque<(String, String)>,
    in_flight: Option<(String, Vec<u8>)>,
    responses: VecDeque<(String, serde_json::Value)>,
    messages: u64,
    bytes: u64,
}

fn frame(message: &ClientMessage) -> CoreResult<Vec<u8>> {
    Ok(encode_message(message, MAX_FRAME_SIZE)?)
}

fn control(kind: &str, data: String) -> ClientMessage {
    ClientMessage::EndpointControl {
        kind: kind.into(),
        data,
    }
}

fn message_kind(message: &ServerMessage) -> &'static str {
    match message {
        ServerMessage::Welcome { .. } => "welcome",
        ServerMessage::Terminal(_) => "terminal",
        ServerMessage::Graphics { .. } => "graphics",
        ServerMessage::ServerShutdown { .. } => "server_shutdown",
        ServerMessage::Notify { .. } => "notify",
        ServerMessage::Clipboard { .. } => "clipboard",
        ServerMessage::WindowTitle { .. } => "window_title",
        ServerMessage::ReloadSoundConfig => "reload_sound_config",
        ServerMessage::MouseCapture { .. } => "mouse_capture",
        ServerMessage::TerminalBell { .. } => "terminal_bell",
        ServerMessage::GraphicsFile { .. } => "graphics_file",
        ServerMessage::GraphicsTransmissionRetired { .. } => "graphics_transmission_retired",
        ServerMessage::ClientShellSnapshot(_) => "client_shell_snapshot",
        ServerMessage::PaneSurface(_) => "pane_surface",
        ServerMessage::SemanticNotification(_) => "semantic_notification",
        ServerMessage::ClientShellError { .. } => "client_shell_error",
        ServerMessage::DirectTerminalKeyboardProtocol { .. } => "direct_terminal_keyboard_protocol",
        ServerMessage::ClientShellKeyboardReportAll { .. } => "client_shell_keyboard_report_all",
        ServerMessage::ClientShellEndpointResponseChunk { .. } => "endpoint_response_chunk",
        ServerMessage::PaneSurfacePatch(_) => "pane_surface_patch",
        ServerMessage::EndpointControl { .. } => "endpoint_control",
    }
}

impl Core {
    fn handle(&mut self, message: ServerMessage, events: &mut Vec<serde_json::Value>) -> CoreResult<()> {
        if self.welcome.is_none() {
            let ServerMessage::EndpointControl { kind, data } = message else {
                return Err(CoreError("expected endpoint welcome".into()));
            };
            if kind != ENDPOINT_WELCOME_KIND {
                return Err(CoreError(format!("unexpected first control {kind}")));
            }
            let welcome: EndpointServerWelcome = serde_json::from_str(&data)?;
            if let Some(error) = &welcome.error {
                return Err(CoreError(format!("welcome rejected: {} {}", error.code, error.message)));
            }
            if welcome.generation != ENDPOINT_PROTOCOL_GENERATION
                || welcome.snapshot_codec != SNAPSHOT_CODEC_V1
                || welcome.surface_codec != SURFACE_CODEC_V1
                || welcome.input_codec != INPUT_CODEC_V1
                || welcome.blob_codec != BLOB_CODEC_V1
            {
                return Err(CoreError("incompatible endpoint codecs".into()));
            }
            let has = |cap: &str| welcome.capabilities.iter().any(|c| c == cap);
            self.encodings = Encodings {
                reuse: has(surface_reuse::CAPABILITY),
                delta: has(surface_delta::CAPABILITY),
                scroll: has(surface_scroll::CAPABILITY),
            };
            events.push(json!({
                "type": "welcome",
                "server_version": welcome.server_version,
                "capabilities": welcome.capabilities,
                "methods": welcome.methods.len(),
            }));
            self.welcome = Some(welcome);
            return Ok(());
        }
        match message {
            ServerMessage::EndpointControl { kind, data } if kind == ENDPOINT_SNAPSHOT_KIND => {
                let next: ClientShellSnapshot = serde_json::from_str(&data)?;
                if next.boot_id.is_empty()
                    || self
                        .snapshot
                        .as_ref()
                        .is_some_and(|s| s.boot_id != next.boot_id || next.revision < s.revision)
                {
                    return Err(CoreError("snapshot identity".into()));
                }
                events.push(json!({ "type": "snapshot", "revision": next.revision, "json": data }));
                self.snapshot = Some(next);
            }
            ServerMessage::EndpointControl { kind, data } if kind == surface_scroll::MESSAGE_KIND => {
                if !self.encodings.scroll {
                    return Err(CoreError("surface_scroll not negotiated".into()));
                }
                let scroll = surface_scroll::decode(&data)?;
                let current = self.surface.as_mut().ok_or(CoreError("scroll before baseline".into()))?;
                Arc::make_mut(current).apply_scroll_patch(scroll)?;
                self.dirty_rows = None; // row shifts move content; re-export everything
                events.push(json!({ "type": "surface", "via": "scroll", "revision": current.surface_revision }));
            }
            ServerMessage::EndpointControl { kind, data } if kind == surface_delta::MESSAGE_KIND => {
                if !self.encodings.delta {
                    return Err(CoreError("surface_delta not negotiated".into()));
                }
                let base = self.surface.as_ref().ok_or(CoreError("delta before baseline".into()))?;
                let next = surface_delta::decode(&data)?.reconstruct(base)?;
                self.accept(next, "delta", events)?;
            }
            ServerMessage::EndpointControl { kind, data } if kind == surface_reuse::MESSAGE_KIND => {
                if !self.encodings.reuse {
                    return Err(CoreError("surface_reuse not negotiated".into()));
                }
                let base = self.surface.as_ref().ok_or(CoreError("reuse before baseline".into()))?;
                let next = surface_reuse::decode(&data)?.reconstruct(base)?;
                self.accept(next, "reuse", events)?;
            }
            ServerMessage::EndpointControl { kind, .. } => {
                events.push(json!({ "type": "control", "kind": kind }));
            }
            ServerMessage::PaneSurface(next) => self.accept(next, "full", events)?,
            ServerMessage::PaneSurfacePatch(patch) => {
                let rows: Vec<u16> = patch.rows.iter().map(|row| row.y).collect();
                let current = self.surface.as_mut().ok_or(CoreError("patch before baseline".into()))?;
                Arc::make_mut(current).apply_patch(patch)?;
                let revision = current.surface_revision;
                if self.images.show() {
                    self.published_images = self.images.published();
                }
                if let Some(dirty) = &mut self.dirty_rows {
                    dirty.extend(rows.iter().copied());
                }
                events.push(json!({ "type": "surface", "via": "patch", "revision": revision, "rows": rows.len() }));
            }
            ServerMessage::ClientShellEndpointResponseChunk {
                boot_id,
                request_id,
                final_chunk,
                data,
            } => {
                if self.snapshot.as_ref().is_none_or(|s| s.boot_id != boot_id) {
                    return Err(CoreError("response from another boot".into()));
                }
                let Some((id, body)) = self.in_flight.as_mut().filter(|(id, _)| *id == request_id) else {
                    return Err(CoreError("unsolicited endpoint response".into()));
                };
                if body.len() + data.len() > MAX_RESPONSE_BYTES {
                    return Err(CoreError("endpoint response too large".into()));
                }
                body.extend(data);
                if final_chunk {
                    let id = id.clone();
                    let (_, body) = self.in_flight.take().unwrap_or_default();
                    let value: serde_json::Value = serde_json::from_slice(&body)?;
                    events.push(json!({ "type": "response", "id": id }));
                    self.responses.push_back((id, value));
                }
            }
            ServerMessage::ServerShutdown { reason } => {
                return Err(CoreError(format!("server shutdown: {}", reason.unwrap_or_default())));
            }
            ServerMessage::ClientShellKeyboardReportAll { enabled } => {
                self.keyboard_report_all = enabled;
                events.push(json!({ "type": "keyboard_report_all", "enabled": enabled }));
            }
            other => events.push(json!({ "type": "message", "kind": message_kind(&other) })),
        }
        Ok(())
    }

    fn accept(&mut self, mut next: PaneSurfaceFrame, via: &str, events: &mut Vec<serde_json::Value>) -> CoreResult<()> {
        let snapshot = self.snapshot.as_ref().ok_or(CoreError("surface before snapshot".into()))?;
        if next.boot_id != snapshot.boot_id
            || self
                .surface
                .as_ref()
                .is_some_and(|old| next.surface_revision <= old.surface_revision)
        {
            return Err(CoreError("surface identity".into()));
        }
        next.frame.validate()?;
        if let Some(popup) = &next.popup {
            popup.frame.validate()?;
        }
        // Bytes leave the surface for the store; the surface keeps placements and keys.
        if self.images.receive(&mut next) | self.images.show() {
            self.published_images = self.images.published();
        }
        events.push(serde_json::json!({
            "type": "surface",
            "via": via,
            "images": self.published_images.len(),
            "revision": next.surface_revision,
            "width": next.frame.width,
            "height": next.frame.height,
            "panes": next.panes.len(),
        }));
        self.surface = Some(Arc::new(next));
        self.dirty_rows = None;
        Ok(())
    }

    /// The retained surface, for a painter linked into the same module.
    pub fn surface(&self) -> Option<&Arc<PaneSurfaceFrame>> {
        self.surface.as_ref()
    }

    /// Queues an endpoint request (`{id, method, params}` as the daemon's API
    /// takes it) and returns its id. Call `next_request_frame` to send it.
    pub fn request(&mut self, method: &str, params: serde_json::Value) -> String {
        self.request_seq += 1;
        let id = format!("web-{}", self.request_seq);
        let request = json!({ "id": id, "method": method, "params": params }).to_string();
        self.queued_requests.push_back((id.clone(), request));
        id
    }

    /// The next queued request, framed, once none is in flight.
    pub fn next_request_frame(&mut self) -> Option<Vec<u8>> {
        if self.in_flight.is_some() {
            return None;
        }
        let boot_id = self.snapshot.as_ref()?.boot_id.clone();
        let (id, request) = self.queued_requests.pop_front()?;
        let frame = frame(&ClientMessage::ClientShellEndpointRequest { boot_id, request }).ok()?;
        self.in_flight = Some((id, Vec::new()));
        Some(frame)
    }

    /// Completed endpoint responses, oldest first, as `(id, envelope)`.
    pub fn take_responses(&mut self) -> Vec<(String, serde_json::Value)> {
        self.responses.drain(..).collect()
    }

    /// Any client message, framed for the daemon.
    pub fn encode(message: &ClientMessage) -> CoreResult<Vec<u8>> {
        frame(message)
    }

    /// The snapshot most recently received, if any.
    pub fn snapshot(&self) -> Option<&ClientShellSnapshot> {
        self.snapshot.as_ref()
    }

    /// Whether the daemon advertised `capability` in its welcome.
    pub fn has_capability(&self, capability: &str) -> bool {
        self.welcome.as_ref().is_some_and(|w| w.capabilities.iter().any(|c| c == capability))
    }

    /// Whether the daemon asked for every key event of its focused pane.
    pub fn keyboard_report_all(&self) -> bool {
        self.keyboard_report_all
    }

    /// Images the retained surface may place, by asset key.
    pub fn images(&self) -> Arc<SurfaceImages> {
        Arc::clone(&self.published_images)
    }

    /// Framed semantic input for one pane.
    pub fn pane_input(&self, pane_id: &str, events: Vec<ClientPaneInputEvent>) -> CoreResult<Vec<u8>> {
        frame(&ClientMessage::ClientShellPaneInput {
            pane_id: pane_id.into(),
            events,
        })
    }

    fn symbol_word(&mut self, symbol: &str) -> u32 {
        let mut chars = symbol.chars();
        match (chars.next(), chars.next()) {
            (None, _) => 0,
            (Some(c), None) => c as u32,
            _ => {
                if let Some(id) = self.symbol_ids.get(symbol) {
                    return SYMBOL_INTERNED | id;
                }
                let id = self.symbol_ids.len() as u32;
                self.symbol_ids.insert(symbol.to_owned(), id);
                self.new_symbols.push(symbol.to_owned());
                SYMBOL_INTERNED | id
            }
        }
    }
}

#[wasm_bindgen]
impl Core {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Core {
        Core::default()
    }

    /// Framed endpoint hello. Requests every optional surface encoding, as upstream clients do.
    pub fn hello(&self, cols: u16, rows: u16, cell_width_px: u32, cell_height_px: u32, surface_active: bool) -> std::result::Result<Vec<u8>, JsValue> {
        let hello = EndpointClientHello {
            generation: ENDPOINT_PROTOCOL_GENERATION,
            cell_width_px,
            cell_height_px,
            surface_size: ClientSurfaceSize { cols, rows },
            pixel_mouse: false,
            direct_graphics: false,
            endpoint_keybindings: false,
            mouse_capture: false,
            surface_active,
            surface_reuse: true,
            surface_delta: true,
            surface_scroll: true,
            snapshot_codecs: vec![SNAPSHOT_CODEC_V1.into()],
            surface_codecs: vec![SURFACE_CODEC_V1.into()],
            input_codecs: vec![INPUT_CODEC_V1.into()],
            blob_codecs: vec![BLOB_CODEC_V1.into()],
        };
        let data = serde_json::to_string(&hello).map_err(CoreError::from)?;
        Ok(frame(&control(ENDPOINT_HELLO_KIND, data))?)
    }

    /// Consumes received bytes; returns a JSON array of events for the frames completed so far.
    pub fn feed(&mut self, chunk: &[u8]) -> std::result::Result<String, JsValue> {
        self.bytes += chunk.len() as u64;
        self.inbound.extend_from_slice(chunk);
        let mut events = Vec::new();
        loop {
            let available = &self.inbound[self.read..];
            if available.len() < 4 {
                break;
            }
            let len = u32::from_le_bytes(available[..4].try_into().unwrap()) as usize;
            if len == 0 || len > MAX_GRAPHICS_FRAME_SIZE {
                return Err(CoreError(format!("frame length {len} out of bounds")).into());
            }
            if available.len() < 4 + len {
                break;
            }
            let message: ServerMessage = decode_payload(&available[4..4 + len]).map_err(CoreError::from)?;
            self.read += 4 + len;
            self.messages += 1;
            self.handle(message, &mut events)?;
        }
        // Compact once per chunk instead of draining per frame.
        if self.read > 0 {
            self.inbound.drain(..self.read);
            self.read = 0;
        }
        Ok(serde_json::to_string(&events).map_err(CoreError::from)?)
    }

    pub fn width(&self) -> u16 {
        self.surface.as_ref().map_or(0, |s| s.frame.width)
    }

    pub fn height(&self) -> u16 {
        self.surface.as_ref().map_or(0, |s| s.frame.height)
    }

    /// Flat `[symbol, fg, bg, flags]` per cell for the whole surface. Colors keep herdr's packing:
    /// tag byte 0 = named (0 reset, 1..=16 ANSI), 1 = 256-color index, 2 = RGB. Flags hold the
    /// ratatui modifier bits (low 16), skip and hyperlink bits.
    pub fn export_cells(&mut self) -> Vec<u32> {
        let Some(surface) = self.surface.take() else {
            return Vec::new();
        };
        let cells = &surface.frame.cells;
        self.cells.resize(cells.len() * CELL_WORDS, 0);
        let rows: Vec<u16> = match self.dirty_rows.take() {
            Some(rows) => rows,
            None => (0..surface.frame.height).collect(),
        };
        let width = surface.frame.width as usize;
        for y in rows {
            for i in y as usize * width..(y as usize + 1) * width {
                let cell = &cells[i];
                let symbol = self.symbol_word(&cell.symbol);
                let flags = cell.modifier as u32
                    | if cell.skip { FLAG_SKIP } else { 0 }
                    | if cell.hyperlink.is_some() { FLAG_HYPERLINK } else { 0 };
                self.cells[i * CELL_WORDS..(i + 1) * CELL_WORDS].copy_from_slice(&[symbol, cell.fg, cell.bg, flags]);
            }
        }
        self.dirty_rows = Some(Vec::new());
        self.surface = Some(surface);
        self.cells.clone()
    }

    /// Multi-codepoint symbols interned since the last call, in id order.
    pub fn take_new_symbols(&mut self) -> Vec<String> {
        std::mem::take(&mut self.new_symbols)
    }

    /// Visible text of the composed surface, one line per row (verification only).
    pub fn text(&self) -> String {
        let Some(surface) = &self.surface else {
            return String::new();
        };
        let frame = &surface.frame;
        let mut out = String::new();
        for row in frame.cells.chunks(frame.width as usize) {
            for cell in row.iter().filter(|c| !c.skip) {
                out.push_str(if cell.symbol.is_empty() { " " } else { &cell.symbol });
            }
            out.push('\n');
        }
        out
    }

    pub fn panes_json(&self) -> String {
        self.surface
            .as_ref()
            .map(|s| serde_json::to_string(&s.panes).unwrap_or_default())
            .unwrap_or_else(|| "[]".into())
    }

    pub fn focused_pane_id(&self) -> Option<String> {
        self.snapshot.as_ref().and_then(|s| s.focused_pane_id.clone())
    }

    pub fn input_text(&self, pane_id: &str, text: &str) -> std::result::Result<Vec<u8>, JsValue> {
        Ok(frame(&ClientMessage::ClientShellPaneInput {
            pane_id: pane_id.into(),
            events: vec![ClientPaneInputEvent::TextCommit(text.into())],
        })?)
    }

    pub fn input_enter(&self, pane_id: &str) -> std::result::Result<Vec<u8>, JsValue> {
        Ok(frame(&ClientMessage::ClientShellPaneInput {
            pane_id: pane_id.into(),
            events: vec![ClientPaneInputEvent::Key {
                code: ClientKeyCode::Enter,
                modifiers: 0,
                kind: ClientKeyKind::Press,
                repeat_count: 1,
                shifted_codepoint: None,
                generated_text: None,
                tracks_release: false,
                physical_key_id: None,
                windows_record: None,
            }],
        })?)
    }

    pub fn resize(&self, cols: u16, rows: u16, cell_width_px: u32, cell_height_px: u32) -> std::result::Result<Vec<u8>, JsValue> {
        Ok(frame(&ClientMessage::ClientShellResize {
            cell_width_px,
            cell_height_px,
            surface_size: ClientSurfaceSize { cols, rows },
            pixel_mouse: false,
        })?)
    }

    /// `request` for JavaScript hosts: `params` is JSON; returns the request id.
    pub fn request_json(&mut self, method: &str, params: &str) -> std::result::Result<String, JsValue> {
        let params = serde_json::from_str(params).map_err(CoreError::from)?;
        Ok(self.request(method, params))
    }

    /// `next_request_frame` for JavaScript hosts.
    pub fn next_request(&mut self) -> Option<Vec<u8>> {
        self.next_request_frame()
    }

    /// Completed responses as a JSON array of `[id, envelope]`.
    pub fn responses_json(&mut self) -> String {
        serde_json::to_string(&self.take_responses()).unwrap_or_else(|_| "[]".into())
    }

    pub fn ping(&self) -> std::result::Result<Vec<u8>, JsValue> {
        Ok(frame(&control("endpoint.health.ping.v1", String::new()))?)
    }

    pub fn messages(&self) -> f64 {
        self.messages as f64
    }

    pub fn bytes(&self) -> f64 {
        self.bytes as f64
    }
}
