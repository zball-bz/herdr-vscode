#![allow(clippy::unwrap_used)]
use super::*;
use herdr_protocol::*;
use std::ops::Range;

fn frame(text: &str, width: u16, height: u16) -> FrameData {
    let mut symbols = text.chars();
    FrameData {
        width,
        height,
        cells: (0..usize::from(width) * usize::from(height))
            .map(|_| CellData {
                symbol: symbols.next().unwrap_or(' ').to_string(),
                fg: 0,
                bg: 0,
                modifier: 0,
                skip: false,
                hyperlink: None,
            })
            .collect(),
        cursor: None,
        hyperlinks: vec![],
        graphics: vec![],
    }
}

fn surface(text: &str) -> PaneSurfaceFrame {
    let rect = SurfaceRect {
        x: 0,
        y: 0,
        width: 80,
        height: 4,
    };
    PaneSurfaceFrame {
        boot_id: "boot".into(),
        projection_revision: 1,
        surface_revision: 1,
        frame: frame(text, 80, 4),
        splits: vec![],
        popup: None,
        graphics: Default::default(),
        panes: vec![PaneSurfacePane {
            pane_id: "pane".into(),
            content_revision: 1,
            rect,
            inner_rect: rect,
            scrollbar_rect: None,
            scroll: None,
            focused: true,
            mouse_reporting: false,
            sgr_pixel_mouse: false,
            alternate_screen_active: false,
            pixel_width: 800,
            pixel_height: 80,
        }],
    }
}

#[test]
fn explicit_links_validate_destination_and_support_wide_cells() {
    let mut s = surface("界 ");
    s.frame.hyperlinks = vec!["https://example.com/docs?q=one#two".into()];
    s.frame.cells[0].hyperlink = Some(0);
    s.frame.cells[1].skip = true;
    for x in [1., 11.] {
        assert_eq!(
            link_at(&s, x, 1., 10., 20.).as_deref(),
            Some("https://example.com/docs?q=one#two")
        );
    }
    for invalid in [
        "file:///tmp/a",
        "javascript:alert(1)",
        "data:text/html,test",
        "mailto:a@example.com",
        "https://",
        "https://example.com/\nnext",
        "https://example.com/a b",
    ] {
        s.frame.hyperlinks[0] = invalid.into();
        assert!(link_at(&s, 1., 1., 10., 20.).is_none(), "{invalid}");
    }
    s.frame.hyperlinks[0] = "https://example.com".into();
    s.frame.cells[0].modifier = HIDDEN;
    assert!(link_at(&s, 1., 1., 10., 20.).is_none());
    assert!(web_url(&format!("https://example.com/{}", "a".repeat(8192))).is_none());
}

#[test]
fn plain_urls_trim_prose_preserve_balanced_paths_and_keep_hit_ranges() {
    for (text, expected) in [
        (
            "See (https://example.com/docs). next",
            "https://example.com/docs",
        ),
        ("https://example.com/a_(b)", "https://example.com/a_(b)"),
        (
            "https://example.com/?q=yes#section",
            "https://example.com/?q=yes#section",
        ),
        ("http://localhost:3000/path", "http://localhost:3000/path"),
    ] {
        let s = surface(text);
        let start = text.find("http").unwrap();
        assert_eq!(
            link_at(&s, start as f32 * 10. + 1., 1., 10., 20.).as_deref(),
            Some(expected)
        );
        assert!(link_at(&s, 791., 1., 10., 20.).is_none());
    }
    let s = surface("https://one.test https://two.test");
    assert_eq!(
        link_at(&s, 181., 1., 10., 20.).as_deref(),
        Some("https://two.test/")
    );
    let mut s = surface("https://example.com");
    s.frame.cells[0].hyperlink = Some(0);
    s.frame.hyperlinks = vec!["file:///tmp/no".into()];
    assert!(link_at(&s, 1., 1., 10., 20.).is_none());
    s.frame.cells[0].hyperlink = Some(99);
    assert!(link_at(&s, 1., 1., 10., 20.).is_none());
}

#[test]
fn geometry_is_bounded_and_popup_blocks_underlying_links() {
    let mut s = surface("https://example.com");
    for (x, y, w, h) in [
        (-1., 1., 10., 20.),
        (800., 1., 10., 20.),
        (1., 80., 10., 20.),
        (f32::NAN, 1., 10., 20.),
        (1., 1., 0., 20.),
    ] {
        assert!(link_at(&s, x, y, w, h).is_none());
    }
    s.panes[0].inner_rect.x = 20;
    s.panes[0].inner_rect.width = 60;
    assert!(link_at(&s, 1., 1., 10., 20.).is_none());
    s.popup = Some(Box::new(ClientShellPopupSurface {
        terminal_id: "popup".into(),
        title: String::new(),
        width: None,
        height: None,
        frame: frame("https://popup.test", 20, 2),
        mouse_reporting: false,
        sgr_pixel_mouse: false,
        pixel_width: 200,
        pixel_height: 40,
    }));
    assert!(link_at(&s, 1., 1., 10., 20.).is_none());
    assert_eq!(
        link_at(&s, 301., 21., 10., 20.).as_deref(),
        Some("https://popup.test/")
    );
    s.popup.as_mut().unwrap().frame.cells[0].symbol = "a".repeat(MAX_ROW_BYTES + 1);
    assert!(link_at(&s, 301., 21., 10., 20.).is_none());
}

#[test]
fn plain_links_do_not_cross_panes_or_guess_wrapped_destinations() {
    let mut s = surface("https://example.com");
    s.panes[0].inner_rect.width = 12;
    assert!(link_at(&s, 1., 1., 10., 20.).is_none());
    let wrapped = frame("https://example.com/long", 12, 2);
    assert!(frame_link(&wrapped, 0, 0, 0, 12).is_none());
    for punctuation in ['.', ',', ';', ':', '!', '?', ')', ']', '}'] {
        let text = format!("https://example{punctuation}com/path");
        let wrapped = frame(&text, 16, 2);
        assert!(frame_link(&wrapped, 0, 0, 0, 16).is_none(), "{text}");
        let mut s = surface(&text);
        s.panes[0].inner_rect.width = 16;
        assert!(link_at(&s, 1., 1., 10., 20.).is_none(), "{text}");
    }
    let unicode = frame("界 https://example.com ", 40, 1);
    assert_eq!(
        frame_link(&unicode, 3, 0, 0, 40),
        Some(RowLink {
            target: RowTarget::Web("https://example.com/".into()),
            row: 0,
            columns: 2..21,
        })
    );
}

mod paths;
