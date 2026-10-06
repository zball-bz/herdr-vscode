//! Link clicks through the window: modifier handling under mouse reporting,
//! and dispatch fenced by menus and surface revisions.
use herdr_client::protocol::{CellData, FrameData, PaneSurfaceFrame, PaneSurfacePane, SurfaceRect};
use std::sync::Arc;

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

#[gpui::test]
fn link_modifier_click_bypasses_mouse_reporting_only_on_links(cx: &mut gpui::TestAppContext) {
    use gpui::{Modifiers, point, px};
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = crate::sidebar::layout_tests::fixture_window(window, cx);
        let mut s = surface("https://example.com/app plain");
        s.panes[0].mouse_reporting = true;
        let snapshot = view.live.snapshot.as_ref().unwrap();
        s.boot_id = snapshot.boot_id.clone();
        s.projection_revision = snapshot.revision;
        view.live.surface = Some(Arc::new(s));
        view
    });
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear(cx);
    });
    let origin = view.read_with(cx, |view, _| view.bounds.origin);
    let link = origin + point(px(1.), px(1.));
    let plain = origin + point(px(251.), px(1.));
    cx.simulate_click(link, Modifiers::default());
    assert!(cx.opened_url().is_none());
    view.read_with(cx, |view, _| {
        assert!(!view.terminal_link_hovered(link, Modifiers::default()));
        assert!(view.terminal_link_hovered(link, Modifiers::secondary_key()));
        assert!(!view.terminal_link_hovered(plain, Modifiers::secondary_key()));
        assert!(!view.link_modifier_held(plain, Modifiers::secondary_key()));
    });
    cx.simulate_click(link, Modifiers::secondary_key());
    assert_eq!(cx.opened_url().as_deref(), Some("https://example.com/app"));
}

#[gpui::test]
fn click_dispatch_opens_browser_and_respects_menu_and_revision(cx: &mut gpui::TestAppContext) {
    use gpui::{point, px};
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = crate::sidebar::layout_tests::fixture_window(window, cx);
        let mut s = surface("https://example.com/click");
        let snapshot = view.live.snapshot.as_ref().unwrap();
        s.boot_id = snapshot.boot_id.clone();
        s.projection_revision = snapshot.revision;
        view.live.surface = Some(Arc::new(s));
        view
    });
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear(cx);
    });
    let position = view.read_with(cx, |view, _| view.bounds.origin + point(px(1.), px(1.)));
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            let mut event = gpui::MouseClickEvent::default();
            event.down.position = position;
            event.up.position = position + point(px(20.), px(0.));
            event.down.click_count = 1;
            view.pressed_terminal_link = Some(crate::window::PressedLink {
                url: Some("https://example.com/click".into()),
                cell: None,
                file: None,
                position,
            });
            view.open_terminal_link(&gpui::ClickEvent::Mouse(event.clone()), window, cx);
            event.up.position = position;
            view.pressed_terminal_link = Some(crate::window::PressedLink {
                url: Some("https://different.example/".into()),
                cell: None,
                file: None,
                position,
            });
            view.open_terminal_link(&gpui::ClickEvent::Mouse(event), window, cx);
        })
    });
    assert!(cx.opened_url().is_none());
    for away in [
        position + point(px(20.), px(0.)),
        position + point(px(0.), px(20.)),
        position - point(px(20.), px(20.)),
    ] {
        cx.simulate_mouse_down(position, gpui::MouseButton::Left, Default::default());
        cx.simulate_mouse_move(away, gpui::MouseButton::Left, Default::default());
        cx.simulate_mouse_move(position, gpui::MouseButton::Left, Default::default());
        cx.simulate_mouse_up(position, gpui::MouseButton::Left, Default::default());
        assert!(cx.opened_url().is_none());
        view.read_with(cx, |view, _| assert!(view.pressed_terminal_link.is_none()));
    }
    cx.simulate_click(position, Default::default());
    assert_eq!(
        cx.opened_url().as_deref(),
        Some("https://example.com/click")
    );
    view.update(cx, |view, _| {
        assert!(view.pending_navigation.is_none());
        assert!(view.pressed_terminal_link.is_none());
        view.menu.page = Some(crate::menu::Page::Menu);
        assert!(view.terminal_link_at(position).is_none());
        view.menu.page = None;
        Arc::make_mut(view.live.surface.as_mut().unwrap()).projection_revision += 1;
        assert!(view.terminal_link_at(position).is_none());
    });
}
