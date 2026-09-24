import { syntaxTree } from "@codemirror/language";
import type { EditorState, Range } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { CodeLanguageWidget } from "./codeLanguage";
import { tables } from "./tables";

// Typora-style live rendering over plain Markdown text. The document is never rewritten;
// this plugin only adds decorations: line classes for block styling, mark classes for inline
// styling, and replacements that hide Markdown syntax while the caret is elsewhere.

const hide = Decoration.replace({});
const revealedMark = Decoration.mark({ class: "cm-md-mark" });

const inlineClass: Record<string, string> = {
  Emphasis: "cm-md-em",
  StrongEmphasis: "cm-md-strong",
  Strikethrough: "cm-md-strike",
  InlineCode: "cm-md-code",
};
const inlineMarkNode: Record<string, string> = {
  Emphasis: "EmphasisMark",
  StrongEmphasis: "EmphasisMark",
  Strikethrough: "StrikethroughMark",
  InlineCode: "CodeMark",
};

class BulletWidget extends WidgetType {
  constructor(readonly label: string, readonly ordered: boolean) {
    super();
  }
  eq(other: BulletWidget) {
    return other.label === this.label && other.ordered === this.ordered;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = this.ordered ? "cm-md-bullet cm-md-bullet-ol" : "cm-md-bullet";
    el.textContent = this.label;
    return el;
  }
}

class TaskWidget extends WidgetType {
  constructor(readonly checked: boolean, readonly markerPos: number) {
    super();
  }
  eq(other: TaskWidget) {
    return other.checked === this.checked && other.markerPos === this.markerPos;
  }
  toDOM(view: EditorView) {
    const el = document.createElement("span");
    el.className = "cm-md-bullet cm-md-task" + (this.checked ? " is-checked" : "");
    el.textContent = "√";
    el.setAttribute("role", "checkbox");
    el.setAttribute("aria-checked", String(this.checked));
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const insert = this.checked ? " " : "x";
      view.dispatch({ changes: { from: this.markerPos + 1, to: this.markerPos + 2, insert } });
    });
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

class ImageWidget extends WidgetType {
  constructor(readonly src: string, readonly alt: string, readonly resolverVersion: number) {
    super();
  }
  eq(other: ImageWidget) {
    return other.src === this.src && other.alt === this.alt && other.resolverVersion === this.resolverVersion;
  }
  toDOM() {
    const image = (src: string) => {
      const img = document.createElement("img");
      img.className = "cm-md-image";
      img.alt = this.alt;
      img.addEventListener("error", () => img.replaceWith(blockedImageNode(this.alt)), { once: true });
      img.src = src;
      return img;
    };
    const show = (r: ResolvedImage) => (typeof r === "string" ? image(r) : blockedImageNode(this.alt, r ?? undefined));
    const resolved = resolveImage(this.src);
    if (resolved instanceof Promise) {
      const pending = document.createElement("span");
      void resolved.then((r) => pending.replaceWith(show(r))).catch(() => pending.replaceWith(blockedImageNode(this.alt)));
      return pending;
    }
    return show(resolved);
  }
}

class BlockedImageWidget extends WidgetType {
  constructor(readonly alt: string) {
    super();
  }
  eq(other: BlockedImageWidget) {
    return other.alt === this.alt;
  }
  toDOM() {
    return blockedImageNode(this.alt);
  }
}

// A blocked local image the user may allow: its folder, for this document, after a native prompt.
export interface BlockedImage {
  folder: string;
  allow: () => Promise<boolean>;
}
type ResolvedImage = string | null | BlockedImage;

function blockedImageNode(altText: string, offer?: BlockedImage) {
  const el = document.createElement("span");
  el.className = "cm-md-image-blocked";
  if (altText) {
    const alt = document.createElement("span");
    alt.className = "cm-md-image-blocked-alt";
    alt.textContent = altText;
    el.appendChild(alt);
  }
  const note = document.createElement("span");
  note.className = "cm-md-image-blocked-note";
  note.textContent = "image blocked";
  el.appendChild(note);
  if (offer) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cm-md-image-allow";
    const name = offer.folder.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || offer.folder;
    button.textContent = `Show images from “${name}”…`;
    button.title = offer.folder;
    button.addEventListener("mousedown", (e) => e.preventDefault()); // keep the editor selection where it is
    button.addEventListener("click", () => void offer.allow());
    el.appendChild(button);
  }
  return el;
}

