//! The scrollbar strip on the view's right edge, drawn as a desktop scrollbar
//! (Konsole, Qt, Chrome): a line-step button at each end, a track, a thumb.
//!
//! Herdr reserves a one-cell scrollbar column at a pane's right edge (outside
//! the alternate screen, which gets it back), too narrow to grab comfortably.
//! Where that column is the grid's last, the view reports one column more than
//! fits beside a strip, so the column lies under the strip, which replaces the
//! thin thumb otherwise painted inside it. With nothing to scroll the strip
//! stays, without a thumb, as desktop scrollbars do. Panes off the right edge
//! of a split keep the thin thumb.

use crate::terminal::Scrollbar;
use crate::theme::{Theme, mix};
use gpui::{Bounds, Path, Pixels, Point, Size, Window, fill, point, px, rgb, rgba, size};
use herdr_protocol::{PaneSurfaceFrame, PaneSurfacePane, PaneSurfaceScrollMetrics, SurfaceRect};

/// The strip's width, as VS Code and desktop toolkits draw scrollbars; never
/// narrower than the cell it covers.
const STRIP_WIDTH: f32 = 14.;
/// The thumb keeps this far off the strip's sides.
const THUMB_INSET: f32 = 3.;

pub(super) fn strip_width(cell_width: f32) -> f32 {
    STRIP_WIDTH.max(cell_width.ceil())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum StripPart {
    Up,
    Down,
    Track,
    Thumb,
}

/// One pane's strip, in view-local pixels.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct Strip {
    pub(super) pane_id: String,
    pub(super) bounds: Bounds<Pixels>,
    pub(super) up: Bounds<Pixels>,
    pub(super) down: Bounds<Pixels>,
    pub(super) track: Bounds<Pixels>,
    /// The thumb along the track; none without scrollback.
    pub(super) bar: Option<Scrollbar>,
    pub(super) scroll: Option<PaneSurfaceScrollMetrics>,
}

impl Strip {
    pub(super) fn part_at(&self, local: Point<Pixels>) -> Option<StripPart> {
        if !self.bounds.contains(&local) {
            return None;
        }
        Some(if self.up.contains(&local) {
            StripPart::Up
        } else if self.down.contains(&local) {
            StripPart::Down
        } else if self
            .bar
            .is_some_and(|bar| thumb_bounds(&bar).contains(&local))
        {
            StripPart::Thumb
        } else {
            StripPart::Track
        })
    }
}

/// The thumb as painted and hit: the bar's span, inset from the strip's sides.
fn thumb_bounds(bar: &Scrollbar) -> Bounds<Pixels> {
    let inset = px(THUMB_INSET
        .min((f32::from(bar.track.size.width) - 2.) / 2.)
        .max(0.));
    Bounds::from_corners(
        point(bar.thumb.left() + inset, bar.thumb.top() + px(1.)),
        point(bar.thumb.right() - inset, bar.thumb.bottom() - px(1.)),
    )
}

fn right(rect: SurfaceRect) -> u32 {
    u32::from(rect.x) + u32::from(rect.width)
}

/// The column herdr keeps for `pane`'s scrollbar when it is the grid's last.
fn edge_column(pane: &PaneSurfacePane, frame_width: u16) -> Option<SurfaceRect> {
    let (rect, inner) = (pane.rect, pane.inner_rect);
    if right(rect) != u32::from(frame_width) || right(inner) >= right(rect) || rect.height == 0 {
        return None;
    }
    Some(SurfaceRect {
        x: inner.x.saturating_add(inner.width),
        y: rect.y,
        // Both rights fit a `u16` grid, and the inner one is the smaller.
        width: u16::try_from(right(rect) - right(inner)).unwrap_or(u16::MAX),
        height: rect.height,
    })
}

/// Whether herdr keeps a scrollbar column at the grid's edge, for a strip to
/// cover; `None` while only the alternate screen, which never has one, shows.
pub(super) fn reserves_edge_column(surface: &PaneSurfaceFrame) -> Option<bool> {
    let width = surface.frame.width;
    let mut edge = surface
        .panes
        .iter()
        .filter(|pane| right(pane.rect) == u32::from(width) && !pane.alternate_screen_active)
        .peekable();
    edge.peek()?;
    Some(edge.any(|pane| edge_column(pane, width).is_some()))
}

