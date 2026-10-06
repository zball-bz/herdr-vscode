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
