import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightCode, tagHighlighter, tags as t } from "@lezer/highlight";
import DOMPurify from "dompurify";
import katexCss from "katex/dist/katex.min.css?raw";
import { Marked, type Token, type TokenizerAndRendererExtension, type Tokens } from "marked";
import { inlineMathClose, inlineMathOpens, isDisplayFence, startsBlock } from "../editor/math";
import { type DiagramResult, diagramsEnabled, MAX_DIAGRAMS, renderDiagram } from "../render/diagram";
import { loads } from "../render/loads";
import { loadMath, MAX_FORMULAS, type MathKind, mathReady, renderMath } from "../render/math";
import exportCss from "./export.css?raw";

// Export: the document as one standalone HTML page. Markdown is rendered with marked and sanitized
// with DOMPurify; only then are our own changes made (highlighted code, embedded images), so nothing
// from the document reaches the page unsanitized. The page carries its own CSP: no scripts at all.
// Formulas are rendered (and sanitized) first and placed in marked's output, so the page sanitizer
// sees them too.

export type ExportOptions = {
  // File name without extension, used when the document has no heading.
  name: string;
  // Local image sources (as written) → a data: URL, or null when the image can't be shown.
  embedImage: (source: string) => Promise<string | null>;
  // Remote image policy: the user's setting plus the editor's host rules (no loopback or private hosts).
  remoteAllowed: (source: string) => boolean;
  // PT Serif as data: URLs, so the page looks right anywhere. Omitted in tests.
  fonts?: { regular: string; italic: string; bold: string; boldItalic: string };
  // Total size of embedded image data; EMBED_BUDGET unless a test sets a smaller one.
  embedBudget?: number;
};

// Math for marked, with the editor's own scanners (src/editor/math.ts). One set per export: it counts
// formulas against the document budget and notes whether KaTeX's stylesheet is needed.
type MathToken = Tokens.Generic & { tex: string };
function mathExtensions(state: { formulas: number; used: boolean }): TokenizerAndRendererExtension[] {
  const html = (tex: string, kind: MathKind) => {
    const source = kind === "display" ? `$$\n${tex}\n$$` : `$${tex}$`;
    const result = state.formulas < MAX_FORMULAS ? renderMath(tex, kind) : null;
    state.formulas++;
    if (!result?.ok) {
      return kind === "display"
        ? `<pre class="ov-math-error"><code>${escapeHtml(source)}</code></pre>\n`
        : `<code class="ov-math-error">${escapeHtml(source)}</code>`;
    }
    state.used = true;
    return kind === "display" ? `<div class="ov-math-display">${result.html}</div>\n` : `<span class="ov-math">${result.html}</span>`;
  };
  // Failed searches per inline run, measured from the end of the text (see inlineMathClose).
  const noClose = new WeakMap<object, { fromLen: number; stopLen: number }>();
  return [
    {
      name: "displayMath",
      level: "block",
      start: (src) => {
        const m = /(?:^|\n) {0,3}\$\$[ \t]*(?:\n|$)/.exec(src);
        return m ? m.index + (m[0].startsWith("\n") ? 1 : 0) : undefined;
      },
      tokenizer(src) {
        const first = src.indexOf("\n");
        if (first < 0 || !isDisplayFence(src.slice(0, first))) return undefined;
        const body: string[] = [];
        for (let at = first + 1; at < src.length;) {
          const end = src.indexOf("\n", at) < 0 ? src.length : src.indexOf("\n", at);
          const line = src.slice(at, end);
          if (isDisplayFence(line)) {
            return { type: "displayMath", raw: src.slice(0, Math.min(end + 1, src.length)), tex: body.join("\n") } as MathToken;
          }
          if (line.trim() === "" || startsBlock(line)) return undefined;
          body.push(line);
          at = end + 1;
        }
        return undefined;
      },
      renderer: (token) => html((token as MathToken).tex, "display"),
    },
    {
      name: "inlineMath",
      level: "inline",
      start: (src) => {
        const i = src.indexOf("$");
        return i < 0 ? undefined : i;
      },
      tokenizer(src, tokens) {
        // The character before, which marked has already consumed: `$$x$` is not a formula, `\$$x$` is.
        const prev = tokens.at(-1);
        if (prev && prev.type !== "escape" && prev.raw.endsWith("$")) return undefined;
        if (!inlineMathOpens(src, 0)) return undefined;
        const known = noClose.get(tokens);
        if (known && src.length < known.fromLen && src.length > known.stopLen) return undefined;
        const { close, stop } = inlineMathClose(src, 0);
        if (close < 0) {
          noClose.set(tokens, { fromLen: src.length, stopLen: src.length - stop });
          return undefined;
        }
        return { type: "inlineMath", raw: src.slice(0, close + 1), tex: src.slice(1, close) } as MathToken;
      },
      renderer: (token) => html((token as MathToken).tex, "inline"),
    },
  ];
}

