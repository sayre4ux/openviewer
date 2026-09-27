import { history, defaultKeymap, indentWithTab, undo, redo } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { forceParsing } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { Compartment, type Extension, type Text } from "@codemirror/state";
import { EditorView, keymap, type ViewUpdate } from "@codemirror/view";
import { lineEndings, makeState, replaceDocument } from "./app/document";
import { createOutline } from "./app/outline";
import { localImageCandidate, resolveClose, type ShellDocument, startShell, type ViewChecks } from "./app/shell";
import { createWordCount } from "./app/wordCount";
import { getLanguage, setLanguage } from "./shared/i18n";
import { isInsertableImage, pastedImageName } from "./app/imageNames";
import { blockStats, mathCutoff, prerenderDiagrams, refreshRendering } from "./editor/blocks";
import { codeHighlight } from "./editor/codeHighlight";
import { headingSlugs, scrollToAnchor } from "./editor/anchors";
import { findCommands, findExtension } from "./editor/find";
import { foldCommands, headingFolding } from "./editor/folding";
import { htmlToMarkdown } from "./editor/htmlToMarkdown";
import { formatCommands, typoraKeymap } from "./editor/keymap";
import { smartTyping, smartTypingKeymap } from "./editor/smartTyping";
import { focusMode } from "./editor/focusMode";
import { imageUrlAllowed, livePreview, refreshImageResolver, setImageResolver, setRemoteImages } from "./editor/livePreview";
import { mathSyntax } from "./editor/math";
import { formatInCell, insertTable, setCellKeys, tableRenderStats } from "./editor/tables";
import { typewriter } from "./editor/typewriter";
import { checkReply, diagramHash, diagramState, renderDiagram, resetDiagrams, sanitizeDiagram, setDiagramsEnabled } from "./render/diagram";
import { katexOutput, loadMath, mathStats, renderMath } from "./render/math";
import sample from "./sample.md?raw";
import { createKeybindingStore } from "./shared/keybindings";
import { commandDefs, effectiveKeys, type Overrides, toCodeMirror } from "./shared/keys";
import "./theme/newsprint.css";

// CodeMirror's standard keys, minus any on a key the command list uses by default: when you move
// a command off its default key, the key goes quiet instead of reaching a hidden CodeMirror
// command (⌘/ toggle comment, ⌘I select parent syntax, ...).
const defaultShortcutKeys = new Set(commandDefs.map((d) => toCodeMirror(d.key)).filter(Boolean));
const baseKeymap = defaultKeymap.filter((b) => !defaultShortcutKeys.has(b.mac ?? b.key ?? ""));

const preview = new Compartment();
const focusComp = new Compartment();
const typewriterComp = new Compartment();
const shortcutsComp = new Compartment();
let overrides: Overrides = {};
let documentChanged: () => void = () => undefined;
// Set by the Tauri shell; in the browser build pasting an image does nothing special.
let imagePaste: ((files: File[]) => void) | null = null;

