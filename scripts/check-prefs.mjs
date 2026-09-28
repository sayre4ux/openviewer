// Behavior checks for Settings → Shortcuts and custom shortcuts in the editor (browser mode,
// where shortcuts live in localStorage instead of keybindings.json).
// Usage: node scripts/check-prefs.mjs [outDir] [chromium|webkit]
import { chromium, webkit } from "playwright";
import { mkdirSync, readFileSync } from "node:fs";

const out = process.argv[2] ?? "shots";
const engine = process.argv[3] ?? "chromium";
const base = process.env.OV_URL ?? "http://localhost:5173/";
mkdirSync(out, { recursive: true });
const browser = engine === "webkit" ? await webkit.launch() : await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 640, height: 620 }, deviceScaleFactor: 2 });
// Settings opens on General; the shortcut rows are on the Shortcuts tab.
async function showShortcuts(p) {
  await p.waitForSelector('.prefs-tab[data-pane="shortcuts"]');
  await p.click('.prefs-tab[data-pane="shortcuts"]');
  await p.waitForSelector(".prefs-row");
}
page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
const settle = (ms = 150) => page.waitForTimeout(ms);

await page.goto(base + "preferences.html");
await page.evaluate(() => {
  localStorage.clear();
  localStorage.setItem("openviewer.settings", JSON.stringify({ language: "en" }));
});
await page.reload(); await showShortcuts(page);
const overrides = () => page.evaluate(() => JSON.parse(localStorage.getItem("openviewer.keybindings") ?? "{}"));
const row = (label) => page.locator(".prefs-row", { has: page.locator(".prefs-label", { hasText: new RegExp(`^${label}$`) }) });
const record = async (label, keys) => { await row(label).locator(".prefs-key").click(); await settle(); await page.keyboard.press(keys); await settle(); };

check("lists every command", (await page.locator(".prefs-row").count()) === JSON.parse(readFileSync("src/shared/commands.json", "utf8")).length, String(await page.locator(".prefs-row").count()));
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
// Heading 1–6, plus Collapse All Headings and Expand All Headings.
check("search filters", (await page.locator(".prefs-row").count()) === 8, String(await page.locator(".prefs-row").count()));
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

// A change saved in Settings reaches an open editor without reloading it.
await page.evaluate(() => {
  localStorage.setItem("openviewer.keybindings", JSON.stringify({ italic: "Cmd+Shift+I" }));
  window.dispatchEvent(new StorageEvent("storage", { key: "openviewer.keybindings" }));
});
await page.evaluate(() => { const v = window.__ov.view; v.dispatch({ changes: { from: 0, to: v.state.doc.line(1).to, insert: "plain" }, selection: { anchor: 0, head: 5 } }); v.focus(); });
await page.keyboard.press("Meta+Shift+I"); await settle();
const live = await page.evaluate(() => window.__ov.view.state.doc.line(1).text);
check("live update from Settings", live === "*plain*", live);

// --- Regressions from the review ---
// A freed default key goes quiet instead of reaching a hidden CodeMirror command (⌘/ = toggle comment).
await page.evaluate(() => localStorage.setItem("openviewer.keybindings", JSON.stringify({ "source-mode": "Cmd+Shift+M", undo: "Cmd+Shift+U" })));
await page.reload(); await page.waitForSelector(".cm-content"); await settle(300);
await page.evaluate(() => { window.__ov.load("line\n\n| A |\n|---|\n| cell |\n"); const v = window.__ov.view; v.dispatch({ selection: { anchor: 2 } }); v.focus(); });
await settle();
await page.keyboard.press("Meta+Slash"); await settle();
const quiet = await page.evaluate(() => window.__ov.view.state.doc.line(1).text);
check("freed key does nothing", quiet === "line" && !(await page.evaluate(() => window.__ov.modes.source)), quiet);

// Table cells follow a rebound Undo.
await page.locator('.cm-md-cell[data-row="1"]').click(); await page.keyboard.press("Meta+ArrowRight"); await page.keyboard.type("X"); await settle();
await page.keyboard.press("Meta+Shift+U"); await settle();
const undone = await page.evaluate(() => window.__ov.view.state.doc.line(5).text);
check("cell uses rebound undo", undone === "| cell |", undone);

