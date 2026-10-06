use super::*;

/// 4 rows of 96 lines of scrollback, with Herdr's scrollbar column at 79 and
/// one more grid column beyond, as beside a split: the thin thumb, no strip.
fn scrolled(offset: u64) -> PaneSurfaceFrame {
    let mut shown = surface("$ ls", false);
    let pane = &mut shown.panes[0];
    pane.rect.width = 79;
    pane.inner_rect.width = 79;
    pane.scrollbar_rect = Some(SurfaceRect {
        x: 79,
        y: 0,
        width: 1,
        height: 4,
    });
    pane.scroll = Some(herdr_protocol::PaneSurfaceScrollMetrics {
        offset_from_bottom: offset,
        max_offset_from_bottom: 96,
        viewport_rows: 4,
    });
    shown
}

/// Every `pane.scroll` request, as (token, offset from the bottom).
pub(super) fn scrolls(events: &Events) -> Vec<(u64, u64)> {
    events
        .borrow()
        .iter()
        .filter_map(|event| match event {
            PaneViewEvent::Request {
                token,
                method: "pane.scroll",
                params,
            } => {
                assert_eq!(params["pane_id"], "p");
                Some((*token, params["offset_from_bottom"].as_u64()?))
            }
            _ => None,
        })
        .collect()
}

/// A point in the scrollbar column, `y` pixels from the grid's top.
pub(super) fn on_track(
    view: &gpui::Entity<PaneView>,
    cx: &mut VisualTestContext,
    y: f32,
) -> Point<Pixels> {
    let x = cell(view, cx, 79., 0.).x;
    view.read_with(cx, |view, _| point(x, view.bounds.origin.y + px(y)))
}

pub(super) fn answer(view: &gpui::Entity<PaneView>, cx: &mut VisualTestContext, token: u64) {
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            view.answer(token, Err(RequestFailure::Client("closed".into())), cx)
        })
    });
}

#[gpui::test]
fn a_shift_press_jumps_and_a_drag_sends_only_the_latest_offset(cx: &mut TestAppContext) {
    let (view, cx, events) = view(cx, scrolled(0));
    events.borrow_mut().clear();
    // The 80 px track holds a 24 px thumb at the bottom; a Shift+press near
    // the top centers the thumb under the pointer, clamped to the oldest line.
    let at = on_track(&view, cx, 5.);
    cx.simulate_mouse_down(at, MouseButton::Left, Modifiers::shift());
    assert_eq!(scrolls(&events), [(1, 96)]);
    assert_eq!(
        view.read_with(cx, |view, _| view.active_scrollbar().map(str::to_owned)),
        Some("p".into())
    );
    // Moves while the first request is in flight replace each other.
    let at = on_track(&view, cx, 40.);
    cx.simulate_mouse_move(at, MouseButton::Left, Modifiers::default());
    let at = on_track(&view, cx, 50.);
    cx.simulate_mouse_move(at, MouseButton::Left, Modifiers::default());
    assert_eq!(scrolls(&events).len(), 1);
    answer(&view, cx, 1);
    // Thumb top 50 - 12 = 38 of 56 px of travel: 32% of the way up.
    assert_eq!(scrolls(&events), [(1, 96), (2, 31)]);
    let at = on_track(&view, cx, 50.);
    cx.simulate_mouse_up(at, MouseButton::Left, Modifiers::default());
    answer(&view, cx, 2);
    assert_eq!(scrolls(&events).len(), 2);
    assert!(view.read_with(cx, |view, _| view.scroll_gesture.is_none()));
    assert!(
        inputs(&events).is_empty(),
        "the drag never reaches the pane"
    );
    assert!(view.read_with(cx, |view, _| view.selection.is_none()));
}

#[gpui::test]
fn a_thumb_press_keeps_the_grab_point(cx: &mut TestAppContext) {
    let (view, cx, events) = view(cx, scrolled(0));
    events.borrow_mut().clear();
    // The thumb spans 56..80 px; grabbing it 4 px down leaves it in place.
    let at = on_track(&view, cx, 60.);
    cx.simulate_mouse_down(at, MouseButton::Left, Modifiers::default());
    assert_eq!(scrolls(&events), [(1, 0)]);
    answer(&view, cx, 1);
    // Dragging up 28 px moves the thumb's top to 28: half of the travel.
    let at = on_track(&view, cx, 32.);
    cx.simulate_mouse_move(at, MouseButton::Left, Modifiers::default());
    assert_eq!(scrolls(&events), [(1, 0), (2, 48)]);
}

#[gpui::test]
fn no_scrollback_or_an_open_popup_leaves_the_column_alone(cx: &mut TestAppContext) {
    let mut bottomless = scrolled(0);
    if let Some(scroll) = &mut bottomless.panes[0].scroll {
        scroll.max_offset_from_bottom = 0;
    }
    let mut covered = scrolled(0);
    covered.popup = Some(Box::new(ClientShellPopupSurface {
        terminal_id: "term".into(),
        title: "popup".into(),
        width: None,
        height: None,
        frame: frame("", 20, 2),
        mouse_reporting: false,
        sgr_pixel_mouse: false,
        pixel_width: 200,
        pixel_height: 40,
    }));
    for shown in [bottomless, covered] {
        let (view, cx, events) = view(cx, shown);
        events.borrow_mut().clear();
        let at = on_track(&view, cx, 5.);
        cx.simulate_mouse_down(at, MouseButton::Left, Modifiers::default());
        assert!(scrolls(&events).is_empty());
        assert!(view.read_with(cx, |view, _| view.active_scrollbar().is_none()));
    }
}
