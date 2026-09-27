import { type EditorState, type SelectionRange, StateEffect, StateField, type Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

// When rendered Markdown shows its source: while a selection touches it. Shared by the live-preview
// plugin and the block field (display math, diagrams), so both reveal and settle together.

// While the mouse button is down, syntax stays shown or hidden as it was when the press started, so
// the text doesn't reflow under a drag. It settles once, on release.
const setFrozenSelection = StateEffect.define<readonly SelectionRange[] | null>();
export const frozenSelection = StateField.define<readonly SelectionRange[] | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setFrozenSelection)) return e.value;
    return value && tr.docChanged ? value.map((r) => r.map(tr.changes)) : value;
  },
});

export const freezeDuringDrag = EditorView.domEventHandlers({
  mousedown(e, view) {
    if (e.button !== 0 || view.state.field(frozenSelection)) return false;
    view.dispatch({ effects: setFrozenSelection.of(view.state.selection.ranges) });
    // Released on the window, so a drag that ends outside the editor still settles. A button released
    // outside the app window sends no mouseup, so a move with no button held, a key press, or losing
    // focus also end it.
    const events: [string, (e: Event) => void][] = [
      ["mouseup", () => release()],
      ["pointerup", () => release()],
      ["pointercancel", () => release()],
      ["mousemove", (e) => { if (((e as MouseEvent).buttons & 1) === 0) release(); }],
      ["keydown", () => release()],
      ["blur", () => release()],
    ];
    const release = () => {
      for (const [type, handler] of events) window.removeEventListener(type, handler, true);
      if (view.state.field(frozenSelection, false)) view.dispatch({ effects: setFrozenSelection.of(null) });
    };
    for (const [type, handler] of events) window.addEventListener(type, handler, true);
    return false;
  },
});

export function frozenChanged(tr: Transaction) {
  return tr.startState.field(frozenSelection, false) !== tr.state.field(frozenSelection, false);
}

export function touches(state: EditorState, from: number, to: number) {
  const ranges = state.field(frozenSelection, false) ?? state.selection.ranges;
  for (const r of ranges) if (r.from <= to && r.to >= from) return true;
  return false;
}

export function lineTouched(state: EditorState, pos: number) {
  const line = state.doc.lineAt(pos);
  return touches(state, line.from, line.to);
}
