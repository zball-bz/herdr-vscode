//! Keys and text: special keys and chords become semantic key events, text and
//! IME compositions arrive through the platform input handler, and an open find
//! bar takes both. Mirrors herdr-gpui's window input without its menus.
use super::{PaneCommand, PaneView, PaneViewEvent, find_bar::Direction};
use crate::terminal::key_input;
use gpui::{
    Bounds, Context, EntityInputHandler, KeyDownEvent, KeyUpEvent, Pixels, Point, UTF16Selection,
    Window,
};
use herdr_protocol::ClientPaneInputEvent;
use std::ops::Range;

impl PaneView {
    pub(super) fn key_down(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        // A new press goes wherever this decides; only the pane branch at the
        // end holds it again for its release.
        self.held.forget(&event.keystroke.key);
        let keystroke = &event.keystroke;
        let modifiers = keystroke.modifiers;
        let key = keystroke.key.as_str();
        if self.find.is_some() {
            if self.find_key(event, window, cx) {
                cx.stop_propagation();
                window.prevent_default();
            }
            return;
        }
        // Copy: Cmd-C, Ctrl-Shift-C, and Ctrl-C while a selection waits for it
        // (with copy-on-select the release already copied, and Ctrl-C must
        // interrupt the pane).
        let copy_chord = (modifiers.platform && !modifiers.control)
            || (modifiers.control && modifiers.shift && !modifiers.alt)
            || (modifiers.control
                && !modifiers.shift
                && !modifiers.alt
                && !self.style.copy_on_select);
        if key.eq_ignore_ascii_case("c")
            && copy_chord
            && self.selection.is_some()
            && self.copy_selection(cx)
        {
            self.selection = None;
            cx.notify();
            cx.stop_propagation();
            window.prevent_default();
            return;
        }
        let paste_chord = (modifiers.platform && !modifiers.control)
            || (modifiers.control && modifiers.shift && !modifiers.alt);
        if key.eq_ignore_ascii_case("v") && paste_chord {
            cx.emit(PaneViewEvent::PasteRequested);
            cx.stop_propagation();
            window.prevent_default();
            return;
        }
        if key.eq_ignore_ascii_case("f")
            && (modifiers.platform || modifiers.control && modifiers.shift)
        {
            self.command(PaneCommand::Find, window, cx);
            cx.stop_propagation();
            window.prevent_default();
            return;
        }
        if self.selection.take().is_some() {
            cx.notify();
        }
        if !self.marked.is_empty() {
            return;
        }
        if let Some(input) = key_input(event, self.style.alt_keys) {
            let input = self.held.press(&keystroke.key, input, self.report_all);
            self.send(vec![input], cx);
            cx.stop_propagation();
            window.prevent_default();
        } else if self.style.commit_text_on_key_down
            && !modifiers.control
            && !modifiers.platform
            && let Some(text) = keystroke.key_char.clone()
        {
            self.send(vec![ClientPaneInputEvent::TextCommit(text)], cx);
            cx.stop_propagation();
            window.prevent_default();
        }
    }

    /// Releases a key the pane received while Herdr reported that its focused
    /// pane wants every key event. Text stays with the input handler, so only
    /// keys sent as key events are released.
    pub(super) fn key_up(&mut self, event: &KeyUpEvent, _: &mut Window, cx: &mut Context<Self>) {
        let Some(release) = self.held.release(&event.keystroke.key) else {
            return;
        };
        if self.report_all && self.marked.is_empty() {
            self.send(vec![release], cx);
            cx.stop_propagation();
        }
    }

    /// Keys while the find bar is open. `true` when the key was the bar's.
    fn find_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let modifiers = event.keystroke.modifiers;
        match event.keystroke.key.as_str() {
            "escape" => self.close_find(cx),
            "enter" if modifiers.shift => self.step_find(Direction::Newer, cx),
            "enter" => self.step_find(Direction::Older, cx),
            "backspace" => {
                if let Some(find) = &mut self.find {
                    find.backspace();
                }
                self.refresh_find(cx);
            }
            "v" if modifiers.platform || modifiers.control => {
                cx.emit(PaneViewEvent::PasteRequested)
            }
            "f" if modifiers.platform || modifiers.control => self.open_find(window, cx),
            // Text reaches the bar through the input handler.
            _ => return false,
        }
        cx.notify();
        true
    }
}

impl EntityInputHandler for PaneView {
    fn text_for_range(
        &mut self,
        range: Range<usize>,
        adjusted: &mut Option<Range<usize>>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<String> {
        let text: Vec<u16> = self.marked.encode_utf16().collect();
        let range = range.start.min(text.len())..range.end.min(text.len());
        *adjusted = Some(range.clone());
        Some(String::from_utf16_lossy(&text[range]))
    }

    fn selected_text_range(
        &mut self,
        _: bool,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        let end = self.marked.encode_utf16().count();
        Some(UTF16Selection {
            range: end..end,
            reversed: false,
        })
    }

    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        (!self.marked.is_empty()).then(|| 0..self.marked.encode_utf16().count())
    }

    fn unmark_text(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        self.marked.clear();
        cx.notify();
    }

    fn replace_text_in_range(
        &mut self,
        _: Option<Range<usize>>,
        text: &str,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.marked.clear();
        if let Some(find) = &mut self.find {
            find.insert(text);
            self.refresh_find(cx);
        } else if !text.is_empty() {
            if self.selection.take().is_some() {
                cx.notify();
            }
            self.send(vec![ClientPaneInputEvent::TextCommit(text.into())], cx);
        }
        cx.notify();
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        _: Option<Range<usize>>,
        text: &str,
        _: Option<Range<usize>>,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.marked = text.into();
        cx.notify();
    }

    fn bounds_for_range(
        &mut self,
        range: Range<usize>,
        _: Bounds<Pixels>,
        window: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let surface = self.surface.as_deref();
        let cell_height = self.cell_height();
        let cursor = crate::terminal::input_cursor_bounds(
            surface,
            self.bounds.origin,
            self.cell_width,
            cell_height,
        );
        Some(self.painter.borrow().composition_bounds(
            &self.marked,
            range,
            cursor,
            crate::terminal::input_area(surface, self.bounds, self.cell_width, cell_height),
            &self.style.font,
            window,
        ))
    }

    fn character_index_for_point(
        &mut self,
        _: Point<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<usize> {
        None
    }
}
