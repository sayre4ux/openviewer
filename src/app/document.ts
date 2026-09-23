import { EditorState, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

// How the file's line breaks are written. "mixed" is more than one kind; those open as LF.
export type LineEndings = "lf" | "crlf" | "cr" | "mixed";

export function lineEndings(text: string): LineEndings {
  let crlf = false;
  let lf = false;
  let cr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 13 && text.charCodeAt(i + 1) === 10) {
      crlf = true;
      i++;
    } else if (c === 10) {
      lf = true;
    } else if (c === 13) {
      cr = true;
    } else {
      continue;
    }
    if ((crlf ? 1 : 0) + (lf ? 1 : 0) + (cr ? 1 : 0) > 1) return "mixed";
  }
  if (crlf) return "crlf";
  if (cr) return "cr";
  return "lf";
}

// Undefined means LF, CodeMirror's default. CR and CRLF are kept so a save writes the same bytes.
export function lineSeparator(text: string): string | undefined {
  const kind = lineEndings(text);
  if (kind === "crlf") return "\r\n";
  if (kind === "cr") return "\r";
  return undefined;
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
