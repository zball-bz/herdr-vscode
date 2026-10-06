//! Painting, hit testing, selection, and link detection for Herdr pane
//! surfaces. Depends only on GPUI and the gen-1 protocol, so the same code
//! paints the native window and a browser (`wasm32`) canvas.
pub mod contrast;
pub mod copy_mode;
#[cfg(feature = "integration-test")]
mod counts;
mod error;
pub mod find;
pub mod pane_view;
pub mod scrollback;
pub mod terminal;
pub mod terminal_painter;
pub mod theme;
mod time;
mod web_url;

#[cfg(feature = "integration-test")]
pub use counts::Counts;
pub use error::{Error, Result};
pub use pane_view::{LinkActivation, PaneCommand, PaneView, PaneViewEvent, PaneViewStyle};
pub use web_url::WebUrl;
