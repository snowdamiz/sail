mod composer;

use std::borrow::Cow;

use composer::{Composer, bind_composer_keys};
use gpui::{
    App, Bounds, Context, Entity, FocusHandle, FontWeight, KeyBinding, Role, TitlebarOptions,
    Window, WindowBounds, WindowOptions, actions, div, prelude::*, px, rgb, size,
};

const TITLE: &str = "Sail GPUI preview";
const PROJECT: &str = "Sail";
const THREAD: &str = "Release checklist";
const FONT: &str = "IBM Plex Sans";
const ACCENT: u32 = 0x8eb8ff;

actions!(preview, [NextFocus, PreviousFocus]);

fn open_fixture(cx: &mut App) -> gpui::Result<gpui::WindowHandle<Fixture>> {
    // WebGL2 and WebGPU expose different subpixel blending capabilities.
    cx.set_text_rendering_mode(gpui::TextRenderingMode::Grayscale);
    cx.text_system().add_fonts(vec![
        Cow::Borrowed(include_bytes!("../fonts/IBMPlexSans-Regular.ttf")),
        Cow::Borrowed(include_bytes!("../fonts/IBMPlexSans-SemiBold.ttf")),
    ])?;
    bind_composer_keys(cx);
    cx.bind_keys([
        KeyBinding::new("tab", NextFocus, None),
        KeyBinding::new("shift-tab", PreviousFocus, None),
    ]);
    let bounds = Bounds::centered(None, size(px(880.), px(560.)), cx);
    let window = cx.open_window(
        WindowOptions {
            titlebar: Some(TitlebarOptions {
                title: Some(TITLE.into()),
                ..Default::default()
            }),
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            app_id: Some("sail-client".into()),
            ..Default::default()
        },
        |window, cx| {
            let project = cx.focus_handle().tab_index(0).tab_stop(true);
            project.focus(window, cx);
            let composer =
                cx.new(|cx| Composer::new(cx.focus_handle().tab_index(1).tab_stop(true)));
            cx.new(|_| Fixture { project, composer })
        },
    )?;
    cx.activate(true);
    Ok(window)
}

#[cfg(not(target_arch = "wasm32"))]
pub fn run_native() {
    gpui_platform::application()
        .with_quit_mode(gpui::QuitMode::LastWindowClosed)
        .run(|cx| {
            if cx.displays().is_empty() {
                eprintln!("Sail GPUI preview needs a desktop display");
                std::process::exit(1);
            }
            let outcome = open_fixture(cx).and_then(|window| {
                window.update(cx, |_, window, _| {
                    window.on_next_frame(|window, _| {
                        println!("Sail GPUI preview ready (scale {})", window.scale_factor());
                    });
                })
            });
            if let Err(error) = outcome {
                eprintln!("Could not open Sail GPUI preview: {error:#}");
                std::process::exit(1);
            }
        });
}

struct Fixture {
    project: FocusHandle,
    composer: Entity<Composer>,
}

impl Render for Fixture {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let composer_focus = self.composer.read(cx).focus.clone();
        let focus_composer = move |_: &gpui::ClickEvent, window: &mut Window, cx: &mut App| {
            composer_focus.focus(window, cx);
        };
        div()
            .size_full()
            .flex()
            .font_family(FONT)
            .text_size(px(14.))
            .text_color(rgb(0xe8e8eb))
            .bg(rgb(0x18181b))
            .on_action(|_: &NextFocus, window, cx| window.focus_next(cx))
            .on_action(|_: &PreviousFocus, window, cx| window.focus_prev(cx))
            .child(
                div()
                    .w(px(204.))
                    .flex_shrink_0()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .p_3()
                    .border_r_1()
                    .border_color(rgb(0x333337))
                    .bg(rgb(0x202024))
                    .child(
                        div()
                            .px_2()
                            .py_1()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(PROJECT),
                    )
                    .child(
                        div()
                            .id("preview-thread")
                            .role(Role::Button)
                            .aria_label(THREAD)
                            .track_focus(&self.project)
                            .px_2()
                            .py_1()
                            .rounded_md()
                            .border_1()
                            .border_color(rgb(0x323237))
                            .bg(rgb(0x323237))
                            .focus(|style| style.border_color(rgb(ACCENT)))
                            .on_click(focus_composer)
                            .child(THREAD),
                    ),
            )
            .child(
                div()
                    .min_w_0()
                    .flex_1()
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .id("thread-heading")
                            .role(Role::Heading)
                            .aria_label(THREAD)
                            .px_5()
                            .py_3()
                            .border_b_1()
                            .border_color(rgb(0x333337))
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(THREAD),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_h_0()
                            .flex()
                            .flex_col()
                            .gap_4()
                            .px_5()
                            .pt_6()
                            .child(
                                div()
                                    .self_end()
                                    .max_w_full()
                                    .rounded_lg()
                                    .px_3()
                                    .py_2()
                                    .bg(rgb(0x34343b))
                                    .child("What is left before the release?"),
                            )
                            .child("Build the client, verify the fixture, and review the results."),
                    )
                    .child(div().px_5().pb_5().child(self.composer.clone())),
            )
    }
}

#[cfg(target_arch = "wasm32")]
mod web {
    use std::{cell::Cell, rc::Rc};

    use futures_channel::oneshot;
    use gpui::Application;
    use gpui_web::{WebBackendPreference, WebPlatform};
    use wasm_bindgen::prelude::*;

    #[wasm_bindgen]
    pub async fn start(backend: String) -> Result<(), JsValue> {
        let backend = match backend.as_str() {
            "auto" => WebBackendPreference::Auto,
            "webgpu" => WebBackendPreference::WebGpu,
            "webgl" => WebBackendPreference::WebGl,
            _ => return Err(JsValue::from_str("Unknown graphics backend")),
        };
        gpui_platform::web_init();
        let (complete, launched) = oneshot::channel();
        let graphics_ready = Rc::new(Cell::new(false));
        let window_graphics_ready = graphics_ready.clone();
        Application::with_platform(Rc::new(WebPlatform::new_with_backend(false, backend))).run(
            move |cx| {
                window_graphics_ready.set(true);
                match super::open_fixture(cx) {
                    Ok(window) => {
                        let result = window.update(cx, |_, window, _| {
                            window.on_next_frame(move |window, _| {
                                let _ = complete.send(Ok(window.scale_factor()));
                            });
                        });
                        if let Err(error) = result {
                            web_sys::console::error_1(&error.to_string().into());
                        }
                    }
                    Err(error) => {
                        let _ = complete.send(Err(error.to_string()));
                    }
                }
            },
        );
        // GPUI drops the launch callback if neither graphics backend can start.
        let scale = launched
            .await
            .map_err(|_| {
                if !graphics_ready.get() {
                    attribute("error", "graphics");
                    JsValue::from_str("GPUI graphics initialization failed")
                } else {
                    JsValue::from_str("GPUI did not present a window")
                }
            })?
            .map_err(|error| JsValue::from_str(&error))?;
        attribute("scale", &scale.to_string());
        Ok(())
    }

    pub fn attribute(name: &str, value: &str) {
        if let Some(root) = web_sys::window()
            .and_then(|window| window.document())
            .and_then(|document| document.document_element())
        {
            let name = format!("data-{name}");
            if root.get_attribute(&name).as_deref() != Some(value) {
                let _ = root.set_attribute(&name, value);
            }
        }
    }
}
