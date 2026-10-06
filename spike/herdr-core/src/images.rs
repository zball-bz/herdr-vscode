//! Image bytes for the surfaces this connection receives.
//!
//! Adapted from herdr-gpui's `herdr-client` `ImageStore` (Apache-2.0): Herdr sends an
//! image's bytes once, in the first surface that places it, and afterwards only
//! references it by key, so the client keeps them and publishes the set alongside the
//! surface. Validation and limits come from the protocol crate.

use herdr_protocol::{
    MAX_IMAGE_BYTES, MAX_IMAGES, MAX_PLACEMENTS, PaneSurfaceFrame, SurfaceGraphicsAssetKey,
    SurfaceGraphicsScene, SurfaceImage, SurfaceImages, valid_asset,
};
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
pub struct ImageStore {
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
    pub fn receive(&mut self, surface: &mut PaneSurfaceFrame) -> bool {
        let scene = &mut surface.graphics;
        if scene.placements.len() > MAX_PLACEMENTS {
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
                continue;
            }
            if self.images.len() >= MAX_IMAGES
                || asset.data.len() > MAX_IMAGE_BYTES.saturating_sub(self.bytes)
            {
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
    pub fn show(&mut self) -> bool {
        self.shown.clone_from(&self.latest);
        self.prune()
    }

    pub fn published(&self) -> Arc<SurfaceImages> {
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
