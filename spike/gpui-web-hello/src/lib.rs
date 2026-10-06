// Feasibility check: does a GPUI app (the framework herdr-gpui paints with) build for the browser,
// and how large is it? Renders a terminal-like grid of colored cells.
use gpui::{App, Context, IntoElement, ParentElement, Render, Styled, Window, WindowOptions, div, prelude::*, rgb};
use wasm_bindgen::prelude::*;

static FONT: &[u8] = include_bytes!("/usr/local/share/fonts/JetBrainsMono/JetBrainsMono-Regular.ttf");

struct Grid;

impl Render for Grid {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        div().size_full().bg(rgb(0x1e1e1e)).font_family("JetBrains Mono").text_size(gpui::px(14.)).flex().flex_col().children((0..40).map(|y| {
            div().flex().children((0..24).map(move |x| {
                div().bg(rgb(((x * 10) << 16 | (y * 6) << 8 | 0x40) as u32)).text_color(rgb(0xd4d4d4)).child("ab ")
            }))
        }))
    }
}

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
    gpui_web::init_logging();
    let platform = std::rc::Rc::new(gpui_web::WebPlatform::new(false));
    gpui::Application::with_platform(platform).run(|cx: &mut App| {
        cx.text_system().add_fonts(vec![std::borrow::Cow::Borrowed(FONT)]).unwrap();
        cx.open_window(WindowOptions::default(), |_, cx| cx.new(|_| Grid)).unwrap();
    });
}
