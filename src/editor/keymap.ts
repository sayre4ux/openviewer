import { insertNewline, insertNewlineAndIndent } from "@codemirror/commands";
import { insertNewlineContinueMarkup } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { EditorSelection, type StateCommand } from "@codemirror/state";
import type { Command, KeyBinding } from "@codemirror/view";

const structuredBlocks = new Set(["ListItem", "Blockquote", "FencedCode", "CodeBlock", "Table", "HTMLBlock"]);

// Typora: Enter starts a new paragraph (a blank line in the source). Inside lists, quotes,
// and code, fall back to CodeMirror's markup-continuing newline.
const typoraEnter: Command = (view) => {
  const { state } = view;
  if (state.selection.ranges.length > 1) return false;
  const pos = state.selection.main.head;
  for (let n: ReturnType<typeof syntaxTree>["topNode"] | null = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent) {
    if (structuredBlocks.has(n.name)) return insertNewlineContinueMarkup(view) || insertNewlineAndIndent(view);
  }
  const line = state.doc.lineAt(pos);
  if (line.text.trim() === "") return insertNewline(view);
  view.dispatch(state.replaceSelection(state.lineBreak + state.lineBreak), { scrollIntoView: true, userEvent: "input" });
  return true;
};

function toggleWrap(marker: string): StateCommand {
  return ({ state, dispatch }) => {
    const len = marker.length;
    const tr = state.changeByRange((range) => {
      const before = state.sliceDoc(range.from - len, range.from);
      const after = state.sliceDoc(range.to, range.to + len);
      if (before === marker && after === marker) {
        return {
          changes: [
            { from: range.from - len, to: range.from },
            { from: range.to, to: range.to + len },
          ],
          range: EditorSelection.range(range.from - len, range.to - len),
        };
      }
      return {
        changes: [
          { from: range.from, insert: marker },
          { from: range.to, insert: marker },
        ],
        range: EditorSelection.range(range.from + len, range.to + len),
      };
    });
    dispatch(state.update(tr, { userEvent: "input" }));
    return true;
  };
}

function setHeading(level: number): StateCommand {
  return ({ state, dispatch }) => {
    const changes = [];
    const seen = new Set<number>();
    for (const r of state.selection.ranges) {
      const line = state.doc.lineAt(r.head);
      if (seen.has(line.from)) continue;
      seen.add(line.from);
      const existing = /^#{1,6} +/.exec(line.text);
      const current = existing ? existing[0].trim().length : 0;
      const target = current === level ? 0 : level; // pressing the same level again toggles off
      changes.push({
        from: line.from,
        to: line.from + (existing ? existing[0].length : 0),
        insert: target ? "#".repeat(target) + " " : "",
      });
    }
    dispatch(state.update({ changes, userEvent: "input" }));
    return true;
  };
}

// Enter behavior is fixed; formatting commands are bound through the customizable shortcuts.
export const typoraKeymap: KeyBinding[] = [
  { key: "Enter", run: typoraEnter },
  { key: "Shift-Enter", run: insertNewline },
];

export const formatCommands: Record<string, StateCommand> = {
  bold: toggleWrap("**"),
  italic: toggleWrap("*"),
  code: toggleWrap("`"),
  paragraph: setHeading(0),
  ...Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [`heading-${n}`, setHeading(n)])),
};
