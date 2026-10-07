//! How far cell backgrounds reach: the runs of one color a row paints, and
//! the edge cells' reach over a sub-cell remainder and the host's margins.

use super::glyphs;
use crate::terminal::cell_colors;
use crate::theme::Theme;
use gpui::{Pixels, Size, px, size};
use herdr_protocol::CellData;
use std::ops::Range;

/// How far the edge cells' backgrounds reach: over a remainder narrower than
/// a cell, plus `margin` to the right, which a host reserves beside the grid
/// on purpose (`TerminalPainter::set_edge_margins`).
pub(super) fn background_extent(
    grid: Size<Pixels>,
    available: Size<Pixels>,
    cell: Size<Pixels>,
    margin: Pixels,
) -> Size<Pixels> {
    let extend = |grid, available, reach| {
        if available > grid && available - grid < reach {
            available
        } else {
            grid
        }
    };
    size(
        extend(grid.width, available.width, cell.width + margin),
        extend(grid.height, available.height, cell.height),
    )
}

/// The left and right edges of the backgrounds of `columns`, from the grid's
/// left: the first column reaches over `lead`, the host's margin left of the
/// grid, and the last to `reach`, the right edge `background_extent` gave.
pub(super) fn span_edges(
    columns: Range<usize>,
    width: usize,
    cell_width: f32,
    lead: Pixels,
    reach: Pixels,
) -> (Pixels, Pixels) {
    let left = if columns.start == 0 {
        -lead
    } else {
        px(columns.start as f32 * cell_width)
    };
    let right = if columns.end == width {
        reach
    } else {
        px(columns.end as f32 * cell_width)
    };
    (left, right)
}

pub(super) fn background_spans<'a>(
    row: &'a [CellData],
    columns: Range<usize>,
    theme: &'a Theme,
) -> impl Iterator<Item = (usize, usize, u32)> + 'a {
    // A wide glyph's continuation cell shows the glyph's background, as a host
    // terminal does: Herdr's ANSI renderer never draws that cell, so its own
    // background is not meant to be seen.
    let bg = move |x: usize| {
        let x = if x > 0 && glyphs::cells(&row[x - 1].symbol) > 1 {
            x - 1
        } else {
            x
        };
        cell_colors(&row[x], theme).1
    };
    let mut start = columns.start;
    let stop = columns.end.min(row.len());
    std::iter::from_fn(move || {
        (start < stop).then_some(())?;
        let color = bg(start);
        let mut end = start + 1;
        while end < stop && bg(end) == color {
            end += 1;
        }
        let span = (start, end, color);
        start = end;
        Some(span)
    })
}
