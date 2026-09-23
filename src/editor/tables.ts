import { redo, undo } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import { type EditorState, Prec, type Range, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap, WidgetType } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";

// GFM tables render as an editable <table>, as in Typora. Each cell is its own small editor:
// while focused it shows the cell's raw Markdown, otherwise the rendered inline formatting.
// Typing rewrites only that cell's text in the document, so the rest of the file keeps its
// exact bytes. Structural edits (rows, columns, alignment) rewrite the table in a normalized
// `| a | b |` form. Tables span several lines, so the widget is a block decoration, and block
// decorations have to come from a state field rather than the live-preview view plugin.

type Align = "left" | "center" | "right" | null;

interface Cell {
  text: string;
  from: number; // start of the trimmed text
  segFrom: number; // start of the whole segment between pipes
  segTo: number;
}

interface TableData {
  from: number;
  to: number;
  rows: Cell[][]; // header first; the delimiter row is not included
  align: Align[];
}

function segment(doc: EditorState["doc"], a: number, b: number): Cell {
  const raw = doc.sliceString(a, b);
  const lead = raw.length - raw.trimStart().length;
  return { text: raw.trim(), from: a + lead, segFrom: a, segTo: b };
}

// Cells come from the parser's own pipe positions (TableDelimiter nodes), so the widget and the
// Markdown parser always agree on where cells split, including pipes inside code spans.
function rowCells(doc: EditorState["doc"], row: SyntaxNode): Cell[] {
  const pipes: number[] = [];
  for (let c = row.firstChild; c; c = c.nextSibling) if (c.name === "TableDelimiter") pipes.push(c.from);
  if (pipes[0] !== row.from) pipes.unshift(row.from - 1); // no leading pipe
  const cells: Cell[] = [];
  for (let i = 0; i < pipes.length; i++) {
    const at = pipes[i] + 1;
    const last = i + 1 === pipes.length;
    const next = last ? row.to : pipes[i + 1];
    // After the final pipe, only real text is a cell; trailing whitespace is not.
    if (last && doc.sliceString(at, next).trim() === "") break;
    cells.push(segment(doc, at, next));
  }
  return cells;
}

function alignment(cell: string): Align {
  const c = cell.replace(/\s/g, "");
  if (/^:-+:$/.test(c)) return "center";
  if (/^-+:$/.test(c)) return "right";
  if (/^:-+$/.test(c)) return "left";
  return null;
}

// DECISION: only top-level tables get the editable widget. Tables inside quotes or lists
// stay as raw source, because rewriting them would have to preserve each line's `>`/indent.
function readTable(state: EditorState, table: SyntaxNode): TableData | null {
  if (table.parent?.name !== "Document") return null;
  const doc = state.doc;
  const rows: Cell[][] = [];
  let align: Align[] = [];
  for (let c = table.firstChild; c; c = c.nextSibling) {
    if (c.name === "TableHeader" || c.name === "TableRow") rows.push(rowCells(doc, c));
    else if (c.name === "TableDelimiter") {
      align = doc.sliceString(c.from, c.to).split("|").map((p) => p.trim()).filter(Boolean).map(alignment);
    }
  }
  if (rows.length === 0 || rows[0].length === 0) return null;
  return { from: doc.lineAt(table.from).from, to: doc.lineAt(table.to).to, rows, align };
}

function tableAt(state: EditorState, pos: number): TableData | null {
  let found: TableData | null = null;
  syntaxTree(state).iterate({
    from: pos,
    to: pos,
    enter: (node) => {
      if (node.name !== "Table") return;
      found = readTable(state, node.node);
      return false;
    },
  });
  return found;
}

