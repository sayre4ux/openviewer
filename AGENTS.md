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
| `src/editor/*.ts` | Keymap, code highlighting, language picker, focus and typewriter modes |
| `src/app/*.ts` | Document load and save, the Tauri shell (menus, windows, close prompt), outline, word count |
| `src/prefs/` + `preferences.html` | The Preferences window (Shortcuts tab) |
| `src/shared/commands.json` | **The one list of commands and default shortcuts**, read by Rust and TypeScript |
| `src/shared/reserved.json` | System shortcuts that can't be reassigned, read by both sides |
| `src/theme/newsprint.css` | All styling; colors and sizes are CSS variables |
| `src-tauri/src/lib.rs` | File commands, windows, menu event routing |
| `src-tauri/src/menu.rs` | Menu built from the command list, `keybindings.json`, Preferences window |
| `scripts/` | Playwright suites (`check-*.mjs`, `shot.mjs`) and the `npm test` runner |

## Rules that must hold

1. **The file on disk is the document.** Never reformat or re-serialize it. Every edit changes only
   the bytes it is about. Save with `state.sliceDoc()`, not `doc.toString()`: the latter always
   joins lines with `\n` and would turn CRLF files into LF. New line breaks use `state.lineBreak`.
   `write_document` is atomic (temp file, fsync, rename) and keeps permissions and the BOM.
2. **Rendering is decoration only.** `livePreview.ts` and `tables.ts` add decorations and widgets;
   they never change the text except when the user edits.
3. **One command list.** A new menu or formatting command goes in `src/shared/commands.json`, and
   the menu, the editor keymap, table cells, and Preferences all pick it up. Shortcuts use the
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
     chosen in Preferences (`settings.rs` accepts only `assets`, `{name}.assets`, `.`), never over an
     existing file and never through a symlinked folder. A dropped file is usable once, and only if
     it was dropped on a window.
   - Folder grants and authorized documents are app-wide, not per window: every window runs the
     same trusted frontend, and a compromised one could already read any authorized document.
   - Text files are decoded in Rust (`documents::decode`); NUL bytes without a BOM mean binary and
     are refused. A save that the file's encoding can't hold fails with `unmappable:` rather than
     writing replacement characters.
   - Platform code lives in `src-tauri/src/platform/`: descriptor-based on macOS, a portable
     fallback elsewhere that opens without following links and checks the opened handle.
   - Images from loopback, private, and link-local hosts are blocked (`imageUrlAllowed`).
   - Permissions are per window: `capabilities/documents.json` and `capabilities/preferences.json`,
     with app commands declared in `build.rs`. A new command needs an entry in both places.
   - Opening refuses non-regular files and files over 64 MB; `keybindings.json` over 1 MB is refused
     and is never written through a symlink.

## Gotchas

- In `src/main.ts`, anything used while the `EditorView` is created (`extensionsForDocument`) must
  be defined above it; a `const` defined later throws at startup.
- macOS menu shortcuts reach the menu before the web page sees the key. Preferences calls
  `suspend_shortcuts` while recording a shortcut, and table cells handle their own keys.
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
