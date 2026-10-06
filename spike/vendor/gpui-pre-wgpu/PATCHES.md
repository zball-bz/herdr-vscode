# Local patches to gpui-pre-wgpu 0.3.6 (Zed's gpui_wgpu snapshot, Apache-2.0)

- On `wasm32` the sprite shader's text correction defaults to none (gamma 1.0,
  grayscale enhanced contrast 0) instead of gamma 1.8 and contrast 1. The
  browser text system delivers coverage already shaped for the text's
  brightness, as the browser shapes its own text, and the canvas blends in gamma
  space as the browser does; correcting it again made light and mid-tone text
  heavier and blurrier than the page's. See gpui-pre-web's `PATCHES.md`.
- Subpixel (LCD) sprites needed dual-source blending, which WebGL2 lacks, so the
  browser always drew grayscale text. On WebGL2 they are now drawn in two passes
  (`shaders_component_alpha.wgsl`): one darkens the destination by each
  channel's coverage, the next adds the text color by the same coverage, which
  computes what one dual-source draw does. `supports_subpixel_rendering` reports
  either path; its subpixel contrast also defaults to none on `wasm32`.