// Outline and word count are remembered across launches; the other modes start off.
const remembered = (key: string, fallback: boolean) => {
  try {
    const v = localStorage.getItem(`openviewer.${key}`);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
};
const remember = (key: string, on: boolean) => {
  try {
    localStorage.setItem(`openviewer.${key}`, on ? "1" : "0");
  } catch {
    // Storage can be unavailable; the setting just won't persist.
  }
};
// DECISION: word count on by default (small, unobtrusive), outline off, as in Typora.
const modes: ViewChecks = {
  source: false,
  outline: remembered("outline", false),
  focus: false,
  typewriter: false,
  wordCount: remembered("wordCount", true),
};
let modesChanged: () => void = () => undefined;

const outlineHost = document.getElementById("outline")!;
const statusEl = document.getElementById("status")!;
const outline = createOutline(outlineHost);
// The file's text encoding; only shown when it isn't UTF-8.
let encoding = "UTF-8";
const wordCount = createWordCount(statusEl, () => (encoding === "UTF-8" ? "" : encoding));
const native = Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
// Test hook (browser build): the performance harness times keystrokes up to the editor's update.
const updateProbes: ((u: ViewUpdate) => void)[] = [];
function extensionsForDocument(): Extension[] {
  return [
    history(),
    EditorView.lineWrapping,
    markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: false, extensions: [mathSyntax] }),
    codeHighlight,
    preview.of(modes.source ? [] : livePreview),
    focusComp.of(modes.focus ? focusMode : []),
    typewriterComp.of(modes.typewriter ? typewriter : []),
    shortcutsComp.of(shortcutKeymap()),
    findExtension,
    headingFolding,
    smartTyping,
    EditorView.domEventHandlers({
      paste: (event) => {
        const files = Array.from(event.clipboardData?.files ?? []).filter((f) => isInsertableImage(f.type));
        if (files.length) {
          if (!imagePaste) return false;
          event.preventDefault();
          imagePaste(files);
          return true;
        }
        const html = event.clipboardData?.getData("text/html");
        if (!html) return false;
        const markdown = htmlToMarkdown(html);
        if (markdown === null) return false;
        event.preventDefault();
        const { state } = view;
        const { from, to } = state.selection.main;
        const insert = markdown.replace(/\n/g, state.lineBreak);
        view.dispatch({
          changes: { from, to, insert },
          selection: { anchor: from + state.toText(insert).length },
          userEvent: "input.paste",
          scrollIntoView: true,
        });
        return true;
      },
    }),
    keymap.of([
      ...typoraKeymap,
      ...smartTypingKeymap,
      indentWithTab,
      ...baseKeymap,
    ]),
    EditorView.updateListener.of((u) => {
      for (const probe of updateProbes) probe(u);
      documentChanged();
      outline.update(u.docChanged);
      if (modes.wordCount) wordCount.update(u.docChanged, u.selectionSet);
    }),
  ];
}

// Zoom scales the root font size; the editor is sized in rem and em, so text, spacing, and the
// column width scale together. Remembered across launches, like the outline.
const ZOOM_STEPS = [0.75, 0.85, 0.93, 1, 1.1, 1.2, 1.35, 1.5, 1.75, 2];
const savedZoom = (() => {
  try {
    return Number(localStorage.getItem("openviewer.zoom"));
  } catch {
    return NaN;
  }
})();
let zoomIndex = ZOOM_STEPS.includes(savedZoom) ? ZOOM_STEPS.indexOf(savedZoom) : ZOOM_STEPS.indexOf(1);
const applyZoom = () => {
  document.documentElement.style.fontSize = `${16 * ZOOM_STEPS[zoomIndex]}px`;
};
applyZoom();
// Another window changed the zoom: follow it (localStorage is shared by the app's windows).
window.addEventListener("storage", (e) => {
  const next = ZOOM_STEPS.indexOf(Number(e.newValue));
  if (e.key !== "openviewer.zoom" || next < 0 || next === zoomIndex) return;
  zoomIndex = next;
  applyZoom();
  view.requestMeasure();
});

const initial = native ? "" : sample;
const view = new EditorView({
  parent: document.getElementById("editor")!,
  state: makeState(initial, extensionsForDocument()),
});
let savedDoc = view.state.doc;
let currentPath: string | null = null;
let hasBom = false;
const load = (text: string, path: string | null = null, bom = false, fileEncoding = "UTF-8") => {
  encoding = fileEncoding;
  // A new document gets a new diagram frame; nothing from the last one carries over.
  // DECISION: here rather than in shell.ts, so the app and the browser build's test hook reset alike.
  resetDiagrams();
  replaceDocument(view, text, extensionsForDocument());
  savedDoc = view.state.doc;
  const loaded = savedDoc;
  // DECISION: not in source mode, which draws nothing; diagrams then render when it is turned off.
  if (!modes.source) void prerenderDiagrams(view.state, () => view.state.doc.eq(loaded));
  currentPath = path;
  hasBom = bom;
  outline.refresh();
  wordCount.refresh();
};

// The customizable shortcuts as a CodeMirror keymap: the editor's own commands, which also run the
// browser build used by the tests.
function shortcutKeymap() {
  const keys = effectiveKeys(overrides);
  return keymap.of(
    commandDefs.flatMap((def) => {
      const key = toCodeMirror(keys[def.id]);
      // Looked up at key time: this keymap is built before `commands` exists.
      const run = () => {
        const command = commands[def.id];
        if (!command) return false;
        command();
        return true;
      };
      // No preventDefault: a key the editor doesn't handle (Save, New, Open, Export… are the app shell's)
      // must reach the menu. WKWebView gives the page a key equivalent before the menu, and a prevented
      // one never gets there, which left ⌘S, ⌘N and ⌘W dead while the editor had focus.
      return key ? [{ key, run }] : [];
    }),
  );
}

