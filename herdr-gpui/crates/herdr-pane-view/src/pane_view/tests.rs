#![allow(clippy::unwrap_used)]
use super::*;
use gpui::{Modifiers, TestAppContext, VisualTestContext, point, px};
use herdr_protocol::{
    CellData, ClientKeyCode, ClientMouseKind, ClientShellPopupSurface, CopySearchResult, FrameData,
    PaneSurfacePane, SurfaceRect, TextPoint, TextRange,
};

const CELL_HEIGHT: f32 = 20.;

fn frame(text: &str, width: u16, height: u16) -> FrameData {
    let mut symbols = text.chars();
    FrameData {
        width,
        height,
        cells: (0..usize::from(width) * usize::from(height))
            .map(|_| CellData {
                symbol: symbols.next().unwrap_or(' ').to_string(),
                fg: 0,
                bg: 0,
                modifier: 0,
                skip: false,
                hyperlink: None,
            })
            .collect(),
        cursor: None,
        hyperlinks: vec![],
        graphics: vec![],
    }
}

fn surface(text: &str, mouse_reporting: bool) -> PaneSurfaceFrame {
    let rect = SurfaceRect {
        x: 0,
        y: 0,
        width: 80,
        height: 4,
    };
    PaneSurfaceFrame {
        boot_id: "boot".into(),
        projection_revision: 1,
        surface_revision: 1,
        frame: frame(text, 80, 4),
        splits: vec![],
        popup: None,
        graphics: Default::default(),
        panes: vec![PaneSurfacePane {
            pane_id: "p".into(),
            content_revision: 2,
            rect,
            inner_rect: rect,
            scrollbar_rect: None,
            scroll: None,
            focused: true,
            mouse_reporting,
            sgr_pixel_mouse: false,
            alternate_screen_active: false,
            pixel_width: 800,
            pixel_height: 80,
        }],
    }
}

fn style() -> PaneViewStyle {
    PaneViewStyle {
        font: gpui::font("Courier"),
        font_size: 14.,
        cell_height: CELL_HEIGHT,
        theme: Theme::default(),
        padding_left: 0.,
        alt_keys: true,
        copy_on_select: false,
        commit_text_on_key_down: false,
    }
}

type Events = Rc<RefCell<Vec<PaneViewEvent>>>;

/// A drawn, focused view showing `surface`, and the events it emits.
fn view(
    cx: &mut TestAppContext,
    surface: PaneSurfaceFrame,
) -> (gpui::Entity<PaneView>, &mut VisualTestContext, Events) {
    let (view, cx) = cx.add_window_view(|_, cx| PaneView::new(style(), cx));
    let events: Events = Rc::default();
    cx.update(|window, cx| {
        let sink = events.clone();
        cx.subscribe(&view, move |_, event: &PaneViewEvent, _| {
            sink.borrow_mut().push(event.clone())
        })
        .detach();
        view.update(cx, |view, cx| {
            view.set_surface(
                Some(Arc::new(surface)),
                Arc::default(),
                Some("p".into()),
                cx,
            );
        });
        window.focus(&view.focus_handle(cx), cx);
        window.refresh();
        window.draw(cx).clear(cx);
    });
    // Setting up may report the grid again: the first surface tells the view
    // whether herdr keeps a scrollbar column (`strip`).
    events.borrow_mut().clear();
    (view, cx, events)
}

fn inputs(events: &Events) -> Vec<ClientPaneInputEvent> {
    events
        .borrow()
        .iter()
        .filter_map(|event| match event {
            PaneViewEvent::Input { events, .. } => Some(events.clone()),
            _ => None,
        })
        .flatten()
        .collect()
}

fn cell(
    view: &gpui::Entity<PaneView>,
    cx: &mut VisualTestContext,
    col: f32,
    row: f32,
) -> Point<Pixels> {
    view.read_with(cx, |view, _| {
        view.bounds.origin
            + point(
                px((col + 0.5) * view.cell_width),
                px((row + 0.5) * CELL_HEIGHT),
            )
    })
}

