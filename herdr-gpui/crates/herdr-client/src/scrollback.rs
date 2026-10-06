//! Typed requests and results for the daemon's scrollback methods.
//!
//! Field names, enum spellings, and the `type` tag of each result match
//! Herdr's endpoint schema (`api::schema::panes` and `ResponseResult`). Rows
//! are absolute screen-buffer rows counted from the top of the retained
//! scrollback, so a point stays put while the pane scrolls; the viewport's
//! top row is `max_offset_from_bottom - offset_from_bottom`.

use crate::{ClientHandle, Error, Result, method::Method};
use serde::Deserialize;
use serde_json::Value;

pub use crate::protocol::{
    CopyMotion, CopyMotionParams, CopyMotionResult, CopySearchParams, CopySearchResult,
    EndpointErrorCode, MAX_SEARCH_QUERY_BYTES, ScrollbackResponse, SearchDirection,
    SelectionReadParams, SelectionResult, TextPoint, TextRange,
};

#[derive(Deserialize)]
struct ErrorBody {
    code: String,
    message: String,
}

#[derive(Deserialize)]
struct Envelope {
    #[serde(default)]
    result: Option<Value>,
    #[serde(default)]
    error: Option<ErrorBody>,
}

impl From<Error> for crate::protocol::RequestFailure {
    fn from(error: Error) -> Self {
        match error {
            Error::Endpoint { code, message } => Self::Endpoint { code, message },
            other => Self::Client(other.to_string()),
        }
    }
}

/// Rejects a search the daemon would refuse before it is queued.
pub fn validate_search(params: &CopySearchParams) -> Result<()> {
    if params.query.len() > MAX_SEARCH_QUERY_BYTES {
        return Err(Error::Endpoint {
            code: EndpointErrorCode::QueryTooLarge,
            message: "copy search query is too large".into(),
        });
    }
    Ok(())
}

impl ClientHandle {
    /// Queues `pane.copy_search`, returning the request ID its response
    /// carries.
    pub fn copy_search(&self, boot_id: &str, params: &CopySearchParams) -> Result<String> {
        validate_search(params)?;
        self.request(
            boot_id,
            Method::PaneCopySearch,
            serde_json::to_value(params)?,
        )
    }

    /// Queues `pane.copy_motion`.
    pub fn copy_motion(&self, boot_id: &str, params: &CopyMotionParams) -> Result<String> {
        self.request(
            boot_id,
            Method::PaneCopyMotion,
            serde_json::to_value(params)?,
        )
    }

    /// Queues `pane.selection.read`.
    pub fn read_selection(&self, boot_id: &str, params: &SelectionReadParams) -> Result<String> {
        self.request(
            boot_id,
            Method::PaneSelectionRead,
            serde_json::to_value(params)?,
        )
    }

    /// Queues `pane.edit_scrollback`, which the daemon honors only for its
    /// focused pane: it opens the pane's history in the user's editor.
    pub fn edit_scrollback(&self, boot_id: &str, pane_id: &str) -> Result<String> {
        self.request(
            boot_id,
            Method::PaneEditScrollback,
            serde_json::json!({ "pane_id": pane_id }),
        )
    }
}

/// Decodes the response envelope of a scrollback request: its result, or
/// the endpoint error it carried.
pub fn decode_response(response: &Value) -> Result<ScrollbackResponse> {
    let envelope = Envelope::deserialize(response).map_err(Error::ResponseSchema)?;
    if let Some(ErrorBody { code, message }) = envelope.error {
        return Err(Error::Endpoint {
            code: code.into(),
            message,
        });
    }
    let result = envelope.result.ok_or(Error::ResponseMissingResult)?;
    ScrollbackResponse::deserialize(result).map_err(Error::ResponseSchema)
}

/// Decodes the answer to a `pane.copy_search` request.
pub fn decode_copy_search(response: &Value) -> Result<CopySearchResult> {
    match decode_response(response)? {
        ScrollbackResponse::PaneCopySearch(result) => Ok(result),
        _ => Err(Error::ResponseType),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests;
