import type { EditorView } from "@codemirror/view";

// Word count in the bottom-right corner. CJK characters count one word each, as Typora does;
// link and image targets and HTML tags are not counted.

const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const word = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;

export function countWords(text: string) {
  const prose = text.replace(/\]\([^)]*\)/g, "]").replace(/<[^>]+>/g, " ");
  const cjkCount = prose.match(cjk)?.length ?? 0;
  const latin = prose.replace(cjk, " ").match(word)?.length ?? 0;
  return cjkCount + latin;
}

const format = (n: number) => n.toLocaleString("en-US");

export function createWordCount(el: HTMLElement) {
  let total = 0;
  let timer = 0;
  let view: EditorView | null = null;

  const show = () => {
    if (!view) return;
    const sel = view.state.selection.main;
    const label = total === 1 ? "word" : "words";
    el.textContent = sel.empty
      ? `${format(total)} ${label}`
      : `${format(countWords(view.state.sliceDoc(sel.from, sel.to)))} of ${format(total)} ${label}`;
    el.title = `${format(view.state.doc.length)} characters · about ${Math.max(1, Math.round(total / 230))} min read`;
  };
  const recount = () => {
    if (!view) return;
    total = countWords(view.state.sliceDoc());
    show();
  };

  return {
    attach(v: EditorView) {
      view = v;
      recount();
    },
    update(docChanged: boolean, selectionSet: boolean) {
      if (docChanged) {
        clearTimeout(timer);
        timer = window.setTimeout(recount, 150);
      } else if (selectionSet) {
        show();
      }
    },
    refresh: recount,
  };
}