// Mermaid blocks become images, rendered in document order before the page is built: the same
// renderer and image as the editor. A diagram that fails, or any diagram while they're off, exports as
// the code block it is. The same editor rules decide what's a diagram: a closed fence whose info
// string is exactly "mermaid".
const EXPORT_DIAGRAM_TIME = 30000;
async function exportDiagrams(marked: Marked, tokens: Token[]): Promise<Map<Token, DiagramResult>> {
  const results = new Map<Token, DiagramResult>();
  if (!diagramsEnabled()) return results;
  const blocks: Tokens.Code[] = [];
  marked.walkTokens(tokens, (token) => {
    if (token.type !== "code") return;
    const code = token as Tokens.Code;
    if (code.codeBlockStyle === "indented" || (code.lang ?? "").trim().toLowerCase() !== "mermaid") return;
    if (/\n[ \t]{0,3}(`{3,}|~{3,})[ \t]*\n*$/.test(code.raw)) blocks.push(code);
  });
  const started = performance.now();
  for (const block of blocks.slice(0, MAX_DIAGRAMS)) {
    if (performance.now() - started > EXPORT_DIAGRAM_TIME) break;
    results.set(block, await renderDiagram(block.text));
  }
  return results;
}

// Code token classes, the same palette as the editor's code card (codeHighlight.ts).
const highlighter = tagHighlighter([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.definitionKeyword, t.modifier], class: "k" },
  { tag: [t.string, t.special(t.string), t.regexp], class: "s" },
  { tag: [t.number, t.bool, t.atom], class: "n" },
  { tag: [t.tagName, t.angleBracket], class: "g" },
  { tag: t.attributeName, class: "a" },
  { tag: [t.lineComment, t.blockComment], class: "c" },
  { tag: [t.typeName, t.className], class: "y" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], class: "f" },
]);

async function highlight(code: HTMLElement) {
  const lang = /(?:^|\s)language-(\S+)/.exec(code.className)?.[1];
  const desc = lang ? LanguageDescription.matchLanguageName(languages, lang, true) : null;
  if (!desc) return;
  let support;
  try {
    support = await desc.load();
  } catch {
    return;
  }
  const text = code.textContent ?? "";
  const tree = support.language.parser.parse(text);
  const out = document.createDocumentFragment();
  highlightCode(text, tree, highlighter,
    (chunk, classes) => {
      if (!classes) { out.append(chunk); return; }
      const span = document.createElement("span");
      span.className = classes;
      span.textContent = chunk;
      out.append(span);
    },
    () => out.append("\n"));
  code.replaceChildren(out);
}

function isLocal(src: string) {
  return !/^[a-z][a-z0-9+.-]*:/i.test(src) || /^[a-z]:[\\/]/i.test(src) || /^file:/i.test(src);
}

// Everything in the page that could load a resource, other than <img src> (checked in `embed`).
// DECISION: dropped rather than checked; a Markdown export has no use for video, SVG references, or
// CSS images, and each would be another way to reach the network.
const FORBID_TAGS = ["style", "form", "button", "textarea", "select", "video", "audio", "source", "track",
  "picture", "object", "embed", "image", "feImage", "use", "link", "meta", "base", "mglyph", "maction"];
const FORBID_ATTR = ["srcset", "poster", "background", "lowsrc", "dynsrc", "ping", "action", "formaction", "xlink:href", "cite", "longdesc"];

// Budget for embedded image bytes, so a document that repeats a large image can't exhaust memory.
const EMBED_BUDGET = 200 * 1024 * 1024;

async function embed(img: HTMLImageElement, options: ExportOptions, cache: Map<string, string | null>, budget: { left: number }) {
  // Charged per use, not per file: every <img> carries its own copy of the data URL.
  const src = img.getAttribute("src") ?? "";
  img.removeAttribute("srcset");
  let url: string | null = null;
  if (/^data:image\//i.test(src)) {
    if (src.length <= budget.left) {
      budget.left -= src.length;
      url = src;
    }
  }
  else if (/^https?:\/\//i.test(src)) url = options.remoteAllowed(src) ? src : null;
  else if (isLocal(src) && src) {
    const local = src.replace(/^file:\/\//i, "");
    if (!cache.has(local)) cache.set(local, budget.left > 0 ? await options.embedImage(local) : null);
    const data = cache.get(local) ?? null;
    if (data && data.length <= budget.left) {
      budget.left -= data.length;
      url = data;
    }
  }
  if (url) {
    img.setAttribute("src", url);
    return;
  }
  // DECISION: an image that can't be shown becomes its alt text, as in the editor.
  const alt = document.createElement("span");
  alt.className = "ov-missing-image";
  alt.textContent = img.getAttribute("alt") || "image";
  img.replaceWith(alt);
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function fontFaces(fonts: ExportOptions["fonts"]) {
  if (!fonts) return "";
  const face = (url: string, style: string, weight: number) =>
    `@font-face{font-family:"PT Serif";font-style:${style};font-weight:${weight};src:url("${url}") format("woff2")}`;
  return face(fonts.regular, "normal", 400) + face(fonts.italic, "italic", 400) + face(fonts.bold, "normal", 700) + face(fonts.boldItalic, "italic", 700);
}

// The page's own policy: images and fonts inline, no scripts, no other requests. Remote images are
// allowed only when one was kept (the user turned them on), so the page otherwise can't reach the network.
const pageCsp = (remote: boolean) =>
  `default-src 'none'; img-src data:${remote ? " https: http:" : ""}; style-src 'unsafe-inline'; font-src data:`;

export async function renderExport(markdown: string, options: ExportOptions): Promise<string> {
  const math = { formulas: 0, used: false };
  // Without KaTeX (it failed to load), formulas export as the text they are.
  if (markdown.includes("$")) await loadMath().catch(() => undefined);
  const marked = new Marked({ gfm: true, breaks: false, async: false });
  if (mathReady()) marked.use({ extensions: mathExtensions(math) });
  const tokens = marked.lexer(markdown);
  const diagrams = await exportDiagrams(marked, tokens);
  marked.use({
    renderer: {
      code(token) {
        const r = diagrams.get(token);
        if (!r?.ok) return false; // an ordinary code block
        return `<p class="ov-diagram"><img src="${r.dataUrl}" alt="Mermaid diagram" width="${r.width}" height="${r.height}"></p>\n`;
      },
    },
  });
  const html = marked.parser(tokens);
  const purify = DOMPurify();
  // Inline styles stay (colors, alignment) unless they could load something.
  // Only <img src> and <a href> may hold a URL; any other attribute that could load one goes.
  purify.addHook("uponSanitizeAttribute", (node, data) => {
    const tag = node.nodeName.toLowerCase();
    if (data.attrName === "src" && tag !== "img") data.keepAttr = false;
    else if (data.attrName === "href" && tag !== "a") data.keepAttr = false;
    else if (data.attrName !== "src" && data.attrName !== "href" && loads.test(data.attrValue)) data.keepAttr = false;
  });
  // <semantics> and <annotation> hold a formula's MathML; without them its TeX would be loose text.
  const body = purify.sanitize(html, { RETURN_DOM_FRAGMENT: true, FORBID_TAGS, FORBID_ATTR, ADD_TAGS: ["semantics", "annotation"] });
  // Only disabled task-list checkboxes survive as inputs.
  for (const input of body.querySelectorAll("input")) {
    if (input.type !== "checkbox") input.remove();
    else input.setAttribute("disabled", "");
  }
  await Promise.all(Array.from(body.querySelectorAll<HTMLElement>("pre > code")).map(highlight));
  // One image at a time, each source once, within the budget.
  const cache = new Map<string, string | null>();
  const budget = { left: options.embedBudget ?? EMBED_BUDGET };
  for (const img of Array.from(body.querySelectorAll("img"))) await embed(img, options, cache, budget);
  const remote = Array.from(body.querySelectorAll("img")).some((img) => /^https?:/i.test(img.getAttribute("src") ?? ""));
  const title = headingText(body.querySelector("h1")) || options.name || "Untitled";
  const holder = document.createElement("div");
  holder.append(body);
  return `<!doctype html>
<html lang="${escapeHtml(document.documentElement.lang || "en")}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${pageCsp(remote)}">
<meta name="generator" content="OpenViewer">
<title>${escapeHtml(title)}</title>
<style>${fontFaces(options.fonts)}
${math.used ? await katexStyles() : ""}
${exportCss}</style>
</head>
<body>
<article class="ov-export">
${holder.innerHTML}
</article>
</body>
</html>
`;
}

// A heading's text; a formula counts once (its MathML copy is left out).
function headingText(h1: Element | null) {
  if (!h1) return "";
  const copy = h1.cloneNode(true) as Element;
  for (const el of copy.querySelectorAll(".katex-mathml")) el.remove();
  return copy.textContent?.trim() ?? "";
}

// KaTeX's own fonts, from a fixed list of its files (never from the document).
const KATEX_FONTS = import.meta.glob("/node_modules/katex/dist/fonts/KaTeX_*.woff2", { query: "?url", import: "default", eager: true }) as Record<string, string>;

// KaTeX's stylesheet with each @font-face pointing at one woff2 data: URL.
// DECISION: all 20 faces (about 350 KB as base64), not only the ones a page uses: which faces a formula needs
// depends on KaTeX internals, and a missing one would print in a fallback font.
async function katexStyles(): Promise<string> {
  const faces = new Map<string, string>();
  await Promise.all(Object.entries(KATEX_FONTS).map(async ([path, url]) => {
    // The build inlines the smallest fonts as data: URLs already; the page's CSP wouldn't let us
    // fetch one (connect-src has no data:), and there's no need to.
    let data = /^data:font\/woff2;base64,/.test(url) ? url : null;
    if (!data) {
      try {
        const response = await fetch(url);
        if (response.ok) data = `data:font/woff2;base64,${toBase64(new Uint8Array(await response.arrayBuffer()))}`;
      } catch {
        // A face that can't be read is left out; its glyphs fall back to another font.
      }
    }
    if (data) faces.set(path.slice(path.lastIndexOf("/") + 1), data);
  }));
  return katexCss.replace(/@font-face\s*\{[^}]*\}/g, (face) => {
    const file = /url\(["']?fonts\/(KaTeX_[A-Za-z0-9-]+\.woff2)/.exec(face)?.[1];
    const data = file ? faces.get(file) : undefined;
    return data ? face.replace(/src:[^;}]*/, `src:url(${data}) format("woff2")`) : "";
  });
}

// PT Serif from the app's own files, as data: URLs.
export async function loadFonts(): Promise<ExportOptions["fonts"]> {
  const load = async (file: string) => {
    const bytes = new Uint8Array(await (await fetch(`/fonts/${file}`)).arrayBuffer());
    return `data:font/woff2;base64,${toBase64(bytes)}`;
  };
  const [regular, italic, bold, boldItalic] = await Promise.all([
    load("PTSerif-Regular.woff2"), load("PTSerif-Italic.woff2"), load("PTSerif-Bold.woff2"), load("PTSerif-BoldItalic.woff2"),
  ]);
  return { regular, italic, bold, boldItalic };
}

export function toBase64(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

const imageTypes: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  svg: "image/svg+xml", avif: "image/avif", heic: "image/heic", heif: "image/heif", bmp: "image/bmp",
  ico: "image/x-icon", tif: "image/tiff", tiff: "image/tiff",
};

export function imageDataUrl(source: string, bytes: Uint8Array) {
  const ext = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(source)?.[1]?.toLowerCase() ?? "";
  return `data:${imageTypes[ext] ?? "application/octet-stream"};base64,${toBase64(bytes)}`;
}
