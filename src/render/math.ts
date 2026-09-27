import type { Config, DOMPurify } from "dompurify";
import type Katex from "katex";
import { loads } from "./loads";
import { t } from "../shared/i18n";

// Math with KaTeX, on the main thread and synchronous: a formula renders the moment the caret leaves
// it, with no pending state. KaTeX, its stylesheet, and the sanitizer load on the first formula.
//
// A formula is untrusted input. The security control is `trust: false`: no \href, \url,
// \includegraphics, or \html*. The limits below bound the work and the output, and the output goes
// through its own DOMPurify instance before it reaches the page.

export type MathKind = "inline" | "display";
export type MathFailure = "too-long" | "too-large" | "syntax" | "limit";
export type MathResult =
  | { ok: true; html: string } // sanitized, safe to parse
  | { ok: false; reason: MathFailure; message: string };

const KATEX_OPTIONS = {
  output: "htmlAndMathml",
  trust: false,
  // DECISION: conformance only; "error" rejects benign input such as CJK text in math.
  strict: "ignore",
  throwOnError: true, // we show our own error text with textContent
  maxExpand: 1000,
  maxSize: 20, // em; clamps \rule, \hspace, \kern
  globalGroup: false,
} as const;

// Past this many formulas in one document (or export), later ones stay as source.
export const MAX_FORMULAS = 2000;
const MAX_SOURCE: Record<MathKind, number> = { inline: 2000, display: 10000 };
const MAX_OUTPUT = 512 * 1024;
const CACHE_SIZE = 500;
const MAX_MESSAGE = 200;

// Its own instance, so these hooks never run for the export sanitizer and the reverse.
const MATH_PURIFY: Config = {
  USE_PROFILES: { html: true, svg: true, mathMl: true },
  // Without these two, DOMPurify drops <semantics> and <annotation> but keeps their text, which moves
  // the raw TeX into the MathML as loose text that a screen reader reads aloud.
  ADD_TAGS: ["semantics", "annotation"],
  FORBID_TAGS: ["a", "img", "image", "use", "style", "script", "foreignObject", "iframe", "form",
    "input", "button", "link", "meta", "base", "object", "embed", "video", "audio", "feImage",
    "mglyph", "maction", "annotation-xml"],
  FORBID_ATTR: ["href", "xlink:href", "src", "srcset", "id", "name", "action", "formaction"],
  ALLOW_DATA_ATTR: false,
};

let katex: typeof Katex | null = null;
let purify: DOMPurify | null = null;
let loading: Promise<void> | null = null;
let katexCalls = 0;

// Loads KaTeX, its stylesheet (fonts come from our own origin), and the sanitizer. Idempotent; a
// failed load is retried on the next call.
export function loadMath(): Promise<void> {
  loading ??= Promise.all([import("katex"), import("dompurify"), import("katex/dist/katex.min.css")])
    .then(([k, d]) => {
      const instance = d.default(window);
      instance.addHook("uponSanitizeAttribute", (_node, data) => {
        if (loads.test(data.attrValue)) data.keepAttr = false;
      });
      purify = instance;
      katex = k.default;
    })
    .catch((error: unknown) => {
      loading = null;
      throw error;
    });
  return loading;
}

export function mathReady(): boolean {
  return katex !== null && purify !== null;
}

// LRU: a Map keeps insertion order, so the first key is the least recently used.
const cache = new Map<string, MathResult>();
const fragments = new WeakMap<MathResult, DocumentFragment>();

const failure = (reason: MathFailure, message: string): MathResult =>
  ({ ok: false, reason, message: message.length > MAX_MESSAGE ? `${message.slice(0, MAX_MESSAGE - 1)}…` : message });

// Renders a formula to sanitized HTML and MathML, or says why not. Synchronous; call loadMath() first.
export function renderMath(tex: string, kind: MathKind): MathResult {
  if (!katex || !purify) throw new Error("renderMath before loadMath");
  const key = `${kind}\n${tex}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const result = render(katex, purify, tex, kind);
  cache.set(key, result);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return result;
}

function render(k: typeof Katex, p: DOMPurify, tex: string, kind: MathKind): MathResult {
  if (tex.length > MAX_SOURCE[kind]) return failure("too-long", t("math.tooLong"));
  let raw: string;
  try {
    katexCalls++;
    // A fresh macros object every time: a \gdef in one formula never reaches another formula,
    // another document, or an export.
    raw = k.renderToString(tex, { ...KATEX_OPTIONS, displayMode: kind === "display", macros: {} });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const limit = error instanceof RangeError || /too many expansions|maxExpand/i.test(message);
    return failure(limit ? "limit" : "syntax", t("math.invalid"));
  }
  // Far past the cap before sanitizing; not worth the sanitizer's time.
  if (raw.length > MAX_OUTPUT * 4) return failure("too-large", t("math.tooLarge"));
  const fragment = p.sanitize(raw, { ...MATH_PURIFY, RETURN_DOM_FRAGMENT: true });
  const holder = document.createElement("div");
  holder.appendChild(fragment.cloneNode(true));
  const html = holder.innerHTML;
  if (html.length > MAX_OUTPUT) return failure("too-large", t("math.tooLarge"));
  const result: MathResult = { ok: true, html };
  fragments.set(result, fragment);
  return result;
}

// The rendered formula as nodes to insert: a copy of the sanitizer's own output, never a re-parse.
export function mathFragment(result: { ok: true; html: string }): DocumentFragment {
  const cached = fragments.get(result);
  if (cached) return cached.cloneNode(true) as DocumentFragment;
  if (!purify) throw new Error("mathFragment before loadMath");
  return purify.sanitize(result.html, { ...MATH_PURIFY, RETURN_DOM_FRAGMENT: true });
}

// For the browser test hook: KaTeX's own output, unsanitized, to compare the sanitizer against.
export function katexOutput(tex: string, kind: MathKind): string {
  if (!katex) throw new Error("katexOutput before loadMath");
  return katex.renderToString(tex, { ...KATEX_OPTIONS, displayMode: kind === "display", macros: {} });
}

export function mathStats() {
  return { katexCalls, cached: cache.size };
}
