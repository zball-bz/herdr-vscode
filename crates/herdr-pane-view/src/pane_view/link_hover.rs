//! The link under the pointer, reported so a host can offer a hover toolbar
//! beside it (open it here or elsewhere, copy it). Unlike the link modifier's
//! underline, it follows the pointer with no key held. It is withdrawn while a
//! button is down and when the pointer leaves, and is read again when new
//! output may have moved the text under a resting pointer.

use super::{LinkActivation, PaneView, PaneViewEvent};
use gpui::{Bounds, Context, Pixels, Point, point, px, size};

/// A link under the pointer and the cells it covers, in window pixels.
#[derive(Clone, Debug, PartialEq)]
pub struct HoveredLink {
    pub link: LinkActivation,
    pub bounds: Bounds<Pixels>,
}

impl PaneView {
    /// Follows the pointer at `position`, or away from the view (`None`), and
    /// reports a change of the link under it.
    pub(super) fn hover_link_at(
        &mut self,
        position: Option<Point<Pixels>>,
        cx: &mut Context<Self>,
    ) {
        self.pointer = position;
        let hovered = position
            .and_then(|position| self.link_at(position))
            .and_then(|(link, rows)| {
                // Plain and explicit links are row-local: one row each.
                let (row, columns) = rows.first()?;
                let width = f32::from(columns.end.saturating_sub(columns.start));
                Some(HoveredLink {
                    link,
                    bounds: Bounds::new(
                        self.bounds.origin
                            + point(
                                px(f32::from(columns.start) * self.cell_width),
                                px(f32::from(*row) * self.cell_height()),
                            ),
                        size(px(width * self.cell_width), px(self.cell_height())),
                    ),
                })
            });
        if hovered != self.hovered_link_target {
            self.hovered_link_target = hovered.clone();
            cx.emit(PaneViewEvent::LinkHovered(hovered));
        }
    }
}
