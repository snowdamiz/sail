use std::ops::Range;

use gpui::{
    App, Bounds, ClipboardItem, Context, CursorStyle, ElementInputHandler, EntityInputHandler,
    FocusHandle, KeyBinding, MouseButton, Pixels, Point, Role, ShapedLine, TextAlign, TextRun,
    UTF16Selection, UnderlineStyle, Window, actions, canvas, div, fill, point, prelude::*, px, rgb,
    size,
};
use unicode_segmentation::UnicodeSegmentation;

use crate::ACCENT;

actions!(
    composer,
    [
        Left,
        Right,
        SelectLeft,
        SelectRight,
        SelectAll,
        Backspace,
        Delete,
        Copy,
        Paste
    ]
);

pub fn bind_composer_keys(cx: &mut App) {
    let context = Some("PreviewComposer");
    let [select_all, copy, paste] = if cx.platform_info().is_mac() {
        ["cmd-a", "cmd-c", "cmd-v"]
    } else {
        ["ctrl-a", "ctrl-c", "ctrl-v"]
    };
    cx.bind_keys([
        KeyBinding::new("left", Left, context),
        KeyBinding::new("right", Right, context),
        KeyBinding::new("shift-left", SelectLeft, context),
        KeyBinding::new("shift-right", SelectRight, context),
        KeyBinding::new(select_all, SelectAll, context),
        KeyBinding::new("backspace", Backspace, context),
        KeyBinding::new("delete", Delete, context),
        KeyBinding::new(copy, Copy, context),
    ]);
    if !cfg!(target_arch = "wasm32") {
        cx.bind_keys([KeyBinding::new(paste, Paste, context)]);
    }
}

pub struct Composer {
    pub focus: FocusHandle,
    draft: String,
    anchor: usize,
    caret: usize,
    marked: Option<Range<usize>>,
    layout: Option<(Point<Pixels>, ShapedLine)>,
}

impl Composer {
    pub fn new(focus: FocusHandle) -> Self {
        Self {
            focus,
            draft: String::new(),
            anchor: 0,
            caret: 0,
            marked: None,
            layout: None,
        }
    }

    fn selection(&self) -> Range<usize> {
        self.anchor.min(self.caret)..self.anchor.max(self.caret)
    }

    fn select(&mut self, anchor: usize, caret: usize, window: &Window, cx: &mut Context<Self>) {
        self.anchor = anchor;
        self.caret = caret;
        window.notify_text_selection_changed(&self.focus);
        cx.notify();
    }

    fn move_caret(&mut self, right: bool, extend: bool, window: &Window, cx: &mut Context<Self>) {
        if self.marked.is_some() {
            cx.propagate();
            return;
        }
        let selection = self.selection();
        let caret = if !extend && !selection.is_empty() {
            if right {
                selection.end
            } else {
                selection.start
            }
        } else {
            adjacent_grapheme(&self.draft, self.caret, right)
        };
        self.select(if extend { self.anchor } else { caret }, caret, window, cx);
    }

    fn remove(&mut self, forward: bool, window: &mut Window, cx: &mut Context<Self>) {
        if self.marked.is_some() {
            cx.propagate();
            return;
        }
        if self.selection().is_empty() {
            self.anchor = adjacent_grapheme(&self.draft, self.caret, forward);
        }
        self.replace_text_in_range(None, "", window, cx);
    }

    fn bytes(&self, range: Range<usize>) -> Range<usize> {
        let start = byte_offset(&self.draft, range.start);
        start..byte_offset(&self.draft, range.end).max(start)
    }

    fn utf16(&self, range: Range<usize>) -> Range<usize> {
        self.draft[..range.start].encode_utf16().count()
            ..self.draft[..range.end].encode_utf16().count()
    }

    fn replace(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        marked_selection: Option<Range<usize>>,
        window: &Window,
        cx: &mut Context<Self>,
    ) {
        let range = range
            .map(|range| self.bytes(range))
            .or_else(|| self.marked.clone())
            .unwrap_or_else(|| self.selection());
        let text = text.replace(['\r', '\n'], " ");
        self.draft.replace_range(range.clone(), &text);

        let start = range.start;
        let end = start + text.len();
        self.marked = marked_selection
            .as_ref()
            .filter(|_| start < end)
            .map(|_| start..end);
        let (anchor, caret) = marked_selection
            .map(|selection| {
                (
                    start + byte_offset(&text, selection.start),
                    start + byte_offset(&text, selection.end),
                )
            })
            .unwrap_or((end, end));
        self.anchor = anchor;
        self.caret = caret;
        self.layout = None;
        window.notify_text_input_changed(&self.focus);
        cx.notify();
    }
}

fn byte_offset(text: &str, utf16_offset: usize) -> usize {
    let mut remaining = utf16_offset;
    for (offset, character) in text.char_indices() {
        if remaining == 0 {
            return offset;
        }
        remaining = remaining.saturating_sub(character.len_utf16());
    }
    text.len()
}

