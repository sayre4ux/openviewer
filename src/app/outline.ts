import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

// Outline sidebar: the document's headings, indented by level. Clicking one moves the caret
// there; the heading at the top of the window is marked as current while scrolling.

interface Heading {
  level: number;
  from: number;
  text: string;
}

function headingText(raw: string) {
  return raw
    .replace(/^\s{0,3}#{1,6}\s*/, "")
    .replace(/\s+#+\s*$/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|\*|_|~~|`)/g, "")
    .trim();
}

function readHeadings(state: EditorState): Heading[] {
  const tree = ensureSyntaxTree(state, state.doc.length, 50) ?? syntaxTree(state);
  const out: Heading[] = [];
  tree.iterate({
    enter: (node) => {
      const m = /^(?:ATX|Setext)Heading(\d)$/.exec(node.name);
      if (!m) return;
      const line = state.doc.lineAt(node.from);
      out.push({ level: Number(m[1]), from: line.from, text: headingText(line.text) || "Untitled heading" });
      return false;
    },
  });
  return out;
}

export function createOutline(host: HTMLElement) {
  let view: EditorView | null = null;
  let headings: Heading[] = [];
  let timer = 0;
  let frame = 0;
  // A clicked heading stays marked while its jump scrolls, even if it can't reach the top.
  let pinned = -1;
  let pinnedUntil = 0;
  const list = document.createElement("ol");
  list.className = "ov-outline-list";
  host.replaceChildren(list);

  const render = () => {
    if (!view) return;
    headings = readHeadings(view.state);
    list.replaceChildren(
      ...headings.map((h, i) => {
        const li = document.createElement("li");
        li.className = "ov-outline-item";
        li.style.setProperty("--level", String(h.level));
        li.textContent = h.text;
        li.title = h.text;
        li.dataset.index = String(i);
        return li;
      }),
    );
    if (headings.length === 0) {
      const empty = document.createElement("li");
      empty.className = "ov-outline-empty";
      empty.textContent = "No headings";
      list.appendChild(empty);
    }
    markActive();
  };

  const markActive = () => {
    if (!view || host.hidden) return;
    let active = -1;
    if (pinned >= 0 && performance.now() < pinnedUntil) {
      active = pinned;
    } else {
      pinned = -1;
      // The current section is the last heading above a point a quarter of the way down.
      const box = view.scrollDOM.getBoundingClientRect();
      const probe = box.top + box.height / 4 - view.documentTop;
      const pos = view.lineBlockAtHeight(Math.max(0, probe)).from;
      headings.forEach((h, i) => {
        if (h.from <= pos) active = i;
      });
      if (active < 0 && headings.length) active = 0;
    }
    for (const li of list.querySelectorAll<HTMLElement>(".ov-outline-item")) {
      li.classList.toggle("is-active", Number(li.dataset.index) === active);
    }
  };

  list.addEventListener("mousedown", (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>(".ov-outline-item");
    if (!li || !view) return;
    e.preventDefault();
    const h = headings[Number(li.dataset.index)];
    pinned = Number(li.dataset.index);
    pinnedUntil = performance.now() + 600;
    view.dispatch({
      selection: { anchor: h.from },
      effects: EditorView.scrollIntoView(h.from, { y: "start", yMargin: 32 }),
    });
    view.focus();
    markActive();
  });

  return {
    attach(v: EditorView) {
      view = v;
      v.scrollDOM.addEventListener("scroll", () => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(markActive);
      });
      render();
    },
    // Called on every editor update; headings are re-read shortly after typing stops.
    update(docChanged: boolean) {
      if (!docChanged) return;
      clearTimeout(timer);
      timer = window.setTimeout(render, 150);
    },
    refresh: render,
  };
}
