import { history, historyKeymap, defaultKeymap, indentWithTab, undo, redo } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { Compartment, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { makeState, replaceDocument } from "./app/document";
import { createOutline } from "./app/outline";
import { type ShellDocument, startShell, type ViewChecks } from "./app/shell";
import { createWordCount } from "./app/wordCount";
import { codeHighlight } from "./editor/codeHighlight";
import { typoraKeymap } from "./editor/keymap";
import { focusMode } from "./editor/focusMode";
import { livePreview } from "./editor/livePreview";
import { insertTable } from "./editor/tables";
import { typewriter } from "./editor/typewriter";
import sample from "./sample.md?raw";
import "./theme/newsprint.css";

const preview = new Compartment();
const focusComp = new Compartment();
const typewriterComp = new Compartment();
let documentChanged: () => void = () => undefined;

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
const wordCount = createWordCount(statusEl);
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
    keymap.of([
      { key: "Mod-/", run: () => (commands["source-mode"](), true) },
      { key: "Mod-Shift-l", run: () => (commands.outline(), true) },
      { key: "F8", run: () => (commands["focus-mode"](), true) },
      { key: "F9", run: () => (commands["typewriter-mode"](), true) },
      { key: "Mod-Alt-t", run: insertTable },
      ...typoraKeymap,
      ...historyKeymap,
      indentWithTab,
      ...defaultKeymap,
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
const load = (text: string, path: string | null = null, bom = false) => {
  replaceDocument(view, text, extensionsForDocument());
  savedDoc = view.state.doc;
  currentPath = path;
  hasBom = bom;
  outline.refresh();
  wordCount.refresh();
};

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
  undo: () => undo(view),
  redo: () => redo(view),
};
const doc: ShellDocument = {
  // sliceDoc honors the CRLF line separator; doc.toString() always joins with \n.
  getText: () => view.state.sliceDoc(),
  getBom: () => hasBom,
  setBom: (value) => { hasBom = value; },
  isDirty: () => !view.state.doc.eq(savedDoc),
  isUntouched: () => currentPath === null && view.state.doc.length === 0 && view.state.doc.eq(savedDoc),
  load,
  saved: () => { savedDoc = view.state.doc; },
  onChange: (callback) => { documentChanged = callback; },
};

outline.attach(view);
wordCount.attach(view);
applyChrome();
view.focus();
void startShell(doc, commands, () => ({ ...modes }), (notify) => {
  modesChanged = notify;
});

// Browser-mode test hook; load() establishes a clean saved baseline.
(window as unknown as { __ov: unknown }).__ov = {
  view,
  source: sample,
  load: (text: string) => load(text),
  commands,
  modes,
};
