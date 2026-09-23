import { syntaxTree } from "@codemirror/language";
import type { EditorState, Range } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

// Focus mode (F8): every block except the one holding the caret fades back. The plugin only
// marks the current block's lines; the fading itself is CSS on `.ov-focus`.

const blocks = new Set([
  "Paragraph",
  "ATXHeading1", "ATXHeading2", "ATXHeading3", "ATXHeading4", "ATXHeading5", "ATXHeading6",
  "SetextHeading1", "SetextHeading2",
  "FencedCode", "CodeBlock", "Table", "HTMLBlock", "HorizontalRule",
]);

const current = Decoration.line({ class: "cm-focus-current" });

function currentBlock(state: EditorState): { from: number; to: number } {
  const head = state.selection.main.head;
  for (let n: ReturnType<typeof syntaxTree>["topNode"] | null = syntaxTree(state).resolveInner(head, 1); n; n = n.parent) {
    if (blocks.has(n.name)) return { from: n.from, to: n.to };
  }
  const line = state.doc.lineAt(head);
  return { from: line.from, to: line.to };
}

function build(state: EditorState): DecorationSet {
  const { from, to } = currentBlock(state);
  const out: Range<Decoration>[] = [];
  for (let n = state.doc.lineAt(from).number; n <= state.doc.lineAt(to).number; n++) {
    out.push(current.range(state.doc.line(n).from));
  }
  return Decoration.set(out);
}

export const focusMode = [
  ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view.state);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.selectionSet) this.decorations = build(u.state);
      }
    },
    { decorations: (v) => v.decorations },
  ),
  EditorView.editorAttributes.of({ class: "ov-focus" }),
];
