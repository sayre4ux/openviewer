// Preferences → Images: where pasted and dropped images are copied. In the app this is settings.json
// (read and written by Rust, which only accepts the three listed folders); in the browser build it's
// localStorage, for tests.

type Settings = { imageFolder: string };

const native = Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
const KEY = "openviewer.settings";

async function load(): Promise<Settings> {
  if (native) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<Settings>("get_settings");
  }
  try {
    return { imageFolder: "assets", ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return { imageFolder: "assets" };
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
  const radios = () => Array.from(group.querySelectorAll<HTMLInputElement>("input[type=radio]"));
  const show = (s: Settings) => { for (const r of radios()) r.checked = r.value === s.imageFolder; };
  group.addEventListener("change", async (e) => {
    const value = (e.target as HTMLInputElement).value;
    try {
      show(await store({ imageFolder: value }));
    } catch {
      show(await load());
    }
  });
  void load().then(show);
  if (native) {
    void import("@tauri-apps/api/event").then(({ listen }) => listen<Settings>("settings-changed", ({ payload }) => show(payload)));
  }
}
