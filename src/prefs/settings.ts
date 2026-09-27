import { resolveSystemLanguage, setLanguage, type Language, type LanguageSetting } from "../shared/i18n";

export interface Settings {
  imageFolder: string;
  remoteImages: boolean;
  diagrams: boolean;
  language: LanguageSetting;
  resolvedLanguage?: string;
}

const KEY = "openviewer.settings";
const defaults: Settings = { imageFolder: "assets", remoteImages: false, diagrams: true, language: "system" };
const supportedLanguages: readonly Language[] = ["en", "zh-Hant", "zh-Hans", "ja"];
const native = Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
let current: Settings = { ...defaults };
let ready = false;
let eventReceived = false;
const listeners = new Set<(settings: Settings, ready: boolean) => void>();

function resolved(settings: Settings): Language {
  if (settings.language !== "system") return settings.language;
  return native && supportedLanguages.includes(settings.resolvedLanguage as Language)
    ? settings.resolvedLanguage as Language
    : resolveSystemLanguage();
}

function receive(settings: Settings, isReady = true) {
  current = { ...defaults, ...settings };
  if (current.language !== "system" && !supportedLanguages.includes(current.language)) current.language = "system";
  setLanguage(resolved(current));
  ready = isReady;
  for (const listener of listeners) listener(current, ready);
}

async function readSettings(): Promise<Settings> {
  if (native) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<Settings>("get_settings");
  }
  const hook = (window as unknown as { __settingsLoad?: { delay?: number; fail?: boolean } }).__settingsLoad ?? {};
  if (hook.delay) await new Promise((resolve) => setTimeout(resolve, hook.delay));
  if (hook.fail) throw new Error("settings unavailable");
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return { ...defaults };
  }
}

async function initialize(): Promise<void> {
  if (native) {
    const { listen } = await import("@tauri-apps/api/event");
    await listen<Settings>("settings-changed", ({ payload }) => {
      eventReceived = true;
      receive(payload);
    });
  }
  try {
    const settings = await readSettings();
    if (!eventReceived) receive(settings);
  } catch {
    ready = false;
    for (const listener of listeners) listener(current, ready);
  }
}

const initialized = initialize();

export function isNativeSettings(): boolean {
  return native;
}

export function currentSettings(): Settings {
  return current;
}

export function onSettingsChange(listener: (settings: Settings, ready: boolean) => void): () => void {
  listeners.add(listener);
  listener(current, ready);
  return () => listeners.delete(listener);
}

export async function updateSettings(change: Partial<Settings>): Promise<Settings> {
  await initialized;
  if (!ready) throw new Error("settings unavailable");
  const next = { ...current, ...change };
  let saved: Settings;
  if (native) {
    const { invoke } = await import("@tauri-apps/api/core");
    saved = await invoke<Settings>("set_settings", { settings: next });
  } else {
    saved = { ...next, resolvedLanguage: resolved(next) };
    localStorage.setItem(KEY, JSON.stringify(saved));
  }
  receive(saved);
  return current;
}
