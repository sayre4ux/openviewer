import type { Config, DOMPurify } from "dompurify";
import { loads } from "./loads";

// Mermaid diagrams. Mermaid runs in a hidden <iframe sandbox="allow-scripts"> (public/diagram/): an
// opaque origin with its own no-network CSP and no Tauri IPC, so its temporary DOM and styles never
// touch the editor's document. It posts back SVG text, which is sanitized here in an inert document
// and shown only as <img src="data:image/svg+xml;base64,…">: an image runs no script, loads nothing,
// and its CSS can't reach the page. Every failure is a value; renderDiagram never rejects. It is the
// seam for a different backend later.
//
// What this does not contain is a hang: the frame shares the editor's thread, so a Mermaid infinite
// loop freezes the window. Against that: input caps, a guard that stops the same diagram freezing
// the app twice (below), rendering while a freshly opened document is still clean, and the
// `diagrams` setting as a kill switch.

export type DiagramFailure =
  | "off" | "too-long" | "too-large" | "limit" | "syntax" | "unsupported" | "unsafe-output" | "timeout" | "blocked";
export type DiagramResult =
  | { ok: true; dataUrl: string; width: number; height: number }
  | { ok: false; reason: DiagramFailure; message: string };

type FrameReply =
  | { v: 1; id: number; ok: true; svg: string }
  | { v: 1; id: number; ok: false; kind: "syntax" | "error"; message: string };

// Past this many Mermaid blocks in one document (or export), later ones stay as code.
export const MAX_DIAGRAMS = 100;
const MAX_SOURCE = 20000;
const MAX_SVG = 1024 * 1024;
const MAX_SIDE = 16384;
const MAX_QUEUE = 100;
const REPLY_TIMEOUT = 10000;
const CACHE_SIZE = 100;
const MAX_BLOCKED = 50;
const MAX_MESSAGE = 200;
const PENDING_KEY = "openviewer.diagram.pending";
const BLOCKED_KEY = "openviewer.diagram.blocked";
export const BLOCKED_NOTE = "This diagram stopped OpenViewer last time";