#[gpui::test]
fn reports_its_grid_once_and_sends_text_and_keys_to_the_focused_pane(cx: &mut TestAppContext) {
    let (view, cx, events) = view(cx, surface("$ ", false));
    let redraw = |cx: &mut VisualTestContext| {
        cx.update(|window, cx| {
            window.refresh();
            window.draw(cx).clear(cx);
        })
    };
    let resizes = |events: &Events| {
        events
            .borrow()
            .iter()
            .filter(|event| matches!(event, PaneViewEvent::Resize { .. }))
            .count()
    };
    // The window's first draw reported the grid before the test subscribed;
    // a reconnect asks for it again, exactly once.
    cx.update(|_, cx| view.update(cx, |view, cx| view.reset_reported_size(cx)));
    redraw(cx);
    redraw(cx);
    assert_eq!(resizes(&events), 1);
    events.borrow_mut().clear();
    cx.simulate_input("hi");
    cx.simulate_keystrokes("enter");
    assert!(events.borrow().iter().all(|event| matches!(
        event,
        PaneViewEvent::Input { target: InputTarget::Pane(id), .. } if id == "p"
    )));
    let sent = inputs(&events);
    // The test platform commits typed text a character at a time.
    assert_eq!(
        sent[..2],
        [
            ClientPaneInputEvent::TextCommit("h".into()),
            ClientPaneInputEvent::TextCommit("i".into())
        ]
    );
    assert!(matches!(
        sent[2],
        ClientPaneInputEvent::Key {
            code: ClientKeyCode::Enter,
            ..
        }
    ));
}

#[gpui::test]
fn an_open_popup_takes_keyboard_input(cx: &mut TestAppContext) {
    let mut shown = surface("", false);
    shown.popup = Some(Box::new(ClientShellPopupSurface {
        terminal_id: "term".into(),
        title: "popup".into(),
        width: None,
        height: None,
        frame: frame("", 20, 2),
        mouse_reporting: false,
        sgr_pixel_mouse: false,
        pixel_width: 200,
        pixel_height: 40,
    }));
    let (_, cx, events) = view(cx, shown);
    events.borrow_mut().clear();
    cx.simulate_input("x");
    assert!(matches!(
        &events.borrow()[0],
        PaneViewEvent::Input { target: InputTarget::Popup(id), .. } if id == "term"
    ));
}

#[gpui::test]
fn ctrl_c_copies_a_selection_and_otherwise_interrupts(cx: &mut TestAppContext) {
    let (view, cx, events) = view(cx, surface("hello world", false));
    events.borrow_mut().clear();
    cx.simulate_keystrokes("ctrl-c");
    assert!(matches!(
        inputs(&events)[..],
        [ClientPaneInputEvent::Key {
            code: ClientKeyCode::Char('c'),
            modifiers: 2,
            ..
        }]
    ));
    events.borrow_mut().clear();
    let start = cell(&view, cx, 0., 0.) - point(px(3.), px(0.));
    let end = cell(&view, cx, 4., 0.) + point(px(3.), px(0.));
    cx.simulate_mouse_down(start, MouseButton::Left, Modifiers::default());
    cx.simulate_mouse_move(end, MouseButton::Left, Modifiers::default());
    cx.simulate_mouse_up(end, MouseButton::Left, Modifiers::default());
    cx.simulate_keystrokes("ctrl-c");
    assert_eq!(
        events.borrow().last(),
        Some(&PaneViewEvent::Copy("hello".into()))
    );
    assert!(
        inputs(&events).is_empty(),
        "the copy chord does not reach the pane"
    );
}

#[gpui::test]
fn link_modifier_click_opens_a_web_link(cx: &mut TestAppContext) {
    let (view, cx, events) = view(cx, surface("see https://example.com/docs now", false));
    events.borrow_mut().clear();
    let on_link = cell(&view, cx, 6., 0.);
    cx.simulate_click(on_link, Modifiers::secondary_key());
    assert_eq!(
        events.borrow().last(),
        Some(&PaneViewEvent::OpenLink(LinkActivation::Web(
            "https://example.com/docs".into()
        )))
    );
    events.borrow_mut().clear();
    cx.simulate_click(on_link, Modifiers::default());
    assert!(
        !events
            .borrow()
            .iter()
            .any(|event| matches!(event, PaneViewEvent::OpenLink(_)))
    );
}

