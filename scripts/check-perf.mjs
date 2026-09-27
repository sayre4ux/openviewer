// Browser editor performance harness.
// Usage: node scripts/check-perf.mjs [outDir] [chromium|webkit]
import { chromium, webkit } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { generatePerfDocuments } from "./perf-docs.mjs";

// Typing is measured two ways per keystroke. Processing: from keydown to the editor having applied the
// change (its state and DOM updated) — the editor's own work. To frame: from keydown to the first
// animation frame after that update — when the change can be on screen. At 60 Hz the second can't be
// below one frame and is often two, whatever the editor does.
// DECISION: the editor's work for a keystroke in a 100 KB document fits in half a frame.
const BUDGET_PROCESS_100KB_P95_MS = 8;
// DECISION: in a 1 MB document it fits in one frame (a larger syntax tree to update).
const BUDGET_PROCESS_1MB_P95_MS = 16;
// DECISION: the change reaches the screen within two 60 Hz frames for 95% of keys, three for 99%.
const BUDGET_FRAME_P95_MS = 34;
const BUDGET_FRAME_P99_MS = 50;
// DECISION: loading should feel immediate enough to begin editing before a short pause is noticed.
const BUDGET_1MB_LOAD_MS = 1500;
// DECISION: a small number of delayed frames is acceptable, while repeated stalls indicate scroll jank.
const BUDGET_SCROLL_OVER_50_PERCENT = 2;

const out = resolve(process.argv[2] ?? "shots/perf");
const engine = process.argv[3] ?? "chromium";
if (engine !== "chromium" && engine !== "webkit") throw new Error(`Unknown engine: ${engine}`);
mkdirSync(out, { recursive: true });

