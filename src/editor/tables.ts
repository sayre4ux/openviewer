import { isolateHistory, redo, undo } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import { type ChangeSpec, type EditorState, Prec, type Range, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap, WidgetType } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { fromEvent } from "../shared/keys";

// GFM tables render as an editable <table>, as in Typora. Each cell is its own small editor:
// while focused it shows the cell's raw Markdown, otherwise the rendered inline formatting.
// Every edit is local: typing rewrites only that cell, adding a row inserts one line, adding or
// removing a column touches one cell per line, alignment touches one delimiter cell. The rest of
// the file keeps its exact bytes. "Tidy" is the one explicit edit that reformats a whole table.
// Tables inside blockquotes and list items work too: each line keeps its container prefix, and
// new rows copy the delimiter row's prefix. Tables span several lines, so the widget is a block
// decoration, and block decorations have to come from a state field rather than a view plugin.

type Align = "left" | "center" | "right" | null;

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

// Past this many cells (rows × header columns) the table stays source text. The widget
// builds DOM and listeners for every cell, which freezes the window on a huge table.
const MAX_TABLE_CELLS = 5000;
// DECISION: a single table under the cap can be joined by enough others to freeze the window.
// Once another widget would pass this total, that table and every table after it stay raw.
const MAX_DOCUMENT_TABLE_CELLS = 20000;

// Shortcuts that cells handle themselves, kept in step with the customizable shortcuts.
let cellFormatKeys: Record<string, string> = { "Cmd+B": "**", "Cmd+I": "*", "Cmd+Shift+X": "~~", "Cmd+E": "`" };
let cellHistoryKeys: Record<string, "undo" | "redo"> = { "Cmd+Z": "undo", "Cmd+Shift+Z": "redo" };
export function setCellKeys(keys: Record<string, string>) {
  cellFormatKeys = {};
  if (keys.bold) cellFormatKeys[keys.bold] = "**";
  if (keys.italic) cellFormatKeys[keys.italic] = "*";
  if (keys.strikethrough) cellFormatKeys[keys.strikethrough] = "~~";
  if (keys.code) cellFormatKeys[keys.code] = "`";
  cellHistoryKeys = {};
  if (keys.undo) cellHistoryKeys[keys.undo] = "undo";
  if (keys.redo) cellHistoryKeys[keys.redo] = "redo";
}

// A menu command (the menu takes the key before the page sees it) aimed at a focused cell.
export function formatInCell(marker: string) {
  const cell = document.activeElement as HTMLElement | null;
  if (!cell?.classList.contains("cm-md-cell")) return false;
  cell.dispatchEvent(new CustomEvent("ov-format", { detail: marker }));
  return true;
}

interface Cell {
  text: string;
  from: number; // start of the trimmed text
  segFrom: number; // start of the whole segment between pipes
  segTo: number;
}

interface Row {
  from: number; // row start, after any container prefix (`> `, list indent, bullet)
  to: number;
  lineFrom: number;
  lineTo: number;
  cells: Cell[];
  pipes: number;
  lastPipe: number | null;
  trailingPipe: boolean;
}

interface TableData {
  from: number; // whole lines covered by the widget
  to: number;
  rows: Row[]; // header first, then body rows
  delim: Row; // the |---| row; its cells hold the dash specs
  align: Align[];
  containers: ("quote" | "list")[]; // enclosing blockquotes and list items, outermost first
  marker: string | null; // list bullet on the header line, when the table starts a list item
  prefix: string; // the delimiter line's container prefix, copied into new rows
}

type Doc = EditorState["doc"];

function segment(doc: Doc, a: number, b: number): Cell {
  const raw = doc.sliceString(a, b);
  const lead = raw.length - raw.trimStart().length;
  return { text: raw.trim(), from: a + lead, segFrom: a, segTo: b };
}

// Split a row at its pipe positions. After the final pipe, only real text is a cell; trailing
// whitespace is not. The same spans feed the cell-count budget, so the cap and the widget agree.
function cellSpans(doc: Doc, from: number, to: number, pipes: number[]): Array<[number, number]> {
  const cuts = pipes[0] === from ? pipes : [from - 1, ...pipes]; // -1: no leading pipe
  const spans: Array<[number, number]> = [];
  for (let i = 0; i < cuts.length; i++) {
    const at = cuts[i] + 1;
    const last = i + 1 === cuts.length;
    const next = last ? to : cuts[i + 1];
    if (last && doc.sliceString(at, next).trim() === "") break;
    spans.push([at, next]);
  }
  return spans;
}

function makeRow(doc: Doc, from: number, to: number, pipes: number[]): Row {
  const cells = cellSpans(doc, from, to, pipes).map(([at, next]) => segment(doc, at, next));
  const lastPipe = pipes.length ? pipes[pipes.length - 1] : null;
  const line = doc.lineAt(from);
  return {
    from,
    to,
    lineFrom: line.from,
    lineTo: line.to,
    cells,
    pipes: pipes.length,
    lastPipe,
    trailingPipe: lastPipe !== null && doc.sliceString(lastPipe + 1, to).trim() === "",
  };
}