fn adjacent_grapheme(text: &str, offset: usize, forward: bool) -> usize {
    let mut boundaries = text.grapheme_indices(true).map(|(byte, _)| byte);
    if forward {
        boundaries.find(|byte| *byte > offset).unwrap_or(text.len())
    } else {
        boundaries.rev().find(|byte| *byte < offset).unwrap_or(0)
    }
}

impl EntityInputHandler for Composer {
    fn text_for_range(
        &mut self,
        range: Range<usize>,
        actual: &mut Option<Range<usize>>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<String> {
        let bytes = self.bytes(range);
        *actual = Some(self.utf16(bytes.clone()));
        Some(self.draft[bytes].to_owned())
    }

    fn selected_text_range(
        &mut self,
        _: bool,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        Some(UTF16Selection {
            range: self.utf16(self.selection()),
            reversed: self.caret < self.anchor,
        })
    }

    fn set_selected_text_range(
        &mut self,
        range: Range<usize>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let bytes = self.bytes(range);
        self.select(bytes.start, bytes.end, window, cx);
    }

    fn text_length_utf16(&mut self, _: &mut Window, _: &mut Context<Self>) -> Option<usize> {
        Some(self.draft.encode_utf16().count())
    }

    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        self.marked.clone().map(|range| self.utf16(range))
    }

    fn unmark_text(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.marked = None;
        window.notify_text_input_changed(&self.focus);
        cx.notify();
    }

    fn replace_text_in_range(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.replace(range, text, None, window, cx);
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        selection: Option<Range<usize>>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let end = text.encode_utf16().count();
        self.replace(range, text, Some(selection.unwrap_or(end..end)), window, cx);
    }

    fn bounds_for_range(
        &mut self,
        range: Range<usize>,
        bounds: Bounds<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let (origin, line) = self.layout.as_ref()?;
        Some(range_bounds(
            *origin,
            line,
            self.bytes(range),
            bounds.size.height,
        ))
    }

    fn character_index_for_point(
        &mut self,
        position: Point<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<usize> {
        let (origin, line) = self.layout.as_ref()?;
        let byte = line.closest_index_for_x(position.x - origin.x);
        Some(self.draft[..byte].encode_utf16().count())
    }
}

fn range_bounds(
    origin: Point<Pixels>,
    line: &ShapedLine,
    range: Range<usize>,
    height: Pixels,
) -> Bounds<Pixels> {
    let a = line.x_for_index(range.start);
    let b = line.x_for_index(range.end);
    Bounds::new(
        point(origin.x + a.min(b), origin.y),
        size((b - a).abs(), height),
    )
}

impl Render for Composer {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let composer = cx.entity();
        div()
            .id("composer")
            .accessibility_id("sail.composer")
            .role(Role::TextInput)
            .aria_label("Message")
            .aria_value(self.draft.clone())
            .when(cfg!(not(target_arch = "wasm32")), |element| {
                let value = self.draft.clone();
                let anchor = value[..self.anchor].chars().count();
                let caret = value[..self.caret].chars().count();
                element.a11y_synthetic_children(move |tree| {
                    use gpui::accesskit::{Node, TextPosition, TextSelection};

                    let id = tree.synthetic_node_id(0);
                    let mut run = Node::new(Role::TextRun);
                    run.set_character_lengths(
                        value
                            .chars()
                            .map(|character| character.len_utf8() as u8)
                            .collect::<Vec<_>>(),
                    );
                    run.set_value(value);
                    tree.push_child(id, run);
                    let position = |character_index| TextPosition {
                        node: id,
                        character_index,
                    };
                    tree.parent_node().set_text_selection(TextSelection {
                        anchor: position(anchor),
                        focus: position(caret),
                    });
                })
            })
            .key_context("PreviewComposer")
            .track_focus(&self.focus)
            .cursor(CursorStyle::IBeam)
            .overflow_hidden()
            .rounded_lg()
            .border_1()
            .border_color(rgb(0x494950))
            .bg(rgb(0x25252a))
            .focus(|style| style.border_color(rgb(ACCENT)))
            .shadow_md()
            .px_3()
            .py_2()
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, event: &gpui::MouseDownEvent, window, cx| {
                    this.focus.focus(window, cx);
                    if let Some((origin, line)) = &this.layout {
                        let caret = line.closest_index_for_x(event.position.x - origin.x);
                        this.select(
                            if event.modifiers.shift {
                                this.anchor
                            } else {
                                caret
                            },
                            caret,
                            window,
                            cx,
                        );
                    }
                }),
            )
            .on_action(
                cx.listener(|this, _: &Left, window, cx| this.move_caret(false, false, window, cx)),
            )
            .on_action(
                cx.listener(|this, _: &Right, window, cx| this.move_caret(true, false, window, cx)),
            )
            .on_action(cx.listener(|this, _: &SelectLeft, window, cx| {
                this.move_caret(false, true, window, cx)
            }))
            .on_action(cx.listener(|this, _: &SelectRight, window, cx| {
                this.move_caret(true, true, window, cx)
            }))
            .on_action(cx.listener(|this, _: &SelectAll, window, cx| {
                this.select(0, this.draft.len(), window, cx)
            }))
            .on_action(
                cx.listener(|this, _: &Backspace, window, cx| this.remove(false, window, cx)),
            )
            .on_action(cx.listener(|this, _: &Delete, window, cx| this.remove(true, window, cx)))
            .on_action(cx.listener(|this, _: &Copy, _, cx| {
                if !this.selection().is_empty() {
                    cx.write_to_clipboard(ClipboardItem::new_string(
                        this.draft[this.selection()].to_owned(),
                    ));
                }
            }))
            .on_action(cx.listener(|this, _: &Paste, window, cx| {
                if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
                    this.replace_text_in_range(None, &text, window, cx);
                }
            }))
            .child(
                canvas(
                    |_, _, _| (),
                    move |bounds, (), window, cx| {
                        let focus = composer.read(cx).focus.clone();
                        window.handle_input(
                            &focus,
                            ElementInputHandler::new(bounds, composer.clone()),
                            cx,
                        );
                        composer.update(cx, |this, cx| this.paint(bounds, window, cx));
                    },
                )
                .w_full()
                .h(px(22.)),
            )
    }
}

