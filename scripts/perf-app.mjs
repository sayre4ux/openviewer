// Memory harness for the real macOS app and its out-of-process WKWebView pages.
// Usage: node scripts/perf-app.mjs [path/to/OpenViewer.app]
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generatePerfDocuments } from "./perf-docs.mjs";

const appPath = resolve(process.argv[2] ?? "src-tauri/target/release/bundle/macos/OpenViewer.app");
if (process.platform !== "darwin") throw new Error("perf-app.mjs requires macOS");
if (!existsSync(appPath)) throw new Error(`App bundle not found: ${appPath}`);

const folder = mkdtempSync(join(tmpdir(), "openviewer-perf-"));
const docs = generatePerfDocuments();
const smallFile = join(folder, "sample-100kb.md");
const largeFile = join(folder, "sample-1mb.md");
writeFileSync(smallFile, docs["100kb"].text);
writeFileSync(largeFile, docs["1mb"].text);
const extraFiles = [];
for (let i = 2; i <= 5; i++) {
  const file = join(folder, `sample-100kb-window-${i}.md`);
  copyFileSync(smallFile, file);
  extraFiles.push(file);
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const run = (command, args) => spawnSync(command, args, {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  maxBuffer: 8 * 1024 * 1024,
});

function appPids() {
  const result = run("pgrep", ["-x", "openviewer"]);
  if (result.status !== 0 && result.status !== 1) throw new Error(result.stderr || "pgrep failed");
  return (result.stdout ?? "").trim().split(/\s+/).filter(Boolean).map(Number).filter(Number.isFinite);
}

function newestAppPid() {
  const result = run("pgrep", ["-n", "-x", "openviewer"]);
  if (result.status !== 0) return null;
  const pid = Number(result.stdout.trim());
  return Number.isFinite(pid) ? pid : null;
}

function processSnapshot() {
  const result = run("ps", ["-axo", "pid=,lstart=,command="]);
  if (result.status !== 0) throw new Error(result.stderr || "ps failed");
  return (result.stdout ?? "").split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
    if (!match) return [];
    return [{ pid: Number(match[1]), startedMs: Date.parse(match[2]), command: match[3] }];
  });
}

function webKitKind(command) {
  const match = command.match(/com\.apple\.WebKit\.(WebContent|Networking|GPU)/);
  return match?.[1] ?? null;
}

async function waitForNewAppPid(oldPids) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const pid = newestAppPid();
    if (pid && !oldPids.has(pid)) return pid;
    await sleep(150);
  }
  throw new Error("Could not find the newly launched OpenViewer pid with pgrep -n -x openviewer");
}

async function waitForPidsGone(pids, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = new Set(appPids());
    if (pids.every((pid) => !current.has(pid))) return true;
    await sleep(150);
  }
  return false;
}

async function quitApp(targetPids) {
  if (!targetPids.length) return "not running";
  const result = run("osascript", ["-e", 'quit app "OpenViewer"']);
  if (result.status === 0 && await waitForPidsGone(targetPids)) return "osascript";

  // The native quit prompt or automation permissions can reject AppleScript; only signal pids
  // launched by this harness, leaving any pre-existing OpenViewer instance alone.
  const stillRunning = appPids().filter((pid) => targetPids.includes(pid));
  for (const pid of stillRunning) run("kill", ["-TERM", String(pid)]);
  await waitForPidsGone(stillRunning, 8000);
  return "kill fallback";
}

function footprintBytes(pid) {
  const result = run("footprint", [String(pid)]);
  if (result.status !== 0) return null;
  const match = `${result.stdout}\n${result.stderr}`.match(/physical footprint[^\n]*?([\d.]+)\s*([KMGT]?)(?:i?B)?/i);
  if (!match) return null;
  const power = { "": 0, K: 1, M: 2, G: 3, T: 4 }[match[2].toUpperCase()];
  return Number(match[1]) * (1024 ** power);
}

function rssBytes(pid) {
  const result = run("ps", ["-o", "rss=", "-p", String(pid)]);
  if (result.status !== 0) return null;
  const kb = Number((result.stdout ?? "").trim());
  return Number.isFinite(kb) && kb > 0 ? kb * 1024 : null;
}