function alignment(cell: string): Align {
  const c = cell.replace(/\s/g, "");
  if (/^:-+:$/.test(c)) return "center";
  if (/^-+:$/.test(c)) return "right";
  if (/^:-+$/.test(c)) return "left";
  return null;
}

// Cells come from the parser's own pipe positions (TableDelimiter nodes inside each row), so the
// widget and the parser always agree on where cells split, including pipes inside code spans.
// The delimiter row has no child nodes, but it can't contain escapes or code, so its pipes are
// found by scanning.
function readTable(state: EditorState, table: SyntaxNode): TableData | null {
  const doc = state.doc;
  const rows: Row[] = [];
  let delim: Row | null = null;
  for (let c = table.firstChild; c; c = c.nextSibling) {
    if (c.name === "TableHeader" || c.name === "TableRow") {
      rows.push(makeRow(doc, c.from, c.to, c.getChildren("TableDelimiter").map((d) => d.from)));
    } else if (c.name === "TableDelimiter") {
      const text = doc.sliceString(c.from, c.to);
      const pipes = [...text].flatMap((ch, i) => (ch === "|" ? [c.from + i] : []));
      delim = makeRow(doc, c.from, c.to, pipes);
    }
  }
  if (!delim || rows.length === 0 || rows[0].cells.length === 0) return null;

  const containers: TableData["containers"] = [];
  for (let p = table.parent; p; p = p.parent) {
    if (p.name === "Blockquote") containers.unshift("quote");
    else if (p.name === "ListItem") containers.unshift("list");
  }
  let marker: string | null = null;
  const item = table.parent?.name === "ListItem" ? table.parent : null;
  const mark = item?.getChild("ListMark");
  if (item && mark && doc.lineAt(mark.from).number === doc.lineAt(table.from).number) {
    const text = doc.sliceString(mark.from, mark.to);
    marker = item.parent?.name === "OrderedList" ? text : "\u2022";
  }
  return {
    from: doc.lineAt(table.from).from,
    to: doc.lineAt(table.to).to,
    rows,
    delim,
    align: delim.cells.map((c) => alignment(c.text)),
    containers,
    marker,
    prefix: doc.sliceString(delim.lineFrom, delim.from),
  };
}

// The table whose lines include `pos`. The widget starts at a line start, which for a nested
// table is before the Table node (the `> ` or indent comes first), so search to the line end.
function tableAt(state: EditorState, pos: number): TableData | null {
  let found: TableData | null = null;
  syntaxTree(state).iterate({
    from: pos,
    to: state.doc.lineAt(pos).to,
    enter: (node) => {
      if (found || node.name !== "Table") return;
      found = readTable(state, node.node);
      return false;
    },
  });
  return found;
}

const emptyRow = (width: number) => "|" + "  |".repeat(width);

// Width in a monospaced editor: East Asian wide and full-width characters take two columns.
const wideRanges: [number, number][] = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff],
  [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe4f], [0xff00, 0xff60],
  [0xffe0, 0xffe6], [0x1f300, 0x1f64f], [0x1f900, 0x1f9ff], [0x20000, 0x3fffd],
];
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
// Measured per visible character, so an emoji with a skin tone or joiner counts once.
function displayWidth(s: string) {
  let w = 0;
  for (const { segment } of graphemes.segment(s)) {
    const cp = segment.codePointAt(0)!;
    w += wideRanges.some(([a, b]) => cp >= a && cp <= b) ? 2 : 1;
  }
  return w;
}

