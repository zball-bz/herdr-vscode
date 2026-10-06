//! Failures of the pane view: selections that no longer match the painted
//! surface, and addresses a link may not open.

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("The selected pane is no longer on screen.")]
    SelectionStale,
    #[error("Selection is too large to copy.")]
    SelectionSize,
    #[error("The selection reaches rows the pane no longer shows.")]
    SelectionOffscreen,
    #[error("Could not decode an image a pane placed.")]
    PaneImageDecode(#[source] image::ImageError),
    #[error("An image a pane placed exceeds the decoded size limit.")]
    PaneImageLimit,
    #[error("Browser tabs open only http and https addresses with a host, of at most 8 KiB.")]
    InvalidBrowserUrl,
}

pub type Result<T> = std::result::Result<T, Error>;
