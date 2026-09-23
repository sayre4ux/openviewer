import registry from "./commands.json";

// Shortcuts are stored in one canonical form, shared with the Rust menu builder:
// modifiers in the order Cmd, Ctrl, Alt, Shift, then the key, joined by "+", e.g. "Cmd+Shift+L",
// "F8", "Cmd+/". An empty string means "no shortcut".

export interface CommandDef {
  id: string;
  label: string;
  menu: string;
  key: string;
  check?: boolean;
  separatorBefore?: boolean;
}

export const commandDefs = registry as CommandDef[];
export const commandIds = new Set(commandDefs.map((c) => c.id));

export type Overrides = Record<string, string>;

export function effectiveKey(id: string, overrides: Overrides): string {
  if (Object.prototype.hasOwnProperty.call(overrides, id)) return overrides[id];
  return commandDefs.find((c) => c.id === id)?.key ?? "";
}

export function effectiveKeys(overrides: Overrides): Record<string, string> {
  return Object.fromEntries(commandDefs.map((c) => [c.id, effectiveKey(c.id, overrides)]));
}

// macOS and the app's own Preferences shortcut; these can't be reassigned.
export const reserved: Record<string, string> = {
  "Cmd+Q": "Quit",
  "Cmd+H": "Hide OpenViewer",
  "Cmd+Alt+H": "Hide Others",
  "Cmd+M": "Minimize",
  "Cmd+C": "Copy",
  "Cmd+V": "Paste",
  "Cmd+X": "Cut",
  "Cmd+A": "Select All",
  "Cmd+,": "Preferences",
  "Cmd+Tab": "App Switcher",
  "Cmd+Space": "Spotlight",
  "Cmd+`": "Cycle Windows",
};

const codeKeys: Record<string, string> = {
  Slash: "/", Comma: ",", Period: ".", Semicolon: ";", Quote: "'", BracketLeft: "[", BracketRight: "]",
  Backslash: "\\", Minus: "-", Equal: "=", Backquote: "`", Enter: "Enter", NumpadEnter: "Enter", Tab: "Tab",
  Space: "Space", Backspace: "Backspace", Delete: "Delete", ArrowUp: "Up", ArrowDown: "Down",
  ArrowLeft: "Left", ArrowRight: "Right", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
};

// The canonical shortcut for a key press, or null for a bare modifier or an unsupported key.
// Keys come from `code`, not `key`, so Option combinations don't turn into accented letters.
export function fromEvent(e: KeyboardEvent): string | null {
  let key: string | null = null;
  const letter = /^Key([A-Z])$/.exec(e.code);
  const digit = /^(?:Digit|Numpad)(\d)$/.exec(e.code);
  if (letter) key = letter[1];
  else if (digit) key = digit[1];
  else if (/^F\d{1,2}$/.test(e.code)) key = e.code;
  else key = codeKeys[e.code] ?? null;
  if (!key) return null;
  const mods = [e.metaKey && "Cmd", e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift"].filter(Boolean);
  return [...mods, key].join("+");
}

// A usable shortcut needs Cmd or Ctrl (Option alone types characters on macOS), except F-keys.
export function isUsable(shortcut: string) {
  const parts = shortcut.split("+");
  const key = parts[parts.length - 1];
  return /^F\d{1,2}$/.test(key) || parts.includes("Cmd") || parts.includes("Ctrl");
}

const cmNames: Record<string, string> = { Up: "ArrowUp", Down: "ArrowDown", Left: "ArrowLeft", Right: "ArrowRight" };

// CodeMirror key name: "Cmd+Shift+L" → "Mod-Shift-l". (Mod is Command on macOS.)
export function toCodeMirror(shortcut: string): string | null {
  if (!shortcut) return null;
  const parts = shortcut.split("+");
  const key = parts.pop()!;
  const mods = parts.map((m) => (m === "Cmd" ? "Mod" : m));
  const name = key.length === 1 ? key.toLowerCase() : cmNames[key] ?? key;
  return [...mods, name].join("-");
}

const symbols: Record<string, string> = {
  Enter: "↩", Tab: "⇥", Space: "Space", Backspace: "⌫", Delete: "⌦", Up: "↑", Down: "↓", Left: "←", Right: "→",
  Home: "↖", End: "↘", PageUp: "⇞", PageDown: "⇟",
};

// macOS menu style: ⌃⌥⇧⌘ then the key.
export function display(shortcut: string): string {
  if (!shortcut) return "";
  const parts = shortcut.split("+");
  const key = parts.pop()!;
  const order: [string, string][] = [["Ctrl", "⌃"], ["Alt", "⌥"], ["Shift", "⇧"], ["Cmd", "⌘"]];
  return order.filter(([m]) => parts.includes(m)).map(([, s]) => s).join("") + (symbols[key] ?? key);
}

// Keep only entries for known commands with well-formed values ("" is allowed: no shortcut).
export function sanitize(raw: unknown): Overrides {
  const out: Overrides = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!commandIds.has(id) || typeof value !== "string") continue;
    if (value === "" || (/^(?:(?:Cmd|Ctrl|Alt|Shift)\+)*[^+]+$/.test(value) && isUsable(value) && !reserved[value])) {
      out[id] = value;
    }
  }
  return out;
}
