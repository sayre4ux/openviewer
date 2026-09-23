import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Range, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";

// GFM tables render as a real <table> while the caret is outside them. Clicking a cell puts the
// caret at that cell's text, which reveals the Markdown source for editing. Tables span several
// lines, so this must be a block decoration, and block decorations have to come from a state
// field rather than the live-preview view plugin.

interface Cell {
  text: string;
  from: number;
}
type Align = "left" | "center" | "right" | null;

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
    const isLeadingEdge = k === 0 && trimmed.startsWith("|");
    const isTrailingEdge = k === edges.length - 2 && trimmed.endsWith("|");
    if (isLeadingEdge || isTrailingEdge) continue;
    const raw = line.slice(start, end);
    const lead = raw.length - raw.trimStart().length;
    cells.push({ text: raw.trim(), from: lineFrom + start + lead });
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

class TableWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly from: number,
    readonly rows: Cell[][],
    readonly align: Align[],
  ) {
    super();
  }
  eq(other: TableWidget) {
    return other.source === this.source && other.from === this.from;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-md-table-wrap";
    const table = document.createElement("table");
    table.className = "cm-md-table";
    const columns = this.rows[0].length;
    this.rows.forEach((row, r) => {
      const tr = document.createElement("tr");
      for (let c = 0; c < columns; c++) {
        const cell = row[c];
        const el = document.createElement(r === 0 ? "th" : "td");
        if (this.align[c]) el.style.textAlign = this.align[c]!;
        if (cell) {
          el.innerHTML = renderInline(cell.text);
          el.dataset.pos = String(cell.from);
        }
        tr.appendChild(el);
      }
      if (r === 0) table.createTHead().appendChild(tr);
      else (table.tBodies[0] ?? table.createTBody()).appendChild(tr);
    });
    wrap.appendChild(table);
    wrap.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const link = (e.target as HTMLElement).closest("[data-href]");
      if ((e.metaKey || e.ctrlKey) && link) {
        window.dispatchEvent(new CustomEvent("openviewer:open-link", { detail: link.getAttribute("data-href") }));
        return;
      }
      const cell = (e.target as HTMLElement).closest<HTMLElement>("[data-pos]");
      const pos = cell ? Number(cell.dataset.pos) : this.from;
      view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
      view.focus();
    });
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

function touches(state: EditorState, from: number, to: number) {
  for (const r of state.selection.ranges) if (r.from <= to && r.to >= from) return true;
  return false;
}

function buildTables(state: EditorState): DecorationSet {
  const out: Range<Decoration>[] = [];
  const doc = state.doc;
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== "Table") return;
      const from = doc.lineAt(node.from).from;
      const to = doc.lineAt(node.to).to;
      if (touches(state, from, to)) return false;
      const rows: Cell[][] = [];
      let align: Align[] = [];
      const first = doc.lineAt(from).number;
      const last = doc.lineAt(to).number;
      for (let n = first; n <= last; n++) {
        const line = doc.line(n);
        const cells = splitRow(line.text, line.from);
        if (n === first + 1) align = cells.map((c) => alignment(c.text));
        else rows.push(cells);
      }
      if (rows.length === 0 || rows[0].length === 0) return false;
      const widget = new TableWidget(doc.sliceString(from, to), from, rows, align);
      out.push(Decoration.replace({ widget, block: true }).range(from, to));
      return false;
    },
  });
  return Decoration.set(out);
}

export const tables = StateField.define<DecorationSet>({
  create: buildTables,
  update(value, tr) {
    if (tr.docChanged || tr.selection || syntaxTree(tr.startState) !== syntaxTree(tr.state)) {
      return buildTables(tr.state);
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});