function applyShortcuts(next: Overrides) {
  overrides = next;
  const keys = effectiveKeys(overrides);
  setCellKeys(keys);
  view.dispatch({ effects: shortcutsComp.reconfigure(shortcutKeymap()) });
}

function applyChrome() {
  view.dom.classList.toggle("ov-source", modes.source);
  outlineHost.hidden = !modes.outline;
  statusEl.hidden = !modes.wordCount;
  if (modes.outline) outline.refresh();
  if (modes.wordCount) wordCount.refresh();
}

function setZoom(index: number) {
  zoomIndex = Math.max(0, Math.min(ZOOM_STEPS.length - 1, index));
  applyZoom();
  try {
    localStorage.setItem("openviewer.zoom", String(ZOOM_STEPS[zoomIndex]));
  } catch {
    // Storage can be unavailable; the zoom just won't persist.
  }
  view.requestMeasure();
}

const commands: Record<string, () => void> = {
  "source-mode": () => {
    modes.source = !modes.source;
    view.dispatch({ effects: preview.reconfigure(modes.source ? [] : livePreview) });
    applyChrome();
    modesChanged();
  },
  outline: () => {
    modes.outline = !modes.outline;
    remember("outline", modes.outline);
    applyChrome();
    view.requestMeasure();
    modesChanged();
  },
  "focus-mode": () => {
    modes.focus = !modes.focus;
    view.dispatch({ effects: focusComp.reconfigure(modes.focus ? focusMode : []) });
    modesChanged();
  },
  "typewriter-mode": () => {
    modes.typewriter = !modes.typewriter;
    view.dispatch({ effects: typewriterComp.reconfigure(modes.typewriter ? typewriter : []) });
    if (modes.typewriter) {
      view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: "center" }) });
    }
    modesChanged();
  },
  "word-count": () => {
    modes.wordCount = !modes.wordCount;
    remember("wordCount", modes.wordCount);
    applyChrome();
    modesChanged();
  },
  "insert-table": () => {
    insertTable(view);
  },
  ...Object.fromEntries(Object.entries({ ...findCommands, ...foldCommands }).map(([id, command]) => [id, () => { command(view); }])),
  "zoom-in": () => setZoom(zoomIndex + 1),
  "zoom-out": () => setZoom(zoomIndex - 1),
  "actual-size": () => setZoom(ZOOM_STEPS.indexOf(1)),
  // Formatting from the menu or a shortcut; a focused table cell formats its own text.
  ...Object.fromEntries(
    Object.entries(formatCommands).map(([id, command]) => [
      id,
      () => {
        const marker = { bold: "**", italic: "*", strikethrough: "~~", code: "`" }[id];
        if (marker && formatInCell(marker)) return;
        // Headings don't apply inside a table cell, and the editor selection is elsewhere then.
        if (document.activeElement?.classList.contains("cm-md-cell")) return;
        command(view);
      },
    ]),
  ),
  undo: () => undo(view),
  redo: () => redo(view),
};
const doc: ShellDocument = {
  // sliceDoc honors the CRLF line separator; doc.toString() always joins with \n.
  getText: () => view.state.sliceDoc(),
  getBom: () => hasBom,
  setBom: (value) => { hasBom = value; },
  insertImages: (markdown, at) => {
    const { state } = view;
    const { from, to } = at == null ? state.selection.main : { from: at, to: at };
    // An image touching the caret shows as its Markdown source. When nothing follows on the line,
    // the caret goes to a new line below, so the image shows right away, as in Typora.
    const line = state.doc.lineAt(to);
    const insert = state.sliceDoc(to, line.to).trim() === "" ? markdown + state.lineBreak : markdown;
    view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, userEvent: "input", scrollIntoView: true });
    view.focus();
  },
  positionAt: (x, y) => view.posAtCoords({ x, y }),
  onImagePaste: (handler) => { imagePaste = handler; },
  getEncoding: () => encoding,
  setEncoding: (value) => {
    encoding = value;
    wordCount.refresh();
  },
  isDirty: () => !view.state.doc.eq(savedDoc),
  isUntouched: () => currentPath === null && view.state.doc.length === 0 && view.state.doc.eq(savedDoc),
  load,
  snapshot: () => ({ text: view.state.sliceDoc(), doc: view.state.doc }),
  saved: (next) => { savedDoc = next; },
  refreshImages: () => refreshImageResolver(view),
  refreshRendering: () => refreshRendering(view),
  scrollToAnchor: (fragment) => scrollToAnchor(view, fragment),
  onChange: (callback) => { documentChanged = callback; },
};

