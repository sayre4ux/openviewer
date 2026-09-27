import { ensureSyntaxTree, foldedRanges, unfoldEffect } from "@codemirror/language";
import type { EditorState, StateEffect } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import { EditorView } from "@codemirror/view";

// `[see below](#my-heading)` jumps to a heading in the same document. Heading ids follow GitHub's
// rules, the ones most Markdown written for the web assumes: lowercase, punctuation dropped, spaces
// to hyphens, and a repeated heading gets -1, -2.

const HEADING_NODES = /^(ATXHeading[1-6]|SetextHeading[12])$/;
// Parts of a heading that aren't its text: Markdown marks, link and image targets, HTML tags.
const NOT_TEXT = new Set(["HeaderMark", "EmphasisMark", "CodeMark", "StrikethroughMark", "LinkMark", "URL",
  "LinkTitle", "LinkLabel", "Image", "HTMLTag", "Comment", "ProcessingInstruction"]);

// The heading's text as it reads when rendered, from the syntax tree: `_emphasis_` loses its marks, a
// literal `snake_case` keeps its underscore, `\*` is a star, and a link is its text.
function headingText(state: EditorState, heading: SyntaxNode) {
  let text = "";
  let pos = heading.from;
  const skip = (node: SyntaxNode) => {
    text += state.sliceDoc(pos, node.from);
    if (node.name === "Escape") text += state.sliceDoc(node.from + 1, node.to);
    pos = node.to;
  };
  const visit = (node: SyntaxNode) => {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (NOT_TEXT.has(child.name) || child.name === "Escape") skip(child);
      else visit(child);
    }
  };
  visit(heading);
  text += state.sliceDoc(pos, heading.to);
  // A setext heading's underline is its own line; the text is the lines above it.
  return text.replace(/\n[ \t]*[=-]+[ \t]*$/, "").replace(/\s+/g, " ");
}

export function slugify(text: string) {
  return text.trim().toLowerCase().replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "").replace(/\s/g, "-");
}

export function headingSlugs(state: EditorState): { slug: string; pos: number }[] {
  // Anchors can point far below the parsed part of a long document; parse up to it (bounded).
  const tree = ensureSyntaxTree(state, state.doc.length, 200);
  if (!tree) return [];
  const seen = new Map<string, number>();
  const out: { slug: string; pos: number }[] = [];
  tree.iterate({
    enter: (node) => {
      if (!HEADING_NODES.test(node.name)) return;
      const first = state.doc.lineAt(node.from);
      const base = slugify(headingText(state, node.node));
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      out.push({ slug: count ? `${base}-${count}` : base, pos: first.from });
      return false;
    },
  });
  return out;
}

export function scrollToAnchor(view: EditorView, fragment: string): boolean {
  let wanted = fragment.replace(/^#/, "");
  try {
    wanted = decodeURIComponent(wanted);
  } catch {
    // Not valid percent-encoding: match it as written.
  }
  const slugs = headingSlugs(view.state);
  const target = slugs.find((h) => h.slug === wanted) ?? slugs.find((h) => h.slug === slugify(wanted));
  if (!target) return false;
  // Sections around the heading, and its own section, are unfolded: the jump is there to read it.
  const effects: StateEffect<unknown>[] = [];
  const headingEnd = view.state.doc.lineAt(target.pos).to;
  foldedRanges(view.state).between(target.pos, headingEnd, (from, to) => {
    if ((from <= target.pos && to >= target.pos) || from === headingEnd) effects.push(unfoldEffect.of({ from, to }));
  });
  effects.push(EditorView.scrollIntoView(target.pos, { y: "start", yMargin: 24 }));
  view.dispatch({ effects });
  return true;
}
