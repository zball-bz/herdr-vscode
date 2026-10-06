//! Browser tabs: web pages shown in place of the terminal, or beside it in
//! another editor group, next to a workspace's Herdr tabs. Herdr panes are always
//! terminals, so these tabs belong to this client alone; the daemon and its
//! other clients never see them. Pages are native web views drawn above the window, which is why the
//! window hides them whenever one of its own overlays is open.

#[cfg(any(target_os = "macos", windows, test))]
mod annotate;
// Linux builds show no pages, so there is nothing to annotate there.
#[cfg(any(target_os = "macos", windows))]
mod annotate_view;
mod feedback;
mod group_motion;
mod groups;
mod groups_view;
mod layouts;
mod location;
#[cfg(any(target_os = "macos", windows))]
mod native;
#[cfg(any(target_os = "macos", windows))]
mod preview;
#[cfg(target_os = "macos")]
mod snapshot;
mod store;
mod tab_appear;
mod tab_scroll;
mod view;
#[cfg(test)]
mod view_tests;

#[cfg(any(target_os = "macos", windows))]
pub(crate) use annotate_view::Annotations;
pub(crate) use feedback::{Batch, Feedback};
pub(crate) use group_motion::Fold;
#[cfg(test)]
pub(crate) use groups::GroupIds;
pub(crate) use groups::{GroupId, Pick, Shown, Slot};
pub(crate) use layouts::Layouts;
pub(crate) use location::{LocalFile, Location, ReviewCheckout};
#[cfg(any(target_os = "macos", windows))]
pub(crate) use native::Pages;
pub(crate) use store::{Scope, Store, Tab, TabId};
pub(crate) use tab_appear::{Leaving, Listed};
pub(crate) use tab_scroll::{Thumb, ThumbDrag};
pub(crate) use view::{Browser, scope};

/// Whether this build can show a page inside the window. Elsewhere a browser
/// tab request opens the system browser instead.
pub(crate) const EMBEDDED: bool = cfg!(any(target_os = "macos", windows));

pub(crate) use herdr_pane_view::WebUrl;
