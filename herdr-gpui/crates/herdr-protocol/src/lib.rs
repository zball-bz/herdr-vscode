//! Stable gen1 wire model with no terminal or server runtime dependencies.
#![doc = include_str!("../README.md")]
pub mod endpoint;
pub mod surface_delta;
pub mod surface_reuse;
pub mod surface_scroll;

mod clipboard;
mod codec;
mod error;
mod frame;
mod scrollback;
mod surface_images;
mod wire;

pub use clipboard::{
    MAX_CLIPBOARD_IMAGE_FRAME_SIZE, MAX_CLIPBOARD_IMAGE_PAYLOAD, MAX_CLIPBOARD_IMAGE_TARGET_BYTES,
    encode_clipboard_image, validate_clipboard_image_target,
};
pub use codec::{
    MAX_FRAME_SIZE, MAX_GRAPHICS_FRAME_SIZE, decode_payload, encode_message, read_message,
    write_message,
};
pub use error::{Error, Result};
pub use scrollback::{
    CopyMotion, CopyMotionParams, CopyMotionResult, CopySearchParams, CopySearchResult,
    EndpointErrorCode, MAX_SEARCH_QUERY_BYTES, RequestFailure, ScrollbackResponse, SearchDirection,
    SelectionReadParams, SelectionResult, TextPoint, TextRange, decode_scrollback_response,
};
pub use surface_images::{
    MAX_IMAGE_BYTES, MAX_IMAGE_SIDE, MAX_IMAGES, MAX_PLACEMENTS, SurfaceImage, SurfaceImages,
    valid_asset,
};
pub use wire::*;
