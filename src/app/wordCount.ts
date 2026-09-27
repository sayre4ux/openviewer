import type { EditorView } from "@codemirror/view";
import { getLanguage, onLanguageChange, setI18nAttribute, t } from "../shared/i18n";

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

const locale = () => getLanguage() === "zh-Hant" ? "zh-Hant-HK" : getLanguage();
const format = (n: number) => new Intl.NumberFormat(locale()).format(n);

// `prefix` names something about the file worth seeing next to the count (a non-UTF-8 encoding).
export function createWordCount(el: HTMLElement, prefix: () => string = () => "") {
  let total = 0;
  let timer = 0;
  let view: EditorView | null = null;

  const show = () => {
    if (!view) return;
    const sel = view.state.selection.main;
    const cjkDisplay = getLanguage() !== "en";
    const selected = format(countWords(view.state.sliceDoc(sel.from, sel.to)));
    const formattedTotal = format(total);
    const count = cjkDisplay
      ? sel.empty
        ? t("wordCount.cjk", { count: formattedTotal })
        : t("wordCount.cjkSelected", { selected, total: formattedTotal })
      : sel.empty
        ? t(total === 1 ? "wordCount.one" : "wordCount.other", { count: formattedTotal })
        : t(total === 1 ? "wordCount.selectedOne" : "wordCount.selectedOther", { selected, total: formattedTotal });
    const note = prefix();
    el.textContent = note ? `${note} · ${count}` : count;
    setI18nAttribute(el, "title", "wordCount.title", {
      characters: format(view.state.doc.length),
      minutes: Math.max(1, Math.round(total / 230)),
    });
  };
  const recount = () => {
    if (!view) return;
    total = countWords(view.state.sliceDoc());
    show();
  };

  onLanguageChange(() => show());

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