// Heading commands do nothing while a table cell has focus.
await page.locator('.cm-md-cell[data-row="1"]').click();
await page.evaluate(() => window.__ov.commands["heading-1"]()); await settle();
const unchanged = await page.evaluate(() => window.__ov.view.state.sliceDoc());
check("heading ignored in a cell", unchanged === "line\n\n| A |\n|---|\n| cell |\n", JSON.stringify(unchanged));

// Settings: duplicates in saved settings are resolved, and broken settings are reported.
await page.setViewportSize({ width: 640, height: 620 });
await page.evaluate(() => localStorage.setItem("openviewer.keybindings", JSON.stringify({ bold: "Cmd+K", italic: "Cmd+K" })));
await page.goto(base + "preferences.html"); await showShortcuts(page); await settle();
check("duplicate override dropped", (await row("Italic").locator("kbd").textContent()) === "⌘I" && (await row("Bold").locator("kbd").textContent()) === "⌘K");
await page.evaluate(() => localStorage.setItem("openviewer.keybindings", "{ bad json,"));
await page.reload(); await showShortcuts(page); await settle();
check("broken settings reported", await page.isVisible("#problems") && (await page.textContent("#problems")).includes("valid JSON"));
await page.screenshot({ path: `${out}/p3-problems.png` });

// Modifier order doesn't hide a duplicate.
await page.evaluate(() => localStorage.setItem("openviewer.keybindings", JSON.stringify({ bold: "Shift+Cmd+K", italic: "Cmd+Shift+K" })));
await page.reload(); await showShortcuts(page); await settle();
check("modifier order normalized", (await row("Bold").locator("kbd").textContent()) === "⇧⌘K" && (await row("Italic").locator("kbd").textContent()) === "⌘I");

// Settings → Images: the folder choice is kept, and only one pane shows at a time.
await page.evaluate(() => localStorage.removeItem("openviewer.settings"));
await page.reload(); await showShortcuts(page); await settle();
await page.click('.prefs-tab[data-pane="images"]'); await settle();
check("images tab shows its pane", await page.isVisible("#pane-images") && !(await page.isVisible("#pane-shortcuts")));
check("images default to ./assets", await page.isChecked('input[name="image-folder"][value="assets"]'));
await page.click('input[name="image-folder"][value="{name}.assets"]'); await settle();
await page.screenshot({ path: `${out}/p4-images.png` });
await page.reload(); await showShortcuts(page); await settle();
check("image folder choice kept", await page.isChecked('input[name="image-folder"][value="{name}.assets"]'),
  await page.evaluate(() => localStorage.getItem("openviewer.settings")));

// Images from the internet: off by default, and turning them on keeps the folder choice.
await page.click('.prefs-tab[data-pane="images"]'); await settle();
check("remote images default off", !(await page.isChecked("#remote-images")));
check("remote images warning explains the risk",
  /IP address/.test(await page.textContent("#pane-images")) && /read receipt/.test(await page.textContent("#pane-images")));
await page.click("#remote-images"); await settle();
await page.screenshot({ path: `${out}/p5-remote-images.png`, fullPage: true });
await page.reload(); await showShortcuts(page); await settle();
const savedSettings = await page.evaluate(() => JSON.parse(localStorage.getItem("openviewer.settings") ?? "{}"));
check("remote images choice kept with the folder", savedSettings.remoteImages === true && savedSettings.imageFolder === "{name}.assets",
  JSON.stringify(savedSettings));

// Diagrams: on by default, and turning them off keeps the other choices.
await page.click('.prefs-tab[data-pane="images"]'); await settle();
check("diagrams default on", await page.isChecked("#diagrams"));
await page.click("#diagrams"); await settle();
await page.reload(); await showShortcuts(page); await settle();
await page.click('.prefs-tab[data-pane="images"]'); await settle();
const diagramSettings = await page.evaluate(() => JSON.parse(localStorage.getItem("openviewer.settings") ?? "{}"));
check("diagrams choice kept with the others",
  diagramSettings.diagrams === false && diagramSettings.remoteImages === true && diagramSettings.imageFolder === "{name}.assets" && !(await page.isChecked("#diagrams")),
  JSON.stringify(diagramSettings));
