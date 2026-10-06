//! Find in a pane's whole scrollback. The daemon searches (`pane.copy_search`)
//! with the shared [`Search`] model deciding what to ask and when; a match out
//! of view is scrolled to (`pane.scroll`). The bar takes text and keys while it
//! is open.
use super::{PaneView, Pending};
use crate::{
    find::{Search, Step},
    scrollback::reveal_offset,
    terminal_painter::Highlight,
    theme::Theme,
    time::Instant,
};
use gpui::{AnyElement, Context, IntoElement, ParentElement, Styled, Window, div, px, rgb};
use herdr_protocol::{PaneSurfacePane, RequestFailure, ScrollbackResponse};
use serde_json::json;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Direction {
    Older,
    Newer,
}

pub(super) struct FindBar {
    search: Search,
    query: String,
}

impl FindBar {
    /// Queries are one line: a pasted newline would never match a row.
    pub(super) fn insert(&mut self, text: &str) {
        self.query.extend(text.chars().filter(|c| !c.is_control()));
    }

    pub(super) fn backspace(&mut self) {
        self.query.pop();
    }

    pub(super) fn render(&self, theme: &Theme) -> AnyElement {
        let status = self
            .search
            .error()
            .map(str::to_owned)
            .unwrap_or_else(|| self.search.label());
        div()
            .absolute()
            .top(px(6.))
            .right(px(14.))
            .flex()
            .gap_2()
            .px_2()
            .py_1()
            .rounded_md()
            .border_1()
            .border_color(rgb(theme.active))
            .bg(rgb(theme.surface))
            .text_color(rgb(theme.foreground))
            .child(format!("Find: {}▏", self.query))
            .child(div().text_color(rgb(theme.muted)).child(status))
            .into_any_element()
    }
}

fn pane_of<'a>(view: &'a PaneView, pane_id: &str) -> Option<&'a PaneSurfacePane> {
    view.surface
        .as_deref()?
        .panes
        .iter()
        .find(|pane| pane.pane_id == pane_id)
}

impl PaneView {
    pub(super) fn open_find(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        window.focus(&self.focus, cx);
        if self.find.is_some() {
            return;
        }
        let Some(pane) = self
            .focused_pane
            .clone()
            .and_then(|id| pane_of(self, &id).cloned())
        else {
            return;
        };
        self.find = Some(FindBar {
            search: Search::new(&pane),
            query: String::new(),
        });
        cx.notify();
    }

    pub(super) fn close_find(&mut self, cx: &mut Context<Self>) {
        if self.find.take().is_some() {
            self.pending
                .retain(|_, pending| !matches!(pending, Pending::Find));
            cx.notify();
        }
    }

    pub(super) fn step_find(&mut self, direction: Direction, cx: &mut Context<Self>) {
        if let Some(find) = &mut self.find {
            find.search.step(match direction {
                Direction::Older => Step::Older,
                Direction::Newer => Step::Newer,
            });
        }
        self.pump_find(cx);
    }

    /// Follows an edited query and a pane whose content moved on.
    pub(super) fn refresh_find(&mut self, cx: &mut Context<Self>) {
        let Some(pane) = self
            .find
            .as_ref()
            .and_then(|find| pane_of(self, find.search.pane_id()).cloned())
        else {
            return;
        };
        if let Some(find) = &mut self.find {
            find.search.set_query(&find.query.clone());
            find.search.content_changed(&pane, Instant::now());
        }
        self.pump_find(cx);
    }

    fn pump_find(&mut self, cx: &mut Context<Self>) {
        let Some(find) = &self.find else {
            return;
        };
        let Some(pane) = pane_of(self, find.search.pane_id()) else {
            return;
        };
        let Some((step, params)) = find.search.next_request(pane) else {
            return;
        };
        let Ok(value) = serde_json::to_value(&params) else {
            return;
        };
        let token = self.request(Pending::Find, "pane.copy_search", value, cx);
        if let Some(find) = &mut self.find {
            find.search
                .sent(token.to_string(), &params, step, Instant::now());
        }
        cx.notify();
    }

    pub(super) fn find_answer(
        &mut self,
        token: u64,
        response: Result<ScrollbackResponse, RequestFailure>,
        cx: &mut Context<Self>,
    ) {
        let answer = response.and_then(|response| match response {
            ScrollbackResponse::PaneCopySearch(result) => Ok(result),
            _ => Err(RequestFailure::Client(
                "endpoint answered with a result of another method".into(),
            )),
        });
        let Some(find) = &mut self.find else {
            return;
        };
        let reveal = find.search.answer(&token.to_string(), answer);
        let pane_id = find.search.pane_id().to_owned();
        if let Some(range) = reveal
            && let Some(offset) =
                pane_of(self, &pane_id).and_then(|pane| reveal_offset(pane, range))
        {
            self.request(
                Pending::Ignore,
                "pane.scroll",
                json!({ "pane_id": pane_id, "offset_from_bottom": offset }),
                cx,
            );
        }
        self.pump_find(cx);
        cx.notify();
    }

    pub(super) fn find_highlights(&self) -> Vec<Highlight> {
        self.find
            .as_ref()
            .and_then(|find| {
                Some(
                    find.search
                        .highlights(pane_of(self, find.search.pane_id())?),
                )
            })
            .unwrap_or_default()
    }
}