/// Strips for the panes whose scrollbar column is the grid's last. A strip
/// starts at that column and reaches the view's edge when the grid fills the
/// view; the bottom pane's strip also takes the rows' leftover pixels below.
pub(super) fn strips(
    surface: &PaneSurfaceFrame,
    view: Size<Pixels>,
    cell_width: f32,
    cell_height: f32,
) -> Vec<Strip> {
    let width = strip_width(cell_width);
    let (view_width, view_height) = (f32::from(view.width), f32::from(view.height));
    surface
        .panes
        .iter()
        .filter_map(|pane| {
            let rect = edge_column(pane, surface.frame.width)?;
            let left = f32::from(rect.x) * cell_width;
            let room = view_width - left;
            let right = if room >= width && room < width + cell_width {
                view_width
            } else {
                left + width
            };
            let top = f32::from(rect.y) * cell_height;
            let rows_end = (f32::from(rect.y) + f32::from(rect.height)) * cell_height;
            let last_row =
                u32::from(rect.y) + u32::from(rect.height) == u32::from(surface.frame.height);
            let bottom =
                if last_row && view_height >= rows_end && view_height - rows_end < cell_height {
                    view_height
                } else {
                    rows_end
                };
            let side = right - left;
            // Buttons only where they leave a track at least as long.
            let button = if bottom - top >= side * 3. { side } else { 0. };
            let track = Bounds::from_corners(
                point(px(left), px(top + button)),
                point(px(right), px(bottom - button)),
            );
            Some(Strip {
                pane_id: pane.pane_id.clone(),
                bounds: Bounds::from_corners(
                    point(px(left), px(top)),
                    point(px(right), px(bottom)),
                ),
                up: Bounds::new(point(px(left), px(top)), size(px(side), px(button))),
                down: Bounds::new(
                    point(px(left), px(bottom - button)),
                    size(px(side), px(button)),
                ),
                track,
                bar: pane
                    .scroll
                    .and_then(|scroll| Scrollbar::on_track(track, scroll)),
                scroll: pane.scroll,
            })
        })
        .collect()
}

/// Strip colors from the terminal theme, like a toolkit's on that background.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct StripColors {
    track: u32,
    edge: u32,
    thumb: u32,
    thumb_hover: u32,
    thumb_active: u32,
    button_hover: u32,
    arrow: u32,
    arrow_disabled: u32,
}

impl StripColors {
    pub(super) fn new(theme: &Theme) -> Self {
        let tint = |percent| mix(theme.background, theme.foreground, percent);
        Self {
            track: tint(4),
            edge: tint(10),
            thumb: tint(28),
            thumb_hover: tint(42),
            thumb_active: tint(56),
            button_hover: tint(12),
            arrow: tint(60),
            arrow_disabled: tint(25),
        }
    }
}

/// How the pointer is on a strip: over a part, or holding one.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) struct StripState {
    pub(super) hovered: Option<StripPart>,
    pub(super) pressed: Option<StripPart>,
}

fn triangle(center: Point<Pixels>, half_width: f32, half_height: f32, up: bool) -> Path<Pixels> {
    let (tip, base) = if up {
        (-half_height, half_height)
    } else {
        (half_height, -half_height)
    };
    let mut path = Path::new(center + point(px(-half_width), px(base)));
    path.line_to(center + point(px(half_width), px(base)));
    path.line_to(center + point(px(0.), px(tip)));
    path
}

pub(super) fn paint(
    strip: &Strip,
    origin: Point<Pixels>,
    colors: StripColors,
    state: StripState,
    window: &mut Window,
) {
    let at = |bounds: Bounds<Pixels>| Bounds::new(bounds.origin + origin, bounds.size);
    window.paint_quad(fill(at(strip.bounds), rgb(colors.track)));
    window.paint_quad(fill(
        Bounds::new(
            at(strip.bounds).origin,
            size(px(1.), strip.bounds.size.height),
        ),
        rgb(colors.edge),
    ));
    let enabled = strip.bar.is_some();
    for (part, bounds, up) in [
        (StripPart::Up, strip.up, true),
        (StripPart::Down, strip.down, false),
    ] {
        if bounds.size.height <= px(0.) {
            continue;
        }
        if enabled && (state.pressed == Some(part) || state.hovered == Some(part)) {
            window.paint_quad(fill(at(bounds), rgb(colors.button_hover)));
        }
        let side = f32::from(bounds.size.width);
        let color = if enabled {
            colors.arrow
        } else {
            colors.arrow_disabled
        };
        window.paint_path(
            triangle(at(bounds).center(), side * 0.22, side * 0.13, up),
            rgba((color << 8) | 0xff),
        );
    }
    if let Some(bar) = &strip.bar {
        let color = match (state.pressed, state.hovered) {
            (Some(StripPart::Thumb), _) => colors.thumb_active,
            (_, Some(StripPart::Thumb)) => colors.thumb_hover,
            _ => colors.thumb,
        };
        let thumb = at(thumb_bounds(bar));
        let radius = thumb.size.width.min(px(8.)) / 2.;
        window.paint_quad(fill(thumb, rgb(color)).corner_radii(radius));
    }
}
