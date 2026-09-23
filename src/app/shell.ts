import type { Text } from "@codemirror/state";
import { setImageResolver } from "../editor/livePreview";
import { lineEndings } from "./document";

export interface ShellDocument {
  getText(): string;
  getBom(): boolean;
  setBom(value: boolean): void;
  isDirty(): boolean;
  isUntouched(): boolean;
  load(text: string, path: string, bom: boolean): void;
  // text is what gets written; doc is the editor state that write came from.
  snapshot(): { text: string; doc: Text };
  saved(doc: Text): void;
  refreshImages(): void;
  onChange(callback: () => void): void;
}

const SAVE = "Save";
const DISCARD = "Don’t Save";

// After Save, close only when the document is still clean. Typing during the write leaves it
// dirty; ask again instead of closing over those keystrokes. A failed save does not close.
export async function resolveClose(
  isDirty: () => boolean,
  ask: () => Promise<string>,
  save: () => Promise<boolean>,
): Promise<boolean> {
  for (;;) {
    if (!isDirty()) return true;
    const result = await ask();
    if (result === SAVE || result === "Yes") {
      if (!await save()) return false;
      continue;
    }
    return result === DISCARD || result === "No";
  }
}

// A local image's absolute path, normalized. Not a security check: Rust (`resolve_image_path`)
// decides which files a document may show.
export function localImageCandidate(source: string, documentPath: string): string | null {
  const normalized = source.replace(/\\/g, "/");
  const parts = normalized.startsWith("/") ? [] : documentPath.replace(/\/[^/]*$/, "").split("/").filter(Boolean);
  for (const part of normalized.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.length ? `/${parts.join("/")}` : null;
}

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

  const [{ invoke: call, convertFileSrc }, { getCurrentWindow }, { message }, { openUrl }] = await Promise.all([
    import("@tauri-apps/api/core"), import("@tauri-apps/api/window"),
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
    // Taken before the await: keystrokes during a slow write must stay unsaved.
    const snap = doc.snapshot();
    try {
      await call("write_document", { path: target, text: snap.text, bom: doc.getBom() });
      path = target;
      doc.saved(snap.doc);
      doc.refreshImages();
      title();
      return true;
    } catch (error) {
      await message(String(error), { title: "Couldn’t save document", kind: "error" });
      return false;
    }
  };
  const saveAs = async (): Promise<boolean> => {
    let target: string | null;
    try {
      target = await call<string | null>("save_dialog", { defaultPath: path || "Untitled.md" });
    } catch (error) {
      await message(String(error), { title: "Couldn’t save document", kind: "error" });
      return false;
    }
    return target ? saveTo(target) : false;
  };
  const save = async (): Promise<boolean> => path ? saveTo(path) : saveAs();
  const openIntoCurrent = async (target: string): Promise<void> => {
    let text: string;
    try {
      const file = await call<{ text: string; bom: boolean; path: string }>("read_document", { path: target });
      text = file.text;
      path = file.path;
      doc.load(file.text, file.path, file.bom);
      title();
    } catch (error) {
      await message(String(error), { title: "Couldn’t open document", kind: "error" });
      return;
    }
    // DECISION: once per open, not once per session. Every mixed file gets this sentence,
    // including a CR/LF mix, because those are saved as LF too.
    if (lineEndings(text) === "mixed") {
      await message(
        "This file mixes Windows (CRLF) and Unix (LF) line endings. OpenViewer will save it with LF line endings.",
        { title: "Mixed Line Endings", kind: "warning" },
      );
    }
  };
  const openPath = async (target: string): Promise<void> => {
    if (doc.isUntouched()) await openIntoCurrent(target);
    else await call("create_document_window", { path: target });
  };
  const openDialog = async () => {
    let selected: string | null;
    try {
      selected = await call<string | null>("open_dialog");
    } catch (error) {
      await message(String(error), { title: "Couldn’t open document", kind: "error" });
      return;
    }
    if (typeof selected === "string") await openPath(selected);
  };
  const askToClose = (): Promise<boolean> => resolveClose(
    () => doc.isDirty(),
    // With custom buttons the dialog resolves to the clicked button's label.
    () => message(`Do you want to save the changes you made to ${path?.split(/[\\/]/).pop() || "Untitled"}?`, {
      title: "Unsaved Changes", kind: "warning", buttons: { yes: SAVE, no: DISCARD, cancel: "Cancel" },
    }),
    () => save(),
  );

  // Set before the first load so images in the startup document resolve on first render.
  setImageResolver((src) => {
    if (/^(https?:|data:)/i.test(src)) return src;
    if (!path) return null;
    // DECISION: local images outside the document folder render the blocked placeholder.
    const candidate = localImageCandidate(src, path);
    if (!candidate) return null;
    return call<string | null>("resolve_image_path", { documentPath: path, source: candidate })
      .then((allowed) => allowed ? convertFileSrc(allowed) : null);
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
  await win.listen<string[]>("authorized-drop", async ({ payload: paths }) => {
    for (const dropped of paths) {
      if (/\.(md|markdown|mdown|txt)$/i.test(dropped)) await openPath(dropped);
    }
  });

  window.addEventListener("openviewer:open-link", (event) => {
    const href = (event as CustomEvent<string>).detail;
    // new URL lowercases the scheme; the opener's URL scope is case-sensitive (HTTP://x wouldn't open).
    let url: URL;
    try {
      url = new URL(href);
    } catch {
      return;
    }
    if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:") void openUrl(url.href);
  });
  for (const pending of await call<string[]>("frontend_ready")) await openPath(pending);
  // Opened by File → Open while no document window existed.
  if (new URLSearchParams(location.search).get("action") === "open") await openDialog();
  title();
}
