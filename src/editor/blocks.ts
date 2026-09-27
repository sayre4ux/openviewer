import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Extension, type Range, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { loadMath, MAX_FORMULAS, mathFragment, mathReady, renderMath } from "../render/math";
import { displayMathSource } from "./math";
import { frozenChanged, touches } from "./reveal";

// Display math rendered in place of its source, as a block widget. Block widgets span lines, so they
// come from a state field (as tables do), not from the live-preview view plugin. A block shows its
// source while a selection touches any of its lines; clicking the rendering puts the caret there.
// Rendering is decoration only: nothing here changes the document.

type Container = "quote" | "list";

interface Block {
  from: number; // whole lines, including any container prefix
  to: number;
  node: number; // the syntax node's start, the key livePreview asks about
  source: string; // the text handed to the renderer
  containers: Container[]; // enclosing blockquotes and list items, outermost first
  marker: string | null; // a list bullet on the block's first line
}

interface Blocks {
  math: Block[];
  // Formulas from this position on stay as source (the document's formula budget is spent).
  cutoff: number;
  hasMath: boolean;
  decorations: DecorationSet;
  shown: Set<number>;
}

// Dispatched when a renderer finishes loading, so waiting formulas render.
const refresh = StateEffect.define<null>();
export function renderRefreshed(u: ViewUpdate): boolean {
  return u.transactions.some((tr) => tr.effects.some((e) => e.is(refresh)));
}

function containersOf(state: EditorState, node: SyntaxNode): { containers: Container[]; marker: string | null } {
  const containers: Container[] = [];
  for (let p = node.parent; p; p = p.parent) {
    if (p.name === "Blockquote") containers.unshift("quote");
    else if (p.name === "ListItem") containers.unshift("list");
  }
  let marker: string | null = null;
  const item = node.parent?.name === "ListItem" ? node.parent : null;
  const mark = item?.getChild("ListMark");
  if (item && mark && state.doc.lineAt(mark.from).number === state.doc.lineAt(node.from).number) {
    marker = item.parent?.name === "OrderedList" ? state.sliceDoc(mark.from, mark.to) : "•";
  }
  return { containers, marker };
}

function block(state: EditorState, node: SyntaxNode, source: string): Block {
  return {
    from: state.doc.lineAt(node.from).from,
    to: state.doc.lineAt(node.to).to,
    node: node.from,
    source,
    ...containersOf(state, node),
  };
}

// Nodes whose insides never hold math.
const opaque = new Set(["FencedCode", "CodeBlock", "HTMLBlock", "Table", "CommentBlock", "ProcessingInstructionBlock"]);

function scan(state: EditorState): Omit<Blocks, "decorations" | "shown"> {
  const math: Block[] = [];
  let formulas = 0;
  let cutoff = Infinity;
  syntaxTree(state).iterate({
    enter: (ref) => {
      const name = ref.name;
      if (opaque.has(name)) return false;
      if (name !== "InlineMath" && name !== "DisplayMath") return;
      formulas++;
      if (formulas === MAX_FORMULAS + 1) cutoff = ref.from;
      if (name === "DisplayMath") math.push(block(state, ref.node, displayMathSource(state, ref.node)));
      return false;
    },
  });
  return { math, cutoff, hasMath: formulas > 0 };
}

function decorate(state: EditorState, found: Omit<Blocks, "decorations" | "shown">): Blocks {
  const out: Range<Decoration>[] = [];
  const shown = new Set<number>();
  if (mathReady()) {
    for (const b of found.math) {
      if (b.node >= found.cutoff || touches(state, b.from, b.to)) continue;
      out.push(Decoration.replace({ widget: new DisplayMathWidget(b), block: true }).range(b.from, b.to));
      shown.add(b.node);
    }
  }
  return { ...found, decorations: Decoration.set(out, true), shown };
}

