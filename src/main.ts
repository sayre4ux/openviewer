import { history, historyKeymap, defaultKeymap, indentWithTab, undo, redo } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { Compartment, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { makeState, replaceDocument } from "./app/document";
import { type ShellDocument, startShell } from "./app/shell";
import { codeHighlight } from "./editor/codeHighlight";
import { typoraKeymap } from "./editor/keymap";
import { livePreview } from "./editor/livePreview";
import { insertTable } from "./editor/tables";
import sample from "./sample.md?raw";
import "./theme/newsprint.css";

const preview = new Compartment();
let sourceMode = false;
let documentChanged: () => void = () => undefined;
const native = Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
function extensionsForDocument(): Extension[] {
  return [
    history(),
    EditorView.lineWrapping,
    markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: false }),
    codeHighlight,
    preview.of(sourceMode ? [] : livePreview),
    keymap.of([
      {
        key: "Mod-/",
        run: (v) => { toggleSource(v); return true; },
      },
      { key: "Mod-Alt-t", run: insertTable },
      ...typoraKeymap,
      ...historyKeymap,
      indentWithTab,
      ...defaultKeymap,
    ]),
    EditorView.updateListener.of(() => documentChanged()),
  ];
}

function toggleSource(view: EditorView) {
  sourceMode = !sourceMode;
  view.dispatch({ effects: preview.reconfigure(sourceMode ? [] : livePreview) });
  view.dom.classList.toggle("ov-source", sourceMode);
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

view.focus();
void startShell(doc, () => toggleSource(view), () => undo(view), () => redo(view));

// Browser-mode test hook; load() establishes a clean saved baseline.
(window as unknown as { __ov: unknown }).__ov = {
  view,
  source: sample,
  load: (text: string) => load(text),
};