function measureProcesses(appProcessIds, webKitProcesses) {
  const allPids = [...new Set([...appProcessIds, ...webKitProcesses.map(({ pid }) => pid)])];
  const footprint = new Map(allPids.map((pid) => [pid, footprintBytes(pid)]));
  const useFootprint = allPids.length > 0 && [...footprint.values()].every((value) => value !== null);
  const bytes = (pid) => useFootprint ? footprint.get(pid) : rssBytes(pid);
  const sum = (pids) => pids.map(bytes).filter((value) => value !== null).reduce((total, value) => total + value, 0);
  const app = sum(appProcessIds);
  const webContentPids = webKitProcesses.filter(({ kind }) => kind === "WebContent").map(({ pid }) => pid);
  const auxiliaryPids = webKitProcesses.filter(({ kind }) => kind !== "WebContent").map(({ pid }) => pid);
  const webContent = sum(webContentPids);
  const auxiliary = sum(auxiliaryPids);
  const toMiB = (value) => Math.round((value / (1024 * 1024)) * 100) / 100;
  return {
    method: useFootprint ? "footprint" : "ps-rss fallback",
    appMiB: toMiB(app),
    webContentMiB: toMiB(webContent),
    webKitAuxiliaryMiB: toMiB(auxiliary),
    grandTotalMiB: toMiB(app + webContent + auxiliary),
    processCounts: {
      app: appProcessIds.length,
      webContent: webContentPids.length,
      webKitAuxiliary: auxiliaryPids.length,
    },
  };
}

const measurements = [];
let activePids = [];
let activeBaseline = new Set();
try {
  if (process.platform === "darwin") {
    const scenarios = [
      { name: "1 window, 100 KB", file: smallFile, additional: [] },
      { name: "1 window, 1 MB", file: largeFile, additional: [] },
      { name: "5 windows, 100 KB each", file: smallFile, additional: extraFiles },
    ];

    for (const scenario of scenarios) {
      const before = processSnapshot();
      const oldPids = new Set(before.map(({ pid }) => pid));
      const oldAppPids = new Set(appPids());
      activeBaseline = oldAppPids;
      const launchStarted = Date.now();
      const launched = run("open", ["-n", "-a", appPath, scenario.file]);
      if (launched.status !== 0) throw new Error(launched.stderr || `open failed for ${scenario.file}`);
      const primaryPid = await waitForNewAppPid(oldAppPids);
      activePids = appPids().filter((pid) => !oldAppPids.has(pid));
      if (!activePids.includes(primaryPid)) activePids.push(primaryPid);

      for (const file of scenario.additional) {
        const opened = run("open", ["-a", appPath, file]);
        if (opened.status !== 0) throw new Error(opened.stderr || `open failed for ${file}`);
        await sleep(200);
      }
      await sleep(3000);

      const currentApps = appPids().filter((pid) => !oldAppPids.has(pid));
      if (!currentApps.length) throw new Error(`OpenViewer exited before measuring ${scenario.name}`);
      activePids = currentApps;
      const after = processSnapshot();
      // Process-name and start-time matching avoids counting Safari or WebKit services already
      // running before this launch. It can miss a reused WebKit process and cannot prove that a
      // newly started WebKit process belongs only to this app when other apps launch WebViews too.
      const webKitProcesses = after.flatMap((process) => {
        const kind = webKitKind(process.command);
        if (!kind || oldPids.has(process.pid) || process.startedMs < launchStarted - 1500) return [];
        return [{ pid: process.pid, kind }];
      });
      const memory = measureProcesses(activePids, webKitProcesses);
      measurements.push({
        scenario: scenario.name,
        primaryAppPid: primaryPid,
        appPids: activePids,
        webKitProcesses,
        ...memory,
      });
      console.log(`Measured ${scenario.name} (app pid ${primaryPid}, ${memory.method})`);
      const quitMethod = await quitApp(activePids);
      measurements.at(-1).quitMethod = quitMethod;
      console.log(`Quit ${scenario.name}: ${quitMethod}`);
      activePids = [];
    }
  }
} finally {
  if (!activePids.length) activePids = appPids().filter((pid) => !activeBaseline.has(pid));
  if (activePids.length) await quitApp(activePids);
  rmSync(folder, { recursive: true, force: true });
}

console.log("\nScenario                     App MiB  WebContent MiB  WebKit aux MiB  Grand total MiB  Method");
console.log("----------------------------  -------  --------------  --------------  ---------------  ----------------");
for (const result of measurements) {
  const line = [
    result.scenario.padEnd(28),
    result.appMiB.toFixed(2).padStart(7),
    result.webContentMiB.toFixed(2).padStart(14),
    result.webKitAuxiliaryMiB.toFixed(2).padStart(14),
    result.grandTotalMiB.toFixed(2).padStart(15),
    result.method,
  ].join("  ");
  console.log(line);
}
console.log("\nJSON summary");
console.log(JSON.stringify({
  appPath,
  documentBytes: { "100kb": docs["100kb"].bytes, "1mb": docs["1mb"].bytes },
  measurements,
  webKitProcessHeuristic: "Only WebKit processes with WebContent, Networking, or GPU in the command and a pid absent before launch are counted. Reused processes and unrelated WebKit processes started during the same interval can be missed or included.",
}, null, 2));
