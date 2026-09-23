// Behavior checks for outline, focus mode, typewriter mode, and word count (browser mode).
// Usage: node scripts/check-modes.mjs [outDir] [chromium|webkit]
import { chromium, webkit } from "playwright";
import { mkdirSync } from "node:fs";

const out = process.argv[2] ?? "shots";
const engine = process.argv[3] ?? "chromium";
mkdirSync(out, { recursive: true });
const browser = engine === "webkit" ? await webkit.launch() : await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1300, height: 800 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
await page.goto(process.env.OV_URL ?? "http://localhost:5173/");
await page.waitForSelector(".cm-content");
await page.evaluate(() => { try { localStorage.clear(); } catch {} });
await page.reload(); await page.waitForSelector(".cm-content"); await page.evaluate(() => document.fonts.ready);
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
const settle = (ms = 250) => page.waitForTimeout(ms);
const run = (id) => page.evaluate((id) => window.__ov.commands[id](), id);
const status = () => page.textContent("#status");

// Word count: on by default, counts CJK characters individually, reports selections.
check("word count visible by default", await page.isVisible("#status"), await status());
await page.evaluate(() => window.__ov.load("你好世界 hello world, it's [a link](https://example.com/long/path) <b>x</b>\n"));
await settle();
check("word count CJK + latin", (await status()) === "10 words", await status());
await page.evaluate(() => { const v = window.__ov.view; v.dispatch({ selection: { anchor: 0, head: 4 } }); });
await settle();
check("word count selection", (await status()) === "4 of 10 words", await status());
await run("word-count"); await settle();
check("word count toggles off", !(await page.isVisible("#status")));
await run("word-count");
await page.evaluate(() => window.__ov.load(window.__ov.source)); await settle();

// Outline: lists headings, jumps on click, marks the current heading.
await run("outline"); await settle();
const items = await page.$$eval(".ov-outline-item", (els) => els.map((e) => e.textContent));
check("outline lists headings", items.length === 6 && items[0] === "The Morning Edition", JSON.stringify(items));
await page.click(".ov-outline-item >> text=A quieter third heading"); await settle(400);
const jumped = await page.evaluate(() => { const v = window.__ov.view; return v.state.doc.lineAt(v.state.selection.main.head).text; });
const active = await page.textContent(".ov-outline-item.is-active");
check("outline click jumps", jumped === "### A quieter third heading", jumped);
check("outline marks current", active === "A quieter third heading", active);
await page.screenshot({ path: `${out}/m1-outline.png` });

// Focus mode: only the current block is at full opacity.
await page.evaluate(() => { const v = window.__ov.view; const i = v.state.doc.toString().indexOf("The column stays"); v.dispatch({ selection: { anchor: i + 5 }, scrollIntoView: true }); v.focus(); });
await run("focus-mode"); await settle(400);
const currentLines = await page.$$eval(".cm-focus-current", (els) => els.map((e) => e.textContent));
const dimmed = await page.$eval(".cm-line:not(.cm-focus-current)", (e) => getComputedStyle(e).opacity);
check("focus mode highlights current paragraph", currentLines.length === 1 && currentLines[0].startsWith("The column stays"), JSON.stringify(currentLines));
check("focus mode dims the rest", Number(dimmed) < 0.5, dimmed);
await page.screenshot({ path: `${out}/m2-focus.png` });
await run("focus-mode"); await settle();

// Typewriter mode: keyboard movement keeps the caret line near the middle of the window.
await run("typewriter-mode"); await settle(400);
await page.evaluate(() => { const v = window.__ov.view; v.dispatch({ selection: { anchor: 0 } }); v.focus(); });
for (let i = 0; i < 12; i++) await page.keyboard.press("ArrowDown");
await settle(500);
const offset = await page.evaluate(() => {
  const v = window.__ov.view;
  const c = v.coordsAtPos(v.state.selection.main.head);
  const r = v.scrollDOM.getBoundingClientRect();
  return Math.round((c.top + c.bottom) / 2 - (r.top + r.height / 2));
});
check("typewriter centers caret", Math.abs(offset) < 40, `${offset}px from center`);
await page.screenshot({ path: `${out}/m3-typewriter.png` });
await run("typewriter-mode");

// Outline setting is remembered across a reload.
await page.reload(); await page.waitForSelector(".cm-content"); await settle();
check("outline remembered", await page.isVisible("#outline"));

// Outline on a large document eventually lists every heading (parsing continues in slices).
await page.evaluate(() => window.__ov.load(Array.from({ length: 12000 }, (_, i) => `## Heading ${i + 1}\n\nText ${i}.\n`).join("\n")));
await page.waitForFunction(() => document.querySelectorAll(".ov-outline-item").length === 12000, null, { timeout: 15000 }).catch(() => {});
const bigCount = await page.$$eval(".ov-outline-item", (els) => els.length);
check("outline complete on 12k headings", bigCount === 12000, String(bigCount));

console.log(`${results.filter(Boolean).length}/${results.length} passed`);
await browser.close();
process.exit(results.every(Boolean) ? 0 : 1);