// https, http (except loopback, private, and link-local hosts), data:image, or a file path.
// Anything else, including javascript: and protocol-relative URLs, is not loaded.
export function imageUrlAllowed(raw: string): boolean {
  const src = raw.trim();
  if (/^data:image\//i.test(src)) return true;
  if (/^[a-z]:[\\/]/i.test(src)) return true; // a Windows drive path, not a URL scheme
  if (/^[a-z][a-z0-9+.-]*:/i.test(src)) {
    if (!/^https?:\/\//i.test(src)) return false;
    try {
      return !isBlockedHost(new URL(src).hostname);
    } catch {
      return false;
    }
  }
  // DECISION: "//host/..." is a remote URL with the page's scheme, not a file path.
  if (src.startsWith("//") || src.startsWith("\\\\")) return false;
  return src.length > 0;
}

function isBlockedHost(hostname: string): boolean {
  let host = hostname.trim().toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host.includes(":")) return isPrivateV6(host);
  const v4 = parseDottedIpv4(host);
  return v4 !== null && isPrivateV4(v4);
}

function parseDottedIpv4(host: string): number | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  let ip = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    ip = ((ip << 8) | n) >>> 0;
  }
  return ip;
}

function isPrivateV4(ip: number): boolean {
  const a = ip >>> 24;
  const b = (ip >>> 16) & 0xff;
  if (a === 0 || a === 10 || a === 127) return true; // 0.0.0.0/8 reaches this machine on macOS
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10: carrier-grade NAT, Tailscale
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

function parseIpv6(host: string): Uint8Array | null {
  let text = host;
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);
  const lastColon = text.lastIndexOf(":");
  if (lastColon !== -1 && text.slice(lastColon + 1).includes(".")) {
    const v4 = parseDottedIpv4(text.slice(lastColon + 1));
    if (v4 === null) return null;
    text = `${text.slice(0, lastColon + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parseSide = (side: string): number[] | null => {
    if (side === "") return [];
    const nums: number[] = [];
    for (const group of side.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      nums.push(parseInt(group, 16));
    }
    return nums;
  };
  const left = parseSide(halves[0]);
  if (!left) return null;
  const right = halves.length === 2 ? parseSide(halves[1]) : [];
  if (!right) return null;
  // "::" has to stand in for at least one group, so 8 explicit groups plus "::" is not an address.
  if (halves.length === 1 ? left.length !== 8 : left.length + right.length > 7) return null;
  const groups = [...left, ...Array(8 - left.length - right.length).fill(0), ...right];
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    out[i * 2] = groups[i] >> 8;
    out[i * 2 + 1] = groups[i] & 0xff;
  }
  return out;
}

function isPrivateV6(host: string): boolean {
  const bytes = parseIpv6(host);
  if (!bytes) return false;
  const mapped = bytes.subarray(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  if (mapped) {
    const ip = ((bytes[12] << 24) | (bytes[13] << 16) | (bytes[14] << 8) | bytes[15]) >>> 0;
    return isPrivateV4(ip);
  }
  if (bytes[15] === 1 && bytes.subarray(0, 15).every((b) => b === 0)) return true; // ::1
  if ((bytes[0] & 0xfe) === 0xfc) return true; // fc00::/7
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true; // fe80::/10
  return false;
}

function touches(state: EditorState, from: number, to: number) {
  for (const r of state.selection.ranges) if (r.from <= to && r.to >= from) return true;
  return false;
}

function lineTouched(state: EditorState, pos: number) {
  const line = state.doc.lineAt(pos);
  return touches(state, line.from, line.to);
}

function listDepth(node: SyntaxNode) {
  let depth = 0;
  for (let n = node.parent; n; n = n.parent) {
    if (n.name === "BulletList" || n.name === "OrderedList") depth++;
  }
  return depth;
}

function addLines(
  state: EditorState,
  out: Range<Decoration>[],
  from: number,
  to: number,
  deco: (lineNo: number, first: boolean, last: boolean) => Decoration | null,
) {
  const first = state.doc.lineAt(from).number;
  const last = state.doc.lineAt(to).number;
  for (let n = first; n <= last; n++) {
    const d = deco(n, n === first, n === last);
    if (d) out.push(d.range(state.doc.line(n).from));
  }
}

function buildDecorations(view: EditorView): DecorationSet {
  const { state } = view;
  const out: Range<Decoration>[] = [];
  const doc = state.doc;
  const { from, to } = view.viewport;

  syntaxTree(state).iterate({
    from,
    to,
    enter: (ref) => {
      const node = ref.node;
      const name = node.name;

      const heading = /^ATXHeading(\d)$/.exec(name) ?? /^SetextHeading(\d)$/.exec(name);
      if (heading) {
        const level = heading[1];
        const active = lineTouched(state, node.from);
        out.push(Decoration.line({ class: `cm-md-h cm-md-h${level}` }).range(doc.lineAt(node.from).from));
        for (let c = node.firstChild; c; c = c.nextSibling) {
          if (c.name !== "HeaderMark") continue;
          if (name.startsWith("Setext")) {
            // The ===/--- underline line collapses like a fence line.
            const line = doc.lineAt(c.from);
            out.push(Decoration.line({ class: active ? "cm-md-setext-mark" : "cm-md-setext-mark is-hidden" }).range(line.from));
            out.push((active ? revealedMark : hide).range(c.from, c.to));
            continue;
          }
          if (active) {
            out.push(revealedMark.range(c.from, c.to));
          } else {
            // Hide "# " (mark plus its following space) or " ##" closing sequences.
            if (c.from === node.from) {
              const end = doc.sliceString(c.to, c.to + 1) === " " ? c.to + 1 : c.to;
              out.push(hide.range(c.from, end));
            } else {
              const start = doc.sliceString(c.from - 1, c.from) === " " ? c.from - 1 : c.from;
              out.push(hide.range(start, c.to));
            }
          }
        }
        return;
      }

      if (name in inlineClass) {
        const active = touches(state, node.from, node.to);
        out.push(Decoration.mark({ class: inlineClass[name] }).range(node.from, node.to));
        for (let c = node.firstChild; c; c = c.nextSibling) {
          if (c.name !== inlineMarkNode[name]) continue;
          out.push((active ? revealedMark : hide).range(c.from, c.to));
        }
        return name === "InlineCode" ? false : undefined;
      }

      if (name === "Link" || name === "Autolink") {
        const active = touches(state, node.from, node.to);
        const marks: SyntaxNode[] = [];
        for (let c = node.firstChild; c; c = c.nextSibling) if (c.name === "LinkMark") marks.push(c);
        if (name === "Autolink" || marks.length < 2) {
          out.push(Decoration.mark({ class: "cm-md-link" }).range(node.from, node.to));
          if (!active) for (const m of marks) out.push(hide.range(m.from, m.to));
          return false;
        }
        const textFrom = marks[0].to;
        const textTo = marks[1].from;
        const url = node.getChild("URL");
        const attrs = url ? { "data-href": doc.sliceString(url.from, url.to) } : undefined;
        if (textTo > textFrom) {
          out.push(Decoration.mark({ class: "cm-md-link", attributes: attrs }).range(textFrom, textTo));
        }
        if (active) {
          out.push(revealedMark.range(node.from, textFrom));
          out.push(revealedMark.range(textTo, node.to));
        } else {
          out.push(hide.range(node.from, textFrom));
          out.push(hide.range(textTo, node.to));
        }
        return;
      }

      if (name === "URL" && node.parent?.name !== "Link" && node.parent?.name !== "Image") {
        const text = doc.sliceString(node.from, node.to);
        out.push(Decoration.mark({ class: "cm-md-link", attributes: { "data-href": text } }).range(node.from, node.to));
        return;
      }

      if (name === "Image") {
        if (touches(state, node.from, node.to)) {
          out.push(revealedMark.range(node.from, node.to));
          return false;
        }
        const url = node.getChild("URL");
        const marks = node.getChildren("LinkMark");
        const alt = marks.length >= 2 ? doc.sliceString(marks[0].to, marks[1].from) : "";
        if (url) {
          const raw = doc.sliceString(url.from, url.to);
          const widget = imageUrlAllowed(raw) ? new ImageWidget(raw, alt, imageResolverVersion) : new BlockedImageWidget(alt);
          out.push(Decoration.replace({ widget }).range(node.from, node.to));
        }
        return false;
      }

      if (name === "Blockquote") {
        addLines(state, out, node.from, node.to, () => Decoration.line({ class: "cm-md-quote" }));
        return;
      }
      if (name === "QuoteMark") {
        const end = doc.sliceString(node.to, node.to + 1) === " " ? node.to + 1 : node.to;
        out.push(hide.range(node.from, end));
        return;
      }

      if (name === "ListItem") {
        const depth = listDepth(node);
        const mark = node.getChild("ListMark");
        if (!mark) return;
        const firstLine = doc.lineAt(node.from);
        const ordered = node.parent?.name === "OrderedList";
        const task = node.getChild("Task")?.getChild("TaskMarker") ?? null;
        const style = `--li-depth:${depth}`;
        addLines(state, out, node.from, node.to, (n, first) => {
          if (first) return Decoration.line({ class: "cm-md-li cm-md-li-first", attributes: { style } });
          // Continuation lines of this item (not lines owned by a nested item).
          const line = doc.line(n);
          const inner = syntaxTree(state).resolveInner(line.from + (line.text.length - line.text.trimStart().length), 1);
          for (let p: SyntaxNode | null = inner; p; p = p.parent) {
            if (p.name === "ListItem") {
              return p.from === node.from ? Decoration.line({ class: "cm-md-li", attributes: { style } }) : null;
            }
          }
          return null;
        });
        // Hide leading indentation and the marker; draw a bullet in the hanging indent.
        let markerEnd = mark.to;
        if (doc.sliceString(markerEnd, markerEnd + 1) === " ") markerEnd++;
        if (task) {
          const checked = /x/i.test(doc.sliceString(task.from, task.to));
          let taskEnd = task.to;
          if (doc.sliceString(taskEnd, taskEnd + 1) === " ") taskEnd++;
          out.push(Decoration.replace({ widget: new TaskWidget(checked, task.from) }).range(firstLine.from, taskEnd));
        } else {
          const label = ordered ? doc.sliceString(mark.from, mark.to) : "•";
          out.push(Decoration.replace({ widget: new BulletWidget(label, ordered) }).range(firstLine.from, markerEnd));
        }
        return;
      }

      if (name === "HorizontalRule") {
        const active = lineTouched(state, node.from);
        out.push(Decoration.line({ class: active ? "cm-md-hr is-active" : "cm-md-hr" }).range(doc.lineAt(node.from).from));
        out.push((active ? revealedMark : hide).range(node.from, node.to));
        return;
      }

      if (name === "FencedCode" || name === "CodeBlock") {
        const fenced = name === "FencedCode";
        const openMark = fenced ? node.firstChild : null;
        const closed = fenced && node.lastChild?.name === "CodeMark" && node.lastChild.from > openMark!.to;
        const open = doc.lineAt(node.from);
        const close = doc.lineAt(node.to);
        // Each fence line reveals its own raw text only while the caret is on it.
        const openActive = fenced && lineTouched(state, open.from);
        const closeActive = closed && lineTouched(state, close.from);
        addLines(state, out, node.from, node.to, (_n, first, last) => {
          const classes = ["cm-md-fence"];
          if (first) classes.push("cm-md-fence-first");
          if (last) classes.push("cm-md-fence-last");
          if (fenced && first) classes.push("cm-md-fence-head", openActive ? "is-active" : "is-rendered");
          if (closed && last) classes.push("cm-md-fence-tail", closeActive ? "is-active" : "is-hidden");
          return Decoration.line({ class: classes.join(" ") });
        });
        if (fenced && openMark) {
          if (openActive) {
            out.push(revealedMark.range(open.from, open.to));
          } else {
            const info = node.getChild("CodeInfo");
            const infoFrom = info ? info.from : openMark.to;
            const infoTo = info ? info.to : openMark.to;
            const widget = new CodeLanguageWidget(doc.sliceString(infoFrom, infoTo), infoFrom, infoTo);
            out.push(Decoration.replace({ widget }).range(open.from, open.to));
          }
          if (closed && close.to > close.from) out.push((closeActive ? revealedMark : hide).range(close.from, close.to));
        }
        return false;
      }

      if (name === "HTMLBlock" || name === "Table") {
        addLines(state, out, node.from, node.to, () => Decoration.line({ class: "cm-md-raw" }));
        return false;
      }
    },
  });

  return Decoration.set(out, true);
}

// Relative image paths resolve against the open file's folder. The spike has no file,
// so this is a hook the Tauri shell replaces.
let imageResolver: (src: string) => ResolvedImage | Promise<ResolvedImage> = (src) => src;
let imageResolverVersion = 0;
export function setImageResolver(fn: (src: string) => ResolvedImage | Promise<ResolvedImage>) {
  imageResolver = fn;
  imageResolverVersion++;
}
export function refreshImageResolver(view: EditorView) {
  imageResolverVersion++;
  view.dispatch({ selection: view.state.selection });
}
function resolveImage(src: string) {
  return imageResolver(src);
}

const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) {
        this.decorations = buildDecorations(u.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
    // Hidden list markers are atomic, so Backspace at the start of an item removes the
    // whole marker and turns the item back into a paragraph, as in Typora.
    provide: (plugin) =>
      EditorView.atomicRanges.of((view) => {
        const value = view.plugin(plugin);
        if (!value) return Decoration.none;
        return value.decorations.update({
          filter: (_f, _t, d) => d.spec.widget instanceof BulletWidget || d.spec.widget instanceof TaskWidget,
        });
      }),
  },
);

const linkClick = EditorView.domEventHandlers({
  mousedown(e) {
    if (!(e.metaKey || e.ctrlKey)) return false;
    const el = (e.target as HTMLElement).closest("[data-href]");
    const href = el?.getAttribute("data-href");
    if (!href) return false;
    e.preventDefault();
    window.dispatchEvent(new CustomEvent("openviewer:open-link", { detail: href }));
    return true;
  },
});

export const livePreview = [livePreviewPlugin, linkClick, tables];
