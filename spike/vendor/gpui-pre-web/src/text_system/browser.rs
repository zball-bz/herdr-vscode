//! Browser fonts: families GPUI has no bytes for, resolved by name through the
//! browser's own font stack (system fonts included), then measured and
//! rasterized through Canvas, as xterm.js's WebGL renderer does. A page then
//! needs no font bytes in its WASM heap, and gets the browser's fallback for
//! every script the family lacks.
//!
//! Layout advances one grapheme at a time with the browser's measured width,
//! which suits a terminal grid that places each cell itself. Shaping across
//! graphemes (ligatures, kerning, complex scripts) is not applied.

use super::{CanvasFont, Source, WebTextSystem};
use crate::canvas_fallback::classify_canvas_fallback;
use crate::canvas_text::{self, CanvasFontMetrics};
use anyhow::{Result, ensure};
use gpui::{
    Bounds, Font, FontId, FontMetrics, FontRun, LineLayout, Pixels, PlatformTextSystem as _,
    ShapedGlyph, ShapedRun, point, px, size,
};
use std::sync::Arc;
use unicode_segmentation::UnicodeSegmentation;

/// Browser font metrics are measured at this many pixels and kept in its units.
const UNITS_PER_EM: u32 = 1000;

fn font_metrics(metrics: CanvasFontMetrics) -> FontMetrics {
    let em = UNITS_PER_EM as f32;
    FontMetrics {
        units_per_em: UNITS_PER_EM,
        ascent: metrics.ascent,
        // Negative below the baseline, as loaded fonts report it.
        descent: -metrics.descent,
        line_gap: 0.,
        // Canvas does not expose these; common values for text faces.
        underline_position: -0.1 * em,
        underline_thickness: 0.05 * em,
        cap_height: metrics.cap_height,
        x_height: metrics.x_height,
        bounding_box: Bounds {
            origin: point(0., -metrics.descent),
            size: size(metrics.em_advance, metrics.ascent + metrics.descent),
        },
    }
}

impl WebTextSystem {
    /// A browser font for `font`, registered once per descriptor.
    pub(super) fn browser_font_id(&self, font: &Font) -> Result<FontId> {
        if let Some(font_id) = self.state.read().browser_font_ids.get(font) {
            return Ok(*font_id);
        }
        let mut browser = CanvasFont {
            source: Source::Browser(font_metrics(CanvasFontMetrics {
                ascent: 0.,
                descent: 0.,
                cap_height: 0.,
                x_height: 0.,
                em_advance: 0.,
            })),
            descriptor: font.clone(),
            monospace: true,
        };
        // The generic family that ends the stack depends on the font's widths.
        let size = px(UNITS_PER_EM as f32);
        let css = browser.css_font(size, false)?;
        let narrow = canvas_text::measure("i", &css)?.advance;
        let wide = canvas_text::measure("m", &css)?.advance;
        browser.monospace = (narrow - wide).abs() < 0.5;
        let metrics = canvas_text::font_metrics(&browser.css_font(size, false)?)?;
        browser.source = Source::Browser(font_metrics(metrics));

        let mut state = self.state.write();
        if let Some(font_id) = state.browser_font_ids.get(font) {
            return Ok(*font_id);
        }
        ensure!(
            state.canvas_fonts.len() < super::CANVAS_FONT_BIT,
            "Canvas font ID space exhausted"
        );
        let font_id = FontId(super::CANVAS_FONT_BIT | state.canvas_fonts.len());
        state.canvas_fonts.push(Arc::new(browser));
        state.browser_font_ids.insert(font.clone(), font_id);
        log::info!(
            "browser font {:?} (monospace: {}) for a family without loaded bytes",
            font.family,
            state.canvas_fonts.last().is_some_and(|font| font.monospace)
        );
        Ok(font_id)
    }

    /// Lays out a line with at least one browser font. Runs of loaded fonts
    /// keep their own shaping, offset to where the previous run ended.
    pub(super) fn layout_browser_line(
        &self,
        text: &str,
        font_size: Pixels,
        runs: &[FontRun],
    ) -> LineLayout {
        let mut layout = LineLayout {
            font_size,
            width: px(0.),
            ascent: px(0.),
            descent: px(0.),
            runs: Vec::new(),
            len: text.len(),
        };
        let mut start = 0;
        for run in runs {
            let end = (start + run.len).min(text.len());
            let Some(segment) = text.get(start..end) else {
                log::warn!("font run splits a character; the rest of the line is dropped");
                break;
            };
            match self.native_font_id(run.font_id) {
                None => self.layout_browser_run(run.font_id, segment, start, &mut layout),
                Some(native_id) => self.layout_native_run(native_id, segment, start, &mut layout),
            }
            start = end;
        }
        layout
    }

    fn layout_browser_run(
        &self,
        font_id: FontId,
        segment: &str,
        start: usize,
        layout: &mut LineLayout,
    ) {
        let Some(font) = self.canvas_font(font_id) else {
            return;
        };
        let metrics = self.canvas_metrics(&font);
        let scale = f32::from(layout.font_size) / metrics.units_per_em as f32;
        layout.ascent = layout.ascent.max(px(metrics.ascent * scale));
        layout.descent = layout.descent.max(px(-metrics.descent * scale));
        let mut glyphs = Vec::new();
        for (offset, grapheme) in segment.grapheme_indices(true) {
            let color = classify_canvas_fallback(grapheme)
                .is_some_and(|fallback| fallback.emoji_presentation);
            let measured = self
                .register_glyph(font_id, grapheme, color)
                .and_then(|glyph| Ok((glyph, self.measure(font_id, glyph, layout.font_size)?)));
            match measured {
                Ok((id, measured)) => {
                    glyphs.push(ShapedGlyph {
                        id,
                        position: point(layout.width, px(0.)),
                        index: start + offset,
                        is_emoji: color,
                    });
                    layout.width += px(measured.advance);
                }
                Err(error) => log::warn!("browser font layout of {grapheme:?} failed: {error:#}"),
            }
        }
        if !glyphs.is_empty() {
            layout.runs.push(ShapedRun { font_id, glyphs });
        }
    }

    fn layout_native_run(
        &self,
        native_id: FontId,
        segment: &str,
        start: usize,
        layout: &mut LineLayout,
    ) {
        let run = [FontRun {
            len: segment.len(),
            font_id: native_id,
        }];
        let mut native = self.native.layout_line(segment, layout.font_size, &run);
        self.apply_fallback(segment, &run, &mut native);
        for mut shaped in native.runs {
            for glyph in &mut shaped.glyphs {
                glyph.position.x += layout.width;
                glyph.index += start;
            }
            layout.runs.push(shaped);
        }
        layout.width += native.width;
        layout.ascent = layout.ascent.max(native.ascent);
        layout.descent = layout.descent.max(native.descent);
    }
}
