import { type Overrides, sanitize } from "./keys";

// Where custom shortcuts live. In the app: `keybindings.json` in the app's config folder, read and
// written by Rust, which also rebuilds the menu and tells every window. In a plain browser (tests):
// localStorage.

export interface KeybindingStore {
  load(): Promise<Overrides>;
  save(overrides: Overrides): Promise<void>;
  onChange(callback: (overrides: Overrides) => void): void;
  openFile(): Promise<void>;
  // Recording a shortcut: turn off menu shortcuts so the key press reaches the page.
  suspend(on: boolean): Promise<void>;
}

const native = () => Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
const storageKey = "openviewer.keybindings";

function browserStore(): KeybindingStore {
  const listeners: ((o: Overrides) => void)[] = [];
  const read = () => {
    try {
      return sanitize(JSON.parse(localStorage.getItem(storageKey) ?? "{}"));
    } catch {
      return {};
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
      listeners.forEach((cb) => cb(sanitize(overrides)));
    },
    onChange: (cb) => void listeners.push(cb),
    openFile: async () => undefined,
    suspend: async () => undefined,
  };
}

function nativeStore(): KeybindingStore {
  const core = import("@tauri-apps/api/core");
  const events = import("@tauri-apps/api/event");
  return {
    load: async () => sanitize(await (await core).invoke("get_keybindings")),
    save: async (overrides) => (await core).invoke("set_keybindings", { overrides: sanitize(overrides) }),
    onChange: (cb) => {
      void events.then(({ listen }) => listen<Overrides>("keybindings-changed", (e) => cb(sanitize(e.payload))));
    },
    openFile: async () => (await core).invoke("open_keybindings_file"),
    suspend: async (on) => (await core).invoke("suspend_shortcuts", { suspended: on }),
  };
}

export const createKeybindingStore = (): KeybindingStore => (native() ? nativeStore() : browserStore());
