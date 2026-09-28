import { isolateHistory } from "@codemirror/commands";
import { EditorSelection, EditorState, type Extension, StateEffect, Transaction } from "@codemirror/state";
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
// in an insert becomes a real line break. A break is one position whatever its characters, so positions
// usually still hold; in a CR file a pasted "\r\n" is two (a break, then a stray "\n") and becomes one,
// so the selection is moved to the same place in the rewritten text, and effects are mapped.
function keepLineBreaks(separator: string) {
  return EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged) return tr;
    let stray = false;
    tr.changes.iterChanges((_fromA, _toA, _fromB, _toB, inserted) => {
      if (stray) return;
      for (const line of inserted.iterLines()) if (/[\r\n]/.test(line)) stray = true;
    });
    if (!stray) return tr;
    const normalize = (text: string) => text.replace(/\r\n|\r|\n/g, separator);
    const changes: { from: number; to: number; insert: string }[] = [];
    // Per change, in the transaction's own result: where its insert starts and ends, its text, and
    // how much longer (or shorter) the rewritten document is up to its end.
    const spans: { fromB: number; toB: number; text: string; shift: number }[] = [];
    let shift = 0;
    let resized = false;
    tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
      const text = inserted.sliceString(0, inserted.length, separator);
      const insert = normalize(text);
      const grew = tr.startState.toText(insert).length - inserted.length;
      if (grew) resized = true;
      shift += grew;
      changes.push({ from: fromA, to: toA, insert });
      spans.push({ fromB, toB, text, shift });
    });
    let selection = tr.selection;
    let effects = tr.effects;
    if (resized) {
      // A position inside an insert keeps its place in the text: the rewritten length of what comes
      // before it there. Elsewhere it moves by what the inserts before it grew or shrank.
      const move = (pos: number) => {
        let before = 0;
        for (const span of spans) {
          if (pos < span.fromB) break;
          if (pos <= span.toB) {
            const offset = tr.newDoc.sliceString(span.fromB, pos, separator).length;
            return span.fromB + before + tr.startState.toText(normalize(span.text.slice(0, offset))).length;
          }
          before = span.shift;
        }
        return pos + before;
      };
      if (selection) {
        const sel = tr.newSelection;
        selection = EditorSelection.create(sel.ranges.map((r) => EditorSelection.range(move(r.anchor), move(r.head))), sel.mainIndex);
      }
      effects = StateEffect.mapEffects(StateEffect.mapEffects(effects, tr.changes.invertedDesc), tr.startState.changes(changes).desc);
    }
    // A rebuilt transaction carries only what is copied here; these are the annotations history reads.
    const userEvent = tr.annotation(Transaction.userEvent);
    const isolate = tr.annotation(isolateHistory);
    return {
      changes,
      selection,
      effects,
      scrollIntoView: tr.scrollIntoView,
      annotations: [
        ...(userEvent ? [Transaction.userEvent.of(userEvent)] : []),
        Transaction.addToHistory.of(tr.annotation(Transaction.addToHistory) ?? true),
        ...(isolate ? [isolateHistory.of(isolate)] : []),
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
