# Working on OpenViewer

Notes for coding agents and contributors. Read this before changing code.

## What this is

A Typora-style Markdown editor for macOS with the Newsprint look. Tauri 2 shell (`src-tauri/`,
Rust) around a TypeScript + CodeMirror 6 frontend (`src/`) running in WKWebView.

## Commands

```sh
npm install
npm run dev          # the editor in a plain browser (http://localhost:5173), used by the tests
npm run app:dev      # the desktop app with live reload
npm run app:build    # OpenViewer.app
npm test             # typecheck + Rust tests + browser suites + CSP check (Chrome)
npm run test:all     # the same, also in WebKit; run this before every commit
cd src-tauri && cargo test
```

## Layout

| Path | What it holds |
|---|---|
| `src/main.ts` | Editor setup: extensions, view modes, the shortcut keymap, the browser test hook |
| `src/editor/livePreview.ts` | Typora-style rendering: decorations that hide or style Markdown |
| `src/editor/tables.ts` | Editable table widget, local structural edits, Tidy |
| `src/editor/math.ts` | Math syntax (`$…$`, `$$` blocks) for the parser, and the scanners export shares |
| `src/editor/blocks.ts` | Block widgets from a `StateField`: display math and Mermaid diagrams |
| `src/render/` | Renderers behind one function each: `math.ts` (KaTeX), `diagram.ts` (Mermaid in a frame) |
| `public/diagram/` | The sandboxed diagram frame (`frame.html`, `frame.js`); Vite adds Mermaid's single file |
| `src/editor/*.ts` | Keymap, code highlighting, language picker, focus and typewriter modes |
| `src/app/*.ts` | Document load and save, the Tauri shell (menus, windows, close prompt), outline, word count |
| `src/prefs/` + `preferences.html` | The Settings window (Shortcuts tab) |
| `src/shared/commands.json` | **The one list of commands and default shortcuts**, read by Rust and TypeScript |
| `src/shared/reserved.json` | System shortcuts that can't be reassigned, read by both sides |
| `src/theme/newsprint.css` | All styling; colors and sizes are CSS variables |
| `src-tauri/src/lib.rs` | File commands, windows, menu event routing |
| `src-tauri/src/menu.rs` | Menu built from the command list, `keybindings.json`, Settings window |
| `scripts/` | Playwright suites (`check-*.mjs`, `shot.mjs`) and the `npm test` runner |

## Rules that must hold

1. **The file on disk is the document.** Never reformat or re-serialize it. Every edit changes only
   the bytes it is about. Save with `state.sliceDoc()`, not `doc.toString()`: the latter always
   joins lines with `\n` and would turn CRLF files into LF. New line breaks use `state.lineBreak`.
   `write_document` is atomic (temp file, fsync, rename) and keeps permissions and the BOM.
2. **Rendering is decoration only.** `livePreview.ts`, `tables.ts`, and `blocks.ts` add decorations
   and widgets; they never change the text except when the user edits.
3. **One command list.** A new menu or formatting command goes in `src/shared/commands.json`, and
   the menu, the editor keymap, table cells, and Settings all pick it up. Shortcuts use the
   canonical form `Cmd+Ctrl+Alt+Shift+Key` (modifiers in that order); `canonical()` exists on both
   sides.
4. **Tables:** the widget is a block decoration from a `StateField`. Cells come from the parser's
   `TableDelimiter` nodes, never from scanning for pipes. Structural edits must be minimal (one line
   per row edit, one cell per line per column edit), and header and delimiter cell counts must match
   or the table stops parsing. Tables inside quotes and lists keep each line's prefix.
5. **Windows share one menu bar.** Send events to one window with `emit_to`, not `emit` (which goes to
   every window). View checkmarks are synced from the focused window through `sync_view_menu`.
