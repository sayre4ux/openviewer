// Builds OpenViewer.app. The builder's home folder is rewritten to "~" in the binary, so a release
// doesn't carry the name of whoever built it (Rust embeds dependency source paths for panic messages).
// CARGO_ENCODED_RUSTFLAGS separates flags with 0x1f, so a home folder with spaces stays one argument,
// and setting it here works under any shell, including cmd.exe.
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";

// Cargo ignores RUSTFLAGS once the encoded form is set, so any flags the builder already has come along.
const existing = process.env.CARGO_ENCODED_RUSTFLAGS?.split("\x1f")
  ?? process.env.RUSTFLAGS?.trim().split(/\s+/)
  ?? [];
const flags = [...existing.filter(Boolean), `--remap-path-prefix=${homedir()}=~`];
const result = spawnSync("npx", ["tauri", "build", "--bundles", "app", ...process.argv.slice(2)], {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, CARGO_ENCODED_RUSTFLAGS: flags.join("\x1f") },
});
process.exit(result.status ?? 1);