const docs = generatePerfDocuments();
const browser = engine === "webkit" ? await webkit.launch() : await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1100, height: 760 }, deviceScaleFactor: 2 });
try {
  page.setDefaultTimeout(120000);
  page.on("pageerror", (error) => console.log("PAGE ERROR:", error.message));
  const percentile = (samples, p) => {
    if (!samples.length) return null;
    const sorted = [...samples].sort((a, b) => a - b);
    return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
  };
  const rounded = (value) => value == null ? null : Math.round(value * 1000) / 1000;
  const stats = (samples) => ({
    count: samples.length,
    p50Ms: rounded(percentile(samples, 0.50)),
    p95Ms: rounded(percentile(samples, 0.95)),
    p99Ms: rounded(percentile(samples, 0.99)),
    maxMs: rounded(Math.max(...samples)),
  });
  const median = (samples) => percentile(samples, 0.50);

  async function loadAndWait(text) {
    return page.evaluate(async (markdown) => {
      const started = performance.now();
      window.__ov.load(markdown);
      await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
      return performance.now() - started;
    }, text);
  }

  async function loadComplete(text) {
    await page.evaluate(async (markdown) => {
      window.__ov.load(markdown);
      await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
      window.__ov.forceParsing();
      await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
    }, text);
  }

  async function setMainCaret(position) {
    await page.evaluate((at) => {
      const view = window.__ov.view;
      view.dispatch({ selection: { anchor: at }, scrollIntoView: true });
      view.focus();
    }, position);
  }

  async function positionForTyping(doc, kind, position) {
    await loadComplete(doc.text);
    if (kind === "table") {
      await setMainCaret(doc.anchors.table);
      await page.locator(".cm-md-table-wrap").first().waitFor({ state: "visible" });
      await page.locator(".cm-md-table-wrap tbody .cm-md-cell").first().click();
      return;
    }
    await setMainCaret(position);
  }

  await page.goto(process.env.OV_URL ?? "http://localhost:5173/");
  await page.waitForSelector(".cm-content");
  // The keydown timestamp is taken in the capture phase; the editor's update listener closes each sample.
  await page.evaluate(() => {
    window.__ovPerf = { recording: false, pending: null, processing: [], frame: [] };
    window.addEventListener("keydown", (event) => {
      const perf = window.__ovPerf;
      if (perf.recording && !event.repeat) perf.pending = performance.now();
    }, true);
    window.__ov.onUpdate((update) => {
      const perf = window.__ovPerf;
      if (!update.docChanged || perf.pending === null) return;
      const started = perf.pending;
      perf.pending = null;
      perf.processing.push(performance.now() - started);
      requestAnimationFrame(() => perf.frame.push(performance.now() - started));
    });
    // Table cells edit in their own element and reach the editor on input; time them from keydown to input.
    document.addEventListener("input", (event) => {
      const perf = window.__ovPerf;
      if (perf.pending === null || !event.target?.closest?.(".cm-md-cell")) return;
      const started = perf.pending;
      perf.pending = null;
      perf.processing.push(performance.now() - started);
      requestAnimationFrame(() => perf.frame.push(performance.now() - started));
    }, true);
  });

  const keySequence = "abcdefghijklmnopqrstuvwxyz";
  async function typeAndCollect(count) {
    await page.evaluate(() => {
      if (!window.__ovPerf) throw new Error("the page reloaded during the run; the probes are gone");
      Object.assign(window.__ovPerf, { processing: [], frame: [], pending: null, recording: true });
    });
    for (let i = 0; i < count; i++) {
      await page.keyboard.press(keySequence[i % keySequence.length]);
      await page.waitForFunction((needed) => {
        if (!window.__ovPerf) throw new Error("the page reloaded during the run; the probes are gone");
        return window.__ovPerf.frame.length >= needed;
      }, i + 1);
    }
    return page.evaluate(() => {
      window.__ovPerf.recording = false;
      return { processing: window.__ovPerf.processing.slice(), frame: window.__ovPerf.frame.slice() };
    });
  }

  // Warm each document size, typing context, mode change, and scroll path before collecting results.
  await loadAndWait(docs["100kb"].text);
  await loadAndWait(docs["1mb"].text);
  for (const [size, doc] of Object.entries(docs)) {
    for (const [kind, position] of [
      ["position", doc.anchors.top],
      ["position", doc.anchors.middle],
      ["position", doc.anchors.end],
      ...(size === "1mb" ? [["table", doc.anchors.table], ["position", doc.anchors.list], ["position", doc.anchors.code]] : []),
    ]) {
      await positionForTyping(doc, kind, position);
      await typeAndCollect(1);
    }
  }
  await loadComplete(docs["1mb"].text);
  await page.evaluate(async () => {
    const view = window.__ov.view;
    const scroller = view.scrollDOM;
    const end = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    scroller.scrollTop = 0;
    await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
    while (scroller.scrollTop < end) {
      await new Promise((resolveFrame) => requestAnimationFrame(resolveFrame));
      scroller.scrollTop = Math.min(end, scroller.scrollTop + scroller.clientHeight);
    }
    await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
    scroller.scrollTop = 0;
    await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
  });
  await page.evaluate(async () => {
    window.__ov.commands["source-mode"]();
    await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
    window.__ov.commands["source-mode"]();
    await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
  });

  // Load latency is measured inside the page, from load() through the second post-load frame.
  const loadResults = {};
  for (const [size, doc] of Object.entries(docs)) {
    const runs = [];
    for (let i = 0; i < 5; i++) runs.push(await loadAndWait(doc.text));
    loadResults[size] = { runsMs: runs.map(rounded), medianMs: rounded(median(runs)) };
  }

  const typingResults = {};
  for (const [size, doc] of Object.entries(docs)) {
    const positions = [
      ["top", doc.anchors.top],
      ["middle", doc.anchors.middle],
      ["end", doc.anchors.end],
    ];
    const scenarios = positions.map(([name, position]) => [`${size}-${name}`, "position", position]);
    if (size === "1mb") {
      scenarios.push(["1mb-table-cell", "table", doc.anchors.table]);
      scenarios.push(["1mb-list-item", "position", doc.anchors.list]);
      scenarios.push(["1mb-code-block", "position", doc.anchors.code]);
    }
    for (const [name, kind, position] of scenarios) {
      await positionForTyping(doc, kind, position);
      const samples = await typeAndCollect(200);
      typingResults[name] = { processing: stats(samples.processing), toFrame: stats(samples.frame) };
    }
  }

  await loadComplete(docs["1mb"].text);
  const scroll = await page.evaluate(async () => {
    const scroller = window.__ov.view.scrollDOM;
    scroller.scrollTop = 0;
    await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
    const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const frameMs = [];
    await new Promise((resolveScroll) => {
      let previous = null;
      const step = (timestamp) => {
        if (previous !== null) frameMs.push(timestamp - previous);
        previous = timestamp;
        if (scroller.scrollTop >= maxScroll) {
          requestAnimationFrame((last) => {
            frameMs.push(last - timestamp);
            resolveScroll();
          });
          return;
        }
        scroller.scrollTop = Math.min(maxScroll, scroller.scrollTop + scroller.clientHeight);
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    scroller.scrollTop = 0;
    return frameMs;
  });
  const scrollOver50 = scroll.filter((frame) => frame > 50).length;
  const scrollResults = {
    p95FrameMs: rounded(percentile(scroll, 0.95)),
    frameCount: scroll.length,
    framesOver50Ms: scrollOver50,
    framesOver50Percent: rounded(scroll.length ? (scrollOver50 / scroll.length) * 100 : 0),
  };

  const toggleResults = { onMs: [], offMs: [] };
  for (let i = 0; i < 5; i++) {
    const on = await page.evaluate(async () => {
      const started = performance.now();
      window.__ov.commands["source-mode"]();
      await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
      return performance.now() - started;
    });
    toggleResults.onMs.push(on);
    const off = await page.evaluate(async () => {
      const started = performance.now();
      window.__ov.commands["source-mode"]();
      await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
      return performance.now() - started;
    });
    toggleResults.offMs.push(off);
  }
  toggleResults.onMedianMs = rounded(median(toggleResults.onMs));
  toggleResults.offMedianMs = rounded(median(toggleResults.offMs));
  toggleResults.onMs = toggleResults.onMs.map(rounded);
  toggleResults.offMs = toggleResults.offMs.map(rounded);

  const all = Object.values(typingResults);
  const of100 = Object.entries(typingResults).filter(([name]) => name.startsWith("100kb-")).map(([, r]) => r);
  const of1mb = Object.entries(typingResults).filter(([name]) => name.startsWith("1mb-")).map(([, r]) => r);
  const worst = (items, metric, key) => Math.max(...items.map((item) => item[metric][key]));
  const checks = [];
  const checkBudget = (name, value, budget, unit) => {
    const pass = value <= budget;
    checks.push({ name, value, budget, unit, pass });
    console.log(`${pass ? "PASS" : "FAIL"} ${name} — ${rounded(value)} ≤ ${budget} ${unit}`);
  };
  checkBudget("typing 100 KB, editor processing p95 (worst position)", worst(of100, "processing", "p95Ms"), BUDGET_PROCESS_100KB_P95_MS, "ms");
  checkBudget("typing 1 MB, editor processing p95 (worst of position/table/list/code)", worst(of1mb, "processing", "p95Ms"), BUDGET_PROCESS_1MB_P95_MS, "ms");
  checkBudget("typing, keydown to next frame p95 (worst scenario)", worst(all, "toFrame", "p95Ms"), BUDGET_FRAME_P95_MS, "ms");
  checkBudget("typing, keydown to next frame p99 (worst scenario)", worst(all, "toFrame", "p99Ms"), BUDGET_FRAME_P99_MS, "ms");
  checkBudget("1 MB load median", loadResults["1mb"].medianMs, BUDGET_1MB_LOAD_MS, "ms");
  checkBudget("scroll frames over 50 ms", scrollResults.framesOver50Percent, BUDGET_SCROLL_OVER_50_PERCENT, "%");

  const summary = {
    engine,
    generatedDocuments: Object.fromEntries(Object.entries(docs).map(([size, doc]) => [size, {
      bytes: doc.bytes,
      tableCount: doc.anchors.tableCount,
      tableRows: doc.anchors.tableRows,
    }])),
    load: loadResults,
    typing: typingResults,
    scroll: scrollResults,
    livePreviewToggle: toggleResults,
    budgets: {
      processing100kbP95Ms: BUDGET_PROCESS_100KB_P95_MS,
      processing1mbP95Ms: BUDGET_PROCESS_1MB_P95_MS,
      toFrameP95Ms: BUDGET_FRAME_P95_MS,
      toFrameP99Ms: BUDGET_FRAME_P99_MS,
      load1mbMs: BUDGET_1MB_LOAD_MS,
      scrollOver50Percent: BUDGET_SCROLL_OVER_50_PERCENT,
    },
    checks,
  };
  const output = join(out, `perf-${engine}.json`);
  writeFileSync(output, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`JSON ${output}`);
  console.log(JSON.stringify(summary, null, 2));

  process.exitCode = checks.every((check) => check.pass) ? 0 : 1;
} finally {
  await browser.close();
}
