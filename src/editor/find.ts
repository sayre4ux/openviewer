import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  replaceAll,
  replaceNext,
  search,
  searchPanelOpen,
  SearchQuery,
  setSearchQuery,
} from "@codemirror/search";
import type { EditorState } from "@codemirror/state";
import { EditorView, type Panel, type ViewUpdate } from "@codemirror/view";
import { onLanguageChange, setI18nAttribute, setI18nText } from "../shared/i18n";

// Find and replace: CodeMirror's search engine (query state, match highlighting, replace as one undo
// step) with our own panel. The panel is built with DOM calls only; the query is never put into HTML.

// Counting stops here so a one-letter query in a huge document doesn't stall typing.
const COUNT_LIMIT = 10000;

function countMatches(state: EditorState, query: SearchQuery): { total: number; current: number; capped: boolean } {
  if (!query.search || !query.valid) return { total: 0, current: 0, capped: false };
  const { from, to } = state.selection.main;
  const cursor = query.getCursor(state);
  let total = 0;
  let current = 0;
  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    total++;
    if (next.value.from === from && next.value.to === to) current = total;
    if (total >= COUNT_LIMIT) return { total, current, capped: true };
  }
  return { total, current, capped: false };
}

// Find Next / Previous. An empty match (a regex like `^` or `a*`) would find itself again from the
// same position, so when the selection doesn't move, search again one character further on.
function step(view: EditorView, forward: boolean) {
  const before = view.state.selection.main;
  (forward ? findNext : findPrevious)(view);
  const after = view.state.selection.main;
  if (!after.empty || after.from !== before.from || after.to !== before.to) return true;
  const pos = forward ? Math.min(view.state.doc.length, after.head + 1) : Math.max(0, after.head - 1);
  if (pos === after.head) return true;
  view.dispatch({ selection: { anchor: pos } });
  (forward ? findNext : findPrevious)(view);
  return true;
}

function button(label: string, titleKey: string, onClick: () => void, labelKey?: string) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "ov-find-button";
  if (labelKey) setI18nText(b, labelKey);
  else b.textContent = label;
  setI18nAttribute(b, "title", titleKey);
  setI18nAttribute(b, "aria-label", titleKey);
  // Keep focus in the field, so Enter keeps working after a click.
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("click", onClick);
  return b;
}

function toggle(label: string, titleKey: string, onChange: (on: boolean) => void) {
  const b = button(label, titleKey, () => {
    const on = b.getAttribute("aria-pressed") !== "true";
    b.setAttribute("aria-pressed", String(on));
    onChange(on);
  });
  b.classList.add("ov-find-toggle");
  b.setAttribute("aria-pressed", "false");
  return b;
}

class FindPanel implements Panel {
  dom: HTMLElement;
  top = true;
  private find: HTMLInputElement;
  private replace: HTMLInputElement;
  private count: HTMLElement;
  private replaceRow: HTMLElement;
  private caseToggle: HTMLButtonElement;
  private wordToggle: HTMLButtonElement;
  private regexToggle: HTMLButtonElement;
  private query: SearchQuery;

  constructor(private view: EditorView) {
    this.query = getSearchQuery(view.state);
    this.dom = document.createElement("div");
    this.dom.className = "ov-find";
    this.dom.setAttribute("role", "search");

    const row = document.createElement("div");
    row.className = "ov-find-row";
    this.find = this.field("find.find", this.query.search);
    this.find.setAttribute("main-field", "true"); // CodeMirror focuses this field when the panel opens
    this.count = document.createElement("span");
    this.count.className = "ov-find-count";
    // Not a live region: the count changes with every caret move, which a screen reader would announce.
    this.count.id = `ov-find-count-${Math.random().toString(36).slice(2)}`;
    this.caseToggle = toggle("Aa", "find.matchCase", (on) => this.commit({ caseSensitive: on }));
    this.wordToggle = toggle("W", "find.wholeWords", (on) => this.commit({ wholeWord: on }));
    this.regexToggle = toggle(".*", "find.regularExpression", (on) => this.commit({ regexp: on }));
    this.caseToggle.setAttribute("aria-pressed", String(this.query.caseSensitive));
    this.wordToggle.setAttribute("aria-pressed", String(this.query.wholeWord));
    this.regexToggle.setAttribute("aria-pressed", String(this.query.regexp));
    const more = button("Replace", "find.showReplace", () => this.showReplace(this.replaceRow.hidden !== false), "find.replaceButton");
    more.classList.add("ov-find-more");
    row.append(
      this.find, this.count,
      button("‹", "find.previous", () => step(this.view, false)),
      button("›", "find.next", () => step(this.view, true)),
      this.caseToggle, this.wordToggle, this.regexToggle, more,
      button("×", "find.close", () => this.close()),
    );

    this.replaceRow = document.createElement("div");
    this.replaceRow.className = "ov-find-row";
    this.replaceRow.hidden = true;
    this.replace = this.field("find.replaceWith", this.query.replace);
    this.replaceRow.append(
      this.replace,
      button("Replace", "find.replaceMatch", () => replaceNext(this.view), "find.replaceButton"),
      button("All", "find.replaceAll", () => replaceAll(this.view), "find.allButton"),
    );
    this.dom.append(row, this.replaceRow);

    this.find.addEventListener("input", () => this.commit({ search: this.find.value }));
    this.replace.addEventListener("input", () => this.commit({ replace: this.replace.value }));
    this.dom.addEventListener("keydown", (e) => this.keydown(e));
    this.render();
  }

