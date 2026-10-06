//! The worker's store of image bytes for one connection.
//!
//! Herdr sends an image's bytes once, in the first surface that places it, and
//! afterwards only references it by key until no placement or retained entry
//! names it. A consumer that coalesces surfaces would miss those bytes, so the
//! worker, which sees every surface in order, keeps them here and publishes
//! the set alongside the surfaces. Validation and limits live in the protocol
//! crate, shared with painters that cannot link this client.

pub use crate::protocol::{
    MAX_IMAGE_BYTES, MAX_IMAGE_SIDE, MAX_IMAGES, MAX_PLACEMENTS, SurfaceImage, SurfaceImages,
    valid_asset,
};
use crate::protocol::{PaneSurfaceFrame, SurfaceGraphicsAssetKey, SurfaceGraphicsScene};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

fn referenced(scene: &SurfaceGraphicsScene) -> HashSet<SurfaceGraphicsAssetKey> {
    scene
        .placements
        .iter()
        .map(|placement| &placement.asset)
        .chain(&scene.retained_assets)
        .cloned()
        .collect()
}

/// The worker's image bytes for one connection.
#[derive(Default)]
pub(crate) struct ImageStore {
    images: HashMap<SurfaceGraphicsAssetKey, SurfaceImage>,
    bytes: usize,
    /// Keys the newest received surface references.
    latest: HashSet<SurfaceGraphicsAssetKey>,
    /// Keys the newest emitted surface references; its consumer may still
    /// paint them while a newer surface waits for its snapshot.
    shown: HashSet<SurfaceGraphicsAssetKey>,
}

impl ImageStore {
    /// Moves a received surface's asset bytes into the store, leaving the
    /// surface with metadata only. Returns whether the published set changed.
    pub(crate) fn receive(&mut self, surface: &mut PaneSurfaceFrame) -> bool {
        let scene = &mut surface.graphics;
        if scene.placements.len() > MAX_PLACEMENTS {
            tracing::debug!(
                category = "surface_images",
                count = scene.placements.len(),
                "dropped placements over the limit"
            );
            scene.placements.truncate(MAX_PLACEMENTS);
        }
        let assets = std::mem::take(&mut scene.assets);
        self.latest = referenced(scene);
        let mut changed = self.prune();
        for asset in assets {
            if self.images.contains_key(&asset.key) || !self.latest.contains(&asset.key) {
                continue;
            }
            if !valid_asset(&asset.key, &asset.data) {
                tracing::debug!(category = "surface_images", "dropped an invalid image");
                continue;
            }
            if self.images.len() >= MAX_IMAGES
                || asset.data.len() > MAX_IMAGE_BYTES.saturating_sub(self.bytes)
            {
                tracing::debug!(category = "surface_images", "dropped an image over budget");
                continue;
            }
            self.bytes += asset.data.len();
            self.images.insert(asset.key, SurfaceImage::new(asset.data));
            changed = true;
        }
        changed
    }

    /// Records that the newest received surface was emitted. Returns whether
    /// the published set changed.
    pub(crate) fn show(&mut self) -> bool {
        self.shown.clone_from(&self.latest);
        self.prune()
    }

    pub(crate) fn published(&self) -> Arc<SurfaceImages> {
        Arc::new(SurfaceImages::from(self.images.clone()))
    }

    fn prune(&mut self) -> bool {
        let before = self.images.len();
        let (latest, shown) = (&self.latest, &self.shown);
        let mut freed = 0;
        self.images.retain(|key, image| {
            let keep = latest.contains(key) || shown.contains(key);
            if !keep {
                freed += image.data().len();
            }
            keep
        });
        self.bytes -= freed;
        self.images.len() != before
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests;
