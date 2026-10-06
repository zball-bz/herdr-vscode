//! Shaped cell symbols, reused across frames.
//!
//! Only the font, its size and bold/italic change a symbol's glyphs; color is
//! applied when painting. Keying by color would shape one symbol once per
//! color, so truecolor output would exhaust the bounded cache and reshape
//! every frame. ASCII, most of any grid, is found by index without hashing.
//! A symbol the font draws wider than its cells is cached already shrunk to
//! fit them (`fitted_size`).

use crate::terminal::{BOLD, ITALIC};
use gpui::ShapedLine;
use std::collections::HashMap;
use unicode_width::UnicodeWidthStr;

pub(super) const CACHE_LIMIT: usize = 4096;
const STYLES: usize = 4;
/// How far past its cells a shaped symbol may reach before it is shrunk: a
/// monospace font's own glyphs fill their cells exactly, give or take rounding.
const OVERFLOW_TOLERANCE: f32 = 0.5;

/// The grid cells `symbol` occupies. Like Herdr's ANSI renderer, a halfwidth
/// katakana with a (semi-)voiced mark counts as two columns.
pub(super) fn cells(symbol: &str) -> usize {
    let mut chars = symbol.chars();
    let wide = symbol.width() > 1
        || matches!(
            (chars.next(), chars.next(), chars.next()),
            (
                Some('\u{ff66}'..='\u{ff9d}'),
                Some('\u{ff9e}' | '\u{ff9f}'),
                None
            )
        );
    if wide { 2 } else { 1 }
}

/// The font size that fits a symbol shaped `width` wide at `font_size` into
/// `cells` cells, or `None` when it already fits.
///
/// Fonts and the grid can disagree about a width: Sarasa Mono SC draws East
/// Asian Ambiguous characters such as `…` and `—` full width, where the grid
/// gives them one cell, so they would cover the next cell's glyph. As with
/// xterm.js's `rescaleOverlappingGlyphs` (on by default in VS Code), such
/// glyphs shrink to their cells. GPUI paints glyphs without a transform, so
/// the shrink is uniform rather than horizontal only; `paint_glyphs` centers
/// the smaller line in the cell, where full-width symbols are drawn anyway.
pub(super) fn fitted_size(
    width: f32,
    font_size: f32,
    cells: usize,
    cell_width: f32,
) -> Option<f32> {
    let room = cell_width * cells as f32;
    (width > room + OVERFLOW_TOLERANCE && room > 0.).then(|| font_size * room / width)
}

pub(super) struct GlyphCache {
    /// A shaped line is kilobytes, so the tables below hold indexes into this.
    lines: Vec<ShapedLine>,
    /// `ascii[style * 128 + byte]`.
    ascii: Vec<Option<u32>>,
    other: [HashMap<String, u32>; STYLES],
}

impl Default for GlyphCache {
    fn default() -> Self {
        Self {
            lines: Vec::new(),
            ascii: vec![None; STYLES * 128],
            other: Default::default(),
        }
    }
}

/// The modifier bits that change shaping, as an index.
pub(super) fn style(modifier: u16) -> usize {
    usize::from(modifier & BOLD != 0) | usize::from(modifier & ITALIC != 0) << 1
}

pub(super) fn style_modifier(style: usize) -> u16 {
    (if style & 1 != 0 { BOLD } else { 0 }) | if style & 2 != 0 { ITALIC } else { 0 }
}

fn ascii_index(style: usize, symbol: &str) -> Option<usize> {
    match symbol.as_bytes() {
        [byte] if byte.is_ascii() => Some(style * 128 + usize::from(*byte)),
        _ => None,
    }
}

impl GlyphCache {
    pub(super) fn get(&self, style: usize, symbol: &str) -> Option<&ShapedLine> {
        let id = match ascii_index(style, symbol) {
            Some(index) => self.ascii[index]?,
            None => *self.other[style].get(symbol)?,
        };
        self.lines.get(usize::try_from(id).ok()?)
    }

    /// Whether `insert` keeps another line; past the limit, lines are shaped
    /// for one paint alone.
    pub(super) fn has_room(&self) -> bool {
        self.lines.len() < CACHE_LIMIT
    }

    pub(super) fn insert(&mut self, style: usize, symbol: &str, line: ShapedLine) -> &ShapedLine {
        // CACHE_LIMIT fits in u32; `has_room` keeps the count below it.
        let id = u32::try_from(self.lines.len()).unwrap_or(u32::MAX);
        match ascii_index(style, symbol) {
            Some(index) => self.ascii[index] = Some(id),
            None => {
                self.other[style].insert(symbol.to_owned(), id);
            }
        }
        self.lines.push(line);
        &self.lines[self.lines.len() - 1]
    }

    pub(super) fn clear(&mut self) {
        *self = Self::default();
    }

    #[cfg(any(test, feature = "integration-test"))]
    pub(super) fn len(&self) -> usize {
        self.lines.len()
    }

    /// Every cached symbol with its style index.
    #[cfg(any(test, feature = "integration-test"))]
    pub(super) fn iter(&self) -> impl Iterator<Item = (usize, String, &ShapedLine)> {
        let ascii = self.ascii.iter().enumerate().filter_map(|(index, id)| {
            let byte = u8::try_from(index % 128).ok()?;
            let symbol = char::from(byte).to_string();
            Some((
                index / 128,
                symbol,
                self.lines.get(usize::try_from((*id)?).ok()?)?,
            ))
        });
        let other = self.other.iter().enumerate().flat_map(move |(style, ids)| {
            ids.iter().filter_map(move |(symbol, id)| {
                Some((
                    style,
                    symbol.clone(),
                    self.lines.get(usize::try_from(*id).ok()?)?,
                ))
            })
        });
        ascii.chain(other)
    }
}