  private field(key: string, value: string) {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "ov-find-field";
    setI18nAttribute(input, "placeholder", key);
    setI18nAttribute(input, "aria-label", key);
    input.spellcheck = false;
    input.autocomplete = "off";
    input.value = value;
    return input;
  }

  private commit(change: Partial<{ search: string; replace: string; caseSensitive: boolean; wholeWord: boolean; regexp: boolean }>) {
    const q = this.query;
    const next = new SearchQuery({
      search: change.search ?? q.search,
      replace: change.replace ?? q.replace,
      caseSensitive: change.caseSensitive ?? q.caseSensitive,
      wholeWord: change.wholeWord ?? q.wholeWord,
      regexp: change.regexp ?? q.regexp,
    });
    if (!next.eq(q)) this.view.dispatch({ effects: setSearchQuery.of(next) });
  }

  showReplace(on: boolean) {
    this.replaceRow.hidden = !on;
    this.dom.classList.toggle("is-replacing", on);
    (on ? this.replace : this.find).focus();
  }

  focusFind() {
    this.find.focus();
    this.find.select();
  }

  private close() {
    closeSearchPanel(this.view);
    this.view.focus();
  }

  private keydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      this.close();
    } else if (e.key === "Enter" && e.target === this.find) {
      e.preventDefault();
      step(this.view, !e.shiftKey);
    } else if (e.key === "Enter" && e.target === this.replace) {
      e.preventDefault();
      (e.metaKey || e.ctrlKey ? replaceAll : replaceNext)(this.view);
    }
  }

  update(update: ViewUpdate) {
    const next = getSearchQuery(update.state);
    const queryChanged = !next.eq(this.query);
    if (queryChanged) {
      this.query = next;
      if (this.find.value !== next.search) this.find.value = next.search;
      if (this.replace.value !== next.replace) this.replace.value = next.replace;
    }
    if (queryChanged || update.docChanged || update.selectionSet) this.render();
  }

  private render() {
    const { query } = this;
    const invalid = Boolean(query.search) && !query.valid;
    this.find.classList.toggle("is-invalid", invalid);
    this.find.setAttribute("aria-invalid", String(invalid));
    this.find.setAttribute("aria-describedby", this.count.id);
    if (!query.search) {
      this.count.textContent = "";
      delete this.count.dataset.i18n;
      delete this.count.dataset.i18nVars;
      return;
    }
    if (!query.valid) {
      setI18nText(this.count, "find.invalidPattern");
      return;
    }
    const { total, current, capped } = countMatches(this.view.state, query);
    const all = capped ? `${total}+` : String(total);
    if (total === 0) setI18nText(this.count, "find.noMatches");
    else if (current) setI18nText(this.count, "find.currentOf", { current, total: all });
    else setI18nText(this.count, "find.totalFound", { total: all });
  }

  refreshLanguage() {
    this.render();
  }

  mount() {
    this.find.select();
  }
}

let lastPanel: FindPanel | null = null;
onLanguageChange(() => lastPanel?.refreshLanguage());

export const findExtension = search({
  top: true,
  createPanel: (view) => (lastPanel = new FindPanel(view)),
  scrollToMatch: (range) => EditorView.scrollIntoView(range, { y: "center" }),
});

function open(view: EditorView, replace: boolean) {
  openSearchPanel(view);
  // ⌥⌘F also shows the replace row; ⌘F while the panel is open just goes back to the find field.
  if (replace) lastPanel?.showReplace(true);
  else lastPanel?.focusFind();
}

export const findCommands = {
  find: (view: EditorView) => open(view, false),
  replace: (view: EditorView) => open(view, true),
  "find-next": (view: EditorView) => (searchPanelOpen(view.state) && getSearchQuery(view.state).search ? step(view, true) : open(view, false)),
  "find-previous": (view: EditorView) => (searchPanelOpen(view.state) && getSearchQuery(view.state).search ? step(view, false) : open(view, false)),
};