function serialize(rows: string[][], align: Align[], lineBreak: string): string {
  const width = Math.max(align.length, ...rows.map((r) => r.length));
  const line = (cells: string[]) =>
    "| " + Array.from({ length: width }, (_, i) => cells[i] ?? "").join(" | ") + " |";
  const delim = Array.from({ length: width }, (_, i) => {
    const a = align[i];
    return a === "center" ? ":---:" : a === "right" ? "---:" : a === "left" ? ":---" : "---";
  });
  return [line(rows[0]), "|" + delim.join("|") + "|", ...rows.slice(1).map(line)].join(lineBreak);
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

  private cellEls(dom: HTMLElement) {
    return Array.from(dom.querySelectorAll<HTMLElement>(".cm-md-cell"));
  }

  private shape() {
    return `${this.data.rows.length}x${this.data.rows[0].length}:${this.data.align.join(",")}`;
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-md-table-wrap";
    wrap.dataset.shape = this.shape();
    wrap.appendChild(this.toolbar(view, wrap));
    const table = document.createElement("table");
    table.className = "cm-md-table";
    const columns = this.data.rows[0].length;
    this.data.rows.forEach((row, r) => {
      const tr = document.createElement("tr");
      for (let c = 0; c < columns; c++) {
        const td = document.createElement(r === 0 ? "th" : "td");
        if (this.data.align[c]) td.style.textAlign = this.data.align[c]!;
        const cell = document.createElement("div");
        cell.className = "cm-md-cell";
        cell.contentEditable = "plaintext-only";
        cell.spellcheck = false;
        cell.dataset.row = String(r);
        cell.dataset.col = String(c);
        cell.dataset.raw = row[c]?.text ?? "";
        cell.innerHTML = renderInline(cell.dataset.raw);
        this.bindCell(view, wrap, cell);
        td.appendChild(cell);
        tr.appendChild(td);
      }
      if (r === 0) table.createTHead().appendChild(tr);
      else (table.tBodies[0] ?? table.createTBody()).appendChild(tr);
    });
    wrap.appendChild(table);
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
    for (const cell of this.cellEls(dom)) {
      const raw = this.data.rows[Number(cell.dataset.row)][Number(cell.dataset.col)]?.text ?? "";
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
    const row = () => Number(cell.dataset.row);
    const col = () => Number(cell.dataset.col);

    // Reveal the raw Markdown when a cell gains focus (only if it differs from what is shown).
    // `offset` is a caret position in the rendered text, mapped into the raw text.
    let clickOffset: number | null = null;
    cell.addEventListener("compositionstart", () => { this.composing = true; });
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
    cell.addEventListener("input", () => {
      const table = this.current(view, wrap);
      const target = table?.rows[row()]?.[col()];
      if (!table || !target) return;
      const text = escapePipes(cell.textContent ?? "");
      cell.dataset.raw = text;
      // Rewrite from the cell text to the closing pipe, so trailing spaces typed and later
      // continued don't pile up as padding. The edited cell ends with one space of padding.
      const change = target.text
        ? { from: target.from, to: target.segTo, insert: `${text.trimEnd()} ` }
        : { from: target.segFrom, to: target.segTo, insert: ` ${text.trimEnd()} ` };
      view.dispatch({ changes: change, userEvent: "input.type" });
      view.requestMeasure();
      // Typewriter mode can't see the caret here (focus is in the cell), so center the cell.
      if (view.dom.classList.contains("ov-typewriter")) cell.scrollIntoView({ block: "center" });
    });
    cell.addEventListener("keydown", (e) => this.onKey(e, view, wrap, row(), col(), cell));
  }

  private onKey(e: KeyboardEvent, view: EditorView, wrap: HTMLElement, r: number, c: number, cell: HTMLElement) {
    // Enter/arrows confirm or pick IME candidates. WebKit can deliver the committing Enter just
    // after compositionend without the composing flag, hence the short grace period.
    if (e.isComposing || e.keyCode === 229 || this.composing || performance.now() - this.composedAt < 80) return;
    const rows = this.data.rows.length;
    const cols = this.data.rows[0].length;
    const mod = e.metaKey || e.ctrlKey;
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
    if ((toStart || toEnd) && !e.shiftKey) {
      placeCaret(cell, toStart ? "start" : "end");
    } else if (mod && e.key.toLowerCase() === "a") {
      const range = document.createRange();
      range.selectNodeContents(cell);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    } else if (mod && e.key.toLowerCase() === "z") {
      if (e.shiftKey) redo(view);
      else undo(view);
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
    if (side === "above") {
      const line = doc.lineAt(table.from);
      if (line.number === 1) {
        view.dispatch({ changes: { from: 0, insert: view.state.lineBreak }, selection: { anchor: 0 } });
      } else {
        view.dispatch({ selection: { anchor: doc.line(line.number - 1).to } });
      }
    } else {
      const line = doc.lineAt(table.to);
      if (line.number === doc.lines) {
        const br = view.state.lineBreak;
        view.dispatch({ changes: { from: doc.length, insert: br }, selection: { anchor: doc.length + br.length } });
      } else {
        view.dispatch({ selection: { anchor: doc.line(line.number + 1).from } });
      }
    }
    view.focus();
  }

  structural(view: EditorView, wrap: HTMLElement, op: string, r: number, c: number) {
    const table = this.current(view, wrap);
    if (!table) return;
    const rows = table.rows.map((row) => row.map((cell) => cell.text));
    const width = Math.max(...rows.map((row) => row.length));
    for (const row of rows) while (row.length < width) row.push("");
    const align = [...table.align];
    while (align.length < width) align.push(null);
    let focus = { row: r, col: c };

    switch (op) {
      case "row-below":
        rows.splice(r + 1, 0, Array(width).fill(""));
        focus = { row: r + 1, col: c };
        break;
      case "row-delete":
        if (r === 0 || rows.length <= 2) return; // keep the header and at least one body row
        rows.splice(r, 1);
        focus = { row: Math.min(r, rows.length - 1), col: c };
        break;
      case "col-right":
        rows.forEach((row) => row.splice(c + 1, 0, ""));
        align.splice(c + 1, 0, null);
        focus = { row: r, col: c + 1 };
        break;
      case "col-delete":
        if (width <= 1) return;
        rows.forEach((row) => row.splice(c, 1));
        align.splice(c, 1);
        focus = { row: r, col: Math.min(c, width - 2) };
        break;
      case "align-left":
      case "align-center":
      case "align-right":
        align[c] = op.slice(6) as Align;
        break;
      case "delete-table":
        view.dispatch({ changes: { from: table.from, to: table.to, insert: "" }, selection: { anchor: table.from } });
        view.focus();
        return;
    }
    pendingFocus = { tableFrom: table.from, ...focus, at: "end" };
    view.dispatch({ changes: { from: table.from, to: table.to, insert: serialize(rows, align, view.state.lineBreak) } });
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

function buildTables(state: EditorState): DecorationSet {
  const out: Range<Decoration>[] = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== "Table") return;
      const data = readTable(state, node.node);
      if (!data) return false;
      const widget = new TableWidget(data, state.doc.sliceString(data.from, data.to));
      out.push(Decoration.replace({ widget, block: true }).range(data.from, data.to));
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
        return focusCell(view, table.from, "last", table.rows[0].length - 1);
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
  const table = serialize(
    [
      ["Column 1", "Column 2", "Column 3"],
      ["", "", ""],
    ],
    [null, null, null],
    br,
  );
  const before = state.doc.length === 0 ? "" : line.text.trim() === "" ? br : br + br;
  const after = next && next.text.trim() !== "" ? br : "";
  const at = line.to;
  pendingFocus = { tableFrom: at + before.length, row: 0, col: 0, at: "end" };
  view.dispatch({ changes: { from: at, insert: before + table + after }, userEvent: "input" });
  return true;
}
