//! The pixel thumb that replaces the daemon's cell scrollbar: a thin pill at
//! the track's right edge that widens to the whole track and brightens while
//! the pointer is on it or drags it, so the column reads as something to grab.

use super::TerminalPainter;
use crate::terminal::Scrollbar;
use gpui::{Bounds, Pixels, Point, Window, fill, point, px, rgba, size};

const INSET: f32 = 1.;
const ALPHA: u32 = 0xc0;
const ACTIVE_ALPHA: u32 = 0x99;

/// The thumb as painted, in grid pixels.
pub(super) fn thumb_bounds(bar: &Scrollbar, active: bool) -> Bounds<Pixels> {
    let track = f32::from(bar.track.size.width) - 2. * INSET;
    let width = if active {
        track.max(2.)
    } else {
        track.clamp(2., 6.)
    };
    Bounds::new(
        point(bar.track.right() - px(width + INSET), bar.thumb.top()),
        size(px(width), bar.thumb.size.height),
    )
}

impl TerminalPainter {
    /// Marks the pane whose scrollbar is hovered or dragged, for the next paint.
    pub fn set_active_scrollbar(&mut self, pane_id: Option<&str>) {
        if self.active_scrollbar.as_deref() != pane_id {
            self.active_scrollbar = pane_id.map(str::to_owned);
        }
    }

    pub(super) fn paint_thumb(
        &self,
        bar: &Scrollbar,
        origin: Point<Pixels>,
        active: bool,
        window: &mut Window,
    ) {
        let mut bounds = thumb_bounds(bar, active);
        bounds.origin += origin;
        let color = if active {
            rgba((self.theme.foreground << 8) | ACTIVE_ALPHA)
        } else {
            rgba((self.theme.muted << 8) | ALPHA)
        };
        let radius = bounds.size.width.min(px(6.)) / 2.;
        window.paint_quad(fill(bounds, color).corner_radii(radius));
    }
}