impl Composer {
    fn paint(&mut self, bounds: Bounds<Pixels>, window: &mut Window, cx: &mut Context<Self>) {
        let focused = self.focus.is_focused(window);
        #[cfg(target_arch = "wasm32")]
        {
            let selection = self.utf16(self.selection());
            crate::web::attribute("draft", &self.draft);
            crate::web::attribute(
                "selection",
                &format!("{}:{}", selection.start, selection.end),
            );
            crate::web::attribute("focus", if focused { "composer" } else { "project" });
        }

        let style = window.text_style();
        let empty = self.draft.is_empty();
        let display = if empty {
            "Write a message…"
        } else {
            &self.draft
        };
        let run = TextRun {
            len: display.len(),
            font: style.font(),
            color: if empty {
                rgb(0xaaaab4).into()
            } else {
                style.color
            },
            background_color: None,
            underline: None,
            strikethrough: None,
        };
        let runs = match &self.marked {
            Some(marked) => vec![
                TextRun {
                    len: marked.start,
                    ..run.clone()
                },
                TextRun {
                    len: marked.len(),
                    underline: Some(UnderlineStyle {
                        color: Some(run.color),
                        thickness: px(1.),
                        wavy: false,
                    }),
                    ..run.clone()
                },
                TextRun {
                    len: display.len() - marked.end,
                    ..run
                },
            ],
            None => vec![run],
        };
        let runs = runs
            .into_iter()
            .filter(|run| run.len > 0)
            .collect::<Vec<_>>();
        let line = window
            .text_system()
            .shape_line(display.to_owned().into(), px(14.), &runs, None);
        let line_height = bounds.size.height;
        let scroll = (line.x_for_index(self.caret) - bounds.size.width + px(2.)).max(px(0.));
        let origin = point(bounds.left() - scroll, bounds.top());
        if focused {
            let selection = self.selection();
            let highlight = if selection.is_empty() {
                Bounds::new(
                    point(origin.x + line.x_for_index(self.caret), origin.y),
                    size(px(1.), line_height),
                )
            } else {
                range_bounds(origin, &line, selection, line_height)
            };
            window.paint_quad(fill(
                highlight,
                if self.selection().is_empty() {
                    rgb(ACCENT)
                } else {
                    rgb(0x435d87)
                },
            ));
        }
        if let Err(error) = line.paint(origin, line_height, TextAlign::Left, None, window, cx) {
            eprintln!("Could not paint the preview composer: {error:#}");
        }
        self.layout = (!empty).then_some((origin, line));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16_positions_map_to_character_boundaries() {
        let text = "A🙂漢";
        assert_eq!(
            (0..=5)
                .map(|offset| byte_offset(text, offset))
                .collect::<Vec<_>>(),
            [0, 1, 5, 5, 8, 8]
        );
    }

    #[test]
    fn cursor_moves_across_combining_marks_and_emoji_as_units() {
        let text = "e\u{301}🙂";
        assert_eq!(adjacent_grapheme(text, 0, true), 3);
        assert_eq!(adjacent_grapheme(text, 3, true), text.len());
        assert_eq!(adjacent_grapheme(text, text.len(), false), 3);
        assert_eq!(adjacent_grapheme(text, 3, false), 0);
    }
}
