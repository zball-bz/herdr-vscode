//! Monotonic time for paint diagnostics and image idling. `std::time::Instant`
//! panics on `wasm32-unknown-unknown`, so browser builds read the page clock.
#[cfg(not(target_family = "wasm"))]
pub use std::time::{Duration, Instant};
#[cfg(target_family = "wasm")]
pub use web_time::{Duration, Instant};
