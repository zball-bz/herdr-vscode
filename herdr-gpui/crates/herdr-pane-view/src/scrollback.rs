//! Where scrollback ranges sit in a painted pane: centering a range and
//! tinting the cells it covers, through the pane's current scroll position.
use crate::terminal_painter::{Highlight, Tint};
use herdr_protocol::{PaneSurfacePane, TextRange};

pub use crate::terminal::viewport_top;

/// The scroll offset that centers `range` in `pane`, or `None` when it is
/// already in view or the pane cannot scroll (an alternate screen has no
/// history to move through).
pub fn reveal_offset(pane: &PaneSurfacePane, range: TextRange) -> Option<u64> {
    let scroll = pane.scroll?;
    let top = viewport_top(pane);
    let height = u32::from(pane.inner_rect.height);
    if range.start.row >= top && range.end.row < top.saturating_add(height) {
        return None;
    }
    let wanted_top = u64::from(range.start.row.saturating_sub(height / 2));
    Some(
        scroll
            .max_offset_from_bottom
            .saturating_sub(wanted_top)
            .min(scroll.max_offset_from_bottom),
    )
}

/// Appends the cells of `range` that `pane` shows, tinted, in the surface
/// frame's grid. Rows map through the pane's current scroll position, so a
/// range keeps its place as the pane scrolls; the rows between its ends run
/// the pane's full width, as a terminal selection does.
pub fn push_range(
    pane: &PaneSurfacePane,
    range: TextRange,
    tint: Tint,
    highlights: &mut Vec<Highlight>,
) {
    let inner = pane.inner_rect;
    let top = viewport_top(pane);
    let bottom = top.saturating_add(u32::from(inner.height));
    if range.end.row < top || range.start.row >= bottom || range.end < range.start {
        return;
    }
    for row in range.start.row.max(top)..=range.end.row.min(bottom.saturating_sub(1)) {
        let start = if row == range.start.row {
            range.start.col
        } else {
            0
        };
        let end = if row == range.end.row {
            range.end.col.saturating_add(1)
        } else {
            inner.width
        }
        .min(inner.width);
        let Ok(offset) = u16::try_from(row - top) else {
            continue;
        };
        if start >= end {
            continue;
        }
        highlights.push(Highlight {
            row: inner.y.saturating_add(offset),
            columns: inner.x.saturating_add(start)..inner.x.saturating_add(end),
            tint,
        });
    }
}
