use super::scrollbar::{answer, on_track, scrolls};
use super::*;
use crate::time::Duration;
use herdr_protocol::PaneSurfaceScrollMetrics;

/// One pane over the whole 80-column grid, 4 rows tall, with herdr's
/// scrollbar column (79) kept beside 79 columns of text.
fn edge(offset: u64, max: u64) -> PaneSurfaceFrame {
    let mut shown = surface("$ ls", false);
    let pane = &mut shown.panes[0];
    pane.inner_rect.width = 79;
    pane.scrollbar_rect = (max > 0).then_some(SurfaceRect {
        x: 79,
        y: 0,
        width: 1,
        height: 4,
    });
    pane.scroll = Some(PaneSurfaceScrollMetrics {
        offset_from_bottom: offset,
        max_offset_from_bottom: max,
        viewport_rows: 4,
    });
    shown
}

fn redraw(cx: &mut VisualTestContext) {
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear(cx);
    });
}

fn show(view: &gpui::Entity<PaneView>, cx: &mut VisualTestContext, shown: PaneSurfaceFrame) {
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            view.set_surface(Some(Arc::new(shown)), Arc::default(), Some("p".into()), cx)
        })
    });
    redraw(cx);
}

fn reported_columns(events: &Events) -> Vec<u16> {
    events
        .borrow()
        .iter()
        .filter_map(|event| match event {
            PaneViewEvent::Resize { size, .. } => Some(size.cols),
            _ => None,
        })
        .collect()
}

#[gpui::test]
fn the_grid_takes_one_column_under_the_strip_while_herdr_keeps_one(cx: &mut TestAppContext) {
    let (view, cx, events) = view(cx, edge(0, 96));
    cx.update(|_, cx| view.update(cx, |view, cx| view.reset_reported_size(cx)));
    redraw(cx);
    let (width, cell_width) = view.read_with(cx, |view, _| {
        (f32::from(view.bounds.size.width), view.cell_width)
    });
    let strip = (14f32).max(cell_width.ceil());
    let with_strip = ((width - strip) / cell_width).floor() as u16 + 1;
    let full = (width / cell_width).floor() as u16;
    assert_eq!(reported_columns(&events).last(), Some(&with_strip));
    // The alternate screen has no column, but says nothing of the others.
    let mut fullscreen = surface("vim", false);
    fullscreen.panes[0].alternate_screen_active = true;
    show(&view, cx, fullscreen);
    assert_eq!(reported_columns(&events).last(), Some(&with_strip));
    // Herdr configured without scrollbars keeps no column: the grid fills the view.
    show(&view, cx, surface("$ ", false));
    assert_eq!(reported_columns(&events).last(), Some(&full));
}

#[gpui::test]
fn the_strip_covers_herdrs_column_with_buttons_track_and_thumb(cx: &mut TestAppContext) {
    let (view, cx, _) = view(cx, edge(0, 96));
    let (strips, cell_width) = view.read_with(cx, |view, _| (view.strips(), view.cell_width));
    let [strip] = &strips[..] else {
        panic!("one strip: {strips:?}");
    };
    let side = (14f32).max(cell_width.ceil());
    assert_eq!(strip.bounds.left(), px(79. * cell_width));
    assert_eq!(strip.bounds.size.width, px(side));
    assert_eq!((strip.up.top(), strip.up.size.height), (px(0.), px(side)));
    assert_eq!(strip.down.bottom(), px(4. * CELL_HEIGHT));
    let Some(bar) = strip.bar else {
        panic!("a thumb with scrollback");
    };
    // A 24 px thumb at the bottom of the track between the buttons.
    assert_eq!(bar.thumb.bottom(), strip.down.top());
    assert_eq!(bar.thumb.size.height, px(24.));
    // The fullscreen app gets the column back, and the strip goes.
    let mut fullscreen = edge(0, 0);
    fullscreen.panes[0].inner_rect.width = 80;
    fullscreen.panes[0].alternate_screen_active = true;
    show(&view, cx, fullscreen);
    assert!(view.read_with(cx, |view, _| view.strips().is_empty()));
}

#[gpui::test]
fn a_track_press_pages_toward_the_pointer_while_held(cx: &mut TestAppContext) {
    let (view, cx, events) = view(cx, edge(0, 96));
    events.borrow_mut().clear();
    // Above the thumb: a page (3 of the 4 rows) back into the history at once,
    // then again every 50 ms after 400 ms, waiting behind the request in flight.
    let at = on_track(&view, cx, 20.);
    cx.simulate_mouse_down(at, MouseButton::Left, Modifiers::default());
    assert_eq!(scrolls(&events), [(1, 3)]);
    cx.executor().advance_clock(Duration::from_millis(400));
    cx.run_until_parked();
    cx.executor().advance_clock(Duration::from_millis(50));
    cx.run_until_parked();
    assert_eq!(scrolls(&events).len(), 1);
    answer(&view, cx, 1);
    assert_eq!(scrolls(&events), [(1, 3), (2, 9)]);
    cx.simulate_mouse_up(at, MouseButton::Left, Modifiers::default());
    answer(&view, cx, 2);
    cx.executor().advance_clock(Duration::from_millis(500));
    cx.run_until_parked();
    assert_eq!(scrolls(&events).len(), 2, "released, it stops");
    assert!(inputs(&events).is_empty());
}

#[gpui::test]
fn the_buttons_step_a_line_and_shift_jumps(cx: &mut TestAppContext) {
    let (view, cx, events) = view(cx, edge(0, 96));
    events.borrow_mut().clear();
    // At the bottom already, the down button has nothing to do.
    let down = on_track(&view, cx, 4. * CELL_HEIGHT - 4.);
    cx.simulate_mouse_down(down, MouseButton::Left, Modifiers::default());
    cx.simulate_mouse_up(down, MouseButton::Left, Modifiers::default());
    assert!(scrolls(&events).is_empty());
    let up = on_track(&view, cx, 4.);
    cx.simulate_mouse_down(up, MouseButton::Left, Modifiers::default());
    cx.simulate_mouse_up(up, MouseButton::Left, Modifiers::default());
    assert_eq!(scrolls(&events), [(1, 1)]);
    answer(&view, cx, 1);
    // Shift+press on the track centers the thumb under the pointer.
    let jump = on_track(&view, cx, 20.);
    cx.simulate_mouse_down(jump, MouseButton::Left, Modifiers::shift());
    cx.simulate_mouse_up(jump, MouseButton::Left, Modifiers::default());
    assert_eq!(scrolls(&events), [(1, 1), (2, 96)]);
}

#[gpui::test]
fn without_scrollback_the_strip_stays_and_keeps_its_presses(cx: &mut TestAppContext) {
    let (view, cx, events) = view(cx, edge(0, 0));
    let strips = view.read_with(cx, |view, _| view.strips());
    assert!(matches!(&strips[..], [strip] if strip.bar.is_none()));
    events.borrow_mut().clear();
    let at = on_track(&view, cx, 30.);
    cx.simulate_mouse_down(at, MouseButton::Left, Modifiers::default());
    cx.simulate_mouse_up(at, MouseButton::Left, Modifiers::default());
    assert!(scrolls(&events).is_empty());
    assert!(inputs(&events).is_empty());
    assert!(view.read_with(cx, |view, _| view.selection.is_none()));
}
