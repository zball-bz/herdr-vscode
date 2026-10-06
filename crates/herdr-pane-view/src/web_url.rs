//! The web addresses a terminal link may open.
use crate::{Error, Result};

const MAX_URL_BYTES: usize = 8192;

/// An address a browser tab may show: http or https with a host, bounded,
/// and free of whitespace and control characters. Anything that reaches a
/// page, from a terminal link, an agent, or the address field, is parsed into
/// this first.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct WebUrl(url::Url);

impl WebUrl {
    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }

    pub fn host(&self) -> &str {
        self.0.host_str().unwrap_or_default()
    }

    /// What someone typed into the address field: a bare host such as
    /// `localhost:3000` or `example.com/docs` gets a scheme, local hosts plain
    /// http and everything else https.
    pub fn from_typed(text: &str) -> Result<Self> {
        let text = text.trim();
        if let Ok(url) = Self::try_from(text) {
            return Ok(url);
        }
        if text.contains("://") {
            return Err(Error::InvalidBrowserUrl);
        }
        let host = text.split(['/', ':', '?', '#']).next().unwrap_or_default();
        let local =
            matches!(host, "localhost" | "127.0.0.1" | "[::1]") || host.ends_with(".localhost");
        let scheme = if local { "http" } else { "https" };
        Self::try_from(format!("{scheme}://{text}").as_str())
    }
}

impl TryFrom<&str> for WebUrl {
    type Error = Error;

    fn try_from(value: &str) -> Result<Self> {
        if value.len() > MAX_URL_BYTES || value.chars().any(|c| c.is_control() || c.is_whitespace())
        {
            return Err(Error::InvalidBrowserUrl);
        }
        let url = url::Url::parse(value).map_err(|_| Error::InvalidBrowserUrl)?;
        if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none_or(str::is_empty) {
            return Err(Error::InvalidBrowserUrl);
        }
        // Serialization can lengthen an address, for example by
        // percent-encoding, so the bound applies to what a page is given too.
        if url.as_str().len() > MAX_URL_BYTES {
            return Err(Error::InvalidBrowserUrl);
        }
        Ok(Self(url))
    }
}

impl TryFrom<String> for WebUrl {
    type Error = Error;

    fn try_from(value: String) -> Result<Self> {
        Self::try_from(value.as_str())
    }
}

impl From<WebUrl> for String {
    fn from(url: WebUrl) -> Self {
        url.0.into()
    }
}

#[cfg(test)]
mod tests;
