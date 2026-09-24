import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightCode, tagHighlighter, tags as t } from "@lezer/highlight";
import DOMPurify from "dompurify";
import { Marked } from "marked";
import exportCss from "./export.css?raw";

// Export: the document as one standalone HTML page. Markdown is rendered with marked and sanitized
// with DOMPurify; only then are our own changes made (highlighted code, embedded images), so nothing
// from the document reaches the page unsanitized. The page carries its own CSP: no scripts at all.

export type ExportOptions = {
  // File name without extension, used when the document has no heading.
  name: string;
  // Local image sources (as written) → a data: URL, or null when the image can't be shown.
  embedImage: (source: string) => Promise<string | null>;
  // Remote image policy, shared with the editor (no loopback or private hosts).
  remoteAllowed: (source: string) => boolean;
  // PT Serif as data: URLs, so the page looks right anywhere. Omitted in tests.
  fonts?: { regular: string; italic: string; bold: string; boldItalic: string };
};

const marked = new Marked({ gfm: true, breaks: false, async: false });

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
  "picture", "object", "embed", "image", "feImage", "use", "link", "meta", "base"];
const FORBID_ATTR = ["srcset", "poster", "background", "lowsrc", "dynsrc", "ping", "action", "formaction", "xlink:href", "cite", "longdesc"];
const cssLoads = /url\s*\(|image-set\s*\(|@import|expression\s*\(|\\/i;

// Budget for embedded image bytes, so a document that repeats a large image can't exhaust memory.
const EMBED_BUDGET = 200 * 1024 * 1024;

async function embed(img: HTMLImageElement, options: ExportOptions, cache: Map<string, string | null>, budget: { left: number }) {
  const src = img.getAttribute("src") ?? "";
  img.removeAttribute("srcset");
  let url: string | null = null;
  if (/^data:image\//i.test(src)) url = src;
  else if (/^https?:\/\//i.test(src)) url = options.remoteAllowed(src) ? src : null;
  else if (isLocal(src) && src) {
    const local = src.replace(/^file:\/\//i, "");
    if (!cache.has(local)) {
      const data = budget.left > 0 ? await options.embedImage(local) : null;
      budget.left -= data?.length ?? 0;
      cache.set(local, data && budget.left >= 0 ? data : null);
    }
    url = cache.get(local) ?? null;
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

// The page's own policy: images and fonts inline or remote images, no scripts, no other requests.
const PAGE_CSP = "default-src 'none'; img-src data: https: http:; style-src 'unsafe-inline'; font-src data:";

export async function renderExport(markdown: string, options: ExportOptions): Promise<string> {
  const html = marked.parse(markdown) as string;
  const purify = DOMPurify();
  // Inline styles stay (colors, alignment) unless they could load something.
  purify.addHook("uponSanitizeAttribute", (_node, data) => {
    if (data.attrName === "style" && cssLoads.test(data.attrValue)) data.keepAttr = false;
  });
  const body = purify.sanitize(html, { RETURN_DOM_FRAGMENT: true, FORBID_TAGS, FORBID_ATTR });
  // Only disabled task-list checkboxes survive as inputs.
  for (const input of body.querySelectorAll("input")) {
    if (input.type !== "checkbox") input.remove();
    else input.setAttribute("disabled", "");
  }
  await Promise.all(Array.from(body.querySelectorAll<HTMLElement>("pre > code")).map(highlight));
  // One image at a time, each source once, within the budget.
  const cache = new Map<string, string | null>();
  const budget = { left: EMBED_BUDGET };
  for (const img of Array.from(body.querySelectorAll("img"))) await embed(img, options, cache, budget);
  const title = body.querySelector("h1")?.textContent?.trim() || options.name || "Untitled";
  const holder = document.createElement("div");
  holder.append(body);
  return `<!doctype html>
<html lang="${escapeHtml(document.documentElement.lang || "en")}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${PAGE_CSP}">
<meta name="generator" content="OpenViewer">
<title>${escapeHtml(title)}</title>
<style>${fontFaces(options.fonts)}
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
