use super::*;
use herdr_protocol::ClientMousePosition;

/// `view` with `padding_left`, drawn again and with its events cleared.
fn padded(
    view: &gpui::Entity<PaneView>,
    cx: &mut VisualTestContext,
    events: &Events,
    padding_left: f32,
) {
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.set_style(
                PaneViewStyle {
                    padding_left,
                    ..style()
                },
                cx,
            );
        });
        window.refresh();
        window.draw(cx).clear(cx);
    });
    events.borrow_mut().clear();
}

#[gpui::test]
fn the_grid_starts_after_the_padding_on_a_device_pixel(cx: &mut TestAppContext) {
    let (view, cx, events) = view(cx, surface("$ ", false));
    // The grid, which `layout` measures and reports, is the view less the padding.
    let (left, width) = view.read_with(cx, |view, _| (view.bounds.left(), view.bounds.size.width));
    padded(&view, cx, &events, 4.3);
    // 4.3 px is 8.6 device pixels at the test window's 2x; the grid takes 9.
    let (padded_left, padded_width, padding) = view.read_with(cx, |view, _| {
        (
            view.bounds.left(),
            view.bounds.size.width,
            view.padding_left(),
        )
    });
    assert_eq!(padding, 4.5);
    assert_eq!(padded_left, left + px(4.5));
    assert_eq!(padded_width, width - px(4.5));
}

#[gpui::test]
fn a_selection_can_start_in_the_padding(cx: &mut TestAppContext) {
    let (view, cx, events) = view(cx, surface("hello world", false));
    padded(&view, cx, &events, 6.);
    let start = view.read_with(cx, |view, _| view.bounds.origin) + point(px(-3.), px(10.));
    let end = cell(&view, cx, 4., 0.) + point(px(3.), px(0.));
    cx.simulate_mouse_down(start, MouseButton::Left, Modifiers::default());
    cx.simulate_mouse_move(end, MouseButton::Left, Modifiers::default());
    cx.simulate_mouse_up(end, MouseButton::Left, Modifiers::default());
    cx.simulate_keystrokes("ctrl-c");
    assert_eq!(
        events.borrow().last(),
        Some(&PaneViewEvent::Copy("hello".into()))
    );
}

#[gpui::test]
fn a_click_in_the_padding_reaches_the_app_at_the_first_column(cx: &mut TestAppContext) {
    let (view, cx, events) = view(cx, surface("app", true));
    padded(&view, cx, &events, 6.);
    let at = view.read_with(cx, |view, _| view.bounds.origin) + point(px(-3.), px(30.));
    cx.simulate_click(at, Modifiers::default());
    let positions: Vec<_> = inputs(&events)
        .into_iter()
        .filter_map(|event| match event {
            ClientPaneInputEvent::Mouse { position, .. } => Some(position),
            _ => None,
        })
        .collect();
    assert_eq!(
        positions,
        [
            ClientMousePosition::Cell { column: 0, row: 1 },
            ClientMousePosition::Cell { column: 0, row: 1 }
        ]
    );
}
