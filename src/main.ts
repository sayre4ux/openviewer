import { history, defaultKeymap, indentWithTab, undo, redo } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { forceParsing } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { Compartment, type Extension, type Text } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { lineEndings, makeState, replaceDocument } from "./app/document";
import { createOutline } from "./app/outline";
import { localImageCandidate, resolveClose, type ShellDocument, startShell, type ViewChecks } from "./app/shell";
import { createWordCount } from "./app/wordCount";
import { isInsertableImage, pastedImageName } from "./app/imageNames";
import { codeHighlight } from "./editor/codeHighlight";
import { formatCommands, typoraKeymap } from "./editor/keymap";
import { focusMode } from "./editor/focusMode";
import { imageUrlAllowed, livePreview, refreshImageResolver } from "./editor/livePreview";
import { formatInCell, insertTable, setCellKeys, tableRenderStats } from "./editor/tables";
import { typewriter } from "./editor/typewriter";
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
function extensionsForDocument(): Extension[] {
  return [
    history(),
    EditorView.lineWrapping,
    markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: false }),
    codeHighlight,
    preview.of(modes.source ? [] : livePreview),
    focusComp.of(modes.focus ? focusMode : []),
    typewriterComp.of(modes.typewriter ? typewriter : []),
    shortcutsComp.of(shortcutKeymap()),
    EditorView.domEventHandlers({
      paste: (event) => {
        const files = Array.from(event.clipboardData?.files ?? []).filter((f) => isInsertableImage(f.type));
        if (!files.length || !imagePaste) return false;
        event.preventDefault();
        imagePaste(files);
        return true;
      },
    }),
    keymap.of([
      ...typoraKeymap,
      indentWithTab,
      ...baseKeymap,
    ]),
    EditorView.updateListener.of((u) => {
      documentChanged();
      outline.update(u.docChanged);
      if (modes.wordCount) wordCount.update(u.docChanged, u.selectionSet);
    }),
  ];
}

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
  replaceDocument(view, text, extensionsForDocument());
  savedDoc = view.state.doc;
  currentPath = path;
  hasBom = bom;
  outline.refresh();
  wordCount.refresh();
};

// The customizable shortcuts as a CodeMirror keymap. In the app the menu takes most of these
// keys first; the keymap covers the rest and runs the browser build used by the tests.
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
      return key ? [{ key, run, preventDefault: true }] : [];
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
  // Formatting from the menu or a shortcut; a focused table cell formats its own text.
  ...Object.fromEntries(
    Object.entries(formatCommands).map(([id, command]) => [
      id,
      () => {
        const marker = { bold: "**", italic: "*", code: "`" }[id];
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
  insertText: (text, at) => {
    const pos = at ?? view.state.selection.main.head;
    const { from, to } = at == null ? view.state.selection.main : { from: pos, to: pos };
    view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, userEvent: "input", scrollIntoView: true });
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
  imageUrlAllowed,
  localImageCandidate,
  pastedImageName,
  // Renders an export page; local images come back as their alt text (there's no Rust here).
  renderExport: async (markdown: string, withFonts = false) => {
    const { renderExport, loadFonts } = await import("./export/render");
    return renderExport(markdown, {
      name: "Test", remoteAllowed: imageUrlAllowed,
      // "assets/big.png" stands in for a local image Rust would embed; the budget fits three copies.
      embedImage: async (src) => (src === "assets/big.png" ? `data:image/png;base64,${"A".repeat(40)}` : null),
      embedBudget: 3 * 62,
      fonts: withFonts ? await loadFonts() : undefined,
    });
  },
  snapshot: () => doc.snapshot(),
  saved: (next: Text) => doc.saved(next),
  isDirty: () => doc.isDirty(),
  resolveClose,
  forceParsing: () => forceParsing(view, view.state.doc.length, 20000),
  tableRenderStats: () => tableRenderStats(view.state),
};
