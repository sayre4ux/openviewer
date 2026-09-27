import { currentSettings, onSettingsChange, updateSettings } from "./settings";

export function setupLanguagePane() {
  const select = document.getElementById("language") as HTMLSelectElement;
  // DECISION: Language belongs on General because it changes the whole app, not one feature.
  onSettingsChange((settings, ready) => {
    select.value = settings.language;
    select.disabled = !ready;
  });
  select.addEventListener("change", () => {
    void updateSettings({ language: select.value as "system" | "en" | "zh-Hant" | "zh-Hans" | "ja" })
      .catch(() => { select.value = currentSettings().language; });
  });
}
