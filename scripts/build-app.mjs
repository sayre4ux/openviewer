// Builds OpenViewer.app. The builder's home folder is rewritten to "~" in the binary, so a release
// doesn't carry the name of whoever built it (Rust embeds dependency source paths for panic messages).
// CARGO_ENCODED_RUSTFLAGS separates flags with 0x1f, so a home folder with spaces stays one argument,
// and setting it here works under any shell, including cmd.exe.
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";

// Cargo ignores RUSTFLAGS once the encoded form is set, so flags from either variable come along.
// `build.rustflags` in a Cargo config would be overridden; this repository has none.
const existing = process.env.CARGO_ENCODED_RUSTFLAGS?.split("\x1f")
  ?? process.env.RUSTFLAGS?.trim().split(/\s+/)
  ?? [];
const flags = [...existing.filter(Boolean), `--remap-path-prefix=${homedir()}=~`];
const forwarded = process.argv.slice(2);
const hasBundleSelection = forwarded.some((argument, index) => argument === "--bundles" || argument.startsWith("--bundles="));
const args = ["tauri", "build", ...(hasBundleSelection ? [] : ["--bundles", "app"]), ...forwarded];
const result = spawnSync("npx", args, {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, CARGO_ENCODED_RUSTFLAGS: flags.join("\x1f") },
});
if (result.error) console.error(`Couldn't run tauri build: ${result.error.message}`);
process.exit(result.status ?? 1);
