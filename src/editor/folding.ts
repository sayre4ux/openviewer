import { codeFolding, foldable, foldedRanges, foldEffect, foldCode, syntaxTree, unfoldAll, unfoldCode, unfoldEffect } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import type { EditorState, Range } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";

// Heading folding. The Markdown language already knows each heading's section (from the heading
// line to the next heading of the same or higher level); this adds the chevron, the placeholder,
// and "collapse all". Folds are view state only: the text never changes.

// The heading level of the heading that starts on this line (ATX `#`, setext underline, or inside a
// block quote), from the syntax tree, so a `# comment` in a code block is not a heading.
function headingLevel(state: EditorState, lineFrom: number): number | null {
  const line = state.doc.lineAt(lineFrom);
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(line.from, 1); n; n = n.parent) {
    const m = /^(?:ATXHeading|SetextHeading)([1-6])$/.exec(n.name);
    if (!m) continue;
    const before = state.sliceDoc(line.from, Math.max(line.from, n.from));
    return n.from >= line.from && /^[ \t>]*$/.test(before) ? Number(m[1]) : null;
  }
  return null;
}

function sectionRange(state: EditorState, lineFrom: number) {
  const line = state.doc.lineAt(lineFrom);
  if (headingLevel(state, line.from) === null) return null;
  return foldable(state, line.from, line.to);
}

function foldedAt(state: EditorState, from: number, to: number) {
  let found = false;
  foldedRanges(state).between(from, to, (a, b) => {
    if (a === from && b === to) found = true;
  });
  return found;
}

class Chevron extends WidgetType {
  constructor(readonly folded: boolean, readonly lineFrom: number) {
    super();
  }
  eq(other: Chevron) {
    return other.folded === this.folded && other.lineFrom === this.lineFrom;
  }
  toDOM(view: EditorView) {
    const el = document.createElement("span");
    el.className = "cm-md-fold" + (this.folded ? " is-folded" : "");
    el.setAttribute("role", "button");
    el.setAttribute("aria-label", this.folded ? "Expand section" : "Collapse section");
    el.setAttribute("aria-expanded", String(!this.folded));
    el.addEventListener("mousedown", (e) => {
      e.preventDefault(); // don't move the caret into the heading, which would reveal its marks
      const range = sectionRange(view.state, this.lineFrom);
      if (!range) return;
      const effect = foldedAt(view.state, range.from, range.to) ? unfoldEffect : foldEffect;
      view.dispatch({ effects: effect.of(range) });
    });
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

function chevrons(view: EditorView): DecorationSet {
  const out: Range<Decoration>[] = [];
  const { state } = view;
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to;) {
      const line = state.doc.lineAt(pos);
      const range = sectionRange(state, line.from);
      if (range) {
        const widget = new Chevron(foldedAt(state, range.from, range.to), line.from);
        out.push(Decoration.widget({ widget, side: -1 }).range(line.from));
      }
      pos = line.to + 1;
    }
  }
  return Decoration.set(out);
}

const chevronPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = chevrons(view);
    }
    update(u: ViewUpdate) {
      const foldsChanged = u.transactions.some((tr) => tr.effects.some((e) => e.is(foldEffect) || e.is(unfoldEffect)));
      if (u.docChanged || u.viewportChanged || foldsChanged) this.decorations = chevrons(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

export const headingFolding = [
  codeFolding({
    placeholderDOM: (_view, onclick) => {
      const el = document.createElement("span");
      el.className = "cm-md-folded";
      el.textContent = "…";
      el.title = "Folded section; click to expand";
      el.setAttribute("aria-label", "Folded section");
      el.addEventListener("click", onclick);
      return el;
    },
  }),
  chevronPlugin,
];

// "Collapse All Headings" folds the sections under the second level and deeper, so the top-level
// structure stays visible; a document without those folds its first-level headings.
// DECISION: the same rule as Typora's outline and flo-state; folding every H1 would hide nearly all.
function foldAllHeadings(view: EditorView) {
  const { state } = view;
  const sections: { from: number; to: number; level: number }[] = [];
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    const level = headingLevel(state, line.from);
    if (level === null) continue;
    const range = foldable(state, line.from, line.to);
    if (range) sections.push({ ...range, level });
  }
  const deep = sections.filter((s) => s.level >= 2);
  const targets = (deep.length ? deep : sections).filter((s) => !foldedAt(state, s.from, s.to));
  if (targets.length) view.dispatch({ effects: targets.map((s) => foldEffect.of({ from: s.from, to: s.to })) });
  return true;
}

// Fold or unfold the section the caret is in: the nearest heading at or above the caret whose
// section reaches the caret. Unfolding also opens a folded section whose heading holds the caret.
function sectionCommand(fold: boolean) {
  return (view: EditorView) => {
    const { state } = view;
    const head = state.selection.main.head;
    const caretLine = state.doc.lineAt(head).number;
    for (let n = caretLine; n >= 1; n--) {
      const line = state.doc.line(n);
      const range = sectionRange(state, line.from);
      if (!range || (n !== caretLine && head > range.to)) continue;
      if (fold === foldedAt(state, range.from, range.to)) return true;
      // Folding moves the caret to the heading, so it isn't left inside the hidden text.
      view.dispatch({ effects: (fold ? foldEffect : unfoldEffect).of(range), selection: fold ? { anchor: line.to } : undefined });
      return true;
    }
    return fold ? foldCode(view) : unfoldCode(view);
  };
}

export const foldCommands = {
  "fold-section": sectionCommand(true),
  "unfold-section": sectionCommand(false),
  "fold-all": foldAllHeadings,
  "unfold-all": (view: EditorView) => unfoldAll(view),
};