// "Tidy": pad every column to a common width and draw the delimiter row to match. Container
// prefixes stay, since only each row's own text (after its prefix) is rewritten.
function tidyChanges(t: TableData): ChangeSpec[] {
  const width = t.rows[0].cells.length;
  const texts = t.rows.map((r) => {
    const cells = r.cells.map((c) => c.text);
    while (cells.length < width) cells.push("");
    return cells;
  });
  const cols = Math.max(...texts.map((r) => r.length));
  const widths = Array.from({ length: cols }, (_, j) => Math.max(3, ...texts.map((r) => (r[j] === undefined ? 0 : displayWidth(r[j])))));
  const pad = (s: string, j: number) => {
    const gap = widths[j] - displayWidth(s);
    const a = t.align[j];
    if (a === "right") return " ".repeat(gap) + s;
    if (a === "center") return " ".repeat(Math.floor(gap / 2)) + s + " ".repeat(Math.ceil(gap / 2));
    return s + " ".repeat(gap);
  };
  const line = (cells: string[]) => "| " + cells.map(pad).join(" | ") + " |";
  const dash = (j: number) => {
    const a = t.align[j];
    const left = a === "left" || a === "center";
    const right = a === "right" || a === "center";
    return (left ? ":" : "") + "-".repeat(widths[j] + 2 - (left ? 1 : 0) - (right ? 1 : 0)) + (right ? ":" : "");
  };
  const delimText = "|" + Array.from({ length: width }, (_, j) => dash(j)).join("|") + "|";
  return [
    { from: t.rows[0].from, to: t.rows[0].lineTo, insert: line(texts[0]) },
    { from: t.delim.from, to: t.delim.lineTo, insert: delimText },
    ...t.rows.slice(1).map((r, i) => ({ from: r.from, to: r.lineTo, insert: line(texts[i + 1]) })),
  ];
}

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Enough inline Markdown for table cells: code, bold, italic, strikethrough, links.
function renderInline(text: string): string {
  const codes: string[] = [];
  let html = escapeHtml(text.replace(/\\\|/g, "|")).replace(/`([^`]+)`/g, (_m, code: string) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });
  html = html
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_m, a, b) => `<strong>${a ?? b}</strong>`)
    .replace(/\*([^*]+)\*|\b_([^_]+)_\b/g, (_m, a, b) => `<em>${a ?? b}</em>`)
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, '<span class="cm-md-link" data-href="$2">$1</span>');
  return html.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => `<code class="cm-md-code">${codes[Number(i)]}</code>`);
}

// A bare pipe typed into a cell would split it; store it escaped. A pipe after an even number of
// backslashes is still bare (`\\|` is an escaped backslash followed by a delimiter).
function escapePipes(s: string) {
  let out = "";
  let slashes = 0;
  for (const ch of s.replace(/[\r\n]+/g, " ")) {
    if (ch === "|" && slashes % 2 === 0) out += "\\";
    out += ch;
    slashes = ch === "\\" ? slashes + 1 : 0;
  }
  return out;
}

// After a structural edit rebuilds the table DOM, focus returns to this cell.
let pendingFocus: { tableFrom: number; row: number; col: number; at: "start" | "end" } | null = null;

function placeCaret(el: HTMLElement, at: "start" | "end") {
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(at === "start");
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

function placeCaretAt(el: HTMLElement, offset: number) {
  el.focus();
  const text = el.firstChild;
  const range = document.createRange();
  if (text && text.nodeType === Node.TEXT_NODE) range.setStart(text, Math.min(offset, text.textContent?.length ?? 0));
  else range.selectNodeContents(el);
  range.collapse(true);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

// Map a caret offset in rendered cell text to the same spot in its raw Markdown by skipping
// the characters that rendering hides: emphasis/code markers, escapes, and link targets.
function renderedToRaw(raw: string, offset: number) {
  let shown = 0;
  for (let i = 0; i < raw.length; i++) {
    if (shown === offset) return i;
    const ch = raw[i];
    if (ch === "\\" && i + 1 < raw.length) {
      i++;
      shown++;
    } else if (ch === "]" && raw[i + 1] === "(") {
      const close = raw.indexOf(")", i);
      i = close < 0 ? raw.length : close;
    } else if (ch === "_" && /[\p{L}\p{N}]/u.test(raw[i - 1] ?? "") && /[\p{L}\p{N}]/u.test(raw[i + 1] ?? "")) {
      shown++; // intraword underscore is literal, not emphasis
    } else if (!"*_~`[".includes(ch)) {
      shown++;
    }
  }
  return raw.length;
}

