import { createKeybindingStore } from "../shared/keybindings";
import { commandDefs, display, effectiveKeys, fromEvent, isUsable, type Overrides, reserved } from "../shared/keys";
import "./prefs.css";

// Preferences → Shortcuts. Click a shortcut to record a new one: Esc cancels, ⌫ clears it.
// A shortcut already used by another command asks before moving it.

const store = createKeybindingStore();
const list = document.getElementById("list")!;
const search = document.getElementById("search") as HTMLInputElement;
const native = Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);

let overrides: Overrides = {};
let recording: string | null = null; // command id being recorded
let notice: { id: string; html: string } | null = null; // inline message under a row

const defaults = effectiveKeys({});
const labelOf = (id: string) => commandDefs.find((c) => c.id === id)?.label ?? id;

function keycap(shortcut: string) {
  return shortcut ? `<kbd>${display(shortcut)}</kbd>` : `<span class="prefs-none">None</span>`;
}

function render() {
  const keys = effectiveKeys(overrides);
  const q = search.value.trim().toLowerCase();
  const groups = new Map<string, typeof commandDefs>();
  for (const def of commandDefs) {
    const hay = `${def.label} ${def.menu} ${display(keys[def.id])}`.toLowerCase();
    if (q && !hay.includes(q)) continue;
    groups.set(def.menu, [...(groups.get(def.menu) ?? []), def]);
  }
  list.innerHTML = "";
  if (groups.size === 0) {
    list.innerHTML = `<p class="prefs-empty">No commands match “${escapeHtml(search.value)}”.</p>`;
    return;
  }
  for (const [menu, defs] of groups) {
    const section = document.createElement("section");
    section.className = "prefs-group";
    section.innerHTML = `<h2>${menu}</h2>`;
    for (const def of defs) {
      const custom = keys[def.id] !== defaults[def.id];
      const row = document.createElement("div");
      row.className = "prefs-row" + (recording === def.id ? " is-recording" : "");
      row.dataset.id = def.id;
      row.innerHTML = `
        <span class="prefs-label">${escapeHtml(def.label)}</span>
        <button type="button" class="prefs-key" data-action="record" aria-label="Shortcut for ${escapeHtml(def.label)}">
          ${recording === def.id ? `<span class="prefs-listening">Press shortcut…</span>` : keycap(keys[def.id])}
        </button>
        <button type="button" class="prefs-reset" data-action="reset" title="Reset to ${display(defaults[def.id]) || "none"}" ${custom ? "" : "hidden"}>↺</button>
        ${notice?.id === def.id ? `<div class="prefs-notice">${notice.html}</div>` : ""}`;
      section.appendChild(row);
    }
    list.appendChild(section);
  }
}

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function save(next: Overrides) {
  // Only keep entries that differ from the defaults, so the file lists just your changes.
  const clean: Overrides = {};
  for (const [id, key] of Object.entries(next)) if (key !== defaults[id]) clean[id] = key;
  overrides = clean;
  render();
  await store.save(clean);
}

async function startRecording(id: string) {
  recording = id;
  notice = null;
  render();
  await store.suspend(true);
}

async function stopRecording() {
  recording = null;
  render();
  await store.suspend(false);
}

async function assign(id: string, shortcut: string) {
  const keys = effectiveKeys(overrides);
  const owner = Object.keys(keys).find((other) => other !== id && shortcut && keys[other] === shortcut);
  if (owner) {
    // Ask before taking a shortcut from another command.
    notice = {
      id,
      html: `<b>${display(shortcut)}</b> is used by <b>${escapeHtml(labelOf(owner))}</b>.
        <button type="button" data-action="steal" data-key="${escapeHtml(shortcut)}" data-owner="${owner}">Use for ${escapeHtml(labelOf(id))}</button>
        <button type="button" data-action="dismiss">Cancel</button>`,
    };
    await stopRecording();
    return;
  }
  notice = null;
  recording = null;
  await store.suspend(false);
  await save({ ...overrides, [id]: shortcut });
}

window.addEventListener(
  "keydown",
  async (e) => {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    const id = recording;
    const bare = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
    if (e.key === "Escape" && bare) return stopRecording();
    if ((e.key === "Backspace" || e.key === "Delete") && bare) return assign(id, "");
    const shortcut = fromEvent(e);
    if (!shortcut) return; // a bare modifier: keep listening
    if (reserved[shortcut]) {
      notice = { id, html: `<b>${display(shortcut)}</b> is reserved for ${reserved[shortcut]}. Try another.` };
      render();
      return;
    }
    if (!isUsable(shortcut)) {
      notice = { id, html: `Add ⌘ or ⌃ to <b>${display(shortcut)}</b>, or use an F-key.` };
      render();
      return;
    }
    await assign(id, shortcut);
  },
  true,
);

list.addEventListener("click", async (e) => {
  const button = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-action]");
  const row = button?.closest<HTMLElement>(".prefs-row");
  if (!button || !row) return;
  const id = row.dataset.id!;
  switch (button.dataset.action) {
    case "record":
      if (recording === id) await stopRecording();
      else await startRecording(id);
      break;
    case "reset": {
      const next = { ...overrides };
      delete next[id];
      notice = null;
      await save(next);
      break;
    }
    case "steal": {
      const owner = button.dataset.owner!;
      notice = null;
      await save({ ...overrides, [owner]: "", [id]: button.dataset.key! });
      break;
    }
    case "dismiss":
      notice = null;
      render();
      break;
  }
});

// Clicking elsewhere stops recording.
document.addEventListener("mousedown", (e) => {
  if (recording && !(e.target as HTMLElement).closest(".prefs-row.is-recording")) void stopRecording();
});

search.addEventListener("input", render);

const openFile = document.getElementById("open-file") as HTMLButtonElement;
openFile.hidden = !native;
openFile.addEventListener("click", () => void store.openFile());

const resetWrap = document.getElementById("reset-all-wrap")!;
resetWrap.addEventListener("click", async (e) => {
  const action = (e.target as HTMLElement).closest<HTMLButtonElement>("button")?.id;
  if (action === "reset-all") {
    resetWrap.innerHTML = `Reset every shortcut? <button id="reset-yes" class="prefs-link" type="button">Reset</button>
      <button id="reset-no" class="prefs-link" type="button">Keep</button>`;
  } else if (action === "reset-yes" || action === "reset-no") {
    if (action === "reset-yes") await save({});
    resetWrap.innerHTML = `<button id="reset-all" class="prefs-link" type="button">Reset all</button>`;
  }
});

store.onChange((next) => {
  overrides = next;
  if (!recording) render();
});

// In the app this window gets menu events while focused: honor Close and Quit, ignore the rest.
if (native) {
  void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
    const { listen, emit } = await import("@tauri-apps/api/event");
    const win = getCurrentWindow();
    await win.listen<string>("menu", ({ payload }) => {
      if (payload === "close-window") void win.close();
      if (payload === "quit") void emit("quit-request"); // every window closes or asks to save
    });
    await listen("quit-request", () => void win.close());
    // Leaving the window mid-recording must not leave the menu without shortcuts.
    await win.onFocusChanged(({ payload: focused }) => {
      if (!focused && recording) void stopRecording();
    });
  });
}

void store.load().then((loaded) => {
  overrides = loaded;
  render();
});
render();

// Test hook for the browser build.
(window as unknown as { __prefs: unknown }).__prefs = { get overrides() { return overrides; } };
