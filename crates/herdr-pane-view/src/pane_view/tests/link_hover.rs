use super::*;

/// Every `LinkHovered` report, in order.
fn hovers(events: &Events) -> Vec<Option<HoveredLink>> {
    events
        .borrow()
        .iter()
        .filter_map(|event| match event {
            PaneViewEvent::LinkHovered(hovered) => Some(hovered.clone()),
            _ => None,
        })
        .collect()
}

#[gpui::test]
fn the_link_under_the_pointer_is_reported_once_with_its_cells(cx: &mut TestAppContext) {
    let (view, cx, events) = view(cx, surface("see https://example.com/docs now", false));
    events.borrow_mut().clear();
    let (origin, cell_width) = view.read_with(cx, |view, _| (view.bounds.origin, view.cell_width));
    for col in [6., 10., 20.] {
        let at = cell(&view, cx, col, 0.);
        cx.simulate_mouse_move(at, None, Modifiers::default());
    }
    let link = HoveredLink {
        link: LinkActivation::Web("https://example.com/docs".into()),
        bounds: Bounds::new(
            origin + point(px(4. * cell_width), px(0.)),
            gpui::size(px(24. * cell_width), px(CELL_HEIGHT)),
        ),
    };
    assert_eq!(
        hovers(&events),
        [Some(link)],
        "moving along one link reports it once"
    );
    let off = cell(&view, cx, 30., 0.);
    cx.simulate_mouse_move(off, None, Modifiers::default());
    assert_eq!(hovers(&events).last(), Some(&None));
}

#[gpui::test]
fn a_held_button_withdraws_the_link_until_release(cx: &mut TestAppContext) {
    let (view, cx, events) = view(cx, surface("open src/store.ts now", false));
    events.borrow_mut().clear();
    let on_path = cell(&view, cx, 7., 0.);
    cx.simulate_mouse_move(on_path, None, Modifiers::default());
    cx.simulate_mouse_down(on_path, MouseButton::Left, Modifiers::default());
    let dragged = cell(&view, cx, 9., 0.);
    cx.simulate_mouse_move(dragged, MouseButton::Left, Modifiers::default());
    cx.simulate_mouse_up(dragged, MouseButton::Left, Modifiers::default());
    let path = |hovered: &Option<HoveredLink>| hovered.as_ref().map(|hovered| hovered.link.clone());
    let reported: Vec<_> = hovers(&events).iter().map(path).collect();
    let store = Some(LinkActivation::Path {
        pane_id: "p".into(),
        path: "src/store.ts".into(),
    });
    assert_eq!(reported, [store.clone(), None, store]);
}

#[gpui::test]
fn new_output_under_a_resting_pointer_is_read_again(cx: &mut TestAppContext) {
    let (view, cx, events) = view(cx, surface("see https://example.com now", false));
    let at = cell(&view, cx, 8., 0.);
    cx.simulate_mouse_move(at, None, Modifiers::default());
    events.borrow_mut().clear();
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            view.set_surface(
                Some(Arc::new(surface("plain text without links", false))),
                Arc::default(),
                Some("p".into()),
                cx,
            )
        })
    });
    assert_eq!(hovers(&events), [None]);
}
