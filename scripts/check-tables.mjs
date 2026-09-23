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

// --- Regressions from the GPT-6 Sol review ---
const load = (t) => page.evaluate((t) => window.__ov.load(t), t);
const widgets = () => page.$$eval(".cm-md-table", (els) => els.map((t) => t.querySelectorAll("thead .cm-md-cell").length));

// A pipe inside backticks splits cells, as the parser says; a structural edit keeps it a table.
await load("| `x|y` | z |\n|---|---|---|\n| a | b | c |\n"); await settle();
check("code-span pipe counts as a cell boundary", JSON.stringify(await widgets()) === "[3]", JSON.stringify(await widgets()));
await cell(1, 2).click();
await page.locator(".cm-md-table-tools button", { hasText: "+ Row" }).dispatchEvent("mousedown"); await settle();
check("structural edit keeps table valid", JSON.stringify(await widgets()) === "[3]", JSON.stringify(await text()));


// A pipe after two backslashes is bare, so it must be escaped with a third.
await load("| A | B |\n|---|---|\n| 1 | 2 |\n"); await settle();
await cell(1, 0).click(); await page.keyboard.press(`${mod}+ArrowRight`);
await page.keyboard.type("\\\\|"); await settle();
check("pipe escape respects backslash parity", (await text()).includes("| 1\\\\\\| |"), JSON.stringify((await text()).split("\n")[2]));

// Enter while an IME is composing belongs to the input method, not table navigation.
await cell(1, 1).click();
await page.evaluate(() => document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true })));
const stillThere = await page.evaluate(() => [document.activeElement?.dataset.row, document.activeElement?.dataset.col].join(","));
check("IME Enter ignored", stillThere === "1,1", stillThere);

// Insert Table while a cell has focus goes after that table, not at the stale editor selection.
await load("Intro\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nOutro\n"); await settle();
await page.evaluate(() => { const v = window.__ov.view; v.dispatch({ selection: { anchor: 2 } }); });
await cell(1, 0).click();
await page.evaluate(() => window.__ov.commands["insert-table"]()); await settle(300);
check("insert table after focused table", (await text()) === "Intro\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n| Column 1 | Column 2 | Column 3 |\n|---|---|---|\n|  |  |  |\n\nOutro\n", JSON.stringify(await text()));

// Clicking the start of formatted text puts the caret there in the raw Markdown, not at the end.
await load("| A |\n|---|\n| **night** desk |\n"); await settle();
const box = await cell(1, 0).boundingBox();
await page.mouse.click(box.x + 2, box.y + box.height / 2); await page.keyboard.type("X"); await settle();
check("click maps into raw text", (await tableSrc()).split("\n")[2] === "| X**night** desk |", (await tableSrc()).split("\n")[2]);

// CRLF files stay CRLF through table edits and Enter.
await load("Para\r\n\r\n| A | B |\r\n|---|---|\r\n| 1 | 2 |\r\n"); await settle();
await cell(1, 1).click(); await page.keyboard.press("Tab"); await settle();
await page.evaluate(() => { const v = window.__ov.view; v.dispatch({ selection: { anchor: 4 } }); v.focus(); });
await page.keyboard.press("Enter"); await settle();
const crlf = await text();
check("CRLF preserved", !/[^\r]\n/.test(crlf) && crlf.includes("| 1 | 2 |\r\n|  |  |"), JSON.stringify(crlf));

// --- Regressions from the second review ---
// Spaces after the closing pipe are not an extra column.
await load("| A | B |  \n|---|---|\n| 1 | 2 |   \n"); await settle();
check("trailing spaces add no column", JSON.stringify(await widgets()) === "[2]", JSON.stringify(await widgets()));

// An underscore inside a word is literal text, so a click after it maps past it exactly once.
await load("| A |\n|---|\n| **a_b** z |\n"); await settle();
const ub = await cell(1, 0).boundingBox();
await page.mouse.click(ub.x + 2, ub.y + ub.height / 2); await page.keyboard.type("X"); await settle();
check("click before intraword underscore text", (await tableSrc()).split("\n")[2] === "| X**a_b** z |", (await tableSrc()).split("\n")[2]);

// Insert Table into an empty document starts on the first line.
await load(""); await settle();
await page.evaluate(() => window.__ov.view.focus());
await page.evaluate(() => window.__ov.commands["insert-table"]()); await settle(300);
check("insert table into empty document", (await text()).startsWith("| Column 1 |"), JSON.stringify(await text()));

// --- Short rows and formatting keys ---
// Typing into a cell that a short row doesn't have yet appends the missing cells.
await load("| A | B | C |\n|---|---|---|\n| 1 |\n"); await settle();
await cell(1, 2).click(); await page.keyboard.type("x"); await settle();
check("type into missing cell (piped row)", (await text()) === "| A | B | C |\n|---|---|---|\n| 1 |  | x |\n", JSON.stringify(await text()));
await load("A | B | C\n--|--|--\n1\n"); await settle();
await cell(1, 2).click(); await page.keyboard.type("x"); await settle();
check("type into missing cell (no outer pipes)", (await text()) === "A | B | C\n--|--|--\n1 |  | x\n", JSON.stringify(await text()));

