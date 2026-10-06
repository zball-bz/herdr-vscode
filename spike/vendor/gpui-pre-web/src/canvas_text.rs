use anyhow::{Context as _, Result, anyhow, ensure};
use gpui::{Bounds, DevicePixels};
use std::cell::{Cell, RefCell};
use wasm_bindgen::{JsCast as _, JsValue};
use web_sys::{OffscreenCanvas, OffscreenCanvasRenderingContext2d};

const MAX_RASTER_DIMENSION: u32 = 4096;
const MAX_RASTER_PIXELS: usize = 4 * 1024 * 1024;

thread_local! {
    static CANVAS: RefCell<Option<TextCanvas>> = const { RefCell::new(None) };
    /// An opaque canvas, where the browser antialiases text for the display's
    /// subpixels (LCD) when the system does.
    static OPAQUE_CANVAS: RefCell<Option<TextCanvas>> = const { RefCell::new(None) };
    static LCD_TEXT: Cell<Option<bool>> = const { Cell::new(None) };
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct CanvasTextMetrics {
    pub(crate) advance: f32,
    pub(crate) left: f32,
    pub(crate) right: f32,
    pub(crate) ascent: f32,
    pub(crate) descent: f32,
}

struct TextCanvas {
    canvas: OffscreenCanvas,
    context: OffscreenCanvasRenderingContext2d,
}

impl TextCanvas {
    fn new(opaque: bool) -> Result<Self> {
        let canvas = OffscreenCanvas::new(1, 1)
            .map_err(|error| anyhow!("creating text OffscreenCanvas: {error:?}"))?;
        let options = js_sys::Object::new();
        // Every rasterized glyph is read back for upload into GPUI's atlas.
        let assigned = js_sys::Reflect::set(
            &options,
            &JsValue::from_str("willReadFrequently"),
            &JsValue::TRUE,
        )
        .map_err(|error| anyhow!("setting Canvas readback option: {error:?}"))?;
        ensure!(assigned, "Canvas readback option could not be set");
        if opaque {
            let assigned =
                js_sys::Reflect::set(&options, &JsValue::from_str("alpha"), &JsValue::FALSE)
                    .map_err(|error| anyhow!("setting Canvas opacity option: {error:?}"))?;
            ensure!(assigned, "Canvas opacity option could not be set");
        }
        let context = canvas
            .get_context_with_context_options("2d", &options)
            .map_err(|error| anyhow!("getting OffscreenCanvas 2D context: {error:?}"))?
            .context("OffscreenCanvas 2D text rendering is unavailable")?
            .dyn_into::<OffscreenCanvasRenderingContext2d>()
            .map_err(|error| anyhow!("unexpected OffscreenCanvas 2D context: {error:?}"))?;
        Ok(Self { canvas, context })
    }

    fn configure(&self, css_font: &str) -> Result<()> {
        ensure!(!css_font.trim().is_empty(), "Canvas text font is empty");
        // An invalid CSS font assignment is ignored by Canvas. Reset first so
        // it cannot accidentally inherit the preceding request's font.
        self.context.set_font("10px sans-serif");
        self.context.set_font(css_font);
        self.context.set_text_align("left");
        self.context.set_text_baseline("alphabetic");
        self.context.set_fill_style_str("white");
        // web-sys does not expose direction on the offscreen 2D context.
        let assigned = js_sys::Reflect::set(
            self.context.as_ref(),
            &JsValue::from_str("direction"),
            &JsValue::from_str("ltr"),
        )
        .map_err(|error| anyhow!("setting Canvas text direction: {error:?}"))?;
        ensure!(assigned, "Canvas text direction could not be set");
        Ok(())
    }
}

fn with_canvas<T>(operation: impl FnOnce(&mut TextCanvas) -> Result<T>) -> Result<T> {
    with_canvas_of(&CANVAS, false, operation)
}

fn with_canvas_of<T>(
    key: &'static std::thread::LocalKey<RefCell<Option<TextCanvas>>>,
    opaque: bool,
    operation: impl FnOnce(&mut TextCanvas) -> Result<T>,
) -> Result<T> {
    key.with(|canvas| {
        let mut canvas = canvas
            .try_borrow_mut()
            .context("Canvas text renderer was called reentrantly")?;
        if canvas.is_none() {
            *canvas = Some(TextCanvas::new(opaque)?);
        }
        operation(
            canvas
                .as_mut()
                .context("Canvas text renderer is unavailable")?,
        )
    })
}

pub(crate) fn measure(text: &str, css_font: &str) -> Result<CanvasTextMetrics> {
    with_canvas(|canvas| {
        canvas.configure(css_font)?;
        let metrics = canvas
            .context
            .measure_text(text)
            .map_err(|error| anyhow!("measuring Canvas text: {error:?}"))?;
        let metrics = CanvasTextMetrics {
            advance: metrics.width() as f32,
            left: -metrics.actual_bounding_box_left() as f32,
            right: metrics.actual_bounding_box_right() as f32,
            ascent: metrics.actual_bounding_box_ascent() as f32,
            descent: metrics.actual_bounding_box_descent() as f32,
        };
        ensure!(
            [
                metrics.advance,
                metrics.left,
                metrics.right,
                metrics.ascent,
                metrics.descent
            ]
            .into_iter()
            .all(f32::is_finite),
            "Canvas returned non-finite text metrics"
        );
        Ok(metrics)
    })
}

/// Font-wide metrics of the font the browser picks first for `css_font`.
#[derive(Clone, Copy, Debug)]
pub(crate) struct CanvasFontMetrics {
    pub(crate) ascent: f32,
    pub(crate) descent: f32,
    pub(crate) cap_height: f32,
    pub(crate) x_height: f32,
    pub(crate) em_advance: f32,
}

pub(crate) fn font_metrics(css_font: &str) -> Result<CanvasFontMetrics> {
    with_canvas(|canvas| {
        canvas.configure(css_font)?;
        let measure = |text: &str| {
            canvas
                .context
                .measure_text(text)
                .map_err(|error| anyhow!("measuring Canvas font: {error:?}"))
        };
        let em = measure("M")?;
        let metrics = CanvasFontMetrics {
            ascent: em.font_bounding_box_ascent() as f32,
            descent: em.font_bounding_box_descent() as f32,
            cap_height: measure("H")?.actual_bounding_box_ascent() as f32,
            x_height: measure("x")?.actual_bounding_box_ascent() as f32,
            em_advance: em.width() as f32,
        };
        ensure!(
            [
                metrics.ascent,
                metrics.descent,
                metrics.cap_height,
                metrics.x_height,
                metrics.em_advance
            ]
            .into_iter()
            .all(f32::is_finite)
                && metrics.ascent + metrics.descent > 0.,
            "Canvas returned unusable font metrics"
        );
        Ok(metrics)
    })
}

/// How `rasterize` draws a glyph and what it returns.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Raster {
    /// The glyph's own colors, as BGRA.
    Color,
    /// Coverage, one byte a pixel, drawn in this gray: the browser's
    /// rasterizer shapes coverage for the luminance of the text's fill.
    Mask(u8),
    /// Coverage of each color channel, as BGRA, drawn in this gray on an
    /// opaque canvas, where the browser antialiases for the display's
    /// subpixels (LCD) when the system does.
    Lcd(u8),
}

