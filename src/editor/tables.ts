import { redo, undo } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import { type EditorState, Prec, type Range, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap, WidgetType } from "@codemirror/view";

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

function splitRow(line: string, lineFrom: number): Cell[] {
  const bounds: number[] = [];
  let inCode = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\") i++;
    else if (ch === "`") inCode = !inCode;
    else if (ch === "|" && !inCode) bounds.push(i);
  }
  const trimmed = line.trim();
  const edges = [-1, ...bounds, line.length];
  const cells: Cell[] = [];
  for (let k = 0; k < edges.length - 1; k++) {
    const start = edges[k] + 1;
    const end = edges[k + 1];
    if (k === 0 && trimmed.startsWith("|")) continue;
    if (k === edges.length - 2 && trimmed.endsWith("|")) continue;
    const raw = line.slice(start, end);
    const lead = raw.length - raw.trimStart().length;
    cells.push({ text: raw.trim(), from: lineFrom + start + lead, segFrom: lineFrom + start, segTo: lineFrom + end });
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

function readTable(state: EditorState, nodeFrom: number, nodeTo: number): TableData | null {
  const doc = state.doc;
  const from = doc.lineAt(nodeFrom).from;
  const to = doc.lineAt(nodeTo).to;
  const first = doc.lineAt(from).number;
  const last = doc.lineAt(to).number;
  const rows: Cell[][] = [];
  let align: Align[] = [];
  for (let n = first; n <= last; n++) {
    const line = doc.line(n);
    const cells = splitRow(line.text, line.from);
    if (n === first + 1) align = cells.map((c) => alignment(c.text));
    else rows.push(cells);
  }
  if (rows.length === 0 || rows[0].length === 0) return null;
  return { from, to, rows, align };
}

function tableAt(state: EditorState, pos: number): TableData | null {
  let found: TableData | null = null;
  syntaxTree(state).iterate({
    from: pos,
    to: pos,
    enter: (node) => {
      if (node.name !== "Table") return;
      found = readTable(state, node.from, node.to);
      return false;
    },
  });
  return found;
}

function serialize(rows: string[][], align: Align[]): string {
  const width = Math.max(align.length, ...rows.map((r) => r.length));
  const line = (cells: string[]) =>
    "| " + Array.from({ length: width }, (_, i) => cells[i] ?? "").join(" | ") + " |";
  const delim = Array.from({ length: width }, (_, i) => {
    const a = align[i];
    return a === "center" ? ":---:" : a === "right" ? "---:" : a === "left" ? ":---" : "---";
  });
  return [line(rows[0]), "|" + delim.join("|") + "|", ...rows.slice(1).map(line)].join("\n");
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

// A bare pipe typed into a cell would split it; store it escaped.
const escapePipes = (s: string) => s.replace(/\n/g, " ").replace(/(^|[^\\])\|/g, "$1\\|");

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

    cell.addEventListener("focus", () => {
      // Reveal the raw Markdown only when it differs from what is shown, so a plain click
      // keeps the caret where it landed.
      const raw = cell.dataset.raw ?? "";
      if (cell.textContent !== raw) {
        cell.textContent = raw;
        placeCaret(cell, "end");
        view.requestMeasure();
      }
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
      }
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
    });
    cell.addEventListener("keydown", (e) => this.onKey(e, view, wrap, row(), col(), cell));
  }

  private onKey(e: KeyboardEvent, view: EditorView, wrap: HTMLElement, r: number, c: number, cell: HTMLElement) {
    const rows = this.data.rows.length;
    const cols = this.data.rows[0].length;
    const mod = e.metaKey || e.ctrlKey;
    const go = (row: number, col: number, at: "start" | "end") => {
      const el = wrap.querySelector<HTMLElement>(`.cm-md-cell[data-row="${row}"][data-col="${col}"]`);
      if (el) placeCaret(el, at);
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
        view.dispatch({ changes: { from: 0, insert: "\n" }, selection: { anchor: 0 } });
      } else {
        view.dispatch({ selection: { anchor: doc.line(line.number - 1).to } });
      }
    } else {
      const line = doc.lineAt(table.to);
      if (line.number === doc.lines) {
        view.dispatch({ changes: { from: doc.length, insert: "\n" }, selection: { anchor: doc.length + 1 } });
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
    view.dispatch({ changes: { from: table.from, to: table.to, insert: serialize(rows, align) } });
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
      const data = readTable(state, node.from, node.to);
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

// ⌥⌘T: insert a 3-column table after the current block and put the caret in its first cell.
export function insertTable(view: EditorView) {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.head);
  const table = serialize(
    [
      ["Column 1", "Column 2", "Column 3"],
      ["", "", ""],
    ],
    [null, null, null],
  );
  const before = line.text.trim() === "" ? "" : "\n\n";
  const at = line.text.trim() === "" ? line.from : line.to;
  const insert = before + table + "\n";
  const tableFrom = at + before.length;
  pendingFocus = { tableFrom, row: 0, col: 0, at: "end" };
  view.dispatch({ changes: { from: at, to: line.text.trim() === "" ? line.to : at, insert }, userEvent: "input" });
  return true;
}
