import { createKeybindingStore, type KeybindingState } from "../shared/keybindings";
import { commandDefs, display, effectiveKeys, fromEvent, isUsable, type Overrides, reserved } from "../shared/keys";
import { applyTranslations, onLanguageChange, setLanguage, t } from "../shared/i18n";
import { setupImagesPane } from "./images";
import { setupLanguagePane } from "./language";
import "./prefs.css";

// Settings → Shortcuts. Click a shortcut to record a new one: Esc cancels, ⌫ clears it.
// A shortcut already used by another command asks before moving it.

const store = createKeybindingStore();
const list = document.getElementById("list")!;
const search = document.getElementById("search") as HTMLInputElement;
const native = Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
const problemsEl = document.getElementById("problems")!;
let confirmResetAll = false;

// Problems with a hand-edited keybindings.json. The listed settings are the last good ones.
function showProblems({ problems, broken }: KeybindingState) {
  problemsEl.hidden = problems.length === 0;
  problemsEl.innerHTML =
    `<ul>${problems.map((p) => `<li>${escapeHtml(p)}</li>`).join("")}</ul>` +
    (broken ? `<p>${escapeHtml(t("settings.shortcuts.problemRecovery"))}</p>` : "");
}

let overrides: Overrides = {};
let recording: string | null = null; // command id being recorded
let notice: {
  id: string;
  messageKey: string;
  vars: Record<string, string>;
  action?: { action: "steal"; labelKey: string; vars: Record<string, string>; key: string; owner: string };
} | null = null;

const defaults = effectiveKeys({});
const labelOf = (id: string) => commandDefs.some((c) => c.id === id) ? t(`command.${id}`) : id;
// reserved.json names each owner by its catalog key under "reserved.", read by both sides.
const reservedLabel = (owner: string) => t(`reserved.${owner}`);

function keycap(shortcut: string) {
  return shortcut ? `<kbd>${escapeHtml(display(shortcut))}</kbd>` : `<span class="prefs-none">${escapeHtml(t("settings.shortcuts.none"))}</span>`;
}

function renderResetAll() {
  if (confirmResetAll) {
    resetWrap.innerHTML = `${escapeHtml(t("settings.shortcuts.confirmResetAll"))} <button id="reset-yes" class="prefs-link" type="button">${escapeHtml(t("settings.shortcuts.reset"))}</button>
      <button id="reset-no" class="prefs-link" type="button">${escapeHtml(t("settings.shortcuts.keep"))}</button>`;
  } else {
    resetWrap.innerHTML = `<button id="reset-all" class="prefs-link" type="button">${escapeHtml(t("settings.shortcuts.resetAll"))}</button>`;
  }
}

