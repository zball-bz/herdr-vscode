//! Paint work counted by the native performance harness.

#[derive(Default, Debug, Clone, Copy)]
pub struct Counts {
    pub shapes: usize,
    pub quads: usize,
    pub glyphs: usize,
    pub decorations: usize,
    pub paint_errors: usize,
    pub metric_shapes: usize,
    pub paints: usize,
    pub sidebar_renders: usize,
}
impl gpui::Global for Counts {}
