import { setImageResolver } from "../editor/livePreview";

export interface ShellDocument {
  getText(): string;
  getBom(): boolean;
  setBom(value: boolean): void;
  isDirty(): boolean;
  isUntouched(): boolean;
  load(text: string, path: string, bom: boolean): void;
  saved(): void;
  onChange(callback: () => void): void;
}

const SAVE = "Save";
const DISCARD = "Don’t Save";
const filters = [{ name: "Markdown and text", extensions: ["md", "markdown", "mdown", "txt"] }];

// View-menu checkmarks, mirrored from the focused window's modes.
export interface ViewChecks {
  source: boolean;
  outline: boolean;
  focus: boolean;
  typewriter: boolean;
  wordCount: boolean;
}

export async function startShell(
  doc: ShellDocument,
  commands: Record<string, () => void>,
  checks: () => ViewChecks,
  onModesChanged: (notify: () => void) => void,
): Promise<void> {
  const invoke = (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  if (!invoke) return;

  const [{ invoke: call }, { convertFileSrc }, { getCurrentWindow }, { open, save: saveDialog, message }, { openUrl }] = await Promise.all([
    import("@tauri-apps/api/core"), import("@tauri-apps/api/core"), import("@tauri-apps/api/window"),
    import("@tauri-apps/plugin-dialog"), import("@tauri-apps/plugin-opener"),
  ]);
  const win = getCurrentWindow();
  let path: string | null = null;
  let closing = false;

  const title = () => {
    const name = path?.split(/[\\/]/).pop() || "Untitled";
    void win.setTitle(`${doc.isDirty() ? "• " : ""}${name}`);
  };
  doc.onChange(title);
  const saveTo = async (target: string): Promise<boolean> => {
    try {
      await call("write_document", { path: target, text: doc.getText(), bom: doc.getBom() });
      path = target;
      doc.saved();
      title();
      return true;
    } catch (error) {
      await message(String(error), { title: "Couldn’t save document", kind: "error" });
      return false;
    }
  };
  const saveAs = async (): Promise<boolean> => {
    const target = await saveDialog({ defaultPath: path || "Untitled.md", filters });
    return target ? saveTo(target) : false;
  };
  const save = async (): Promise<boolean> => path ? saveTo(path) : saveAs();
  const openIntoCurrent = async (target: string): Promise<void> => {
    try {
      const file = await call<{ text: string; bom: boolean }>("read_document", { path: target });
      doc.load(file.text, target, file.bom);
      path = target;
      title();
    } catch (error) {
      await message(String(error), { title: "Couldn’t open document", kind: "error" });
    }
  };
  const openPath = async (target: string): Promise<void> => {
    if (doc.isUntouched()) await openIntoCurrent(target);
    else await call("create_document_window", { path: target });
  };
  const openDialog = async () => {
    const selected = await open({ multiple: false, filters });
    if (typeof selected === "string") await openPath(selected);
  };
  const askToClose = async (): Promise<boolean> => {
    if (!doc.isDirty()) return true;
    const result = await message(`Do you want to save the changes you made to ${path?.split(/[\\/]/).pop() || "Untitled"}?`, {
      title: "Unsaved Changes", kind: "warning", buttons: { yes: SAVE, no: DISCARD, cancel: "Cancel" },
    });
    // With custom buttons the dialog resolves to the clicked button's label.
    if (result === SAVE || result === "Yes") return save();
    return result === DISCARD || result === "No";
  };

  // Set before the first load so images in the startup document resolve on first render.
  setImageResolver((src) => {
    if (/^(https?:|data:)/i.test(src) || !path) return src;
    const folder = path.replace(/[\\/][^\\/]*$/, "");
    const absolute = src.startsWith("/") ? src : `${folder}/${src}`;
    return convertFileSrc(absolute);
  });

  const startupPath = new URLSearchParams(location.search).get("path");
  if (startupPath) await openIntoCurrent(startupPath);
  const { listen, emit } = await import("@tauri-apps/api/event");
  // Menu and open-path events are targeted at this window only (Rust uses emit_to).
  await win.listen<string>("menu", async ({ payload: id }) => {
    switch (id) {
      case "new": await call("create_document_window", { path: null }); break;
      case "open": await openDialog(); break;
      case "save": await save(); break;
      case "save-as": await saveAs(); break;
      case "close-window": await win.close(); break;
      case "quit": {
        // DECISION: each window handles its own prompt, so Cancel keeps that document open.
        await emit("quit-request");
        break;
      }
      default:
        commands[id]?.();
    }
  });
  // The macOS menu is shared by all windows, so its checkmarks follow whichever window is focused.
  const syncMenu = () => {
    if (document.hasFocus()) void call("sync_view_menu", { checks: checks() });
  };
  onModesChanged(syncMenu);
  await win.onFocusChanged(({ payload: focused }) => {
    if (focused) syncMenu();
  });
  syncMenu();
  let pendingOpen = Promise.resolve();
  await win.listen<string>("open-path", ({ payload: target }) => {
    pendingOpen = pendingOpen.then(() => openPath(target));
  });
  await listen("quit-request", async () => {
    const mayClose = await askToClose();
    if (mayClose) { closing = true; await win.close(); }
  });

  await win.onCloseRequested(async (event) => {
    if (closing) return;
    event.preventDefault();
    if (await askToClose()) { closing = true; await win.close(); }
  });
  await win.onDragDropEvent(async ({ payload }) => {
    if (payload.type === "drop") {
      for (const dropped of payload.paths) {
        if (/\.(md|markdown|mdown|txt)$/i.test(dropped)) await openPath(dropped);
      }
    }
  });

  window.addEventListener("openviewer:open-link", (event) => {
    const href = (event as CustomEvent<string>).detail;
    if (/^(https?:|mailto:)/i.test(href)) void openUrl(href);
  });
  for (const pending of await call<string[]>("frontend_ready")) await openPath(pending);
  // Opened by File → Open while no document window existed.
  if (new URLSearchParams(location.search).get("action") === "open") await openDialog();
  title();
}