function render() {
  const keys = effectiveKeys(overrides);
  const q = search.value.trim().toLowerCase();
  const groups = new Map<string, typeof commandDefs>();
  for (const def of commandDefs) {
    const command = labelOf(def.id);
    const menu = t(`menu.${def.menu.toLowerCase()}`);
    const hay = `${command} ${menu} ${def.label} ${def.menu} ${display(keys[def.id])}`.toLowerCase();
    if (q && !hay.includes(q)) continue;
    groups.set(def.menu, [...(groups.get(def.menu) ?? []), def]);
  }
  list.innerHTML = "";
  if (groups.size === 0) {
    list.innerHTML = `<p class="prefs-empty">${escapeHtml(t("settings.shortcuts.noCommands", { query: search.value }))}</p>`;
    return;
  }
  for (const [menu, defs] of groups) {
    const section = document.createElement("section");
    section.className = "prefs-group";
    section.innerHTML = `<h2>${escapeHtml(t(`menu.${menu.toLowerCase()}`))}</h2>`;
    for (const def of defs) {
      const custom = keys[def.id] !== defaults[def.id];
      const row = document.createElement("div");
      row.className = "prefs-row" + (recording === def.id ? " is-recording" : "");
      row.dataset.id = def.id;
      row.innerHTML = `
        <span class="prefs-label">${escapeHtml(labelOf(def.id))}</span>
        <button type="button" class="prefs-key" data-action="record" aria-label="${escapeHtml(t("settings.shortcuts.forCommand", { command: labelOf(def.id) }))}">
          ${recording === def.id ? `<span class="prefs-listening">${escapeHtml(t("settings.shortcuts.listening"))}</span>` : keycap(keys[def.id])}
        </button>
        <button type="button" class="prefs-reset" data-action="reset" title="${escapeHtml(t("settings.shortcuts.resetTo", { shortcut: display(defaults[def.id]) || t("settings.shortcuts.none") }))}" ${custom ? "" : "hidden"}>↺</button>
        ${notice?.id === def.id ? `<div class="prefs-notice"><span>${escapeHtml(t(notice.messageKey, notice.vars))}</span>
          ${notice.action ? `<button type="button" data-action="steal" data-key="${escapeHtml(notice.action.key)}" data-owner="${escapeHtml(notice.action.owner)}">${escapeHtml(t(notice.action.labelKey, notice.action.vars))}</button><button type="button" data-action="dismiss">${escapeHtml(t("settings.shortcuts.cancel"))}</button>` : ""}</div>` : ""}`;
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
      messageKey: "settings.shortcuts.inUse",
      vars: { key: display(shortcut), command: labelOf(owner) },
      action: { action: "steal", labelKey: "settings.shortcuts.useFor", vars: { command: labelOf(id) }, key: shortcut, owner },
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
      notice = { id, messageKey: "settings.shortcuts.reserved", vars: { key: display(shortcut), owner: reservedLabel(reserved[shortcut]) } };
      render();
      return;
    }
    if (!isUsable(shortcut)) {
      notice = { id, messageKey: "settings.shortcuts.addModifier", vars: { key: display(shortcut) } };
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
    confirmResetAll = true;
    renderResetAll();
  } else if (action === "reset-yes" || action === "reset-no") {
    if (action === "reset-yes") await save({});
    confirmResetAll = false;
    renderResetAll();
  }
});

store.onChange((next) => {
  overrides = next.overrides;
  showProblems(next);
  if (!recording) render();
});

// In the app this window gets menu events while focused: honor Close and Quit, ignore the rest.
if (native) {
  void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
    const { invoke } = await import("@tauri-apps/api/core");
    const win = getCurrentWindow();
    await win.listen<string>("menu", ({ payload }) => {
      if (payload === "close-window") void win.close();
      // The menu takes ⌘Z/⇧⌘Z before the search field sees them.
      if (payload === "undo" || payload === "redo") document.execCommand(payload);
    });
    const updateRequests = new Set<string>();
    await win.listen<string | null>("quit-request", async ({ payload: requestId }) => {
      if (typeof requestId === "string") {
        if (updateRequests.has(requestId)) return;
        updateRequests.add(requestId);
        await invoke("update_quit_response", { requestId, accepted: true }).catch(() => {});
        return;
      }
      await win.close();
    });
    // Leaving the window mid-recording must not leave the menu without shortcuts.
    await win.onFocusChanged(({ payload: focused }) => {
      if (!focused && recording) void stopRecording();
    });
  });
}

// Sidebar tabs: one pane shows at a time.
const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>(".prefs-tab"));
for (const tab of tabs) {
  tab.addEventListener("click", () => {
    for (const t of tabs) {
      const active = t === tab;
      t.classList.toggle("is-active", active);
      if (active) t.setAttribute("aria-current", "page");
      else t.removeAttribute("aria-current");
      document.getElementById(`pane-${t.dataset.pane}`)!.hidden = !active;
    }
  });
}
setupImagesPane();
setupLanguagePane();

void store.load().then((loaded) => {
  overrides = loaded.overrides;
  showProblems(loaded);
  render();
});
render();
renderResetAll();
applyTranslations();
onLanguageChange(() => {
  void store.load().then((loaded) => {
    overrides = loaded.overrides;
    showProblems(loaded);
    if (!recording) render();
  });
  renderResetAll();
});

// Test hook for the browser build (never in the app).
if (!native) (window as unknown as { __prefs: unknown }).__prefs = {
  get overrides() { return overrides; },
  setLanguage,
};