// ⌘B wraps the selection, ⌘B again unwraps it, and each is one undo step.
await load("| A |\n|---|\n| word |\n"); await settle();
await cell(1, 0).click(); await page.keyboard.press(`${mod}+a`); await page.keyboard.press(`${mod}+b`); await settle();
check("cmd-b wraps selection", (await tableSrc()).split("\n")[2] === "| **word** |", (await tableSrc()).split("\n")[2]);
await page.keyboard.press(`${mod}+b`); await settle();
check("cmd-b again unwraps", (await tableSrc()).split("\n")[2] === "| word |", (await tableSrc()).split("\n")[2]);
await page.keyboard.press(`${mod}+i`); await page.keyboard.type("!"); await settle();
check("cmd-i wraps and keeps typing inside", (await tableSrc()).split("\n")[2] === "| *!* |", (await tableSrc()).split("\n")[2]);
await page.keyboard.press(`${mod}+z`); await settle();
await page.keyboard.press(`${mod}+z`); await settle();
check("format is its own undo step", (await tableSrc()).split("\n")[2] === "| word |", (await tableSrc()).split("\n")[2]);

// --- Local structural edits: only the touched lines/cells change ---
const tool = (label) => page.locator(".cm-md-table-tools button", { hasText: label }).first().dispatchEvent("mousedown");
const padded = "| Name   | Qty |\n| ------ | --: |\n| apple  | 3   |\n| pear   | 10  |\n";
const expectEdit = async (name, setup, want) => {
  await load(padded); await settle();
  await setup(); await settle();
  check(name, (await text()) === want, JSON.stringify(await text()));
};
await expectEdit("add row inserts one line", async () => { await cell(1, 0).click(); await tool("+ Row"); },
  "| Name   | Qty |\n| ------ | --: |\n| apple  | 3   |\n|  |  |\n| pear   | 10  |\n");
await expectEdit("delete middle row", async () => { await cell(1, 0).click(); await tool("− Row"); },
  "| Name   | Qty |\n| ------ | --: |\n| pear   | 10  |\n");
await expectEdit("delete last row", async () => { await cell(2, 0).click(); await tool("− Row"); },
  "| Name   | Qty |\n| ------ | --: |\n| apple  | 3   |\n");
await expectEdit("add column touches one cell per line", async () => { await cell(1, 0).click(); await tool("+ Col"); },
  "| Name   |  | Qty |\n| ------ | --- | --: |\n| apple  |  | 3   |\n| pear   |  | 10  |\n");
await expectEdit("delete column", async () => { await cell(1, 1).click(); await tool("− Col"); },
  "| Name   |\n| ------ |\n| apple  |\n| pear   |\n");
await expectEdit("align keeps delimiter width", async () => { await cell(1, 0).click(); await tool("↔"); },
  "| Name   | Qty |\n| :----: | --: |\n| apple  | 3   |\n| pear   | 10  |\n");

// Without outer pipes, a new last column is closed with a pipe so it counts as a cell.
await load("a | b\n--|--\n1 | 2\n"); await settle();
await cell(1, 1).click(); await tool("+ Col"); await settle();
check("add last column without outer pipes", (await text()) === "a | b |  |\n--|-- | --- |\n1 | 2 |  |\n" && JSON.stringify(await widgets()) === "[3]", JSON.stringify(await text()));

// Tidy lines up the columns, respecting alignment.
await load("| a | bb |\n|:-|-:|\n| long text | 1 |\n"); await settle();
await cell(1, 0).click(); await tool("Tidy"); await settle();
check("tidy pads and aligns", (await text()) === "| a         |  bb |\n|:----------|----:|\n| long text |   1 |\n", JSON.stringify(await text()));

// --- Tables inside lists and quotes ---
await load("- | a | b |\n  |---|---|\n  | 1 | 2 |\n"); await settle();
check("list table renders", JSON.stringify(await widgets()) === "[2]", JSON.stringify(await widgets()));
await cell(1, 1).click(); await page.keyboard.press(`${mod}+ArrowRight`); await page.keyboard.type("x"); await settle();
await tool("+ Row"); await settle();
check("list table edits keep indentation", (await text()) === "- | a | b |\n  |---|---|\n  | 1 | 2x |\n  |  |  |\n", JSON.stringify(await text()));
await page.screenshot({ path: `${out}/t4-list-table.png`, clip: { x: 0, y: 0, width: 1100, height: 300 } });

await load("> | A | B |\n> |---|---|\n> | 1 | 2 |\n\nAfter\n"); await settle();
check("quoted table renders", JSON.stringify(await widgets()) === "[2]", JSON.stringify(await widgets()));
await cell(1, 0).click(); await tool("+ Row"); await settle();
check("quoted table new row keeps >", (await text()) === "> | A | B |\n> |---|---|\n> | 1 | 2 |\n> |  |  |\n\nAfter\n", JSON.stringify(await text()));
await page.screenshot({ path: `${out}/t5-quote-table.png`, clip: { x: 0, y: 0, width: 1100, height: 300 } });
await cell(1, 0).click(); await tool("Delete"); await settle();
check("delete quoted table keeps the quote", (await text()) === "> \n\nAfter\n", JSON.stringify(await text()));

console.log(`${results.filter(Boolean).length}/${results.length} passed`);
await browser.close();
process.exit(results.every(Boolean) ? 0 : 1);