// Select characters [from, to) of a cell holding a single text node.
function selectText(el: HTMLElement, from: number, to: number) {
  el.focus();
  const text = el.firstChild;
  if (!text || text.nodeType !== Node.TEXT_NODE) return placeCaret(el, "end");
  const max = text.textContent?.length ?? 0;
  const range = document.createRange();
  range.setStart(text, Math.max(0, Math.min(from, max)));
  range.setEnd(text, Math.max(0, Math.min(to, max)));
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

function caretOffset(el: HTMLElement): { start: number; end: number } {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return { start: 0, end: 0 };
  const range = sel.getRangeAt(0);
  const pre = document.createRange();
  pre.selectNodeContents(el);
  pre.setEnd(range.startContainer, range.startOffset);
  const start = pre.toString().length;
  return { start, end: start + range.toString().length };
}

class TableWidget extends WidgetType {
  private composing = false;
  private composedAt = 0;
  constructor(readonly data: TableData, readonly source: string) {
    super();
  }
  eq(other: TableWidget) {
    return other.source === this.source && other.data.from === this.data.from;
  }

  private width() {
    return this.data.rows[0].cells.length;
  }

  private shape() {
    const d = this.data;
    return `${d.rows.length}x${this.width()}:${d.align.join(",")}:${d.containers.join(">")}:${d.marker ?? ""}`;
  }

  toDOM(view: EditorView) {
    const d = this.data;
    const wrap = document.createElement("div");
    wrap.className = "cm-md-table-wrap";
    wrap.dataset.shape = this.shape();
    wrap.appendChild(this.toolbar(view, wrap));
    // One nested box per enclosing quote or list item, in source order, so the quote bars and
    // list indents compose the way they do for the surrounding text.
    let inner: HTMLElement = wrap;
    for (const kind of d.containers) {
      const box = document.createElement("div");
      box.className = kind === "quote" ? "cm-md-table-quote" : "cm-md-table-list";
      inner.appendChild(box);
      inner = box;
    }
    if (d.marker) {
      const marker = document.createElement("span");
      marker.className = "cm-md-table-marker";
      marker.textContent = d.marker;
      inner.appendChild(marker);
    }
    const table = document.createElement("table");
    table.className = "cm-md-table";
    const columns = this.width();
    d.rows.forEach((row, r) => {
      const tr = document.createElement("tr");
      for (let c = 0; c < columns; c++) {
        const td = document.createElement(r === 0 ? "th" : "td");
        if (d.align[c]) td.style.textAlign = d.align[c]!;
        const cell = document.createElement("div");
        cell.className = "cm-md-cell";
        cell.contentEditable = "plaintext-only";
        cell.spellcheck = false;
        cell.dataset.row = String(r);
        cell.dataset.col = String(c);
        cell.dataset.raw = row.cells[c]?.text ?? "";
        cell.innerHTML = renderInline(cell.dataset.raw);
        this.bindCell(view, wrap, cell);
        td.appendChild(cell);
        tr.appendChild(td);
      }
      if (r === 0) table.createTHead().appendChild(tr);
      else (table.tBodies[0] ?? table.createTBody()).appendChild(tr);
    });
    inner.appendChild(table);
    wrap.addEventListener("focusin", () => wrap.classList.add("is-editing"));
    wrap.addEventListener("focusout", (e) => {
      if (!wrap.contains(e.relatedTarget as Node | null)) wrap.classList.remove("is-editing");
    });
    this.restoreFocus(wrap);
    return wrap;
  }

  // Keep the DOM (and the focused cell's caret) when only cell text changed.
  updateDOM(dom: HTMLElement, view: EditorView) {
    if (dom.dataset.shape !== this.shape()) return false;
    for (const cell of dom.querySelectorAll<HTMLElement>(".cm-md-cell")) {
      const raw = this.data.rows[Number(cell.dataset.row)].cells[Number(cell.dataset.col)]?.text ?? "";
      if (cell.dataset.raw === raw) continue;
      cell.dataset.raw = raw;
      if (document.activeElement === cell) {
        // The document stores cells trimmed; a trailing space still being typed is not a change.
        if (escapePipes(cell.textContent ?? "").trim() !== raw) {
          cell.textContent = raw; // an undo or redo changed the cell under the caret
          placeCaret(cell, "end");
        }
      } else {
        cell.innerHTML = renderInline(raw);
      }
    }
    // Toolbar buttons close over the widget instance, so rebind them to the current data.
    dom.querySelector(".cm-md-table-tools")?.replaceWith(this.toolbar(view, dom));
    this.restoreFocus(dom);
    return true;
  }

  private restoreFocus(wrap: HTMLElement) {
    const want = pendingFocus;
    if (!want || want.tableFrom !== this.data.from) return;
    pendingFocus = null;
    requestAnimationFrame(() => {
      const cell = wrap.querySelector<HTMLElement>(`.cm-md-cell[data-row="${want.row}"][data-col="${want.col}"]`);
      if (cell) placeCaret(cell, want.at);
    });
  }

  private current(view: EditorView, wrap: HTMLElement): TableData | null {
    return tableAt(view.state, view.posAtDOM(wrap));
  }

  private bindCell(view: EditorView, wrap: HTMLElement, cell: HTMLElement) {
    // Reveal the raw Markdown when a cell gains focus (only if it differs from what is shown).
    // `clickOffset` is a caret position in the rendered text, mapped into the raw text.
    let clickOffset: number | null = null;
    cell.addEventListener("compositionstart", () => {
      this.composing = true;
    });
    cell.addEventListener("compositionend", () => {
      this.composedAt = performance.now();
      this.composing = false;
    });
    cell.addEventListener("focus", () => {
      const raw = cell.dataset.raw ?? "";
      const offset = clickOffset;
      clickOffset = null;
      if (cell.textContent === raw) return;
      cell.textContent = raw;
      if (offset === null) placeCaret(cell, "end");
      else placeCaretAt(cell, renderedToRaw(raw, offset));
      view.requestMeasure();
    });
    cell.addEventListener("blur", () => {
      cell.innerHTML = renderInline(cell.dataset.raw ?? "");
      view.requestMeasure();
    });
    cell.addEventListener("mousedown", (e) => {
      const link = (e.target as HTMLElement).closest("[data-href]");
      if ((e.metaKey || e.ctrlKey) && link) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("openviewer:open-link", { detail: link.getAttribute("data-href") }));
        return;
      }
      if (document.activeElement === cell) return;
      // First click into a formatted cell: swap to raw text ourselves so the caret lands where
      // the click was, not where the browser hit-tests the (longer) raw text.
      const hit = document.caretRangeFromPoint?.(e.clientX, e.clientY);
      if (!hit || !cell.contains(hit.startContainer)) return;
      const pre = document.createRange();
      pre.selectNodeContents(cell);
      pre.setEnd(hit.startContainer, hit.startOffset);
      if (cell.textContent === (cell.dataset.raw ?? "")) return;
      e.preventDefault();
      clickOffset = pre.toString().length;
      cell.focus({ preventScroll: true });
    });
    cell.addEventListener("input", () => this.commit(view, wrap, cell, false));
    cell.addEventListener("ov-format", (e) => this.toggleFormat(view, wrap, cell, (e as CustomEvent<string>).detail));
    cell.addEventListener("keydown", (e) => this.onKey(e, view, wrap, Number(cell.dataset.row), Number(cell.dataset.col), cell));
  }

  // Write the cell's current text into the document. Typing merges into one undo step per
  // burst; `isolate` makes an edit (such as ⌘B) its own undo step.
  private commit(view: EditorView, wrap: HTMLElement, cell: HTMLElement, isolate: boolean) {
    const table = this.current(view, wrap);
    const row = table?.rows[Number(cell.dataset.row)];
    if (!table || !row) return;
    const c = Number(cell.dataset.col);
    const text = escapePipes(cell.textContent ?? "").trimEnd();
    cell.dataset.raw = text;
    const target = row.cells[c];
    let change: ChangeSpec;
    if (target) {
      // Rewrite from the cell text to the closing pipe, so trailing spaces typed and later
      // continued don't pile up as padding. The edited cell ends with one space of padding.
      change = target.text
        ? { from: target.from, to: target.segTo, insert: `${text} ` }
        : { from: target.segFrom, to: target.segTo, insert: ` ${text} ` };
    } else {
      // A row shorter than the header shows empty cells that don't exist in the source yet:
      // append the missing ones through this column.
      let insert = "";
      for (let j = row.cells.length; j <= c; j++) {
        const content = j === c ? text : "";
        insert += row.trailingPipe ? ` ${content} |` : ` | ${content}`;
      }
      change = { from: row.trailingPipe ? row.lastPipe! + 1 : row.to, insert };
    }
    view.dispatch({
      changes: change,
      userEvent: isolate ? "input" : "input.type",
      annotations: isolate ? isolateHistory.of("full") : undefined,
    });
    view.requestMeasure();
    // Typewriter mode can't see the caret here (focus is in the cell), so center the cell.
    if (view.dom.classList.contains("ov-typewriter")) cell.scrollIntoView({ block: "center" });
  }

  // ⌘B / ⌘I / ⌘E: wrap the selection in the cell with a Markdown marker, or unwrap it when the
  // marker already surrounds it (the same rule as the editor's own ⌘B).
  private toggleFormat(view: EditorView, wrap: HTMLElement, cell: HTMLElement, marker: string) {
    const text = cell.textContent ?? "";
    const { start, end } = caretOffset(cell);
    const n = marker.length;
    const wrapped = text.slice(start - n, start) === marker && text.slice(end, end + n) === marker;
    const next = wrapped
      ? text.slice(0, start - n) + text.slice(start, end) + text.slice(end + n)
      : text.slice(0, start) + marker + text.slice(start, end) + marker + text.slice(end);
    const shift = wrapped ? -n : n;
    cell.textContent = next;
    selectText(cell, start + shift, end + shift);
    this.commit(view, wrap, cell, true);
  }

  private onKey(e: KeyboardEvent, view: EditorView, wrap: HTMLElement, r: number, c: number, cell: HTMLElement) {
    // Enter/arrows confirm or pick IME candidates. WebKit can deliver the committing Enter just
    // after compositionend without the composing flag, hence the short grace period.
    if (e.isComposing || e.keyCode === 229 || this.composing || performance.now() - this.composedAt < 80) return;
    const rows = this.data.rows.length;
    const cols = this.width();
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const go = (row: number, col: number, at: "start" | "end") => {
      const el = wrap.querySelector<HTMLElement>(`.cm-md-cell[data-row="${row}"][data-col="${col}"]`);
      if (!el) return;
      placeCaret(el, at);
      if (view.dom.classList.contains("ov-typewriter")) el.scrollIntoView({ block: "center" });
    };
    const { start, end } = caretOffset(cell);
    const len = (cell.textContent ?? "").length;
    let handled = true;

    // Line-start/end and select-all keys would otherwise let the browser move the caret out
    // of this cell into the surrounding editor or the next cell.
    const toStart = (mod && (e.key === "ArrowLeft" || e.key === "ArrowUp")) || e.key === "Home";
    const toEnd = (mod && (e.key === "ArrowRight" || e.key === "ArrowDown")) || e.key === "End";
    const pressed = fromEvent(e);
    const format = pressed ? cellFormatKeys[pressed] : undefined;
    // Customizable keys come first, so a rebinding onto a navigation key still works.
    if (pressed && cellHistoryKeys[pressed]) {
      if (cellHistoryKeys[pressed] === "redo") redo(view);
      else undo(view);
    } else if (format) {
      this.toggleFormat(view, wrap, cell, format);
    } else if ((toStart || toEnd) && !e.shiftKey) {
      placeCaret(cell, toStart ? "start" : "end");
    } else if (mod && e.key.toLowerCase() === "a") {
      selectText(cell, 0, len);

    } else if (mod && e.key === "Enter") {
      this.structural(view, wrap, "row-below", r, c);
    } else if (e.key === "Tab" && !e.shiftKey) {
      if (c + 1 < cols) go(r, c + 1, "end");
      else if (r + 1 < rows) go(r + 1, 0, "end");
      else this.structural(view, wrap, "row-below", r, 0);
    } else if (e.key === "Tab" && e.shiftKey) {
      if (c > 0) go(r, c - 1, "end");
      else if (r > 0) go(r - 1, cols - 1, "end");
    } else if (e.key === "Enter") {
      if (r + 1 < rows) go(r + 1, c, "end");
      else this.exit(view, wrap, "below");
    } else if (e.key === "ArrowDown") {
      if (r + 1 < rows) go(r + 1, c, "end");
      else this.exit(view, wrap, "below");
    } else if (e.key === "ArrowUp") {
      if (r > 0) go(r - 1, c, "end");
      else this.exit(view, wrap, "above");
    } else if (e.key === "ArrowLeft" && start === 0 && end === 0 && !e.shiftKey) {
      if (c > 0) go(r, c - 1, "end");
      else if (r > 0) go(r - 1, cols - 1, "end");
      else this.exit(view, wrap, "above");
    } else if (e.key === "ArrowRight" && start === len && end === len && !e.shiftKey) {
      if (c + 1 < cols) go(r, c + 1, "start");
      else if (r + 1 < rows) go(r + 1, 0, "start");
      else this.exit(view, wrap, "below");
    } else if (e.key === "Escape") {
      this.exit(view, wrap, "below");
    } else {
      handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  // Leave the table and put the editor caret on the line above or below it.
  private exit(view: EditorView, wrap: HTMLElement, side: "above" | "below") {
    const table = this.current(view, wrap);
    if (!table) return;
    const doc = view.state.doc;
    const br = view.state.lineBreak;
    if (side === "above") {
      const line = doc.lineAt(table.from);
      if (line.number === 1) view.dispatch({ changes: { from: 0, insert: br }, selection: { anchor: 0 } });
      else view.dispatch({ selection: { anchor: doc.line(line.number - 1).to } });
    } else {
      const line = doc.lineAt(table.to);
      if (line.number === doc.lines) {
        view.dispatch({ changes: { from: doc.length, insert: br }, selection: { anchor: doc.length + br.length } });
      } else {
        view.dispatch({ selection: { anchor: doc.line(line.number + 1).from } });
      }
    }
    view.focus();
  }

  // Row/column/alignment edits, each written as the smallest local change.
  structural(view: EditorView, wrap: HTMLElement, op: string, r: number, c: number) {
    const t = this.current(view, wrap);
    if (!t) return;
    const doc = view.state.doc;
    const br = view.state.lineBreak;
    const width = t.rows[0].cells.length;
    const lines = [t.rows[0], t.delim, ...t.rows.slice(1)]; // every row in source order
    const changes: ChangeSpec[] = [];
    let focus = { row: r, col: c };

    switch (op) {
      case "row-below": {
        // Insert one line after this row (after the delimiter row for the header).
        const anchor = r === 0 ? t.delim : t.rows[r];
        changes.push({ from: anchor.lineTo, insert: br + t.prefix + emptyRow(width) });
        focus = { row: r + 1, col: c };
        break;
      }
      case "row-delete": {
        if (r === 0 || t.rows.length <= 2) return; // keep the header and one body row
        const line = doc.lineAt(t.rows[r].from);
        if (line.to >= t.to) changes.push({ from: doc.line(line.number - 1).to, to: line.to });
        else changes.push({ from: line.from, to: doc.line(line.number + 1).from });
        focus = { row: Math.min(r, t.rows.length - 2), col: c };
        break;
      }
      case "col-right": {
        // One new cell right of column c on every line that has a column c; short rows are
        // left alone (GFM pads them).
        for (const row of lines) {
          const cell = row.cells[c];
          if (!cell) continue;
          const content = row === t.delim ? "---" : "";
          const pipeAfter = c < row.cells.length - 1 || row.trailingPipe;
          if (pipeAfter) changes.push({ from: cell.segTo + 1, insert: ` ${content} |` });
          // A bare trailing pipe isn't a cell, so close the new cell with one.
          else changes.push({ from: row.to, insert: ` | ${content} |` });
        }
        focus = { row: r, col: c + 1 };
        break;
      }
      case "col-delete": {
        if (width <= 1) return;
        for (const row of lines) {
          const cell = row.cells[c];
          if (!cell) continue;
          if (row.pipes === 1 && row.cells.length === 2) {
            // Removing this row's only pipe would leave plain text (a header and delimiter
            // without pipes read as a setext heading), so rewrite it as a one-cell piped row.
            const keep = row.cells[1 - c];
            changes.push({ from: row.from, to: row.to, insert: `| ${keep.text} |` });
          } else if (row.cells.length === 1) {
            // Empty the row's only cell but keep a pipe, or a pipe-less row would become a blank
            // line and end the table.
            if (row.lastPipe === null) changes.push({ from: row.from, to: row.to, insert: emptyRow(1) });
            else changes.push({ from: cell.segFrom, to: cell.segTo, insert: " " });
          } else if (cell.segFrom > row.from) {
            changes.push({ from: cell.segFrom - 1, to: cell.segTo }); // the pipe before it, and it
          } else {
            changes.push({ from: cell.segFrom, to: Math.min(cell.segTo + 1, row.to) }); // it, and the pipe after
          }
        }
        focus = { row: r, col: Math.min(c, width - 2) };
        break;
      }
      case "align-left":
      case "align-center":
      case "align-right": {
        // Swap colons in this column's delimiter cell, keeping its width so aligned tables stay aligned.
        const spec = t.delim.cells[c];
        if (!spec) return;
        const a = op.slice(6);
        const left = a === "left" || a === "center";
        const right = a === "right" || a === "center";
        const len = spec.text.length;
        const dashes = Math.max(1, len - (left ? 1 : 0) - (right ? 1 : 0));
        changes.push({ from: spec.from, to: spec.from + len, insert: (left ? ":" : "") + "-".repeat(dashes) + (right ? ":" : "") });
        break;
      }
      case "tidy":
        changes.push(...tidyChanges(t));
        break;
      case "delete-table": {
        // Keep the header line's container prefix (`> `, a list bullet) so the container survives.
        const from = t.containers.length ? t.rows[0].from : t.from;
        view.dispatch({ changes: { from, to: t.to }, selection: { anchor: from }, userEvent: "delete" });
        view.focus();
        return;
      }
    }
    pendingFocus = { tableFrom: t.from, ...focus, at: "end" };
    view.dispatch({ changes, userEvent: "input", annotations: isolateHistory.of("full") });
  }

  private toolbar(view: EditorView, wrap: HTMLElement) {
    const bar = document.createElement("div");
    bar.className = "cm-md-table-tools";
    const buttons: [op: string, label: string, title: string][] = [
      ["align-left", "⇤", "Align column left"],
      ["align-center", "↔", "Align column center"],
      ["align-right", "⇥", "Align column right"],
      ["row-below", "+ Row", "Add row below (⌘↩)"],
      ["row-delete", "− Row", "Delete row"],
      ["col-right", "+ Col", "Add column right"],
      ["col-delete", "− Col", "Delete column"],
      ["tidy", "Tidy", "Line up the table's columns in the Markdown source"],
      ["delete-table", "Delete", "Delete table"],
    ];
    for (const [op, label, title] of buttons) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.title = title;
      // mousedown, not click: keep focus (and so the active cell) until the edit runs.
      b.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const active = wrap.querySelector<HTMLElement>(".cm-md-cell:focus");
        const r = active ? Number(active.dataset.row) : 0;
        const c = active ? Number(active.dataset.col) : 0;
        this.structural(view, wrap, op, r, c);
      });
      bar.appendChild(b);
    }
    return bar;
  }

  ignoreEvent() {
    return true;
  }
}

