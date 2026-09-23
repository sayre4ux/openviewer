import { type Overrides, sanitize } from "./keys";

// Where custom shortcuts live. In the app: `keybindings.json` in the app's config folder, read and
// written by Rust, which also rebuilds the menu and tells every window. In a plain browser (tests):
// localStorage.

// `problems`: what's wrong with a hand-edited keybindings.json (bad JSON, dropped entries).
export interface KeybindingState {
  overrides: Overrides;
  problems: string[];
}

export interface KeybindingStore {
  load(): Promise<KeybindingState>;
  save(overrides: Overrides): Promise<void>;
  onChange(callback: (state: KeybindingState) => void): void;
  openFile(): Promise<void>;
  // Recording a shortcut: turn off menu shortcuts so the key press reaches the page.
  suspend(on: boolean): Promise<void>;
}

const native = () => Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
const storageKey = "openviewer.keybindings";

function browserStore(): KeybindingStore {
  const listeners: ((s: KeybindingState) => void)[] = [];
  const read = (): KeybindingState => {
    try {
      return { overrides: sanitize(JSON.parse(localStorage.getItem(storageKey) ?? "{}")), problems: [] };
    } catch {
      return { overrides: {}, problems: ["Saved shortcuts aren't valid JSON"] };
    }
  };
  window.addEventListener("storage", (e) => {
    if (e.key === storageKey) listeners.forEach((cb) => cb(read()));
  });
  return {
    load: async () => read(),
    save: async (overrides) => {
      try {
        localStorage.setItem(storageKey, JSON.stringify(sanitize(overrides)));
      } catch {
        // Storage unavailable: the change applies until reload.
      }
      listeners.forEach((cb) => cb({ overrides: sanitize(overrides), problems: [] }));
    },
    onChange: (cb) => void listeners.push(cb),
    openFile: async () => undefined,
    suspend: async () => undefined,
  };
}

const checked = (s: KeybindingState): KeybindingState => ({ overrides: sanitize(s.overrides), problems: s.problems ?? [] });

function nativeStore(): KeybindingStore {
  const core = import("@tauri-apps/api/core");
  const events = import("@tauri-apps/api/event");
  return {
    load: async () => checked(await (await core).invoke<KeybindingState>("get_keybindings")),
    save: async (overrides) => (await core).invoke("set_keybindings", { overrides: sanitize(overrides) }),
    onChange: (cb) => {
      void events.then(({ listen }) => listen<KeybindingState>("keybindings-changed", (e) => cb(checked(e.payload))));
    },
    openFile: async () => (await core).invoke("open_keybindings_file"),
    suspend: async (on) => (await core).invoke("suspend_shortcuts", { suspended: on }),
  };
}

export const createKeybindingStore = (): KeybindingStore => (native() ? nativeStore() : browserStore());
