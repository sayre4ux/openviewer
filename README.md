# OpenViewer

A Markdown editor for macOS that works like Typora and looks like its Newsprint theme: you write
and read in one view, and Markdown syntax disappears once you finish typing it.

![OpenViewer editing a document in the Newsprint style](docs/screenshot.png)

## Features

- **One writing surface.** Headings, emphasis, links, lists, quotes, and code render in place. The
  Markdown markers reappear only while the cursor is inside them. ⌘/ switches to plain source.
- **Your file stays your file.** The text on disk is the document. Opening and saving without edits
  leaves every byte the same, including CRLF line endings and a UTF-8 BOM, and saves are atomic.
- **Tables you can edit in place.** Click a cell and type, Tab to move, and use the toolbar to add or
  remove rows and columns. Each edit changes only the lines it touches; **Tidy** lines up the columns.
- **Images.** Paste or drag an image in and it is copied into `./assets` next to the document and
  linked with a relative path (Settings → Images offers a folder per document instead). Images
  from the internet stay off until you turn them on.
- **Any text encoding.** UTF-8, UTF-16, and legacy encodings such as Big5, GBK, or Shift_JIS open
  and save in their own encoding; the status bar names any encoding that isn't UTF-8.
- **Export** to PDF (⇧⌘E) or a single self-contained HTML file, in the same Newsprint look, with
  local images and fonts embedded.
- **Code blocks** in a dark card with syntax highlighting and a language picker.
- **Math.** `$…$` inline and `$$` blocks render with KaTeX as you leave them, and show their TeX
  again when the cursor goes back in. Prices like `$5 and $10` stay text. Export keeps the formulas,
  with KaTeX's fonts embedded.
- **Mermaid diagrams.** A ` ```mermaid ` block is drawn as a picture (flowcharts, sequence, class,
  state, ER, Gantt, and pie charts) and shows its code when you click it. Diagrams are drawn in a
  sealed-off frame with no network access and shown as images; Settings → Images can turn them off.
- **Outline sidebar** (⇧⌘L), **focus mode** (F8), **typewriter mode** (F9), and a word count that
  counts Chinese, Japanese, and Korean characters as words.
- **Custom shortcuts.** Settings (⌘,) lets you record a new shortcut for any menu or formatting
  command. They are saved to `keybindings.json`, which you can also edit by hand.
- Small and native: about 14 MB, one document per window, native menus and dialogs, and "Open With"
  from Finder.

## Build and run

You need macOS, [Node.js](https://nodejs.org) 24 (see `.node-version`), and a stable
[Rust](https://rustup.rs) toolchain.

```sh
npm install
npm run app:dev      # run the app with live reload
npm run app:build    # build src-tauri/target/release/bundle/macos/OpenViewer.app
```

The build is not signed with a Developer ID or notarized yet, so macOS blocks the first launch of a
downloaded copy. Open it once, then go to System Settings → Privacy & Security and click **Open Anyway**
next to the message about OpenViewer. (Or, in Terminal: `xattr -dr com.apple.quarantine /path/to/OpenViewer.app`.)

## Test

```sh
npx playwright install webkit   # once
npm test                        # typecheck, Rust tests, browser suites, CSP check
npm run test:all                # the same, plus WebKit (the engine the app uses)
```

The browser suites run the editor in a plain browser against `npm run dev`.

## Releasing

OpenViewer updates itself with Tauri's updater: it checks a signed feed on GitHub, and installs only
updates signed with the project's key.

1. **Once:** create the updater key pair and keep the private key out of the repository:
   `npx tauri signer generate -w ~/.tauri/openviewer.key`. Paste the public key into
   `src-tauri/tauri.release.conf.json`. The public GitHub repository `sayre4ux/openviewer` must exist
   before the first release is published.
2. **Set the version:** `npm run release -- --version 0.1.0-beta.1` updates `package.json`,
   `Cargo.toml`, and `tauri.conf.json`; review and commit the change. Write the notes in
   `release-notes/<version>.md`.
3. **Build:** with `TAURI_SIGNING_PRIVATE_KEY` (and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` if the key has
   one) set, `npm run release` builds the app, the signed update archive, the download zip (made with
   `ditto`, so the signature survives), and `latest.json` into `release/<version>/`. It only prints the
   publishing commands. `--universal` builds for Apple silicon and Intel.
4. **Sign and notarize (when available):** set `APPLE_SIGNING_IDENTITY` for Developer ID signing, and
   `APPLE_ID`, `APPLE_PASSWORD` (an app-specific password), and `APPLE_TEAM_ID` to notarize. Without them
   the build is signed ad hoc, and testers use Open Anyway on first launch.
5. **Publish:** `npm run release -- --publish` creates the GitHub release (a pre-release for versions
   like `0.1.0-beta.1`) and replaces `latest.json` on the release tagged `updates`, which is where the app
   looks. A fixed tag is used because GitHub's "latest release" link skips pre-releases, so testers on a
   beta would never see the next one. Don't delete the `updates` release.

## Security

OpenViewer treats every Markdown file as untrusted. The app can read and write only files you chose
(Open, Save As, drag and drop, or Open With), local images load only from the document's folder or git
repository (other folders only after you allow them), images from your local network are blocked, and a strict Content-Security-Policy applies.
Images from the internet don't load unless you turn them on in Settings → Images, because loading one
tells its server that you opened the document. Formulas can't make links or load images, and Mermaid
diagrams are drawn in a sandboxed frame with no network access and shown only as images. A diagram
that freezes the app is shown as code the next time, with a button to try again.

## How it works

OpenViewer is a [Tauri 2](https://tauri.app) app. The editor is
[CodeMirror 6](https://codemirror.net) with a live-preview layer that only adds decorations over
the Markdown text, so nothing is re-serialized when you save. Notes for contributors and coding
agents are in [AGENTS.md](AGENTS.md).

## Roadmap

Before the first release:

- Signing with a Developer ID and notarization
- Continuous integration

After the first release:

- Dark mode
- A file tree sidebar
- A choice of spellcheck language
- Windows support

## License

[MIT](LICENSE).

## Credits

- The look follows Typora's Newsprint theme. The CSS here is written from scratch.
- [PT Serif](https://fonts.google.com/specimen/PT+Serif) by ParaType, bundled under the
  [SIL Open Font License](public/fonts/OFL.txt).
- Built with Tauri, CodeMirror, Lezer, [KaTeX](https://katex.org) (whose fonts are bundled), and
  [Mermaid](https://mermaid.js.org).
