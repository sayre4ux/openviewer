import type { EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import type { BlockContext, Element, InlineContext, LeafBlock, LeafBlockParser, Line, MarkdownConfig } from "@lezer/markdown";

// Math syntax: `$…$` inline and a `$$` line … `$$` line as a block. The scanners here are shared with
// export (src/export/render.ts), so the editor and an exported page agree on what is a formula.
//
// Inline: the opening `$` is followed by a character that isn't whitespace or `$`; the closing `$` is
// preceded by one that isn't whitespace, isn't followed by a digit, and isn't part of `$$`; the formula
// stays on one line and holds no backtick. Backslashes escape by parity: `\$x\$` is text, `\\$x$` is
// math. So `$5 and $10` stays text. Prices written with a pair of dollars (`$5$`) are math, as in
// Pandoc; escape them.
//
// Block: a line holding only `$$` (up to three spaces before it) opens, the next such line closes.
// DECISION: a display formula can't hold a blank line (LaTeX rejects one too) or a line that would
// start another block (a heading, list item, quote, or fence); such a block stays text. An unclosed
// `$$` stays text as well, rather than swallowing the rest of the document the way an open fence does.

const DOLLAR = 36;
const BACKSLASH = 92;

const isSpace = (ch: string | undefined) => ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
const isDigit = (ch: string | undefined) => ch !== undefined && ch >= "0" && ch <= "9";

// True when the character at `pos` is preceded by an odd number of backslashes.
function escaped(text: string, pos: number) {
  let n = 0;
  for (let i = pos - 1; i >= 0 && text.charCodeAt(i) === BACKSLASH; i--) n++;
  return n % 2 === 1;
}

// Whether the `$` at `pos` can open an inline formula. The caller has already skipped escaped
// dollars (both Markdown parsers consume `\$` as an escape before this runs).
export function inlineMathOpens(text: string, pos: number): boolean {
  if (text.charCodeAt(pos) !== DOLLAR) return false;
  if (pos > 0 && text.charCodeAt(pos - 1) === DOLLAR && !escaped(text, pos - 1)) return false;
  const next = text[pos + 1];
  return next !== undefined && next !== "$" && !isSpace(next);
}

// Look for the `$` closing a formula opened at `open`. Returns its index, or -1 with `stop`, where
// the search gave up: no closing `$` exists anywhere in (open, stop), which callers remember so that
// a line full of lone dollars is scanned once, not once per dollar.
// DECISION: a formula can't hold a backtick, so a `$` inside a code span never closes one opened
// before it ("costs $5, see `$PATH`" stays text). TeX has no use for a backtick in math.
export function inlineMathClose(text: string, open: number): { close: number; stop: number } {
  for (let i = open + 1; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 10 || ch === 13 || ch === 96) return { close: -1, stop: i };
    if (ch === BACKSLASH) {
      i++;
      continue;
    }
    if (ch !== DOLLAR) continue;
    const before = text[i - 1];
    const after = text[i + 1];
    if (!isSpace(before) && before !== "$" && after !== "$" && !isDigit(after)) return { close: i, stop: i };
  }
  return { close: -1, stop: text.length };
}

// A line (after any container prefix and up to three spaces of indentation) that opens or closes a
// display formula.
export function isDisplayFence(text: string): boolean {
  return /^ {0,3}\$\$[ \t]*$/.test(text);
}

// Lines that end a paragraph in CommonMark (or turn it into a setext heading), used by export to
// match the editor, where the parser itself ends a display block at such a line.
export function startsBlock(text: string): boolean {
  return /^ {0,3}(?:#{1,6}(?:[ \t]|$)|>|[-+*][ \t]+\S|1[.)][ \t]+\S|`{3,}|~{3,}|(?:[-*_][ \t]*){3,}$|[=-]+[ \t]*$|<(?:script|pre|style|textarea|!--|\?|![A-Za-z]|!\[CDATA\[|\/?(?:address|article|aside|blockquote|body|details|dialog|div|dl|fieldset|figure|footer|form|h[1-6]|header|hr|html|li|main|nav|ol|p|section|table|ul)(?:[\s/>]|$)))/i.test(text);
}

// Failed searches per inline section: [from, stop) holds no closing `$`.
const noClose = new WeakMap<InlineContext, { from: number; stop: number }>();

class DisplayMathParser implements LeafBlockParser {
  nextLine(cx: BlockContext, line: Line, leaf: LeafBlock) {
    if (line.indent - line.baseIndent >= 4 || !isDisplayFence(line.text.slice(line.basePos))) return false;
    const closeFrom = cx.lineStart + line.pos;
    const open = cx.elt("MathMark", leaf.start, leaf.start + 2);
    const close = cx.elt("MathMark", closeFrom, closeFrom + 2);
    // The closing line's own container markers (a quote's `>`) belong to this block too.
    cx.addLeafElement(leaf, cx.elt("DisplayMath", leaf.start, cx.lineStart + line.text.length, [open, ...line.markers, close]));
    cx.nextLine();
    return true;
  }
  finish() {
    return false; // never closed: an ordinary paragraph
  }
}

export const mathSyntax: MarkdownConfig = {
  defineNodes: [{ name: "DisplayMath", block: true }, "InlineMath", "MathMark"],
  parseBlock: [{
    name: "DisplayMath",
    leaf: (_cx, leaf) => (isDisplayFence(leaf.content) ? new DisplayMathParser() : null),
    endLeaf: (_cx, line, leaf) =>
      isDisplayFence(line.text.slice(line.basePos)) && !leaf.parsers.some((p) => p instanceof DisplayMathParser),
    before: "FencedCode",
  }],
  parseInline: [{
    name: "InlineMath",
    before: "Emphasis",
    parse(cx, next, pos) {
      if (next !== DOLLAR) return -1;
      const at = pos - cx.offset;
      if (!inlineMathOpens(cx.text, at)) return -1;
      const known = noClose.get(cx);
      if (known && at > known.from && at < known.stop) return -1;
      const { close, stop } = inlineMathClose(cx.text, at);
      if (close < 0) {
        noClose.set(cx, { from: at, stop });
        return -1;
      }
      const end = cx.offset + close;
      const marks: Element[] = [cx.elt("MathMark", pos, pos + 1), cx.elt("MathMark", end, end + 1)];
      return cx.addElement(cx.elt("InlineMath", pos, end + 1, marks));
    },
  }],
};

// The TeX inside an inline formula node.
export function inlineMathSource(state: EditorState, node: SyntaxNode): string {
  return state.sliceDoc(node.from + 1, node.to - 1);
}

// The TeX inside a display block: the lines between the fences, without container markers (a quote's
// `>`). Leading spaces are kept; TeX ignores them.
export function displayMathSource(state: EditorState, node: SyntaxNode): string {
  const doc = state.doc;
  const first = doc.lineAt(node.from).number + 1;
  const last = doc.lineAt(node.to).number - 1;
  if (last < first) return "";
  const from = doc.line(first).from;
  const to = doc.line(last).to;
  const cut: [number, number][] = [];
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.name === "QuoteMark" && c.from >= from && c.to <= to) {
      const end = doc.sliceString(c.to, c.to + 1) === " " ? c.to + 1 : c.to;
      cut.push([c.from, end]);
    }
  }
  let tex = "";
  let at = from;
  for (const [a, b] of cut) {
    tex += doc.sliceString(at, a);
    at = b;
  }
  tex += doc.sliceString(at, to);
  // CodeMirror joins lines with \n whatever the file uses, so CRLF files give the same TeX.
  return tex;
}
