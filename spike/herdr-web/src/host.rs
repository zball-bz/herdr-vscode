//! The page that embeds this module owns the transport. It calls `run` once with
//! the fonts and a host object `{ send(bytes), event(json) }`, then `deliver` for
//! every chunk of daemon bytes and `host_event` for transport and editor events.
//! A browser page backs `send` with a WebSocket; the VS Code webview with
//! `postMessage` to the extension host, which owns the daemon socket.

use futures::channel::mpsc::{UnboundedReceiver, UnboundedSender, unbounded};
use serde::Deserialize;
use std::cell::RefCell;
use wasm_bindgen::prelude::*;

/// What the host tells the view.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum HostEvent {
    /// The transport reached the daemon; the view may send its hello.
    Open,
    /// The transport ended; the view keeps its last surface and shows why.
    Closed { reason: String },
    /// Clipboard text the host read for a paste.
    Paste { text: String },
    /// The editor focused or blurred the view.
    Focus { focused: bool },
    /// An editor command routed to the view, such as `find` or `copy`.
    Command { name: String },
    /// The editor showed or hid the view; a hidden view stops receiving surfaces.
    Visibility { visible: bool },
}

pub enum Inbound {
    Bytes(Vec<u8>),
    Host(HostEvent),
}

thread_local! {
    static INBOX: RefCell<Option<UnboundedSender<Inbound>>> = const { RefCell::new(None) };
}

/// Opens the inbox that `deliver` and `host_event` feed; called once by `run`.
pub fn inbox() -> UnboundedReceiver<Inbound> {
    let (tx, rx) = unbounded();
    INBOX.with(|inbox| *inbox.borrow_mut() = Some(tx));
    rx
}

fn push(message: Inbound) {
    INBOX.with(|inbox| {
        if let Some(tx) = inbox.borrow().as_ref() {
            let _ = tx.unbounded_send(message);
        }
    });
}

/// Daemon bytes from the host's transport.
#[wasm_bindgen]
pub fn deliver(bytes: &[u8]) {
    push(Inbound::Bytes(bytes.to_vec()));
}

/// A JSON-encoded [`HostEvent`] from the page or editor.
#[wasm_bindgen]
pub fn host_event(json: &str) {
    match serde_json::from_str(json) {
        Ok(event) => push(Inbound::Host(event)),
        Err(error) => {
            web_sys::console::warn_1(&format!("unknown host event {json}: {error}").into())
        }
    }
}

/// The host object's two callbacks.
#[derive(Clone)]
pub struct Host {
    send: js_sys::Function,
    event: js_sys::Function,
}

impl Host {
    pub fn new(host: &JsValue) -> Result<Self, JsValue> {
        let get = |name: &str| -> Result<js_sys::Function, JsValue> {
            js_sys::Reflect::get(host, &JsValue::from_str(name))?
                .dyn_into()
                .map_err(|_| JsValue::from_str(&format!("host.{name} must be a function")))
        };
        Ok(Self {
            send: get("send")?,
            event: get("event")?,
        })
    }

    /// Bytes for the daemon, already framed.
    pub fn send(&self, bytes: &[u8]) {
        let array = js_sys::Uint8Array::from(bytes);
        let _ = self.send.call1(&JsValue::NULL, &array);
    }

    /// A JSON event for the page or editor: status, links to open, text to copy.
    pub fn event(&self, value: serde_json::Value) {
        let _ = self
            .event
            .call1(&JsValue::NULL, &JsValue::from_str(&value.to_string()));
    }
}
