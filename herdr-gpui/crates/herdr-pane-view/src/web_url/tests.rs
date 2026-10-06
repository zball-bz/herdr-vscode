#![allow(clippy::unwrap_used)]
use super::*;

#[test]
fn only_bounded_web_addresses_with_a_host_are_accepted() {
    for valid in [
        "http://localhost:3000/",
        "https://example.com/a?b#c",
        "https://[::1]:8080/",
    ] {
        assert!(WebUrl::try_from(valid).is_ok(), "{valid}");
    }
    for invalid in [
        "file:///etc/passwd",
        "javascript:alert(1)",
        "data:text/html,hi",
        "vscode://open",
        "https://",
        "https://a.test/\nb",
        "https://a.test/ b",
        "not a url",
    ] {
        assert!(
            matches!(WebUrl::try_from(invalid), Err(Error::InvalidBrowserUrl)),
            "{invalid}"
        );
    }
    let long = format!("https://a.test/{}", "x".repeat(MAX_URL_BYTES));
    assert!(WebUrl::try_from(long.as_str()).is_err());
}

#[test]
fn typed_addresses_gain_a_scheme() {
    let typed = |text| WebUrl::from_typed(text).map(|url| url.as_str().to_owned());
    assert_eq!(typed("localhost:3000").unwrap(), "http://localhost:3000/");
    assert_eq!(typed("app.localhost/x").unwrap(), "http://app.localhost/x");
    assert_eq!(
        typed(" example.com/docs ").unwrap(),
        "https://example.com/docs"
    );
    assert_eq!(typed("http://a.test").unwrap(), "http://a.test/");
    assert!(typed("file:///etc/passwd").is_err());
    assert!(typed("ftp://a.test").is_err());
    assert!(typed("").is_err());
}

#[test]
fn saved_addresses_are_validated_when_read() {
    assert!(serde_json::from_str::<WebUrl>(r#""https://a.test/""#).is_ok());
    assert!(serde_json::from_str::<WebUrl>(r#""file:///etc/passwd""#).is_err());
}
