import { EditorState, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

export function lineSeparator(text: string): string | undefined {
  return text.includes("\r\n") && !text.replace(/\r\n/g, "").includes("\n") ? "\r\n" : undefined;
}

export function makeState(text: string, extensions: Extension) {
  const separator = lineSeparator(text);
  return EditorState.create({ doc: text, extensions: separator ? [extensions, EditorState.lineSeparator.of(separator)] : extensions });
}

export function replaceDocument(view: EditorView, text: string, extensions: Extension): EditorState {
  const state = makeState(text, extensions);
  view.setState(state);
  return state;
}
