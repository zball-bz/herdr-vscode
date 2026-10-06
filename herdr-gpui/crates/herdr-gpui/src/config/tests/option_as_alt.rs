#[test]
fn option_as_alt_follows_the_layout_only_on_macos() {
    use crate::config::OptionAsAlt;
    let us = "com.apple.keylayout.US";
    let german = "com.apple.keylayout.German";
    let macos = cfg!(target_os = "macos");
    assert!(OptionAsAlt::Auto.sends_alt(us));
    assert!(OptionAsAlt::Auto.sends_alt("com.apple.keylayout.ABC"));
    assert_eq!(OptionAsAlt::Auto.sends_alt(german), !macos);
    assert!(OptionAsAlt::Always.sends_alt(german));
    assert_eq!(OptionAsAlt::Never.sends_alt(us), !macos);
}