// Header cells × body rows (delimiter excluded), from the parser's pipes, before any widget data.
function countedCells(state: EditorState, table: SyntaxNode): number | null {
  const doc = state.doc;
  let rows = 0;
  let header = 0;
  for (let c = table.firstChild; c; c = c.nextSibling) {
    if (c.name !== "TableHeader" && c.name !== "TableRow") continue;
    if (rows === 0) {
      header = cellSpans(doc, c.from, c.to, c.getChildren("TableDelimiter").map((d) => d.from)).length;
      if (header === 0) return null;
    }
    rows++;
  }
  return rows === 0 ? null : rows * header;
}

function buildTables(state: EditorState): DecorationSet {
  const out: Range<Decoration>[] = [];
  let used = 0;
  let full = false;
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== "Table") return;
      if (full) return false;
      const cells = countedCells(state, node.node);
      if (cells === null || cells > MAX_TABLE_CELLS) return false;
      if (used + cells > MAX_DOCUMENT_TABLE_CELLS) {
        full = true;
        return false;
      }
      const data = readTable(state, node.node);
      if (!data) return false;
      const actual = data.rows.length * data.rows[0].cells.length;
      if (actual > MAX_TABLE_CELLS) return false;
      if (used + actual > MAX_DOCUMENT_TABLE_CELLS) {
        full = true;
        return false;
      }
      used += actual;
      const widget = new TableWidget(data, state.doc.sliceString(data.from, data.to));
      out.push(Decoration.replace({ widget, block: true, cells: actual }).range(data.from, data.to));
      return false;
    },
  });
  return Decoration.set(out);
}