await page.screenshot({ path: `${out}/p6-diagrams.png`, fullPage: true });

// An unreadable settings.json turned diagrams off: Settings says so, until a save writes a good file.
check("no unreadable note normally", !(await page.isVisible("#settings-unreadable")));
await page.evaluate(() => localStorage.setItem("openviewer.settings", JSON.stringify({ diagrams: false, unreadable: true, language: "en" })));
await page.reload(); await showShortcuts(page); await settle();
await page.click('.prefs-tab[data-pane="images"]'); await settle();
const noteShown = await page.isVisible("#settings-unreadable");
const noteText = await page.textContent("#settings-unreadable");
await page.locator("#settings-unreadable").locator("xpath=..").screenshot({ path: `${out}/p6b-unreadable.png` });
await page.click("#diagrams"); await settle();
check("an unreadable settings file is explained next to the diagrams switch, and a save clears it",
  noteShown && noteText.includes("couldn’t be read") && !(await page.isVisible("#settings-unreadable")) && await page.isChecked("#diagrams"),
  JSON.stringify({ noteShown, noteText }));

// Undo rebound onto a key cells use for navigation still undoes in a cell.
await page.evaluate(() => localStorage.setItem("openviewer.keybindings", JSON.stringify({ undo: "Cmd+Left" })));
await page.setViewportSize({ width: 1100, height: 700 });
await page.goto(base); await page.waitForSelector(".cm-content"); await settle(300);
await page.evaluate(() => { window.__ov.load("| A |\n|---|\n| cell |\n"); window.__ov.view.focus(); }); await settle();
await page.locator('.cm-md-cell[data-row="1"]').click(); await page.keyboard.press("End"); await page.keyboard.type("X"); await settle();
await page.keyboard.press("Meta+ArrowLeft"); await settle();
const undoneLeft = await page.evaluate(() => window.__ov.view.state.doc.line(3).text);
check("rebound undo beats cell navigation", undoneLeft === "| cell |", undoneLeft);

// Settings → Images stays disabled until the saved settings arrive, and stays disabled if reading them
// fails: any write sends the whole object, so an early click would put the defaults over them.
for (const hook of [{ delay: 600 }, { fail: true }]) {
  const p = await browser.newPage({ viewport: { width: 640, height: 620 } });
  await p.addInitScript((h) => {
    localStorage.setItem("openviewer.settings", JSON.stringify({ imageFolder: ".", remoteImages: true, language: "en" }));
    window.__settingsLoad = h;
  }, hook);
  await p.goto(base + "preferences.html");
  await p.click('.prefs-tab[data-pane="images"]');
  const early = await p.evaluate(() => ({
    remote: document.getElementById("remote-images").disabled,
    diagrams: document.getElementById("diagrams").disabled,
    folder: document.querySelector('input[name="image-folder"][value="assets"]').disabled,
  }));
  await p.waitForTimeout(900);
  const later = await p.evaluate(() => ({
    remote: document.getElementById("remote-images").disabled,
    diagrams: document.getElementById("diagrams").disabled,
    checked: document.getElementById("remote-images").checked,
    folder: document.querySelector('input[name="image-folder"]:checked')?.value ?? null,
  }));
  if (hook.delay) {
    check("settings controls wait for the saved settings",
      early.remote && early.diagrams && early.folder && !later.remote && !later.diagrams && later.checked && later.folder === ".", JSON.stringify({ early, later }));
  } else {
    check("settings controls stay disabled when reading them fails",
      early.remote && later.remote && later.diagrams, JSON.stringify({ early, later }));
  }
  await p.close();
}

console.log(`${results.filter(Boolean).length}/${results.length} passed`);
await browser.close();
process.exit(results.every(Boolean) ? 0 : 1);