/// Whether the browser draws text on an opaque canvas with LCD antialiasing,
/// as it does where the system's font settings ask for subpixel rendering.
pub(crate) fn lcd_text() -> bool {
    if let Some(known) = LCD_TEXT.with(Cell::get) {
        return known;
    }
    let bounds = Bounds {
        origin: gpui::point(DevicePixels(0), DevicePixels(-20)),
        size: gpui::size(DevicePixels(24), DevicePixels(26)),
    };
    let lcd = rasterize("m", "20px sans-serif", bounds, (0., 0.), Raster::Lcd(255)).is_ok_and(
        |pixels| {
            pixels
                .chunks_exact(4)
                .any(|pixel| pixel[0].abs_diff(pixel[1]) > 16 || pixel[1].abs_diff(pixel[2]) > 16)
        },
    );
    LCD_TEXT.with(|known| known.set(Some(lcd)));
    lcd
}

/// Draws `text` into `bounds` and returns its pixels as `raster` says.
pub(crate) fn rasterize(
    text: &str,
    css_font: &str,
    bounds: Bounds<DevicePixels>,
    subpixel_offset: (f32, f32),
    raster: Raster,
) -> Result<Vec<u8>> {
    ensure!(
        subpixel_offset.0.is_finite() && subpixel_offset.1.is_finite(),
        "Canvas text subpixel offset must be finite"
    );
    let width = u32::try_from(bounds.size.width.0)
        .context("Canvas text raster width must be nonnegative")?;
    let height = u32::try_from(bounds.size.height.0)
        .context("Canvas text raster height must be nonnegative")?;
    if width == 0 || height == 0 {
        return Ok(Vec::new());
    }
    ensure!(
        width <= MAX_RASTER_DIMENSION && height <= MAX_RASTER_DIMENSION,
        "Canvas text raster exceeds maximum dimension {MAX_RASTER_DIMENSION}: {width}x{height}"
    );
    let pixel_count = usize::try_from(width)?
        .checked_mul(usize::try_from(height)?)
        .context("Canvas text raster pixel count overflow")?;
    ensure!(
        pixel_count <= MAX_RASTER_PIXELS,
        "Canvas text raster exceeds maximum pixel count {MAX_RASTER_PIXELS}: {width}x{height}"
    );
    let byte_count = pixel_count
        .checked_mul(4)
        .context("Canvas text raster byte count overflow")?;

    let (key, opaque) = match raster {
        Raster::Lcd(_) => (&OPAQUE_CANVAS, true),
        Raster::Color | Raster::Mask(_) => (&CANVAS, false),
    };
    with_canvas_of(key, opaque, |canvas| {
        // Shrink before growing so intermediate canvas sizes obey the pixel cap.
        if height < canvas.canvas.height() {
            canvas.canvas.set_height(height);
        }
        if canvas.canvas.width() != width {
            canvas.canvas.set_width(width);
        }
        if canvas.canvas.height() != height {
            canvas.canvas.set_height(height);
        }
        canvas.configure(css_font)?;
        match raster {
            Raster::Color => canvas
                .context
                .clear_rect(0.0, 0.0, f64::from(width), f64::from(height)),
            Raster::Mask(gray) => {
                canvas
                    .context
                    .clear_rect(0.0, 0.0, f64::from(width), f64::from(height));
                canvas
                    .context
                    .set_fill_style_str(&format!("rgb({gray} {gray} {gray})"));
            }
            Raster::Lcd(gray) => {
                // Coverage is read back against whichever of black and white
                // lies farther from the text's gray (`lcd_coverage`).
                canvas
                    .context
                    .set_fill_style_str(if gray >= 128 { "black" } else { "white" });
                canvas
                    .context
                    .fill_rect(0.0, 0.0, f64::from(width), f64::from(height));
                canvas
                    .context
                    .set_fill_style_str(&format!("rgb({gray} {gray} {gray})"));
            }
        }
        canvas
            .context
            .fill_text(
                text,
                -f64::from(bounds.origin.x.0) + f64::from(subpixel_offset.0),
                -f64::from(bounds.origin.y.0) + f64::from(subpixel_offset.1),
            )
            .map_err(|error| anyhow!("drawing Canvas text: {error:?}"))?;
        let image = canvas
            .context
            .get_image_data(0.0, 0.0, f64::from(width), f64::from(height))
            .map_err(|error| anyhow!("reading Canvas text raster pixels: {error:?}"))?;
        let mut pixels = image.data().0;
        ensure!(
            pixels.len() == byte_count,
            "Canvas text raster returned {} bytes, expected {byte_count}",
            pixels.len()
        );
        match raster {
            Raster::Color => {
                for pixel in pixels.chunks_exact_mut(4) {
                    pixel.swap(0, 2);
                }
                Ok(pixels)
            }
            Raster::Mask(_) => {
                let mut alpha = Vec::new();
                alpha
                    .try_reserve_exact(pixel_count)
                    .context("allocating Canvas text alpha mask")?;
                alpha.extend(pixels.chunks_exact(4).map(|pixel| pixel[3]));
                Ok(alpha)
            }
            Raster::Lcd(gray) => {
                for pixel in pixels.chunks_exact_mut(4) {
                    let [red, green, blue] =
                        [pixel[0], pixel[1], pixel[2]].map(|value| lcd_coverage(value, gray));
                    pixel.copy_from_slice(&[blue, green, red, red.max(green).max(blue)]);
                }
                Ok(pixels)
            }
        }
    })
}

/// A channel's coverage from its value after text of `gray` was blended onto
/// black (light text) or white (dark text) at that coverage.
fn lcd_coverage(value: u8, gray: u8) -> u8 {
    let (value, gray) = (u32::from(value), u32::from(gray));
    let coverage = if gray >= 128 {
        value * 255 / gray
    } else {
        (255 - value) * 255 / (255 - gray)
    };
    u8::try_from(coverage).unwrap_or(u8::MAX)
}
