import { syntaxTree } from "@codemirror/language";
import { type ChangeSpec, EditorSelection, type EditorState, type Line } from "@codemirror/state";
import { type Command, EditorView, type KeyBinding } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";

// Small typing conveniences on top of plain Markdown. Each one changes only the characters it is
// about, as one undoable step, and falls back to the default behavior when it doesn't apply.

const EMPHASIS = new Set(["Emphasis", "StrongEmphasis", "Strikethrough"]);
const EMPHASIS_MARKS = new Set(["EmphasisMark", "StrikethroughMark"]);

// `**bold|**` + space → `**bold** |`: a space typed just inside a closing marker lands outside it,
// so the next word isn't formatted. Nested runs (`***both|***`) are hopped together.
// DECISION: not inside `code`, where a trailing space is often part of the code.
function closingMarkerEnd(state: EditorState, pos: number): number | null {
  const before = state.sliceDoc(pos - 1, pos);
  if (!before || /\s/.test(before)) return null;
  let node = syntaxTree(state).resolveInner(pos, 1);
  if (EMPHASIS_MARKS.has(node.name) && node.parent) node = node.parent;
  let end = pos;
  for (let n: typeof node | null = node; n && EMPHASIS.has(n.name); n = n.parent) {
    const close = n.lastChild;
    if (!close || !EMPHASIS_MARKS.has(close.name) || close.from !== end) break;
    end = close.to;
  }
  return end > pos ? end : null;
}

const spaceOutOfEmphasis = EditorView.inputHandler.of((view, from, to, text) => {
  if (text !== " " || from !== to || view.state.selection.ranges.length > 1) return false;
  const end = closingMarkerEnd(view.state, from);
  if (end === null) return false;
  view.dispatch({ changes: { from: end, insert: " " }, selection: { anchor: end + 1 }, userEvent: "input.type" });
  return true;
});

// Text that is source, not prose: a `~` typed over a selection there is just a `~`.
const LITERAL = new Set(["InlineCode", "InlineMath", "DisplayMath", "FencedCode", "CodeBlock", "HTMLBlock"]);

function touchesLiteral(state: EditorState, from: number, to: number): boolean {
  let found = false;
  syntaxTree(state).iterate({ from, to, enter: (n) => {
    if (found) return false;
    if (LITERAL.has(n.name)) found = true;
  } });
  return found;
}

// Whether text typed or pasted at `pos` goes inside code, math, or HTML, not merely next to it. Side 0
// enters only nodes that extend on both sides of pos. Blocks without a closing mark end at their last
// character, though, so text at their end (or, for a fence never closed, anywhere below) is inside too.
export function insideLiteral(state: EditorState, pos: number): boolean {
  const tree = syntaxTree(state);
  for (let n: SyntaxNode | null = tree.resolveInner(pos, 0); n; n = n.parent) {
    if (LITERAL.has(n.name)) return true;
  }
  // Where a block that ends here ends: at pos itself (an unclosed fence takes the rest of the document,
  // blank lines included), or at the last non-space character before it.
  let back = pos;
  while (back > 0 && /\s/.test(state.sliceDoc(back - 1, back))) back--;
  for (const end of back === pos ? [pos] : [pos, back]) {
    for (let n: SyntaxNode | null = tree.resolveInner(end, -1); n; n = n.parent) {
      if (n.to !== end) continue;
      if (n.name === "FencedCode") return !(n.lastChild?.name === "CodeMark" && n.lastChild.from > n.from);
      // Indented code: only more text on its last line.
      if (n.name === "CodeBlock") return end === pos;
      // HTML: the same line, or the one right after it (no blank line has ended the block yet).
      if (n.name === "HTMLBlock") return state.doc.lineAt(pos).number - state.doc.lineAt(end).number <= 1;
    }
  }
  return false;
}

// `~` with text selected strikes the selection through instead of replacing it.
const tildeStrikes = EditorView.inputHandler.of((view, _from, _to, text) => {
  if (text !== "~" || view.state.selection.ranges.every((r) => r.empty)) return false;
  const { state } = view;
  if (state.selection.ranges.some((r) => !r.empty && touchesLiteral(state, r.from, r.to))) return false;
  view.dispatch(state.update(state.changeByRange((range) => {
    if (range.empty) return { range };
    return {
      changes: [{ from: range.from, insert: "~~" }, { from: range.to, insert: "~~" }],
      range: EditorSelection.range(range.from + 2, range.to + 2),
    };
  }), { userEvent: "input" }));
  return true;
});

// A list item's line: indent, marker, the space after it, and an optional task box.
const LIST_PREFIX = /^( *)([-+*]|\d{1,9}[.)])( +)(\[[ xX]\] +)?/;

type ListLine = { line: Line; indent: number; contentFrom: number };

