import { history, historyKeymap, defaultKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { codeHighlight } from "./editor/codeHighlight";
import { typoraKeymap } from "./editor/keymap";
import { livePreview } from "./editor/livePreview";
import sample from "./sample.md?raw";
import "./theme/newsprint.css";

const preview = new Compartment();
let sourceMode = false;

const view = new EditorView({
  parent: document.getElementById("editor")!,
  state: EditorState.create({
    doc: sample,
    extensions: [
      history(),
      EditorView.lineWrapping,
      markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: false }),
      codeHighlight,
      preview.of(livePreview),
      keymap.of([
        {
          key: "Mod-/",
          run: (v) => {
            sourceMode = !sourceMode;
            v.dispatch({ effects: preview.reconfigure(sourceMode ? [] : livePreview) });
            v.dom.classList.toggle("ov-source", sourceMode);
            return true;
          },
        },
        ...typoraKeymap,
        ...historyKeymap,
        indentWithTab,
        ...defaultKeymap,
      ]),
    ],
  }),
});

view.focus();

// Test hook for the screenshot/round-trip scripts.
(window as unknown as { __ov: unknown }).__ov = { view, source: sample };