#[gpui::test]
fn a_mouse_reporting_pane_owns_clicks_unless_shift_is_held(cx: &mut TestAppContext) {
    let (view, cx, events) = view(cx, surface("app", true));
    events.borrow_mut().clear();
    let at = cell(&view, cx, 1., 1.);
    cx.simulate_click(at, Modifiers::default());
    let kinds: Vec<_> = inputs(&events)
        .into_iter()
        .filter_map(|event| match event {
            ClientPaneInputEvent::Mouse { kind, .. } => Some(kind),
            _ => None,
        })
        .collect();
    assert!(matches!(
        kinds[..],
        [ClientMouseKind::Down(_), ClientMouseKind::Up(_)]
    ));
    events.borrow_mut().clear();
    cx.simulate_click(at, Modifiers::shift());
    assert!(inputs(&events).is_empty(), "shift keeps the click local");
}

#[gpui::test]
fn find_searches_through_the_daemon_and_scrolls_to_the_match(cx: &mut TestAppContext) {
    let mut shown = surface("", false);
    shown.panes[0].scroll = Some(herdr_protocol::PaneSurfaceScrollMetrics {
        offset_from_bottom: 0,
        max_offset_from_bottom: 100,
        viewport_rows: 4,
    });
    let (view, cx, events) = view(cx, shown);
    cx.update(|window, cx| view.update(cx, |view, cx| view.command(PaneCommand::Find, window, cx)));
    events.borrow_mut().clear();
    // A paste lands in the bar whole; typed text arrives a character at a time
    // and waits behind the request in flight.
    cx.update(|_, cx| view.update(cx, |view, cx| view.paste("needle".into(), cx)));
    let (token, params) = events
        .borrow()
        .iter()
        .find_map(|event| match event {
            PaneViewEvent::Request {
                token,
                method: "pane.copy_search",
                params,
            } => Some((*token, params.clone())),
            _ => None,
        })
        .unwrap();
    assert_eq!(params["query"], "needle");
    assert!(inputs(&events).is_empty(), "the bar takes the text");
    let found = TextRange {
        start: TextPoint { row: 10, col: 0 },
        end: TextPoint { row: 10, col: 5 },
    };
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            let result = CopySearchResult {
                pane_id: "p".into(),
                content_revision: 2,
                matches: vec![found],
                total: 1,
                current: Some(0),
                current_global: Some(0),
            };
            view.answer(token, Ok(ScrollbackResponse::PaneCopySearch(result)), cx);
        })
    });
    assert!(events.borrow().iter().any(|event| matches!(
        event,
        PaneViewEvent::Request {
            method: "pane.scroll",
            ..
        }
    )));
    cx.simulate_keystrokes("escape");
    assert!(view.read_with(cx, |view, _| view.find.is_none()));
}

#[gpui::test]
fn the_browser_option_commits_plain_keys_from_the_key_event(cx: &mut TestAppContext) {
    let (view, cx, events) = view(cx, surface("$ ", false));
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            let style = PaneViewStyle {
                commit_text_on_key_down: true,
                ..style()
            };
            view.set_style(style, cx);
        })
    });
    events.borrow_mut().clear();
    cx.simulate_keystrokes("x ctrl-x");
    let sent = inputs(&events);
    assert_eq!(sent[0], ClientPaneInputEvent::TextCommit("x".into()));
    assert!(
        matches!(
            sent[1],
            ClientPaneInputEvent::Key {
                code: ClientKeyCode::Char('x'),
                modifiers: 2,
                ..
            }
        ),
        "chords stay key events"
    );
    assert_eq!(sent.len(), 2, "nothing is committed twice");
}

mod cell_metrics;
mod link_hover;
mod padding;
mod scrollbar;
mod strip;
