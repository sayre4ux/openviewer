import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { type EditorState, type Extension, Prec, type Range, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import type { SyntaxNode, Tree } from "@lezer/common";
import {
  cachedDiagram, type DiagramFailure, type DiagramResult, diagramGeneration, diagramsEnabled, MAX_DIAGRAMS, renderDiagram,
} from "../render/diagram";
import { loadMath, MAX_FORMULAS, mathFragment, mathReady, renderMath, type MathFailure } from "../render/math";
import { setI18nAttribute, setI18nText } from "../shared/i18n";
import { displayMathSource } from "./math";
import { frozenChanged, touches } from "./reveal";

// Display math and Mermaid diagrams rendered in place of their source, as block widgets. Block widgets
// span lines, so they come from a state field (as tables do), not from the live-preview view plugin. A
// block shows its source while a selection touches any of its lines; clicking the rendering puts the
// caret there. Rendering is decoration only: nothing here changes the document.

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
  diagrams: Block[];
  // Formulas from this position on stay as source (the document's formula budget is spent).
  cutoff: number;
  hasMath: boolean;
  decorations: DecorationSet;
  shown: Set<number>;
}

// Dispatched when a renderer finishes loading or a setting changes, so blocks render again.
const refresh = StateEffect.define<null>();
export function renderRefreshed(u: ViewUpdate): boolean {
  return u.transactions.some((tr) => tr.effects.some((e) => e.is(refresh)));
}
export function refreshRendering(view: EditorView) {
  view.dispatch({ effects: refresh.of(null) });
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

// The code inside a closed ```mermaid fence (the info string, trimmed, is "mermaid" in any case), or
// null. Container markers (a quote's `>`) and the indentation all lines share are left out.
function mermaidSource(state: EditorState, node: SyntaxNode): string | null {
  const open = node.firstChild;
  const close = node.lastChild;
  if (open?.name !== "CodeMark" || close?.name !== "CodeMark" || close.from <= open.to) return null;
  const info = node.getChild("CodeInfo");
  if (!info || state.sliceDoc(info.from, info.to).trim().toLowerCase() !== "mermaid") return null;
  const doc = state.doc;
  const first = doc.lineAt(open.from).number + 1;
  const last = doc.lineAt(close.from).number - 1;
  const quoteEnds = new Map<number, number>();
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.name === "QuoteMark") quoteEnds.set(doc.lineAt(c.from).number, doc.sliceString(c.to, c.to + 1) === " " ? c.to + 1 : c.to);
  }
  const lines: string[] = [];
  for (let n = first; n <= last; n++) {
    const line = doc.line(n);
    lines.push(doc.sliceString(quoteEnds.get(n) ?? line.from, line.to));
  }
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length));
  return (Number.isFinite(indent) && indent > 0 ? lines.map((l) => l.slice(Math.min(indent, /^[ \t]*/.exec(l)![0].length))) : lines).join("\n");
}

// Nodes whose insides never hold math.
// DECISION: math inside table cells stays source in this release. Cells render through `renderInline`
// in tables.ts, a regex renderer feeding innerHTML; routing KaTeX through it is a separate change.
const opaque = new Set(["CodeBlock", "HTMLBlock", "Table", "CommentBlock", "ProcessingInstructionBlock"]);

function scan(state: EditorState, tree: Tree = syntaxTree(state)): Omit<Blocks, "decorations" | "shown"> {
  const math: Block[] = [];
  const diagrams: Block[] = [];
  let formulas = 0;
  let cutoff = Infinity;
  tree.iterate({
    enter: (ref) => {
      const name = ref.name;
      if (name === "FencedCode") {
        const source = diagrams.length < MAX_DIAGRAMS ? mermaidSource(state, ref.node) : null;
        if (source !== null) diagrams.push(block(state, ref.node, source));
        return false;
      }
      if (opaque.has(name)) return false;
      if (name !== "InlineMath" && name !== "DisplayMath") return;
      formulas++;
      if (formulas === MAX_FORMULAS + 1) cutoff = ref.from;
      if (name === "DisplayMath") math.push(block(state, ref.node, displayMathSource(state, ref.node)));
      return false;
    },
  });
  return { math, diagrams, cutoff, hasMath: formulas > 0 };
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
  if (diagramsEnabled()) {
    for (const b of found.diagrams) {
      if (touches(state, b.from, b.to)) continue;
      out.push(Decoration.replace({ widget: new DiagramWidget(b), block: true }).range(b.from, b.to));
      shown.add(b.node);
    }
  }
  return { ...found, decorations: Decoration.set(out, true), shown };
}

