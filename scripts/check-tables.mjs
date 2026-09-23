// Behavior checks for editable tables, against `vite` in browser mode.
// Usage: node scripts/check-tables.mjs [outDir] [chromium|webkit]
import { chromium, webkit } from "playwright";
import { mkdirSync } from "node:fs";

const out = process.argv[2] ?? "shots";
const engine = process.argv[3] ?? "chromium";
mkdirSync(out, { recursive: true });
const browser = engine === "webkit" ? await webkit.launch() : await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1100, height: 760 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
await page.goto(process.env.OV_URL ?? "http://localhost:5173/");
await page.waitForSelector(".cm-md-table");
const mod = engine === "webkit" || process.platform === "darwin" ? "Meta" : "Control";
const text = () => page.evaluate(() => window.__ov.view.state.sliceDoc());
const tableSrc = async () => (await text()).split("\n").filter((l) => l.startsWith("|")).join("\n");
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
const settle = () => page.waitForTimeout(150);
const cell = (r, c) => page.locator(`.cm-md-cell[data-row="${r}"][data-col="${c}"]`);

const before = await text();

// 1. Typing in a cell changes only that cell's bytes.
await cell(2, 0).click(); await page.keyboard.press(`${mod}+ArrowRight`); await page.keyboard.type(" team"); await settle();
const after = await text();
check("typing edits one cell", after === before.replace("| Sports |", "| Sports team |"), JSON.stringify((await tableSrc()).split("\n")[3]));
await page.screenshot({ path: `${out}/t1-typing.png`, clip: { x: 0, y: 0, width: 1100, height: 520 } });

// 2. Undo inside a cell restores the document.
await page.keyboard.press(`${mod}+z`); await settle();
check("undo inside cell", (await text()) === before);

// 3. A typed pipe is stored escaped and does not split the cell.
await cell(1, 2).click(); await page.keyboard.press(`${mod}+ArrowRight`); await page.keyboard.type("|x"); await settle();
check("pipe escaped", (await text()).includes("| 18:00\\|x |"), (await tableSrc()).split("\n")[2]);
await page.keyboard.press(`${mod}+z`); await settle();
await page.keyboard.press(`${mod}+z`); await settle();
check("undo pipe edit", (await text()) === before, (await tableSrc()).split("\n")[2]);

// 4. Tab moves to the next cell; Tab in the last cell adds a row.
await cell(3, 1).click(); await page.keyboard.press("Tab"); await settle();
const focusAfterTab = await page.evaluate(() => [document.activeElement?.dataset.row, document.activeElement?.dataset.col].join(","));
check("tab moves right", focusAfterTab === "3,2", focusAfterTab);
await page.keyboard.press("Tab"); await settle();
const rowsAfter = (await tableSrc()).split("\n").length;
const focusNewRow = await page.evaluate(() => [document.activeElement?.dataset.row, document.activeElement?.dataset.col].join(","));
check("tab at end adds row", rowsAfter === 6 && focusNewRow === "4,0", `${rowsAfter} lines, focus ${focusNewRow}`);
await page.keyboard.type("Obituaries"); await settle();
check("type in new row", (await tableSrc()).includes("| Obituaries |  |  |"), (await tableSrc()).split("\n").at(-1));

// 5. Toolbar: add a column to the right of the focused cell.
await page.locator(".cm-md-table-tools button", { hasText: "+ Col" }).dispatchEvent("mousedown"); await settle();
const header = (await tableSrc()).split("\n")[0];
check("toolbar adds column", header === "| Desk |  | Owner | Due |", header);
await page.screenshot({ path: `${out}/t2-structural.png`, clip: { x: 0, y: 0, width: 1100, height: 520 } });

// 6. Escape leaves the table; ArrowDown from the line above enters the first cell.
await page.keyboard.press("Escape"); await settle();
const inEditor = await page.evaluate(() => document.activeElement === window.__ov.view.contentDOM);
check("escape returns to editor", inEditor);
await page.evaluate(() => { const v = window.__ov.view; const i = v.state.doc.toString().indexOf("2. Send plates"); v.dispatch({ selection: { anchor: i } }); v.focus(); });
await page.keyboard.press("ArrowDown"); await page.keyboard.press("ArrowDown"); await settle();
const entered = await page.evaluate(() => [document.activeElement?.dataset.row, document.activeElement?.dataset.col].join(","));
check("arrow down enters table", entered === "0,0", entered);

// 7. Insert Table (⌥⌘T) on an empty document.
await page.evaluate(() => { const v = window.__ov.view; v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: "Intro\n" }, selection: { anchor: 0 } }); v.focus(); });
await page.keyboard.press(`${mod}+Alt+t`); await page.waitForTimeout(300);
const inserted = await text();
const firstFocus = await page.evaluate(() => document.activeElement?.classList.contains("cm-md-cell") ? `${document.activeElement.dataset.row},${document.activeElement.dataset.col}` : "none");
check("insert table", inserted.startsWith("Intro\n\n| Column 1 | Column 2 | Column 3 |\n|---|---|---|\n|  |  |  |") && firstFocus === "0,0", `${JSON.stringify(inserted)} focus ${firstFocus}`);
await page.screenshot({ path: `${out}/t3-inserted.png`, clip: { x: 0, y: 0, width: 1100, height: 360 } });

console.log(`${results.filter(Boolean).length}/${results.length} passed`);
await browser.close();
process.exit(results.every(Boolean) ? 0 : 1);
