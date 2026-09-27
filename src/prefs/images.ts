// Settings → Images: where pasted and dropped images are copied, and whether images from the
// internet load. In the app this is settings.json (read and written by Rust, which only accepts the
// three listed folders); in the browser build it's localStorage, for tests.

type Settings = { imageFolder: string; remoteImages: boolean };
const DEFAULTS: Settings = { imageFolder: "assets", remoteImages: false };

const native = Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
const KEY = "openviewer.settings";

// Browser build only: tests set this before the page loads to make reading settings slow or fail.
type LoadHook = { delay?: number; fail?: boolean };
const loadHook = (): LoadHook => (window as unknown as { __settingsLoad?: LoadHook }).__settingsLoad ?? {};

async function load(): Promise<Settings> {
  if (native) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<Settings>("get_settings");
  }
  const hook = loadHook();
  if (hook.delay) await new Promise((resolve) => setTimeout(resolve, hook.delay));
  if (hook.fail) throw new Error("settings unavailable");
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}

async function store(settings: Settings): Promise<Settings> {
  if (native) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<Settings>("set_settings", { settings });
  }
  localStorage.setItem(KEY, JSON.stringify(settings));
  return settings;
}

export function setupImagesPane() {
  const group = document.getElementById("image-folder")!;
  const remote = document.getElementById("remote-images") as HTMLInputElement;
  const radios = () => Array.from(group.querySelectorAll<HTMLInputElement>("input[type=radio]"));
  // Every write sends the whole settings object, so changing one never resets the other.
  let current: Settings = { ...DEFAULTS };
  const show = (s: Settings) => {
    current = { ...DEFAULTS, ...s };
    for (const r of radios()) r.checked = r.value === current.imageFolder;
    remote.checked = current.remoteImages === true;
  };
  // Enabled only while `current` holds the saved settings. A write sends the whole object, so a click
  // before they arrive, or after reading them failed, would put the defaults over them.
  const enable = (on: boolean) => { for (const c of [...radios(), remote]) c.disabled = !on; };
  const reload = async () => {
    try {
      show(await load());
      enable(true);
    } catch {
      enable(false);
    }
  };
  const update = async (change: Partial<Settings>) => {
    try {
      show(await store({ ...current, ...change }));
    } catch {
      await reload();
    }
  };
  group.addEventListener("change", (e) => void update({ imageFolder: (e.target as HTMLInputElement).value }));
  remote.addEventListener("change", () => void update({ remoteImages: remote.checked }));
  enable(false);
  void reload();
  if (native) {
    void import("@tauri-apps/api/event").then(({ listen }) => listen<Settings>("settings-changed", ({ payload }) => show(payload)));
  }
}