const keybindings = createKeybindingStore();
void keybindings.load().then((s) => applyShortcuts(s.overrides));
keybindings.onChange((s) => applyShortcuts(s.overrides));

outline.attach(view);
wordCount.attach(view);
applyChrome();
view.focus();
void startShell(doc, commands, () => ({ ...modes }), (notify) => {
  modesChanged = notify;
});

// Test hook for the browser build (never in the app); load() establishes a clean saved baseline.
if (!native) (window as unknown as { __ov: unknown }).__ov = {
  view,
  source: sample,
  load: (text: string, fileEncoding?: string) => load(text, null, false, fileEncoding),
  commands,
  modes,
  lineEndings,
  setLanguage,
  getLanguage,
  imageUrlAllowed,
  headingSlugs: () => headingSlugs(view.state),
  onUpdate: (probe: (u: ViewUpdate) => void) => { updateProbes.push(probe); },
  htmlToMarkdown,
  // The app reads this from settings.json; off by default, as there.
  setRemoteImages: (on: boolean) => { setRemoteImages(view, on); },
  // The app reads this from settings.json; on by default, as there.
  setDiagrams: (on: boolean) => { if (setDiagramsEnabled(on)) refreshRendering(view); },
  // Diagram internals for check-diagrams: the renderer, the reply check, the sanitizer, the guard's hash.
  diagram: {
    render: (source: string, force = false) => renderDiagram(source, { force }),
    checkReply,
    sanitize: sanitizeDiagram,
    hash: diagramHash,
    state: diagramState,
    blocks: () => blockStats(view.state),
  },
  localImageCandidate,
  pastedImageName,
  insertImages: (markdown: string, at?: number) => doc.insertImages(markdown, at),
  // Resolve images after a delay, as the app does through Rust ("blocked" sources resolve to null);
  // null goes back to the browser build's immediate resolver.
  useAsyncImages: (delay: number | null) => {
    setImageResolver(delay === null
      ? (src) => src
      : (src) => new Promise((resolve) => setTimeout(() => resolve(src.includes("blocked") ? null : src), delay)));
    refreshImageResolver(view);
  },
  // Renders an export page; local images come back as their alt text (there's no Rust here).
  renderExport: async (markdown: string, withFonts = false, remote = true, budget = 3 * 62) => {
    const { renderExport, loadFonts } = await import("./export/render");
    return renderExport(markdown, {
      name: "Test", remoteAllowed: remote ? imageUrlAllowed : () => false,
      // "assets/big.png" stands in for a local image Rust would embed; the default budget fits three copies.
      embedImage: async (src) => (src === "assets/big.png" ? `data:image/png;base64,${"A".repeat(40)}` : null),
      embedBudget: budget,
      fonts: withFonts ? await loadFonts() : undefined,
    });
  },
  // Renders one formula as the editor would; `katexCalls` counts calls into KaTeX for this one.
  math: async (tex: string, kind: "inline" | "display" = "inline") => {
    await loadMath();
    const before = mathStats().katexCalls;
    const started = performance.now();
    const result = renderMath(tex, kind);
    return { ...result, ms: performance.now() - started, katexCalls: mathStats().katexCalls - before };
  },
  mathCutoff: () => mathCutoff(view.state),
  scrollTo: (pos: number) => EditorView.scrollIntoView(pos, { y: "center" }),
  // KaTeX's own output next to the sanitized one, for the sanitizer fidelity check.
  mathFidelity: async (tex: string, kind: "inline" | "display" = "inline") => {
    await loadMath();
    const result = renderMath(tex, kind);
    return { raw: katexOutput(tex, kind), sanitized: result.ok ? result.html : null };
  },
  snapshot: () => doc.snapshot(),
  saved: (next: Text) => doc.saved(next),
  isDirty: () => doc.isDirty(),
  resolveClose,
  forceParsing: () => forceParsing(view, view.state.doc.length, 20000),
  tableRenderStats: () => tableRenderStats(view.state),
};
