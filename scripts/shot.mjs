// Screenshot and behavior checks for the editor running under `vite`.
// Usage: node scripts/shot.mjs <outDir> [chromium|webkit]
import { chromium, webkit } from "playwright";
import { mkdirSync } from "node:fs";

const out = process.argv[2] ?? "shots";
const engine = process.argv[3] ?? "chromium";
const url = process.env.OV_URL ?? "http://localhost:5173/";
mkdirSync(out, { recursive: true });

const browser = engine === "webkit" ? await webkit.launch() : await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1100, height: 760 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
page.on("console", (m) => m.type() === "error" && console.log("CONSOLE:", m.text()));
await page.goto(url);
await page.waitForSelector(".cm-content");
await page.evaluate(() => document.fonts.ready);

const ov = (fn, arg) => page.evaluate(fn, arg);
const caretAtEnd = () => ov(() => { const v = window.__ov.view; v.dispatch({ selection: { anchor: v.state.doc.length } }); });
const scrollTo = (y) => ov((y) => { window.__ov.view.scrollDOM.scrollTop = y; }, y);
const settle = () => page.waitForTimeout(250);

// 1. Round trip: the editor's text is the file, byte for byte.
const same = await ov(() => window.__ov.view.state.sliceDoc() === window.__ov.source);
console.log("round-trip identical:", same);

// 2. Reading views, caret parked at the end so nothing near the top is revealed.
await caretAtEnd(); await scrollTo(0); await settle();
await page.screenshot({ path: `${out}/1-top.png` });
await scrollTo(560); await settle();
await page.screenshot({ path: `${out}/2-middle.png` });
await scrollTo(100000); await settle();
await page.screenshot({ path: `${out}/3-bottom.png` });

// Tables render as a widget while the caret is elsewhere; clicking a cell reveals the source.
await caretAtEnd(); await settle();
const tableY = await ov(() => { const t = document.querySelector(".cm-md-table"); return t ? t.getBoundingClientRect().top + window.__ov.view.scrollDOM.scrollTop : -1; });
console.log("table rendered:", tableY >= 0);
await scrollTo(Math.max(0, tableY - 120)); await settle();
await page.screenshot({ path: `${out}/2b-table.png`, clip: { x: 0, y: 0, width: 1100, height: 420 } });
await page.click(".cm-md-table tbody td"); await settle();
const editing = await ov(() => document.activeElement?.classList.contains("cm-md-cell") ?? false);
console.log("table click focuses a cell:", editing);
await page.screenshot({ path: `${out}/2c-table-editing.png`, clip: { x: 0, y: 0, width: 1100, height: 420 } });

// 3. Caret inside **PT Serif** reveals its markers.
await scrollTo(0);
await ov(() => { const v = window.__ov.view; const i = v.state.doc.toString().indexOf("PT Serif"); v.dispatch({ selection: { anchor: i + 2 } }); v.focus(); });
await settle();
await page.screenshot({ path: `${out}/4-reveal-bold.png`, clip: { x: 0, y: 0, width: 1100, height: 330 } });

// 4. Typing test on an empty document.
await ov(() => { const v = window.__ov.view; v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: "" } }); v.focus(); });
await page.keyboard.type("# Typed title");
await page.keyboard.press("Enter");
await page.keyboard.type("Some **bold** and *italic* and `code` here.");
await page.keyboard.press("Enter");
await page.keyboard.type("- first item");
await page.keyboard.press("Enter");
await page.keyboard.type("second item");
await settle();
const typed = await ov(() => window.__ov.view.state.doc.toString());
console.log("typed source:", JSON.stringify(typed));
await page.screenshot({ path: `${out}/5-typed.png`, clip: { x: 0, y: 0, width: 1100, height: 420 } });

// 4. Loading and saving CRLF text preserves its line endings.
const crlf = "# A\r\n\r\nb\r\n";
await ov((text) => window.__ov.load(text), crlf);
const crlfSame = await ov((text) => window.__ov.view.state.sliceDoc() === text, crlf);
console.log("crlf round-trip identical:", crlfSame);

await browser.close();
