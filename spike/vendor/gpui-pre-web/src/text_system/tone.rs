//! Glyph masks shaped for the brightness of the text they draw, as the browser
//! shapes its own.
//!
//! Chrome's rasterizer (Skia) adjusts a glyph's coverage for its fill's
//! luminance before blending in gamma space, so light text gets more coverage
//! than dark text and both look as heavy as they should. GPUI's sprite shader,
//! written for raw coverage, applies a DirectWrite-style correction of its own,
//! which on Canvas masks counted twice: light and mid-tone text came out
//! heavier and blurrier than the page's. So this text system keys each glyph by
//! its color's luminance level (`RenderGlyphParams::dilation`, unused off
//! macOS), rasterizes Canvas glyphs in a gray of that level, and the renderer
//! leaves coverage alone (`../../gpui-pre-wgpu`). Glyphs of loaded fonts, raw
//! coverage from swash, get the shader's former correction here instead.

use gpui::{Hsla, get_gamma_correction_ratios};

/// Skia keeps three bits of a fill's luminance for its coverage tables.
const LEVELS: u8 = 8;
/// The gamma and contrast GPUI's renderer applies to raw coverage by default.
const NATIVE_GAMMA: f32 = 1.8;
const NATIVE_CONTRAST: f32 = 1.;

/// The luminance level of `color`, as Skia computes it from the sRGB bytes.
pub(super) fn level(color: Hsla) -> u8 {
    let rgb = color.to_rgb();
    let byte = |channel: f32| (channel.clamp(0., 1.) * 255.).round() as u32;
    let luminance = (byte(rgb.r) * 54 + byte(rgb.g) * 183 + byte(rgb.b) * 19) >> 8;
    (luminance >> 5) as u8
}

/// A gray of `level`, as Skia's canonical luminance spells it.
pub(super) fn gray(level: u8) -> u8 {
    let level = level.min(LEVELS - 1);
    level << 5 | level << 2 | level >> 1
}

/// Applies to raw coverage what GPUI's shader applied for text of `level`'s
/// brightness: its light-on-dark contrast, then its gamma ratios.
pub(super) fn correct_raw_coverage(mask: &mut [u8], level: u8) {
    let brightness = f32::from(gray(level)) / 255.;
    let [gx, gy, gz, gw] = get_gamma_correction_ratios(NATIVE_GAMMA);
    let contrast = NATIVE_CONTRAST * (4. * (0.75 - brightness)).clamp(0., 1.);
    let mut table = [0u8; 256];
    for (value, corrected) in table.iter_mut().enumerate() {
        let alpha = value as f32 / 255.;
        let alpha = alpha * (contrast + 1.) / (alpha * contrast + 1.);
        let correction = (gx * brightness + gy) * alpha + (gz * brightness + gw);
        let alpha = alpha + alpha * (1. - alpha) * correction;
        *corrected = (alpha.clamp(0., 1.) * 255.).round() as u8;
    }
    for value in mask {
        *value = table[usize::from(*value)];
    }
}