const SVG_NS = "http://www.w3.org/2000/svg";
// A <style> that could load or escape something: anything that isn't an in-image url(#id) reference.
const STYLE_LOADS = /@import|url\s*\(\s*(?!["']?#)|image-set|image\s*\(|cross-fade|element\s*\(|expression\s*\(|\\/i;
const LOCAL_URL = /^\s*url\(\s*#[\w.:-]+\s*\)\s*$/;

const DIAGRAM_PURIFY: Config = {
  USE_PROFILES: { svg: true, svgFilters: true },
  FORBID_TAGS: ["a", "image", "feImage", "use", "script", "foreignObject"],
  FORBID_ATTR: ["href", "xlink:href", "src"],
  ALLOW_DATA_ATTR: false,
};

const fail = (reason: DiagramFailure, message: string): DiagramResult =>
  ({ ok: false, reason, message: message.length > MAX_MESSAGE ? `${message.slice(0, MAX_MESSAGE - 1)}…` : message });

// ---- Settings ----

let enabled = true;
export function diagramsEnabled(): boolean {
  return enabled;
}
// True when the value changed. Turning diagrams off also stops whatever is rendering or waiting.
export function setDiagramsEnabled(on: boolean): boolean {
  if (enabled === on) return false;
  enabled = on;
  if (!on) resetDiagrams();
  return true;
}

// ---- The hang guard ----
// Before a job goes to the frame its hash is added to a pending list in localStorage, and removed when
// the reply comes. A hash still pending when a window starts means the app froze (or was quit) while
// rendering it: it moves to a blocked list, and that diagram shows its source and "Render anyway"
// instead of freezing the app again. A diagram that later renders is taken off both lists.
// DECISION: a list rather than one key, so two windows rendering at once don't erase each other's
// entry. A window opening while another renders may block that diagram for a moment; the render that
// then finishes unblocks it.

export function diagramHash(source: string): string {
  // DECISION: cyrb53, not SHA-256: synchronous (the pending entry must be written before the job is
  // posted) and needs no secure-context crypto; a collision only means a false "blocked" note with a
  // button.
  let h1 = 0xdeadbeef ^ source.length;
  let h2 = 0x41c6ce57 ^ source.length;
  for (let i = 0; i < source.length; i++) {
    const ch = source.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function readList(key: string): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(value) ? value.filter((h): h is string => typeof h === "string" && h.length <= 16).slice(-MAX_BLOCKED) : [];
  } catch {
    return [];
  }
}

function writeList(key: string, list: string[]) {
  try {
    if (list.length) localStorage.setItem(key, JSON.stringify(list.slice(-MAX_BLOCKED)));
    else localStorage.removeItem(key);
  } catch {
    // Storage unavailable: the guard just doesn't remember.
  }
}

function markPending(hash: string) {
  writeList(PENDING_KEY, [...readList(PENDING_KEY), hash]);
}

function settle(hash: string) {
  const pending = readList(PENDING_KEY);
  const at = pending.indexOf(hash);
  if (at >= 0) pending.splice(at, 1);
  writeList(PENDING_KEY, pending);
  const blocked = readList(BLOCKED_KEY);
  if (blocked.includes(hash)) writeList(BLOCKED_KEY, blocked.filter((h) => h !== hash));
}

function isBlocked(hash: string) {
  return readList(BLOCKED_KEY).includes(hash);
}

(function promoteLeftovers() {
  const pending = readList(PENDING_KEY);
  if (!pending.length) return;
  const blocked = readList(BLOCKED_KEY).filter((h) => !pending.includes(h));
  writeList(BLOCKED_KEY, [...blocked, ...new Set(pending)]);
  writeList(PENDING_KEY, []);
})();

// ---- The sanitizer ----

let purify: DOMPurify | null = null;
let purifyLoading: Promise<DOMPurify> | null = null;
let removedForeign = 0;

function loadPurify(): Promise<DOMPurify> {
  purifyLoading ??= import("dompurify").then((d) => {
    // Its own instance, so these hooks never run for the export or math sanitizers.
    const instance = d.default(window);
    instance.addHook("uponSanitizeElement", (_node, data) => {
      if (data.tagName === "foreignobject") removedForeign++;
    });
    instance.addHook("uponSanitizeAttribute", (_node, data) => {
      const value = data.attrValue;
      // A marker or clip reference inside the image is fine; any other url() and anything else that
      // could name a resource goes.
      if (/url\s*\(/i.test(value)) {
        if (!LOCAL_URL.test(value)) data.keepAttr = false;
      } else if (loads.test(value)) {
        data.keepAttr = false;
      }
    });
    purify = instance;
    return instance;
  }).catch((error: unknown) => {
    purifyLoading = null;
    throw error;
  });
  return purifyLoading;
}

function base64Utf8(text: string) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

// The frame's SVG text → an image, or a refusal. The image is the boundary; this is the second layer,
// and it protects whoever opens an exported image directly. Strict: a false refusal shows the source.
export function diagramFromSvg(svg: string): DiagramResult {
  if (!purify) throw new Error("diagramFromSvg before the sanitizer loaded");
  if (svg.length > MAX_SVG) return fail("too-large", "diagram too large");
  removedForeign = 0;
  const body = purify.sanitize(svg, { ...DIAGRAM_PURIFY, RETURN_DOM: true }) as Element;
  if (removedForeign > 0) return fail("unsupported", "this diagram needs HTML labels, which OpenViewer doesn't show");
  const roots = Array.from(body.children);
  const root = roots[0];
  if (roots.length !== 1 || root.localName !== "svg" || root.namespaceURI !== SVG_NS) return fail("unsafe-output", "the diagram's output isn't a single SVG image");
  for (const style of root.querySelectorAll("style")) {
    if (STYLE_LOADS.test(style.textContent ?? "")) return fail("unsafe-output", "the diagram's styles refer to something outside it");
  }
  const box = (root.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
  if (box.length !== 4 || !box.every(Number.isFinite) || box[2] <= 0 || box[3] <= 0 || box[2] > MAX_SIDE || box[3] > MAX_SIDE) {
    return fail("unsafe-output", "the diagram's size is out of range");
  }
  // An intrinsic size, so the image lays out at its natural width and scales down from there.
  const width = Math.ceil(box[2]);
  const height = Math.ceil(box[3]);
  root.setAttribute("width", String(width));
  root.setAttribute("height", String(height));
  root.removeAttribute("style");
  const xml = new XMLSerializer().serializeToString(root);
  return { ok: true, dataUrl: `data:image/svg+xml;base64,${base64Utf8(xml)}`, width, height };
}

// ---- The frame ----

interface Job {
  id: number;
  source: string;
  hash: string;
  resolve: (result: DiagramResult) => void;
}

interface Frame {
  el: HTMLIFrameElement;
  ready: Promise<boolean>;
  markReady: (ok: boolean) => void;
}

let frame: Frame | null = null;
let current: { job: Job; timer: number } | null = null;
const queue: Job[] = [];
const inflight = new Map<string, Promise<DiagramResult>>();
const cache = new Map<string, DiagramResult>();
let nextId = 1;
let generation = 0;

function createFrame(): Frame {
  const el = document.createElement("iframe");
  // Exactly allow-scripts: never allow-same-origin, which would hand the frame this origin.
  el.setAttribute("sandbox", "allow-scripts");
  el.setAttribute("aria-hidden", "true");
  el.tabIndex = -1;
  // Laid out but unseen. Never display:none: Mermaid measures text and would get zero sizes.
  el.style.cssText = "position:fixed;left:-10000px;top:0;width:1200px;height:900px;border:0;visibility:hidden;pointer-events:none";
  let markReady: (ok: boolean) => void = () => undefined;
  const ready = new Promise<boolean>((resolve) => { markReady = resolve; });
  const made: Frame = { el, ready, markReady };
  window.setTimeout(() => markReady(false), REPLY_TIMEOUT);
  // The frame loads once. A second load means it navigated away from its page (the app CSP's
  // default-src 'self' already keeps it on our origin): it is no longer ours to talk to.
  let loads = 0;
  el.addEventListener("load", () => {
    if (++loads === 1 || frame !== made) return;
    markReady(false);
    dropFrame();
    if (current) abandon(current.job, fail("unsafe-output", "the diagram renderer left its page"));
  });
  // A real URL, not srcdoc: Tauri's IPC entry point parses the sender's URL before it checks the key.
  el.src = "/diagram/frame.html";
  document.body.appendChild(el);
  return made;
}

function dropFrame() {
  frame?.el.remove();
  frame = null;
}

// Replies are accepted only from our frame (an opaque origin posts as "null"), for the job in flight,
// in exactly the shape the frame sends. Both sides post with target "*" because an opaque origin
// can't be named; the source check is the authentication.
export function checkReply(data: unknown, id: number): FrameReply | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  const keys = Object.keys(d).sort().join();
  if (d.v !== 1 || d.id !== id) return null;
  if (d.ok === true && keys === "id,ok,svg,v" && typeof d.svg === "string") return { v: 1, id, ok: true, svg: d.svg };
  if (d.ok === false && keys === "id,kind,message,ok,v" && (d.kind === "syntax" || d.kind === "error") && typeof d.message === "string") {
    return { v: 1, id, ok: false, kind: d.kind, message: d.message };
  }
  return null;
}

window.addEventListener("message", (event) => {
  const f = frame;
  if (!f || event.source !== f.el.contentWindow || event.origin !== "null") return;
  const data = event.data as Record<string, unknown> | null;
  if (data && typeof data === "object" && Object.keys(data).sort().join() === "ready,v" && data.v === 1 && data.ready === true) {
    f.markReady(true);
    return;
  }
  if (!current) return;
  const reply = checkReply(data, current.job.id);
  if (reply) finish(current.job, reply);
});

function remember(source: string, result: DiagramResult) {
  cache.set(source, result);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
}

function finish(job: Job, reply: FrameReply) {
  if (current?.job !== job) return;
  window.clearTimeout(current.timer);
  current = null;
  settle(job.hash);
  let result: DiagramResult;
  if (reply.ok) {
    try {
      result = diagramFromSvg(reply.svg);
    } catch {
      result = fail("unsafe-output", "the diagram's output couldn't be read");
    }
  } else if (reply.kind === "syntax") {
    result = fail("syntax", reply.message);
  } else {
    // DECISION: a syntax error is an ordinary result; any other failure inside the frame replaces it,
    // in case Mermaid was left in a bad state.
    dropFrame();
    result = fail(/limit|exceed|maximum/i.test(reply.message) ? "limit" : "unsupported", reply.message);
  }
  remember(job.source, result);
  job.resolve(result);
  void pump();
}

// Gives up on the job in flight without a reply. The window survived (a stall, not a freeze), so this
// isn't one for the hang guard.
function abandon(job: Job, result: DiagramResult) {
  if (current?.job !== job) return;
  window.clearTimeout(current.timer);
  current = null;
  settle(job.hash);
  dropFrame();
  job.resolve(result);
  void pump();
}

function timedOut(job: Job) {
  abandon(job, fail("timeout", "the diagram took too long to render"));
}

async function pump() {
  if (current || !queue.length) return;
  const job = queue.shift()!;
  current = { job, timer: 0 };
  let ready = false;
  try {
    await loadPurify();
    frame ??= createFrame();
    ready = await frame.ready;
  } catch {
    ready = false;
  }
  if (current?.job !== job) return; // reset while waiting
  const f = frame;
  if (!ready || !f?.el.contentWindow) {
    current = null;
    dropFrame();
    job.resolve(fail("timeout", "the diagram renderer didn't start"));
    void pump();
    return;
  }
  markPending(job.hash);
  current.timer = window.setTimeout(() => timedOut(job), REPLY_TIMEOUT);
  // The frame is sent diagram source and nothing else.
  f.el.contentWindow.postMessage({ v: 1, id: job.id, source: job.source }, "*");
}

// Renders a diagram, or says why not. `force` renders a diagram the hang guard blocked.
export function renderDiagram(source: string, options?: { force: boolean }): Promise<DiagramResult> {
  if (!enabled) return Promise.resolve(fail("off", "diagrams are off"));
  if (source.length > MAX_SOURCE) return Promise.resolve(fail("too-long", "diagram too long"));
  const hit = cache.get(source);
  if (hit) {
    cache.delete(source);
    cache.set(source, hit);
    return Promise.resolve(hit);
  }
  const hash = diagramHash(source);
  if (!options?.force && isBlocked(hash)) return Promise.resolve(fail("blocked", BLOCKED_NOTE));
  const running = inflight.get(source);
  if (running) return running;
  if (queue.length >= MAX_QUEUE) return Promise.resolve(fail("limit", "too many diagrams waiting"));
  const promise = new Promise<DiagramResult>((resolve) => {
    queue.push({ id: nextId++, source, hash, resolve });
  });
  inflight.set(source, promise);
  void promise.then(() => {
    if (inflight.get(source) === promise) inflight.delete(source);
  });
  void pump();
  return promise;
}

// A result already at hand, without starting a render: widgets use it to draw at once.
export function cachedDiagram(source: string): DiagramResult | null {
  return cache.get(source) ?? null;
}

// A new document: a fresh frame, and whatever was waiting for the old one is dropped.
export function resetDiagrams(): void {
  generation++;
  const dropped = queue.splice(0);
  if (current) {
    window.clearTimeout(current.timer);
    settle(current.job.hash);
    dropped.push(current.job);
    current = null;
  }
  dropFrame();
  inflight.clear();
  for (const job of dropped) job.resolve(fail("timeout", "cancelled"));
}

export function diagramGeneration(): number {
  return generation;
}

// For the browser test hook.
export async function sanitizeDiagram(svg: string): Promise<DiagramResult> {
  await loadPurify();
  return diagramFromSvg(svg);
}

export function diagramState() {
  return {
    frame: frame ? { sandbox: frame.el.getAttribute("sandbox"), src: frame.el.getAttribute("src") } : null,
    inflight: current?.job.id ?? null,
    nextId,
    queued: queue.length,
    cached: cache.size,
  };
}
