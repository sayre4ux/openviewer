import type { Text } from "@codemirror/state";
import { imageUrlAllowed, isRemoteImage, remoteImagesAllowed, setImageResolver, setRemoteImages } from "../editor/livePreview";
import { setDiagramsEnabled } from "../render/diagram";
import { lineEndings } from "./document";
import { pastedImageName } from "./imageNames";

export interface ShellDocument {
  getText(): string;
  getBom(): boolean;
  setBom(value: boolean): void;
  isDirty(): boolean;
  isUntouched(): boolean;
  load(text: string, path: string, bom: boolean, encoding: string): void;
  getEncoding(): string;
  setEncoding(encoding: string): void;
  // text is what gets written; doc is the editor state that write came from.
  snapshot(): { text: string; doc: Text };
  saved(doc: Text): void;
  refreshImages(): void;
  // Redraw formulas and diagrams, after a setting that affects them changed.
  refreshRendering(): void;
  // Scroll to a heading by its GitHub-style id; false when there is none.
  scrollToAnchor(fragment: string): boolean;
  // Insert image links at a document position (or the selection) as one undoable edit.
  insertImages(markdown: string, at?: number | null): void;
  // The document position under a point in window coordinates (CSS pixels), if any.
  positionAt(x: number, y: number): number | null;
  // Image files pasted into the editor are handed to this (Tauri only).
  onImagePaste(handler: (files: File[]) => void): void;
  onChange(callback: () => void): void;
}

// What Rust returns for a local image (see images.rs `Resolution`).
type Resolution = { status: "ok"; url: string } | { status: "blocked"; folder: string | null };
// Rust prefixes save errors with this when the file's encoding can't hold some characters.
const UNMAPPABLE = "unmappable:";
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
// decides which files a document may show. Handles percent-encoding (Typora writes `my%20shot.png`),
// `<...>` destinations, and Windows drive paths.
const UTF8 = { encoding: "UTF-8", bom: false };