const tableField = StateField.define<DecorationSet>({
  create: buildTables,
  update(value, tr) {
    if (tr.docChanged || syntaxTree(tr.startState) !== syntaxTree(tr.state)) return buildTables(tr.state);
    return value;
  },
  provide: (field) => [EditorView.decorations.from(field), EditorView.atomicRanges.of((v) => v.state.field(field))],
});

export function tableRenderStats(state: EditorState): { widgets: number; cells: number; ranges: [number, number][] } {
  const set = state.field(tableField, false);
  if (!set) return { widgets: 0, cells: 0, ranges: [] };
  const ranges: [number, number][] = [];
  let cells = 0;
  const cursor = set.iter();
  while (cursor.value) {
    const n = cursor.value.spec.cells;
    if (typeof n === "number") cells += n;
    ranges.push([cursor.from, cursor.to]);
    cursor.next();
  }
  return { widgets: ranges.length, cells, ranges };
}

function focusCell(view: EditorView, tableFrom: number, row: number | "last", col: number) {
  const wraps = Array.from(view.contentDOM.querySelectorAll<HTMLElement>(".cm-md-table-wrap"));
  const wrap = wraps.find((w) => view.posAtDOM(w) === tableFrom);
  if (!wrap) return false;
  const r = row === "last" ? wrap.querySelectorAll("tr").length - 1 : row;
  const cell = wrap.querySelector<HTMLElement>(`.cm-md-cell[data-row="${r}"][data-col="${col}"]`);
  if (!cell) return false;
  placeCaret(cell, "end");
  return true;
}