function listLine(state: EditorState, line: Line): ListLine | null {
  const m = LIST_PREFIX.exec(line.text);
  if (!m) return null;
  // The parser has to agree: a `-` in a code block or a paragraph line isn't a list item.
  const markerPos = line.from + m[1].length;
  let inList = false;
  for (let n: ReturnType<typeof syntaxTree>["topNode"] | null = syntaxTree(state).resolveInner(markerPos, 1); n; n = n.parent) {
    if (n.name === "FencedCode" || n.name === "CodeBlock" || n.name === "HTMLBlock") return null;
    if (n.name === "ListItem") inList = true;
  }
  return inList ? { line, indent: m[1].length, contentFrom: line.from + m[0].length } : null;
}

// ⌘⌫ on a list item deletes back to the start of its text and keeps the bullet: `- buy milk|` → `- |`.
const deleteToItemStart: Command = (view) => {
  const { state } = view;
  const range = state.selection.main;
  if (state.selection.ranges.length > 1 || !range.empty) return false;
  const item = listLine(state, state.doc.lineAt(range.head));
  if (!item || range.head <= item.contentFrom) return false;
  view.dispatch({ changes: { from: item.contentFrom, to: range.head }, selection: { anchor: item.contentFrom }, userEvent: "delete.backward" });
  return true;
};

const indentOf = (text: string) => /^ */.exec(text)![0].length;

// The item plus the lines that belong to it (children and continuation lines, indented deeper;
// blank lines count while more of the item follows).
function subtreeEnd(state: EditorState, item: ListLine): number {
  let last = item.line.number;
  for (let n = item.line.number + 1; n <= state.doc.lines; n++) {
    const text = state.doc.line(n).text;
    if (text.trim() === "") continue;
    // A tab-indented line counts as deeper, so the caller sees it and leaves the item alone.
    if (indentOf(text) <= item.indent && !/^ *\t/.test(text)) break;
    last = n;
  }
  return last;
}

// The indent a list item should get when it is indented (Tab) or outdented (⇧Tab), or null to leave it.
// Tab: under the previous sibling's text, so the item becomes its child. ⇧Tab: its parent's indent.
function targetIndent(state: EditorState, item: ListLine, outdent: boolean): number | null {
  for (let n = item.line.number - 1, seen = 0; n >= 1 && seen < 256; n--, seen++) {
    const line = state.doc.line(n);
    if (line.text.trim() === "") continue;
    const other = listLine(state, line);
    const indent = indentOf(line.text);
    if (!other) {
      if (indent <= item.indent) return outdent && item.indent > 0 ? 0 : null;
      continue;
    }
    if (outdent) {
      if (other.indent < item.indent) return other.indent;
    } else if (other.indent === item.indent) {
      return other.contentFrom - other.line.from;
    } else if (other.indent < item.indent) {
      return null; // the first child of its parent can't go deeper
    }
  }
  return outdent && item.indent > 0 ? 0 : null;
}

function shiftList(outdent: boolean): Command {
  return (view) => {
    const { state } = view;
    const items: ListLine[] = [];
    for (const range of state.selection.ranges) {
      const first = state.doc.lineAt(range.from).number;
      const last = state.doc.lineAt(range.to).number;
      for (let n = first; n <= last; n++) {
        const item = listLine(state, state.doc.line(n));
        if (!item) {
          if (state.doc.line(n).text.trim() !== "") return false; // mixed selection: default Tab
          continue;
        }
        if (!items.some((i) => i.line.number === n)) items.push(item);
      }
    }
    if (!items.length) return false;
    const changes: ChangeSpec[] = [];
    let covered = 0;
    for (const item of items.sort((a, b) => a.line.number - b.line.number)) {
      if (item.line.number <= covered) continue; // moves with the item above it
      const end = subtreeEnd(state, item);
      covered = end;
      // Indentation with tab characters can't be shifted by spaces without stranding lines: leave
      // those to the default Tab.
      for (let n = item.line.number; n <= end; n++) if (/^[ ]*\t/.test(state.doc.line(n).text)) return false;
      const target = targetIndent(state, item, outdent);
      if (target === null || target === item.indent) continue;
      const delta = target - item.indent;
      for (let n = item.line.number; n <= end; n++) {
        const line = state.doc.line(n);
        if (line.text.trim() === "") continue;
        if (delta > 0) changes.push({ from: line.from, insert: " ".repeat(delta) });
        else changes.push({ from: line.from, to: line.from + Math.min(-delta, indentOf(line.text)) });
      }
    }
    // On a list line Tab is always ours, even when there is nothing to move, so focus stays put.
    if (changes.length) view.dispatch({ changes, userEvent: outdent ? "delete.dedent" : "input.indent" });
    return true;
  };
}

export const smartTyping = [spaceOutOfEmphasis, tildeStrikes];

export const smartTypingKeymap: KeyBinding[] = [
  { key: "Mod-Backspace", run: deleteToItemStart },
  { key: "Tab", run: shiftList(false), shift: shiftList(true) },
];
