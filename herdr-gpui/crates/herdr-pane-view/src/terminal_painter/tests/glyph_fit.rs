use super::*;

#[test]
fn symbols_span_their_grid_cells() {
    assert_eq!(glyphs::cells("a"), 1);
    // East Asian Ambiguous: one cell, whatever width a CJK font draws.
    assert_eq!(glyphs::cells("\u{2026}"), 1);
    assert_eq!(glyphs::cells("\u{2014}"), 1);
    assert_eq!(glyphs::cells("\u{4e2d}"), 2);
    // Halfwidth katakana with a voiced mark, as Herdr's renderer counts it.
    assert_eq!(glyphs::cells("\u{ff76}\u{ff9e}"), 2);
}

#[test]
fn only_glyphs_wider_than_their_cells_shrink() {
    // A monospace font's own glyphs fill their cells, give or take rounding.
    assert_eq!(glyphs::fitted_size(8., 14., 1, 8.), None);
    assert_eq!(glyphs::fitted_size(8.4, 14., 1, 8.), None);
    assert_eq!(glyphs::fitted_size(16., 14., 2, 8.), None);
    // Sarasa Mono SC's full-width `…` in a one-cell slot: half the size.
    assert_eq!(glyphs::fitted_size(16., 14., 1, 8.), Some(7.));
    // A wide symbol drawn wider than two cells fits two.
    assert_eq!(glyphs::fitted_size(20., 14., 2, 8.), Some(11.2));
    // Before the cell is measured nothing is shrunk to nothing.
    assert_eq!(glyphs::fitted_size(16., 14., 1, 0.), None);
}