6. **Security.** A Markdown file is untrusted input.
   - Never put document text into `innerHTML` without escaping (see `renderInline` in `tables.ts`).
     Keep the CSP in `tauri.conf.json` strict; `scripts/check-csp.mjs` must pass.
   - No inline `<style>` or `<script>` in any HTML asset (`index.html`, `preferences.html`, `public/`,
     including the diagram frame).
     Tauri would add a hash to that directive, browsers then ignore `'unsafe-inline'`, and KaTeX's
     inline styles would break in the app while `check-csp.mjs` (which reads the unmodified policy)
     still passed.
   - Math (`src/render/math.ts`) is KaTeX on the main thread with `trust: false` (no `\href`, `\url`,
     `\includegraphics`, `\html*`), `maxExpand` 1000, `maxSize` 20, and a fresh `macros` object per
     formula, so a `\gdef` never reaches another formula. Sources over 2,000 (inline) or 10,000
     (display) UTF-16 units are refused before KaTeX sees them, output over 512 KiB is refused, and a
     document renders at most 2,000 formulas. The output goes through its own DOMPurify instance
     (`semantics` and `annotation` added; links, images, ids, and resource-naming values removed) and
     is inserted as nodes, never re-parsed; errors use `textContent`. `check-math.mjs` compares 30
     formulas node for node with KaTeX's own output, so an upgrade that drops markup fails. Math in
     table cells stays source (their `renderInline` feeds `innerHTML`). A KaTeX denial-of-service bug
     would freeze the window: the version is pinned exactly, so upgrade promptly.
   - Mermaid (`src/render/diagram.ts`) never runs in the editor's document. It runs in one hidden
     `<iframe sandbox="allow-scripts">` per document (never `allow-same-origin`), loaded from
     `/diagram/frame.html` with its own CSP (`default-src 'none'`, scripts only from our origin as
     classic scripts, no inline script). A frame's own CSP can't stop it navigating itself; the app
     CSP's `default-src 'self'` (with no `frame-src`) is what keeps it on our origin, and the editor
     drops a frame that loads a second time. Don't add a `frame-src` or widen `default-src`
     (`check-csp.mjs` tests this). The opaque origin gets no Tauri IPC script or invoke key;
     `strict` security, no HTML labels, and a `secure` list that directives can't change. The parent
     sends it diagram source only, and accepts a reply only from that frame's window, with origin
     `"null"`, in the exact shape, for the job in flight. The SVG is sanitized in an inert document
     (`foreignObject` means refused, a `<style>` that could load anything means refused, only
     `url(#id)` references kept, a single `<svg>` root with a sane `viewBox`) and shown only as
     `<img src="data:image/svg+xml;base64,…">`: never insert diagram SVG into the page. Caps: 20,000
     UTF-16 units of source, 1 MiB of SVG, 100 diagrams per document, one job at a time, a queue of 100,
     10 s for a reply. A synchronous Mermaid loop still freezes the window (the frame shares its
     thread): the hang guard (`openviewer.diagram.pending` → `openviewer.diagram.blocked` in
     `localStorage`) shows such a diagram's code and "Render anyway" on the next launch, a freshly
     opened document's first diagrams render while it is still clean, and `diagrams` in
     `settings.json` (on by default; off when settings can't be read) turns them all off. The guard
     works per diagram, so a file with many different looping diagrams can freeze its window once per
     diagram (an accepted limit). Export renders diagrams the same way into
     `<img>` tags before the page sanitizer runs; the export CSP doesn't change.
   - File access is by user choice only: `read_document`, `write_document`, and
     `create_document_window` accept only paths authorized in Rust by the Open or Save As dialog
     (`open_dialog` / `save_dialog`), a drop, or Finder's Open With. Paths are compared canonically,
     reads verify the opened file with `F_GETPATH`, and writes go through a verified directory handle
     (`openat`/`renameat`), so a symlink swapped in later is never followed.
   - Local images are served by our own `ovimg:` scheme (`images.rs`), not Tauri's asset protocol.
     `resolve_image_path` issues a random token for one file inside the document's git repository
     (or its folder), bound to that file's identity; the scheme serves only issued tokens, at most
     32 MB, off the main thread. Images elsewhere need a folder grant from a native prompt
     (`allow_image_folder`, never the home folder, forgotten on quit).
   - Pasted and dropped images (`insert_image`, `insert_dropped_image`) are copied into the folder
     chosen in Settings (`settings.rs` accepts only `assets`, `{name}.assets`, `.`), never over an
     existing file and never through a symlinked folder. A dropped file is usable once, and only if
     it was dropped on a window.
   - Folder grants and authorized documents are app-wide, not per window: every window runs the
     same trusted frontend, and a compromised one could already read any authorized document.
     Dropped images are the exception: each drop is usable only by the window it landed on.
   - Windows can't emit events (`core:event:allow-emit` is not granted), so one window can't send
     `menu` commands to another. Quit is broadcast by Rust. `allow-destroy` stays: Tauri's
     `onCloseRequested` calls `destroy()` after our unsaved-changes prompt.
   - Remote images are off by default (`remoteImages` in `settings.json`, set only from the
     Settings window). Off, the editor shows a placeholder naming the host, and export drops them
     and leaves `https:`/`http:` out of the page's CSP. The app's own CSP still allows `https:` images
     (a CSP can't follow a runtime setting), so the check in `buildDecorations` is the only guard:
     any new way of creating an `<img>` must go through it (diagrams are the one exception: their
     `src` is always our own `data:image/svg+xml`, built in `diagram.ts`). Known gap once turned on: a remote image is
     checked by host name only, so a public URL that redirects, or a name that resolves, to a LAN
     address still loads. Closing it means fetching remote images in Rust.
   - Text files are decoded in Rust (`documents::decode`); NUL bytes without a BOM mean binary and
     are refused. A save that the file's encoding can't hold fails with `unmappable:` rather than
     writing replacement characters.
   - Export (`export.rs`, `src/export/`): Markdown is rendered with marked, sanitized with DOMPurify,
     and only then changed by us (highlighting, embedded images). The page has its own CSP with no
     scripts; tags, attributes, and inline styles that could load a resource are removed, so only
     `<img src>` (checked with `imageUrlAllowed`, local ones embedded within a 200 MB budget) loads.
     Formulas and diagrams (as SVG `data:` images, charged to the same budget) are rendered first and placed in marked's output, so the page sanitizer (with
     `semantics` and `annotation` added) sees them too; KaTeX's woff2 fonts are embedded as `data:`
     URLs from a fixed list of its files, and the page CSP doesn't change. Rust writes only to a target picked in `export_dialog`, once. PDFs are printed by an
     offscreen WKWebView outside the app (JavaScript off, non-persistent store, no IPC) into a private
     temporary folder, then saved like a document. `OPENVIEWER_PDF_SELFTEST=in.html:out.pdf` (debug
     builds only) prints a page and quits.
   - Platform code lives in `src-tauri/src/platform/`: descriptor-based on macOS, a portable
     fallback elsewhere that opens without following links and checks the opened handle.
   - Images from loopback, private, and link-local hosts are blocked (`imageUrlAllowed`).
   - Permissions are per window: `capabilities/documents.json` and `capabilities/preferences.json`,
     with app commands declared in `build.rs`. A new command needs an entry in both places.
   - Updater checks, prompts, downloads, and installs are Rust-driven; never grant updater permissions
     to a webview capability.
   - Opening refuses non-regular files and files over 64 MB; `keybindings.json` over 1 MB is refused
     and is never written through a symlink.

## Gotchas

- In `src/main.ts`, anything used while the `EditorView` is created (`extensionsForDocument`) must
  be defined above it; a `const` defined later throws at startup.
- In WKWebView the page sees a key equivalent (⌘S) before the menu, and a key the page prevents never
  reaches the menu. The editor's shortcut keymap therefore never uses `preventDefault` for keys it
  doesn't handle. The Settings window calls `suspend_shortcuts` while recording a shortcut (so the menu
  doesn't take the key), and table cells handle their own keys.
- CodeMirror's `WidgetType.updateDOM` keeps a focused table cell alive while its text changes; a
  change in table shape rebuilds the widget and focus moves to `pendingFocus`.
- The Playwright suites drive the browser build through `window.__ov` and `window.__prefs`, which
  exist only outside the app.
- In GFM, a non-blank line directly under a table becomes a table row. Anything that inserts a
  table (`insertTable`) leaves a blank line after it.

## Conventions

- TypeScript is strict. Keep modules small and match the surrounding style.
- Comments explain why, not what. Mark a judgment call with `// DECISION:`.
- Every behavior fix gets a check in a `scripts/check-*.mjs` suite.
- Commit messages: a short imperative subject, then a body that says what changed and why.
- Don't commit anything from `.autopilot/`, `.claude/`, `DEVLOG.md`, or other local state (see `.gitignore`).
