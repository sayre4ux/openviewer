import { EditorView, WidgetType } from "@codemirror/view";

// The header of a fenced code block: the language name and a chevron. A native <select> sits
// transparently on top, so clicking opens the macOS menu, and picking a language rewrites the
// fence's info string in the file.

const languages: [id: string, label: string][] = [
  ["", "Plain text"],
  ["bash", "Bash"],
  ["c", "C"],
  ["cpp", "C++"],
  ["csharp", "C#"],
  ["css", "CSS"],
  ["diff", "Diff"],
  ["go", "Go"],
  ["html", "HTML"],
  ["java", "Java"],
  ["javascript", "JavaScript"],
  ["json", "JSON"],
  ["kotlin", "Kotlin"],
  ["markdown", "Markdown"],
  ["php", "PHP"],
  ["python", "Python"],
  ["ruby", "Ruby"],
  ["rust", "Rust"],
  ["sql", "SQL"],
  ["swift", "Swift"],
  ["toml", "TOML"],
  ["typescript", "TypeScript"],
  ["xml", "XML"],
  ["yaml", "YAML"],
];

const aliases: Record<string, string> = {
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  "c++": "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  golang: "go",
  js: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  md: "markdown",
  py: "python",
  rb: "ruby",
  rs: "rust",
  yml: "yaml",
};

function labelFor(info: string) {
  const id = aliases[info.toLowerCase()] ?? info.toLowerCase();
  return languages.find(([lang]) => lang === id)?.[1] ?? info;
}

const chevron =
  '<svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export class CodeLanguageWidget extends WidgetType {
  constructor(
    readonly info: string,
    readonly infoFrom: number,
    readonly infoTo: number,
  ) {
    super();
  }
  eq(other: CodeLanguageWidget) {
    return other.info === this.info && other.infoFrom === this.infoFrom && other.infoTo === this.infoTo;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("span");
    wrap.className = "cm-md-lang";
    const label = document.createElement("span");
    label.className = "cm-md-lang-label";
    label.textContent = labelFor(this.info) || "Plain text";
    label.insertAdjacentHTML("beforeend", chevron);

    const select = document.createElement("select");
    select.className = "cm-md-lang-select";
    select.setAttribute("aria-label", "Code language");
    const known = new Set(languages.map(([id]) => id));
    const options = known.has(this.info.toLowerCase()) || !this.info ? languages : [[this.info, this.info] as [string, string], ...languages];
    const current = aliases[this.info.toLowerCase()] ?? this.info.toLowerCase();
    for (const [id, name] of options) {
      const option = new Option(name, id, false, id === current || id === this.info);
      select.add(option);
    }
    select.addEventListener("change", () => {
      view.dispatch({ changes: { from: this.infoFrom, to: this.infoTo, insert: select.value } });
      view.focus();
    });
    wrap.append(label, select);
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}
