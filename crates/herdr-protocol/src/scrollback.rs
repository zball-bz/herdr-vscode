//! Typed requests and results for the daemon's scrollback methods.
//!
//! Field names, enum spellings, and the `type` tag of each result match
//! Herdr's endpoint schema (`api::schema::panes` and `ResponseResult`). Rows
//! are absolute screen-buffer rows counted from the top of the retained
//! scrollback, so a point stays put while the pane scrolls; the viewport's
//! top row is `max_offset_from_bottom - offset_from_bottom`. Kept below the
//! socket client so views that cannot link it (a browser build) share them.
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A cell in screen-buffer coordinates. Declared row first so the derived
/// order is reading order.
#[derive(
    Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize,
)]
pub struct TextPoint {
    pub row: u32,
    pub col: u16,
}

/// A span of cells. `end` is inclusive: it names the last cell of the match,
/// which for a wide glyph is its second column.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct TextRange {
    pub start: TextPoint,
    pub end: TextPoint,
}

/// The daemon refuses longer queries with `query_too_large`; checking here
/// keeps an oversized paste from reaching the wire at all.
pub const MAX_SEARCH_QUERY_BYTES: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SearchDirection {
    /// Toward newer output: the first match starting after the origin.
    Forward,
    /// Toward older output: the last match ending before the origin.
    Backward,
}

/// `pane.copy_search` parameters. The origin is `previous` when given (its
/// end searching forward, its start backward), otherwise `cursor`. A search
/// that finds nothing past the origin wraps around.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CopySearchParams {
    pub pane_id: String,
    pub query: String,
    pub direction: SearchDirection,
    pub cursor: TextPoint,
    /// The pane content the coordinates were read from. The daemon answers
    /// `stale_content` when its terminal has moved on since.
    pub content_revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous: Option<TextRange>,
}

/// `pane.copy_search` result. `matches` is a bounded window around the
/// current match; `total` counts every match in the pane.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CopySearchResult {
    pub pane_id: String,
    pub content_revision: u64,
    pub matches: Vec<TextRange>,
    pub total: u64,
    /// Index of the current match within `matches`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current: Option<u32>,
    /// Index of the current match among all `total` matches, top first.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_global: Option<u64>,
}

impl CopySearchResult {
    /// The current match, when the daemon named one inside `matches`.
    pub fn current_match(&self) -> Option<TextRange> {
        self.current
            .and_then(|index| self.matches.get(usize::try_from(index).ok()?))
            .copied()
    }
}

/// A copy-mode motion the daemon resolves against the terminal's own text:
/// word classes, line ends, and paragraphs, which a client cannot know from
/// the painted cells alone. Spellings match Herdr's `PaneCopyMotion`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CopyMotion {
    LineEnd,
    FirstNonBlank,
    NextWordStart,
    PreviousWordStart,
    NextWordEnd,
    NextBigWordStart,
    PreviousBigWordStart,
    NextBigWordEnd,
    PreviousParagraph,
    NextParagraph,
}

/// `pane.copy_motion` parameters.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CopyMotionParams {
    pub pane_id: String,
    pub cursor: TextPoint,
    pub motion: CopyMotion,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_revision: Option<u64>,
}

/// `pane.copy_motion` result: where the motion lands. A motion with nowhere
/// to go answers the cursor it was given.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CopyMotionResult {
    pub pane_id: String,
    pub cursor: TextPoint,
    pub content_revision: u64,
}

/// `pane.selection.read` parameters: the cells from `anchor` to `cursor`,
/// both inclusive, in either order. Without a revision the daemon reads its
/// live terminal, which is what an explicit selection wants.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SelectionReadParams {
    pub pane_id: String,
    pub anchor: TextPoint,
    pub cursor: TextPoint,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_revision: Option<u64>,
}

/// `pane.selection.read` result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SelectionResult {
    pub pane_id: String,
    pub text: String,
}

/// The result of any scrollback method, by its `type` tag.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ScrollbackResponse {
    PaneCopySearch(CopySearchResult),
    PaneCopyMotion(CopyMotionResult),
    PaneSelection(SelectionResult),
    /// `pane.edit_scrollback` answers a bare acknowledgement.
    Ok {},
}

/// An endpoint error code this client acts on. Codes are open-ended on the
/// wire, so anything else is kept verbatim for display.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EndpointErrorCode {
    /// The pane's content changed after the request's revision was read.
    StaleContent,
    PaneNotFound,
    QueryTooLarge,
    Other(String),
}

impl From<String> for EndpointErrorCode {
    fn from(code: String) -> Self {
        match code.as_str() {
            "stale_content" => Self::StaleContent,
            "pane_not_found" => Self::PaneNotFound,
            "query_too_large" => Self::QueryTooLarge,
            _ => Self::Other(code),
        }
    }
}

/// Why a scrollback request failed, as a view acts on it: an endpoint error
/// keeps its code, so a stale answer can be retried against a newer surface;
/// a failure before the daemon answered keeps only its message.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RequestFailure {
    #[error("{message}")]
    Endpoint {
        code: EndpointErrorCode,
        message: String,
    },
    #[error("{0}")]
    Client(String),
}

impl RequestFailure {
    /// The pane changed after the request's revision was read.
    pub fn is_stale(&self) -> bool {
        matches!(
            self,
            Self::Endpoint {
                code: EndpointErrorCode::StaleContent,
                ..
            }
        )
    }
}

/// Decodes a scrollback request's response envelope (`{id, result}` or
/// `{id, error: {code, message}}`) into its result or the failure a view acts
/// on. A malformed envelope is a client-side failure, kept as its message.
pub fn decode_scrollback_response(response: &Value) -> Result<ScrollbackResponse, RequestFailure> {
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
    let schema =
        |error: serde_json::Error| RequestFailure::Client(format!("endpoint response: {error}"));
    let envelope = Envelope::deserialize(response).map_err(schema)?;
    if let Some(ErrorBody { code, message }) = envelope.error {
        return Err(RequestFailure::Endpoint {
            code: code.into(),
            message,
        });
    }
    let result = envelope
        .result
        .ok_or_else(|| RequestFailure::Client("endpoint response has no result".into()))?;
    ScrollbackResponse::deserialize(result).map_err(schema)
}
