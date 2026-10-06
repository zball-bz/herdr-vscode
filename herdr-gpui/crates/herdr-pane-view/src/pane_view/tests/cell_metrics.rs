use super::*;
use crate::terminal_painter::snap_to_device;

/// `length` in device pixels at `scale`.
fn device(length: f32, scale: f32) -> f32 {
    length * scale
}

fn assert_whole(device_pixels: f32, expected: f32) {
    assert!(
        (device_pixels - expected).abs() < 1e-3,
        "{device_pixels} device pixels, expected {expected}"
    );
}

#[test]
fn lengths_snap_to_whole_device_pixels() {
    // At 175% a 7 px advance spans 12.25 device pixels; cells take 12, so each
    // column starts on a device pixel and draws its glyph at the same phase.
    assert_whole(device(snap_to_device(7., 1.75), 1.75), 12.);
    assert_whole(device(snap_to_device(22., 1.75), 1.75), 39.);
    assert_whole(device(snap_to_device(7., 1.45), 1.45), 10.);
    assert_whole(snap_to_device(8.4, 1.), 8.);
    assert_whole(snap_to_device(7., 2.), 7.);
    // Never under one device pixel; untouched without a usable scale.
    assert_whole(snap_to_device(0.2, 1.), 1.);
    assert_whole(snap_to_device(7.3, 0.), 7.3);
}

#[gpui::test]
fn the_grid_is_measured_in_whole_device_pixels(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(|_, cx| {
        PaneView::new(
            PaneViewStyle {
                cell_height: 20.3,
                ..style()
            },
            cx,
        )
    });
    let scale = cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear(cx);
        window.scale_factor()
    });
    let (cell_width, cell_height) =
        view.read_with(cx, |view, _| (view.cell_width, view.cell_height()));
    assert_whole(device(cell_width, scale), device(cell_width, scale).round());
    // The style's 20.3 px rows are 40.6 device pixels at the test window's 2x.
    assert_eq!(scale, 2.);
    assert_whole(device(cell_height, scale), 41.);
}
