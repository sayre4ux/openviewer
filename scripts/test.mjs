// Runs every check: typecheck, Rust unit tests, the browser suites against `vite`, and the CSP
// check against the production build. `--webkit` also runs the browser suites in WebKit, the
// engine the macOS app uses.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const engines = process.argv.includes("--webkit") ? ["chromium", "webkit"] : ["chromium"];
const shots = mkdtempSync(join(tmpdir(), "openviewer-shots-"));
const failures = [];

function run(label, cmd, args, opts = {}) {
  process.stdout.write(`\n▶ ${label}\n`);
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.status !== 0) failures.push(label);
}

run("typecheck", "npx", ["tsc", "--noEmit"]);
run("rust tests", "cargo", ["test", "--quiet"], { cwd: "src-tauri" });
run("release script tests", process.execPath, ["--test", "scripts/release.test.mjs"]);

// OV_PORT lets two checkouts (git worktrees) run their suites at the same time.
const port = process.env.OV_PORT ?? "5173";
process.env.OV_URL = `http://localhost:${port}/`;
const vite = spawn("npx", ["vite", "--port", port, "--strictPort"], { stdio: ["ignore", "pipe", "inherit"] });
await new Promise((resolve, reject) => {
  // Color codes split "Local:" when FORCE_COLOR is set (as in CI and some terminals), so strip them first.
  vite.stdout.on("data", (d) => String(d).replace(/\x1b\[[0-9;]*m/g, "").includes("Local:") && resolve());
  vite.on("exit", (code) => reject(new Error(`vite exited (${code}); is port ${port} in use?`)));
});
try {
  for (const engine of engines) {
    for (const script of ["shot.mjs", "check-tables.mjs", "check-modes.mjs", "check-prefs.mjs", "check-l10n.mjs", "check-security.mjs", "check-paste.mjs", "check-export.mjs", "check-editing.mjs", "check-math.mjs", "check-diagrams.mjs"]) {
      if (script === "shot.mjs" && engine !== "chromium") continue;
      run(`${script} (${engine})`, "node", [join("scripts", script), join(shots, engine), engine]);
    }
  }
} finally {
  vite.kill();
}

run("production build", "npx", ["vite", "build", "--logLevel", "warn"]);
for (const engine of engines) run(`check-csp.mjs (${engine})`, "node", ["scripts/check-csp.mjs", engine]);

console.log(failures.length ? `\n✗ failed: ${failures.join(", ")}` : "\n✓ all checks passed");
console.log(`screenshots: ${shots}`);
process.exit(failures.length ? 1 : 0);
