import { EditorState, type Extension, Transaction } from "@codemirror/state";
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

// With a CR or CRLF separator, CodeMirror splits inserted text only on that separator, so a lone "\n"
// (from a replacement like `one\ntwo`, a regex `$&` across a line break, or any other insert) would stay
// inside a line and the file would be saved with mixed line endings. Every lone line-break character
// in an insert becomes a real line break; each is one character either way, so positions still hold.
function keepLineBreaks(separator: string) {
  return EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged) return tr;
    let stray = false;
    tr.changes.iterChanges((_fromA, _toA, _fromB, _toB, inserted) => {
      if (stray) return;
      for (const line of inserted.iterLines()) if (/[\r\n]/.test(line)) stray = true;
    });
    if (!stray) return tr;
    const changes: { from: number; to: number; insert: string }[] = [];
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      changes.push({ from: fromA, to: toA, insert: inserted.sliceString(0, inserted.length, separator).replace(/\r\n|\r|\n/g, separator) });
    });
    const userEvent = tr.annotation(Transaction.userEvent);
    return {
      changes,
      selection: tr.selection,
      effects: tr.effects,
      scrollIntoView: tr.scrollIntoView,
      annotations: [
        ...(userEvent ? [Transaction.userEvent.of(userEvent)] : []),
        Transaction.addToHistory.of(tr.annotation(Transaction.addToHistory) ?? true),
      ],
    };
  });
}

export function makeState(text: string, extensions: Extension) {
  const separator = lineSeparator(text);
  return EditorState.create({
    doc: text,
    extensions: separator ? [extensions, EditorState.lineSeparator.of(separator), keepLineBreaks(separator)] : extensions,
  });
}

export function replaceDocument(view: EditorView, text: string, extensions: Extension): EditorState {
  const state = makeState(text, extensions);
  view.setState(state);
  return state;
}
