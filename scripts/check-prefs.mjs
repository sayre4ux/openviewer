// Behavior checks for Preferences → Shortcuts and custom shortcuts in the editor (browser mode,
// where shortcuts live in localStorage instead of keybindings.json).
// Usage: node scripts/check-prefs.mjs [outDir] [chromium|webkit]
import { chromium, webkit } from "playwright";
import { mkdirSync } from "node:fs";

const out = process.argv[2] ?? "shots";
const engine = process.argv[3] ?? "chromium";
const base = process.env.OV_URL ?? "http://localhost:5173/";
mkdirSync(out, { recursive: true });
const browser = engine === "webkit" ? await webkit.launch() : await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 640, height: 620 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
const settle = (ms = 150) => page.waitForTimeout(ms);

await page.goto(base + "preferences.html");
await page.evaluate(() => localStorage.clear());
await page.reload(); await page.waitForSelector(".prefs-row");
const overrides = () => page.evaluate(() => JSON.parse(localStorage.getItem("openviewer.keybindings") ?? "{}"));
const row = (label) => page.locator(".prefs-row", { has: page.locator(".prefs-label", { hasText: new RegExp(`^${label}$`) }) });
const record = async (label, keys) => { await row(label).locator(".prefs-key").click(); await settle(); await page.keyboard.press(keys); await settle(); };

check("lists every command", (await page.locator(".prefs-row").count()) === 23, String(await page.locator(".prefs-row").count()));
check("shows default keys", (await row("Save").locator("kbd").textContent()) === "⌘S", await row("Save").locator("kbd").textContent());
await page.screenshot({ path: `${out}/p1-default.png` });

await record("Bold", "Meta+Shift+B");
check("records a shortcut", JSON.stringify(await overrides()) === '{"bold":"Cmd+Shift+B"}' && (await row("Bold").locator("kbd").textContent()) === "⇧⌘B", JSON.stringify(await overrides()));
check("reset button shows for a custom key", await row("Bold").locator(".prefs-reset").isVisible());

await record("Italic", "Meta+s");
check("conflict asks first", (await row("Italic").locator(".prefs-notice").textContent())?.includes("is used by Save") && !(await overrides()).italic, await row("Italic").locator(".prefs-notice").textContent());
await page.screenshot({ path: `${out}/p2-conflict.png` });
await row("Italic").locator("button", { hasText: "Use for Italic" }).click(); await settle();
const o1 = await overrides();
check("taking a shortcut clears the other command", o1.italic === "Cmd+S" && o1.save === "", JSON.stringify(o1));

await record("Inline Code", "Meta+q");
check("reserved shortcut refused", (await row("Inline Code").locator(".prefs-notice").textContent())?.includes("reserved for Quit") && !("code" in (await overrides())));
await page.keyboard.press("Escape"); await settle();
check("escape cancels", !(await page.locator(".prefs-row.is-recording").count()));

await record("Inline Code", "k");
check("bare key refused", (await row("Inline Code").locator(".prefs-notice").textContent())?.includes("Add ⌘ or ⌃"));
await page.keyboard.press("Backspace"); await settle();
check("backspace clears to none", (await overrides()).code === "" && (await row("Inline Code").locator(".prefs-none").isVisible()));

await row("Bold").locator(".prefs-reset").click(); await settle();
check("reset one", !("bold" in (await overrides())));

await page.fill("#search", "head"); await settle();
check("search filters", (await page.locator(".prefs-row").count()) === 6, String(await page.locator(".prefs-row").count()));
await page.fill("#search", ""); await settle();

await page.click("#reset-all"); await settle();
await page.click("#reset-yes"); await settle();
check("reset all", JSON.stringify(await overrides()) === "{}");

// The editor follows custom shortcuts, in text and in table cells.
await page.evaluate(() => localStorage.setItem("openviewer.keybindings", JSON.stringify({ bold: "Cmd+Shift+B" })));
await page.setViewportSize({ width: 1100, height: 700 });
await page.goto(base); await page.waitForSelector(".cm-content"); await settle(300);
await page.evaluate(() => { const v = window.__ov.view; v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: "word\n\n| A |\n|---|\n| cell |\n" }, selection: { anchor: 0, head: 4 } }); v.focus(); });
await page.keyboard.press("Meta+b"); await settle();
const afterOld = await page.evaluate(() => window.__ov.view.state.doc.line(1).text);
check("old shortcut no longer bolds", afterOld === "word", afterOld);
await page.keyboard.press("Meta+Shift+B"); await settle();
const afterNew = await page.evaluate(() => window.__ov.view.state.doc.line(1).text);
check("new shortcut bolds", afterNew === "**word**", afterNew);
await page.locator('.cm-md-cell[data-row="1"]').click(); await page.keyboard.press("Meta+a"); await page.keyboard.press("Meta+Shift+B"); await settle();
const cellText = await page.evaluate(() => window.__ov.view.state.doc.line(5).text);
check("new shortcut bolds in a table cell", cellText === "| **cell** |", cellText);

// A change saved in Preferences reaches an open editor without reloading it.
await page.evaluate(() => {
  localStorage.setItem("openviewer.keybindings", JSON.stringify({ italic: "Cmd+Shift+I" }));
  window.dispatchEvent(new StorageEvent("storage", { key: "openviewer.keybindings" }));
});
await page.evaluate(() => { const v = window.__ov.view; v.dispatch({ changes: { from: 0, to: v.state.doc.line(1).to, insert: "plain" }, selection: { anchor: 0, head: 5 } }); v.focus(); });
await page.keyboard.press("Meta+Shift+I"); await settle();
const live = await page.evaluate(() => window.__ov.view.state.doc.line(1).text);
check("live update from Preferences", live === "*plain*", live);

console.log(`${results.filter(Boolean).length}/${results.length} passed`);
await browser.close();
process.exit(results.every(Boolean) ? 0 : 1);