// Arrow keys and Backspace next to a table move into it instead of jumping over it or
// deleting it as one atomic range.
const tableKeys = Prec.high(
  keymap.of([
    {
      key: "ArrowDown",
      run: (view) => {
        const { head, empty } = view.state.selection.main;
        if (!empty) return false;
        const line = view.state.doc.lineAt(head);
        if (line.number === view.state.doc.lines) return false;
        const next = view.state.doc.line(line.number + 1);
        return tableAt(view.state, next.from)?.from === next.from && focusCell(view, next.from, 0, 0);
      },
    },
    {
      key: "ArrowUp",
      run: (view) => {
        const { head, empty } = view.state.selection.main;
        if (!empty) return false;
        const line = view.state.doc.lineAt(head);
        if (line.number === 1) return false;
        const prev = view.state.doc.line(line.number - 1);
        const table = tableAt(view.state, prev.from);
        return !!table && table.to === prev.to && focusCell(view, table.from, "last", 0);
      },
    },
    {
      key: "Backspace",
      run: (view) => {
        const { head, empty } = view.state.selection.main;
        if (!empty) return false;
        const table = head > 0 ? tableAt(view.state, head - 1) : null;
        if (!table || table.to !== head) return false;
        return focusCell(view, table.from, "last", table.rows[0].cells.length - 1);
      },
    },
  ]),
);

export const tables = [tableField, tableKeys];

// ⌥⌘T: insert a 3-column table after the current block (or after the table whose cell has
// focus, since cell focus doesn't move the editor selection) and put the caret in its first cell.
// Blank lines around it keep neighbouring text from being read as table rows.
export function insertTable(view: EditorView) {
  const { state } = view;
  const br = state.lineBreak;
  const activeWrap = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(".cm-md-table-wrap");
  const activeTable = activeWrap && view.contentDOM.contains(activeWrap) ? tableAt(state, view.posAtDOM(activeWrap)) : null;
  const line = state.doc.lineAt(activeTable ? activeTable.to : state.selection.main.head);
  const next = line.number < state.doc.lines ? state.doc.line(line.number + 1) : null;
  const table = ["| Column 1 | Column 2 | Column 3 |", "|---|---|---|", emptyRow(3)].join(br);
  const before = state.doc.length === 0 ? "" : line.text.trim() === "" ? br : br + br;
  const after = next && next.text.trim() !== "" ? br : "";
  const at = line.to;
  pendingFocus = { tableFrom: at + before.length, row: 0, col: 0, at: "end" };
  view.dispatch({ changes: { from: at, insert: before + table + after }, userEvent: "input" });
  return true;
}