const blocksField = StateField.define<Blocks>({
  create: (state) => decorate(state, scan(state)),
  update(value, tr) {
    if (tr.docChanged || syntaxTree(tr.startState) !== syntaxTree(tr.state)) return decorate(tr.state, scan(tr.state));
    if (tr.selection || frozenChanged(tr) || tr.effects.some((e) => e.is(refresh))) return decorate(tr.state, value);
    return value;
  },
  provide: (field) => EditorView.decorations.from(field, (v) => v.decorations),
});

// Whether the block whose syntax node starts at `from` is showing its rendering.
export function isRenderedBlock(state: EditorState, from: number): boolean {
  return state.field(blocksField, false)?.shown.has(from) ?? false;
}

export function mathCutoff(state: EditorState): number {
  return state.field(blocksField, false)?.cutoff ?? Infinity;
}

// Loads KaTeX once a document has a formula; the formulas render when it arrives.
let mathRequested = false;
function requestMath(view: EditorView) {
  if (mathRequested || mathReady()) return;
  mathRequested = true;
  loadMath().then(
    () => view.dispatch({ effects: refresh.of(null) }),
    () => { mathRequested = false; },
  );
}

const mathLoader = ViewPlugin.define((view) => {
  const check = (v: EditorView) => {
    if (!mathReady() && v.state.field(blocksField).hasMath) requestMath(v);
  };
  check(view);
  return {
    update: (u: ViewUpdate) => {
      if (u.startState.field(blocksField) !== u.state.field(blocksField)) check(u.view);
    },
  };
});

// The widget's frame: one nested box per enclosing quote or list item, so quote bars and list
// indents continue through the block, and the list bullet when the block starts an item.
function frame(b: Block, className: string): { wrap: HTMLElement; inner: HTMLElement } {
  const wrap = document.createElement("div");
  wrap.className = className;
  let inner = wrap;
  for (const kind of b.containers) {
    const box = document.createElement("div");
    box.className = kind === "quote" ? "cm-md-block-quote" : "cm-md-block-list";
    inner.appendChild(box);
    inner = box;
  }
  if (b.marker) {
    const marker = document.createElement("span");
    marker.className = "cm-md-block-marker";
    marker.textContent = b.marker;
    inner.appendChild(marker);
  }
  return { wrap, inner };
}

// A click shows the source: the caret goes to the end of the block's first content line.
function revealOnClick(view: EditorView, wrap: HTMLElement) {
  wrap.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    const doc = view.state.doc;
    const first = doc.lineAt(view.posAtDOM(wrap));
    const line = first.number < doc.lines ? doc.line(first.number + 1) : first;
    view.dispatch({ selection: { anchor: line.to } });
    view.focus();
  });
}

function failureNode(source: string, message: string) {
  const box = document.createElement("div");
  box.className = "cm-md-render-failed";
  const code = document.createElement("pre");
  code.className = "cm-md-render-source";
  code.textContent = source;
  const note = document.createElement("div");
  note.className = "cm-md-render-note";
  note.textContent = message;
  box.append(code, note);
  return box;
}

const sameFrame = (a: Block, b: Block) =>
  a.source === b.source && a.marker === b.marker && a.containers.join() === b.containers.join();

class DisplayMathWidget extends WidgetType {
  constructor(readonly block: Block) {
    super();
  }
  eq(other: DisplayMathWidget) {
    return sameFrame(other.block, this.block);
  }
  get estimatedHeight() {
    return 64;
  }
  toDOM(view: EditorView) {
    const { wrap, inner } = frame(this.block, "cm-md-math-block");
    const result = renderMath(this.block.source, "display");
    if (result.ok) {
      const box = document.createElement("div");
      box.className = "cm-md-math-display";
      box.appendChild(mathFragment(result));
      inner.appendChild(box);
    } else {
      inner.appendChild(failureNode(`$$\n${this.block.source}\n$$`, result.message));
    }
    revealOnClick(view, wrap);
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

export const blockPreview: Extension = [blocksField, mathLoader];
