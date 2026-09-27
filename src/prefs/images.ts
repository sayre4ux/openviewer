import { onSettingsChange, updateSettings } from "./settings";

// Settings → Images: pasted images, remote images, and Mermaid diagrams.
export function setupImagesPane() {
  const group = document.getElementById("image-folder")!;
  const remote = document.getElementById("remote-images") as HTMLInputElement;
  const diagrams = document.getElementById("diagrams") as HTMLInputElement;
  const radios = () => Array.from(group.querySelectorAll<HTMLInputElement>("input[type=radio]"));
  let current = { imageFolder: "assets", remoteImages: false, diagrams: true };

  const show = (settings: typeof current, ready: boolean) => {
    current = settings;
    for (const radio of radios()) {
      radio.checked = radio.value === current.imageFolder;
      radio.disabled = !ready;
    }
    remote.checked = current.remoteImages;
    remote.disabled = !ready;
    diagrams.checked = current.diagrams;
    diagrams.disabled = !ready;
  };
  const update = (change: Partial<typeof current>) => {
    void updateSettings(change).catch(() => show(current, false));
  };

  group.addEventListener("change", (event) => update({ imageFolder: (event.target as HTMLInputElement).value }));
  remote.addEventListener("change", () => update({ remoteImages: remote.checked }));
  diagrams.addEventListener("change", () => update({ diagrams: diagrams.checked }));
  onSettingsChange(show);
}