// Renders a freshly opened document's first diagrams, in order, while it has no edits to lose.
// DECISION: the first 20, for at most 2 seconds, and only while the document is clean. Mermaid can't
// be interrupted, so if one of them freezes the window, it happens before anything was typed; the
// hang guard then blocks it on the next launch.
export async function prerenderDiagrams(state: EditorState, stillClean: () => boolean) {
  if (!diagramsEnabled()) return;
  const generation = diagramGeneration();
  const tree = ensureSyntaxTree(state, state.doc.length, 200) ?? syntaxTree(state);
  const sources = scan(state, tree).diagrams.slice(0, 20).map((b) => b.source);
  const started = performance.now();
  for (const source of sources) {
    if (performance.now() - started > 2000 || generation !== diagramGeneration() || !stillClean()) return;
    await renderDiagram(source);
  }
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

// For the browser test hook: what the field found and what it is showing rendered.
export function blockStats(state: EditorState) {
  const b = state.field(blocksField, false);
  return b ? { math: b.math.length, diagrams: b.diagrams.length, shown: b.shown.size } : null;
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

function failureNode(source: string, messageKey: string) {
  const box = document.createElement("div");
  box.className = "cm-md-render-failed";
  const code = document.createElement("pre");
  code.className = "cm-md-render-source";
  code.textContent = source;
  const note = document.createElement("div");
  note.className = "cm-md-render-note";
  setI18nText(note, messageKey);
  box.append(code, note);
  return box;
}

function mathFailureKey(reason: MathFailure): string {
  return reason === "too-long" ? "math.tooLong" : reason === "too-large" ? "math.tooLarge" : "math.invalid";
}

function diagramFailureKey(reason: DiagramFailure): string {
  return {
    off: "diagram.off", "too-long": "diagram.tooLong", "too-large": "diagram.tooLarge",
    limit: "diagram.limit", syntax: "diagram.syntax", unsupported: "diagram.unsupported",
    "unsafe-output": "diagram.unsafeOutput", timeout: "diagram.timeout", blocked: "diagram.blocked",
  }[reason];
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
      inner.appendChild(failureNode(`$$\n${this.block.source}\n$$`, mathFailureKey(result.reason)));
    }
    revealOnClick(view, wrap);
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

// A Mermaid diagram: the renderer's image, or the code and why it isn't a picture. The widget's root
// stays put and only its contents change when the render arrives, as with images.
class DiagramWidget extends WidgetType {
  constructor(readonly block: Block) {
    super();
  }
  eq(other: DiagramWidget) {
    return sameFrame(other.block, this.block);
  }
  get estimatedHeight() {
    const hit = cachedDiagram(this.block.source);
    return hit?.ok ? hit.height + 16 : 160;
  }
  toDOM(view: EditorView) {
    const { wrap, inner } = frame(this.block, "cm-md-diagram");
    const box = document.createElement("div");
    box.className = "cm-md-diagram-box";
    inner.appendChild(box);
    const source = this.block.source;
    const show = (result: DiagramResult) => {
      if (result.ok && result.dataUrl.startsWith("data:image/svg+xml;base64,")) {
        const img = document.createElement("img");
        img.className = "cm-md-diagram-image";
        setI18nAttribute(img, "alt", "block.mermaidAlt");
        img.addEventListener("error", () => box.replaceChildren(failureNode(source, "block.imageFailed")), { once: true });
        img.width = result.width;
        img.height = result.height;
        img.src = result.dataUrl;
        box.replaceChildren(img);
      } else if (!result.ok) {
        const failed = failureNode(source, diagramFailureKey(result.reason));
        if (result.reason === "blocked") {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "cm-md-render-anyway";
          setI18nText(button, "block.renderAnyway");
          button.addEventListener("mousedown", (e) => e.preventDefault()); // keep the editor selection
          button.addEventListener("click", () => {
            box.replaceChildren(pendingNode());
            void renderDiagram(source, { force: true }).then(show);
          });
          failed.appendChild(button);
        }
        box.replaceChildren(failed);
      }
      view.requestMeasure();
    };
    const hit = cachedDiagram(source);
    if (hit) {
      show(hit);
    } else {
      box.appendChild(pendingNode());
      void renderDiagram(source).then(show);
    }
    revealOnClick(view, wrap);
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

function pendingNode() {
  const note = document.createElement("div");
  note.className = "cm-md-diagram-pending";
  setI18nText(note, "block.rendering");
  return note;
}

// The line ranges of the blocks showing a rendering, in document order.
function shownRanges(state: EditorState): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  const cursor = state.field(blocksField).decorations.iter();
  for (; cursor.value; cursor.next()) out.push({ from: cursor.from, to: cursor.to });
  return out;
}

// Arrow keys move onto a rendered block (which shows its source) instead of jumping over it, and
// Backspace at the start of the line below one shows it rather than joining that line to its closing
// fence. Where the caret would go is CodeMirror's own vertical motion, so wrapped lines move as usual.
function enterBlock(forward: boolean) {
  return (view: EditorView) => {
    const range = view.state.selection.main;
    if (!range.empty || view.state.selection.ranges.length > 1) return false;
    const head = range.head;
    const target = view.moveVertically(range, forward).head;
    const blocks = shownRanges(view.state);
    const hit = forward
      ? blocks.find((b) => b.from > head && target >= b.from)
      : blocks.reverse().find((b) => b.to < head && target <= b.to);
    if (!hit) return false;
    view.dispatch({ selection: { anchor: forward ? hit.from : hit.to }, scrollIntoView: true });
    return true;
  };
}

const blockKeys = Prec.high(keymap.of([
  { key: "ArrowDown", run: enterBlock(true) },
  { key: "ArrowUp", run: enterBlock(false) },
  {
    key: "Backspace",
    run: (view) => {
      const range = view.state.selection.main;
      if (!range.empty || view.state.selection.ranges.length > 1) return false;
      const above = shownRanges(view.state).find((b) => b.to + 1 === range.head && view.state.doc.lineAt(range.head).from === range.head);
      if (!above) return false;
      view.dispatch({ selection: { anchor: above.to } });
      return true;
    },
  },
]));

export const blockPreview: Extension = [blocksField, mathLoader, blockKeys];