export function localImageCandidate(source: string, documentPath: string): string | null {
  let raw = source.trim();
  if (raw.startsWith("<") && raw.endsWith(">")) raw = raw.slice(1, -1);
  try {
    // decodeURIComponent, not decodeURI: `images%2Fpic.png` names images/pic.png.
    raw = decodeURIComponent(raw);
  } catch {
    // Not valid percent-encoding: use it as written.
  }
  const src = raw.replace(/\\/g, "/");
  const doc = documentPath.replace(/\\/g, "/");
  const driveOf = (p: string) => /^[A-Za-z]:\//.exec(p)?.[0] ?? null;
  let root: string;
  let parts: string[];
  let rest: string;
  if (src.startsWith("/")) {
    [root, parts, rest] = ["/", [], src];
  } else if (driveOf(src)) {
    root = driveOf(src)!;
    [parts, rest] = [[], src.slice(root.length)];
  } else {
    root = driveOf(doc) ?? "/";
    parts = doc.slice(root.length).replace(/\/[^/]*$/, "").split("/").filter(Boolean);
    rest = src;
  }
  for (const part of rest.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.length ? root + parts.join("/") : null;
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

  const [{ invoke: call }, { getCurrentWindow }, { message }, { openUrl }] = await Promise.all([
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
  // `as` overrides the file's encoding for this write; it becomes the document's only if the write succeeds.
  const saveTo = async (target: string, as?: { encoding: string; bom: boolean }): Promise<boolean> => {
    // Taken before the await: keystrokes during a slow write must stay unsaved.
    const snap = doc.snapshot();
    const encoding = as?.encoding ?? doc.getEncoding();
    const bom = as?.bom ?? doc.getBom();
    try {
      await call("write_document", { path: target, text: snap.text, bom, encoding });
      doc.setEncoding(encoding);
      doc.setBom(bom);
      path = target;
      doc.saved(snap.doc);
      doc.refreshImages();
      title();
      return true;
    } catch (error) {
      const text = String(error);
      if (text.startsWith(UNMAPPABLE)) {
        // The file's encoding (e.g. Big5) can't hold something that was typed: offer UTF-8 instead.
        const choice = await message(`${text.slice(UNMAPPABLE.length)} Save “${target.split(/[\\/]/).pop()}” as UTF-8 instead?`, {
          title: "Can’t Save in This Encoding", kind: "warning", buttons: { ok: "Save as UTF-8", cancel: "Cancel" },
        });
        if (choice !== "Save as UTF-8" && choice !== "Ok") return false;
        return saveTo(target, UTF8);
      }
      await message(text, { title: "Couldn’t save document", kind: "error" });
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
      const file = await call<{ text: string; bom: boolean; encoding: string; exact: boolean; path: string }>("read_document", { path: target });
      text = file.text;
      path = file.path;
      doc.load(file.text, file.path, file.bom, file.encoding);
      title();
      if (!file.exact) {
        await message(
          `This file is in ${file.encoding}, and some of its bytes can't be written back exactly. Saving may change them.`,
          { title: "Text Encoding", kind: "warning" },
        );
      }
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
  // Images need the document's folder, so an Untitled document is saved first (with the user's OK).
  const documentForImages = async (): Promise<string | null> => {
    if (path) return path;
    const choice = await message("Save this document first, so the image can be stored in a folder next to it.", {
      title: "Save Before Adding Images", kind: "info", buttons: { ok: "Save…", cancel: "Cancel" },
    });
    if (choice !== "Save…" && choice !== "Ok") return null;
    return (await saveAs()) ? path : null;
  };
  const insertImages = async (files: File[]) => {
    const documentPath = await documentForImages();
    if (!documentPath) return;
    const links: string[] = [];
    for (const file of files) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const name = pastedImageName(file.name, file.type, new Date());
        const inserted = await call<{ markdown: string }>("insert_image", bytes, {
          headers: { "x-document": encodeURIComponent(documentPath), "x-name": encodeURIComponent(name) },
        });
        links.push(inserted.markdown);
      } catch (error) {
        await message(String(error), { title: "Couldn’t add the image", kind: "error" });
      }
    }
    if (links.length) doc.insertImages(links.join(" "));
  };
  doc.onImagePaste((files) => void insertImages(files));

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

  // Remote images stay off until the setting says otherwise; read before the first load so a document
  // never shows them for a moment when they're off. Diagrams are on unless turned off (the switch
  // exists for the day Mermaid has a flaw with no fix); read first too, so a diagram never renders
  // when they're off.
  // Only a change to one of these re-renders; the folder setting doesn't affect them.
  type RenderSettings = { remoteImages?: boolean; diagrams?: boolean };
  const applySettings = (s: RenderSettings) => {
    if (setRemoteImages(null, s.remoteImages === true)) doc.refreshImages();
    if (setDiagramsEnabled(s.diagrams !== false)) doc.refreshRendering();
  };
  const { listen } = await import("@tauri-apps/api/event");
  // Listening before the first load: a startup sheet (encoding, line endings) must not hide a change.
  // Broadcast by Rust when the Settings window changes one.
  await listen<RenderSettings>("settings-changed", ({ payload }) => applySettings(payload));
  // Settings that can't be read fail closed: no remote images, and diagrams off (the switch is a
  // safety valve, so an unknown value means off).
  await call<RenderSettings>("get_settings").then(applySettings).catch(() => applySettings({ remoteImages: false, diagrams: false }));

  // Set before the first load so images in the startup document resolve on first render.
  setImageResolver((src) => {
    if (/^(https?:|data:)/i.test(src)) return src;
    if (!path) return null;
    const documentPath = path;
    const candidate = localImageCandidate(src, documentPath);
    if (!candidate) return null;
    return call<Resolution>("resolve_image_path", { documentPath, source: candidate }).then((r) => {
      if (r.status === "ok") return r.url;
      if (!r.folder) return null;
      // Outside what the document may show, but the user can allow that folder for this document.
      return {
        folder: r.folder,
        allow: async () => {
          const ok = await call<boolean>("allow_image_folder", { documentPath, source: candidate }).catch(async (error) => {
            await message(String(error), { title: "Couldn’t show images", kind: "error" });
            return false;
          });
          if (ok) doc.refreshImages();
          return ok;
        },
      };
    });
  });

  // File → Export: the page is rendered here (sanitized, images embedded by Rust's rules) and Rust
  // writes it, as HTML or printed to PDF, to the file picked in its dialog.
  let exporting = false;
  const exportAs = async (format: "pdf" | "html") => {
    if (exporting) return;
    exporting = true;
    try {
      const name = path?.split(/[\\/]/).pop()?.replace(/\.[^.]*$/, "") || "Untitled";
      const target = await call<string | null>("export_dialog", { format, defaultPath: path ?? `${name}.md` });
      if (!target) return;
      const { renderExport, loadFonts, imageDataUrl } = await import("../export/render");
      const documentPath = path;
      const html = await renderExport(doc.getText(), {
        name,
        remoteAllowed: (src) => remoteImagesAllowed() && isRemoteImage(src) && imageUrlAllowed(src),
        fonts: await loadFonts(),
        embedImage: async (src) => {
          const candidate = documentPath && localImageCandidate(src, documentPath);
          if (!candidate) return null;
          try {
            const bytes = await call<ArrayBuffer>("export_image", { documentPath, source: candidate });
            return imageDataUrl(candidate, new Uint8Array(bytes));
          } catch {
            return null;
          }
        },
      });
      await call(format === "pdf" ? "export_pdf" : "export_html", { path: target, html });
    } catch (error) {
      await message(String(error), { title: "Couldn’t export", kind: "error" });
    } finally {
      exporting = false;
    }
  };

  const startupPath = new URLSearchParams(location.search).get("path");
  if (startupPath) {
    await openIntoCurrent(startupPath);
    // Opened from a link like `other.md#setup`.
    const anchor = new URLSearchParams(location.search).get("anchor");
    if (anchor) doc.scrollToAnchor(anchor);
  }
  // Menu and open-path events are targeted at this window only (Rust uses emit_to).
  await win.listen<string>("menu", async ({ payload: id }) => {
    switch (id) {
      case "new": await call("create_document_window", { path: null }); break;
      case "open": await openDialog(); break;
      case "save": await save(); break;
      case "save-as": await saveAs(); break;
      case "close-window": await win.close(); break;
      case "export-pdf": await exportAs("pdf"); break;
      case "export-html": await exportAs("html"); break;
      case "save-as-utf8":
        if (path) await saveTo(path, UTF8);
        else await saveAs();
        break;
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
  await listen<string | null>("quit-request", async ({ payload: requestId }) => {
    const mayClose = await askToClose();
    if (typeof requestId === "string") {
      await call("update_quit_response", { requestId, accepted: mayClose }).catch(() => {});
      return;
    }
    if (mayClose) { closing = true; await win.close(); }
  });

  await win.onCloseRequested(async (event) => {
    if (closing) return;
    event.preventDefault();
    if (await askToClose()) { closing = true; await win.close(); }
  });
  // Image files dropped on the window: copied next to the document and linked where they were dropped.
  await win.listen<{ paths: string[]; x: number; y: number }>("dropped-images", async ({ payload }) => {
    const documentPath = await documentForImages();
    if (!documentPath) return;
    const scale = window.devicePixelRatio || 1;
    const at = doc.positionAt(payload.x / scale, payload.y / scale);
    const links: string[] = [];
    for (const source of payload.paths) {
      try {
        links.push((await call<{ markdown: string }>("insert_dropped_image", { documentPath, source })).markdown);
      } catch (error) {
        await message(String(error), { title: "Couldn’t add the image", kind: "error" });
      }
    }
    if (links.length) doc.insertImages(links.join(" "), at);
  });
  await win.listen<string[]>("authorized-drop", async ({ payload: paths }) => {
    for (const dropped of paths) {
      if (/\.(md|markdown|mdown|txt)$/i.test(dropped)) await openPath(dropped);
    }
  });

  window.addEventListener("openviewer:open-link", (event) => {
    const href = (event as CustomEvent<string>).detail;
    // new URL lowercases the scheme; the opener's URL scope is case-sensitive (HTTP://x wouldn't open).
    let url: URL | null = null;
    try {
      url = new URL(href);
    } catch {
      // Not an absolute URL: a path, handled below.
    }
    if (url) {
      if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:") void openUrl(url.href);
      return;
    }
    // Another document next to this one: Rust checks it is Markdown or text inside this document's
    // folder or repository. Other local files are never opened from a link.
    const [target, anchor = ""] = href.split("#", 2);
    if (!path || !/\.(md|markdown|mdown|txt)>?$/i.test(target)) return;
    call("open_linked_document", { documentPath: path, target, anchor: anchor || null })
      .catch((error) => message(String(error), { title: "Couldn’t open link", kind: "warning" }));
  });
  for (const pending of await call<string[]>("frontend_ready")) await openPath(pending);
  // Opened by File → Open while no document window existed.
  if (new URLSearchParams(location.search).get("action") === "open") await openDialog();
  title();
}
