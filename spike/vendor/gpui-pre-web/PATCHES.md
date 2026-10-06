# Local patches to gpui-pre-web 0.3.6 (Zed's gpui_web snapshot, Apache-2.0)

- `PlatformWindow::update_ime_position` was a no-op and the IME mirror textarea sat
  at the page's top-left, so the platform candidate window never followed the
  caret. It now moves the textarea onto the reported caret bounds
  (`ImeMirror::set_caret_bounds`), keeping one unwrapped line.
- Text in a family GPUI has no bytes for failed to resolve (and `resolve_font`
  panicked once its fallbacks failed too). Such a family is now a *browser font*
  (`text_system/browser.rs`): the browser resolves it by name like any CSS font
  stack, Canvas measures each grapheme and rasterizes it, and font metrics come
  from `TextMetrics.fontBoundingBox*`. A page can then draw system fonts without
  loading their bytes into the WASM heap. Layout is per grapheme (no shaping
  across graphemes); loaded fonts keep cosmic-text shaping.
- `WgpuRenderer::draw` only logs a lost GPU device or WebGL context, and nothing
  paints again. `WebWindow::draw` now dispatches a `gpui-graphics-lost` event on
  the window once, so the page's host can reload it.
- Canvas masks were rasterized in white whatever the text's color, then GPUI's
  shader corrected them again for gamma 1.8 and contrast 1, so dark text was
  drawn with light text's coverage and light and mid-tone text came out heavier
  and blurrier than the browser's own. `glyph_dilation_for_color` now returns the
  color's luminance level (`text_system/tone.rs`), which keys the atlas, Canvas
  draws each mask in a gray of that level so the browser shapes its coverage as
  for its own text, and the vendored gpui-pre-wgpu leaves coverage alone on
  `wasm32`. Loaded fonts' raw swash coverage gets the shader's former correction
  on the CPU instead.
- Browser fonts are drawn with LCD (subpixel) antialiasing where the browser
  draws its own text so, as on a desktop whose font settings ask for it: Canvas
  rasterizes such glyphs on an opaque canvas, reading each channel's coverage
  back against black or white by the text's luminance level
  (`canvas_text::Raster::Lcd`), and `is_subpixel_rendering_supported` follows the
  vendored gpui-pre-wgpu's two-pass WebGL2 path. A one-time probe
  (`canvas_text::lcd_text`) keeps glyphs grayscale where the browser does not
  antialias for subpixels, such as on macOS. Loaded fonts stay grayscale.
