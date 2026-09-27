// Start the browser build and run the opt-in timing harness in Chromium and WebKit.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const out = resolve(process.argv[2] ?? "shots/perf");
mkdirSync(out, { recursive: true });
const failures = [];
const vite = spawn("npx", ["vite", "--port", "5173", "--strictPort"], { stdio: ["ignore", "pipe", "inherit"] });

await new Promise((resolveReady, reject) => {
  let ready = false;
  vite.stdout.on("data", (data) => {
    // Strip color escapes before checking: ANSI output can split the visible "Local:" text.
    const clean = String(data).replace(/\x1b\[[0-9;]*m/g, "");
    if (!ready && clean.includes("Local:")) {
      ready = true;
      resolveReady();
    }
  });
  vite.on("error", (error) => reject(error));
  vite.on("exit", (code) => {
    if (!ready) reject(new Error(`vite exited (${code}); is port 5173 in use?`));
  });
});

try {
  for (const engine of ["chromium", "webkit"]) {
    process.stdout.write(`\n▶ check-perf.mjs (${engine})\n`);
    const result = spawnSync(process.execPath, [join("scripts", "check-perf.mjs"), out, engine], { stdio: "inherit" });
    if (result.status !== 0) failures.push(engine);
  }
} finally {
  vite.kill();
}

console.log(failures.length ? `\n✗ performance budgets failed: ${failures.join(", ")}` : "\n✓ performance budgets passed in Chromium and WebKit");
console.log(`JSON output: ${out}`);
process.exit(failures.length ? 1 : 0);
