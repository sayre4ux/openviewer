// Editing features: find and replace, smart typing, strikethrough, heading folding, links to
// headings, zoom, and syntax that holds still during a mouse drag.
// Usage: node scripts/check-editing.mjs [outDir] [chromium|webkit]
import { chromium, webkit } from "playwright";
import { mkdirSync } from "node:fs";

const out = process.argv[2] ?? "shots";
const engine = process.argv[3] ?? "chromium";
mkdirSync(out, { recursive: true });
const browser = engine === "webkit" ? await webkit.launch() : await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1100, height: 760 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
page.setDefaultTimeout(20000);
await page.goto(process.env.OV_URL ?? "http://localhost:5173/");
await page.waitForSelector(".cm-content");
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
const settle = (ms = 120) => page.waitForTimeout(ms);
const load = (text, anchor) => page.evaluate(([t, a]) => {
  window.__ov.load(t);
  const v = window.__ov.view;
  v.dispatch({ selection: { anchor: a ?? 0 } });
  v.focus();
}, [text, anchor]);
const docText = () => page.evaluate(() => window.__ov.view.state.sliceDoc());
const run = (id) => page.evaluate((i) => window.__ov.commands[i](), id);
const mod = process.platform === "darwin" ? "Meta" : "Control";

try {
  // ---------- Find and replace ----------
  await load("alpha beta alpha\r\nALPHA gamma\r\n");
  await run("find"); await settle();
  const findField = page.locator(".ov-find-field").first();
  check("⌘F opens the find bar with the field focused, without the replace row",
    await page.isVisible(".ov-find") && await page.evaluate(() => document.activeElement?.classList.contains("ov-find-field")) &&
    !(await page.locator(".ov-find-field").nth(1).isVisible()));
  await findField.fill("alpha"); await settle();
  const counted = await page.textContent(".ov-find-count");
  await page.keyboard.press("Enter"); await settle();
  const first = await page.evaluate(() => { const s = window.__ov.view.state.selection.main; return [s.from, s.to]; });
  const counter = await page.textContent(".ov-find-count");
  check("matches are counted, case-insensitive by default, and Enter selects the next",
    counted === "3 found" && first[0] === 0 && first[1] === 5 && counter === "1 of 3", JSON.stringify({ counted, first, counter }));
  await page.click('.ov-find-toggle[title="Match case"]'); await settle();
  check("Match case narrows the matches", /of 2$|^2 found$/.test(await page.textContent(".ov-find-count")), await page.textContent(".ov-find-count"));
  await run("replace"); await settle();
  await page.locator(".ov-find-field").nth(1).fill("omega");
  await page.click('.ov-find-button[title="Replace all matches"]'); await settle();
  const replaced = await docText();
  await page.evaluate(() => window.__ov.commands.undo()); await settle();
  const undone = await docText();
  check("Replace All changes every match as one undo step and keeps CRLF",
    replaced === "omega beta omega\r\nALPHA gamma\r\n" && undone === "alpha beta alpha\r\nALPHA gamma\r\n", JSON.stringify({ replaced, undone }));
  await page.click('.ov-find-toggle[title="Regular expression"]');
  await findField.fill("(unclosed"); await settle();
  check("an invalid pattern says so", (await page.textContent(".ov-find-count")) === "Invalid pattern");
  await page.screenshot({ path: `${out}/edit-find.png` });
  await findField.focus(); await page.keyboard.press("Escape"); await settle();
  check("Esc closes the find bar and returns to the text",
    !(await page.isVisible(".ov-find")) && await page.evaluate(() => window.__ov.view.hasFocus));

  // Review fixes: replacements can't leave bare line feeds in a CRLF file; empty matches advance.
  await load("alpha beta\r\nx\r\ny\r\n");
  await run("replace"); await settle();
  const fields = page.locator(".ov-find-field");
  await page.evaluate(() => {
    for (const b of document.querySelectorAll(".ov-find-toggle")) if (b.getAttribute("aria-pressed") === "true") b.click();
  });
  await fields.nth(0).fill("alpha"); await fields.nth(1).fill("one\\ntwo");
  await page.click('.ov-find-button[title="Replace all matches"]'); await settle();
  const escaped = await docText();
  await page.click('.ov-find-toggle[title="Regular expression"]');
  await fields.nth(0).fill("x\\ny"); await fields.nth(1).fill("[$&]");
  await page.click('.ov-find-button[title="Replace all matches"]'); await settle();
  const spanning = await docText();
  check("a replacement with a line break keeps CRLF, from an escape or from $&",
    escaped === "one\r\ntwo beta\r\nx\r\ny\r\n" && spanning === "one\r\ntwo beta\r\n[x\r\ny]\r\n", JSON.stringify({ escaped, spanning }));
  await load("a\nb\nc\n");
  await run("find"); await settle();
  await fields.nth(0).fill("^"); await settle();
  const heads = [];
  for (let i = 0; i < 3; i++) {
    await fields.nth(0).press("Enter"); await settle(60);
    heads.push(await page.evaluate(() => window.__ov.view.state.selection.main.head));
  }
  check("Find Next moves on from an empty match (^)", heads[0] < heads[1] && heads[1] < heads[2], JSON.stringify(heads));
  await fields.nth(0).press("Escape");

  // Keys the editor doesn't handle (Save, New, Open…) must not be prevented: in WKWebView the page
  // sees ⌘S before the menu, and a prevented key never reaches it.
  await load("keys\n", 2);
  const prevented = await page.evaluate(() => {
    const seen = {};
    const listener = (e) => { seen[e.key.toLowerCase()] = e.defaultPrevented; };
    window.addEventListener("keydown", listener);
    window.__keysSeen = seen;
    window.__keysListener = listener;
    return true;
  });
  await page.keyboard.press(`${mod}+s`);
  await page.keyboard.press(`${mod}+b`);
  const seenKeys = await page.evaluate(() => {
    window.removeEventListener("keydown", window.__keysListener);
    return window.__keysSeen;
  });
  check("⌘S is left for the menu; ⌘B is the editor's", prevented && seenKeys.s === false && seenKeys.b === true, JSON.stringify(seenKeys));

  // ---------- Smart typing ----------
  await load("**bold**\n", 6);
  await page.keyboard.type(" "); await settle();
  const hop = await page.evaluate(() => [window.__ov.view.state.sliceDoc(), window.__ov.view.state.selection.main.head]);
  check("a space just inside a closing ** lands outside it", hop[0] === "**bold** \n" && hop[1] === 9, JSON.stringify(hop));
  await load("*a* and 2 * 3\n", 13);
  await page.keyboard.type(" "); await settle();
  check("a space elsewhere is just a space", (await docText()) === "*a* and 2 * 3 \n", JSON.stringify(await docText()));
  await load("strike me\n");
  await page.evaluate(() => window.__ov.view.dispatch({ selection: { anchor: 0, head: 6 } }));
  await page.keyboard.type("~"); await settle();
  check("~ with a selection strikes it through", (await docText()) === "~~strike~~ me\n", JSON.stringify(await docText()));
  await load("plain words\n");
  await page.evaluate(() => window.__ov.view.dispatch({ selection: { anchor: 0, head: 5 } }));
  await run("strikethrough"); await settle();
  check("Format → Strikethrough wraps the selection", (await docText()) === "~~plain~~ words\n", JSON.stringify(await docText()));
  await load("- buy milk\n", 10);
  await page.keyboard.press(`${mod}+Backspace`); await settle();
  check("⌘⌫ on a list item keeps the bullet", (await docText()) === "- \n", JSON.stringify(await docText()));
  await load("- a\n- b\n  - c\n", 6);
  await page.keyboard.press("Tab"); await settle();
  const indented = await docText();
  await page.keyboard.press("Shift+Tab"); await settle();
  const outdented = await docText();
  check("Tab nests a list item under the one above, with its children; ⇧Tab undoes it",
    indented === "- a\n  - b\n    - c\n" && outdented === "- a\n- b\n  - c\n", JSON.stringify({ indented, outdented }));
  await load("1. one\n2. two\n", 13);
  await page.keyboard.press("Tab"); await settle();
  check("Tab in a numbered list lines up with the item's text", (await docText()) === "1. one\n   2. two\n", JSON.stringify(await docText()));
  await load("- a\n  - b\n", 9);
  await page.keyboard.press("Tab"); await settle();
  check("a first child can't be nested deeper", (await docText()) === "- a\n  - b\n", JSON.stringify(await docText()));
  await load("```\n- not a list\n```\n", 16);
  await page.keyboard.press(`${mod}+Backspace`); await settle();
  check("list keys ignore list-like lines inside code", (await docText()) === "```\n\n```\n", JSON.stringify(await docText()));

  // ---------- Heading folding ----------
  const outline = "# Title\n\nintro\n\n## Alpha\n\nalpha text\n\n## Beta\n\nbeta text\n\n### Deep\n\ndeep text\n";
  await load(outline, 3);
  const chevrons = await page.locator(".cm-md-fold").count();
  await run("fold-all"); await settle();
  const foldedAll = await page.evaluate(() => ({
    placeholders: document.querySelectorAll(".cm-md-folded").length,
    text: document.querySelector(".cm-content").innerText,
  }));
  await page.screenshot({ path: `${out}/edit-folded.png` });
  await run("unfold-all"); await settle();
  const unfolded = await page.evaluate(() => document.querySelector(".cm-content").innerText);
  check("Collapse All Headings folds the level-2 sections; Expand All brings them back",
    chevrons === 4 && foldedAll.placeholders === 2 && !foldedAll.text.includes("alpha text") && foldedAll.text.includes("intro") &&
    unfolded.includes("deep text"), JSON.stringify({ chevrons, foldedAll }));
  await page.evaluate(() => {
    const v = window.__ov.view;
    v.dispatch({ selection: { anchor: v.state.doc.toString().indexOf("beta text") } });
  });
  await run("fold-section"); await settle();
  const sectionFolded = await page.evaluate(() => ({
    text: document.querySelector(".cm-content").innerText,
    caretLine: window.__ov.view.state.doc.lineAt(window.__ov.view.state.selection.main.head).text,
  }));
  check("Fold Section folds the section the caret is in and moves the caret to its heading",
    !sectionFolded.text.includes("beta text") && sectionFolded.text.includes("alpha text") && sectionFolded.caretLine === "## Beta",
    JSON.stringify(sectionFolded));
  await run("unfold-all"); await settle();
  await page.locator(".cm-line.cm-md-h2", { hasText: "Alpha" }).hover();
  await page.locator(".cm-line.cm-md-h2", { hasText: "Alpha" }).locator(".cm-md-fold").dispatchEvent("mousedown");
  await settle();
  check("clicking a heading's chevron folds its section, and the file is untouched",
    !(await page.evaluate(() => document.querySelector(".cm-content").innerText)).includes("alpha text") && (await docText()) === outline);

  // ---------- Links to headings ----------
  const slugs = await page.evaluate(() => {
    window.__ov.load("# Hello, World!\n\n## Hello, World!\n\n### Café *déjà* vu\n\nSetext\n------\n\n```\n# not a heading\n```\n");
    return window.__ov.headingSlugs().map((h) => h.slug);
  });
  check("heading ids follow GitHub's rules", JSON.stringify(slugs) === JSON.stringify(["hello-world", "hello-world-1", "café-déjà-vu", "setext"]), JSON.stringify(slugs));
  const moreSlugs = await page.evaluate(() => {
    window.__ov.load("## foo_bar\n\n## _em_ text\n\n## [a link](https://x.test) and `code`\n\n## a\\*b = c\n");
    return window.__ov.headingSlugs().map((h) => h.slug);
  });
  check("heading ids keep literal underscores and drop marks and link targets",
    JSON.stringify(moreSlugs) === JSON.stringify(["foo_bar", "em-text", "a-link-and-code", "ab--c"]), JSON.stringify(moreSlugs));
  await load("Title\n=====\n\nintro\n\nSub\n---\n\nsub text\n\n> ## Quoted\n>\n> quoted text\n", 0);
  const setextChevrons = await page.locator(".cm-md-fold").count();
  await run("fold-all"); await settle();
  const setextFolded = await page.evaluate(() => document.querySelector(".cm-content").innerText);
  await run("unfold-all"); await settle();
  check("underlined (setext) headings fold too", setextChevrons >= 2 && !setextFolded.includes("sub text") && setextFolded.includes("intro"),
    JSON.stringify({ setextChevrons, setextFolded }));
  const filler = Array.from({ length: 120 }, (_, i) => `Paragraph ${i} with some words to make the page long.`).join("\n\n");
  await load(`Jump to [the end](#the-end).\n\nsecond line\n\n${filler}\n\n## The End\n\n${filler}\n`, 30);
  await page.evaluate(() => { document.querySelector(".cm-scroller").scrollTop = 0; });
  await settle();
  await page.locator('.cm-md-link[data-href="#the-end"]').click({ modifiers: [mod] }); await settle(300);
  const jumped = await page.evaluate(() => {
    const scroller = document.querySelector(".cm-scroller");
    const v = window.__ov.view;
    const at = v.coordsAtPos(v.state.doc.toString().indexOf("## The End"));
    return { scrollTop: scroller.scrollTop, top: at ? Math.round(at.top - scroller.getBoundingClientRect().top) : null };
  });
  check("⌘-clicking a link to a heading scrolls to it", jumped.scrollTop > 1000 && jumped.top !== null && jumped.top >= 0 && jumped.top < 200, JSON.stringify(jumped));
  await load(`[go](#hidden)\n\n# Top\n\n## Section\n\n### Hidden\n\ntext\n`, 20);
  await run("fold-all"); await settle();
  await page.locator('.cm-md-link[data-href="#hidden"]').click({ modifiers: [mod] }); await settle(200);
  check("a link into a collapsed section unfolds it",
    (await page.evaluate(() => document.querySelectorAll(".cm-md-folded").length)) === 0);

  // ---------- Zoom ----------
  await run("zoom-in"); await run("zoom-in"); await settle();
  const zoomed = await page.evaluate(() => [document.documentElement.style.fontSize, localStorage.getItem("openviewer.zoom")]);
  await run("actual-size"); await settle();
  const actual = await page.evaluate(() => document.documentElement.style.fontSize);
  for (let i = 0; i < 20; i++) await run("zoom-out");
  const smallest = await page.evaluate(() => document.documentElement.style.fontSize);
  await run("actual-size");
  check("zoom steps, remembers, resets, and stops at its limits",
    zoomed[0] === "19.2px" && zoomed[1] === "1.2" && actual === "16px" && smallest === "12px", JSON.stringify({ zoomed, actual, smallest }));

  // ---------- Syntax holds still during a drag ----------
  await load("Some **bold** words here\n\nSecond paragraph\n", 30);
  const bold = page.locator(".cm-md-strong").first();
  const box = await bold.boundingBox();
  await page.mouse.move(box.x + 4, box.y + box.height / 2);
  await page.mouse.down(); await settle();
  const during = await page.evaluate(() => document.querySelector(".cm-line").textContent);
  await page.mouse.move(box.x + box.width + 30, box.y + box.height / 2, { steps: 5 }); await settle();
  const dragging = await page.evaluate(() => document.querySelector(".cm-line").textContent);
  await page.mouse.up(); await settle();
  const after = await page.evaluate(() => document.querySelector(".cm-line").textContent);
  check("during a drag the clicked line keeps its syntax hidden; it shows on release",
    during === "Some bold words here" && dragging === during && after.includes("**bold**"), JSON.stringify({ during, dragging, after }));
  // A release outside the window sends no mouseup: a move with no button held ends the freeze.
  await load("Some **bold** words here\n\nSecond paragraph\n", 30);
  const box2 = await page.locator(".cm-md-strong").first().boundingBox();
  await page.mouse.move(box2.x + 4, box2.y + box2.height / 2);
  await page.mouse.down(); await settle();
  await page.evaluate(() => window.dispatchEvent(new MouseEvent("mousemove", { buttons: 0, bubbles: true })));
  await settle();
  const released = await page.evaluate(() => document.querySelector(".cm-line").textContent);
  await page.mouse.up();
  check("a drag released outside the window doesn't stay frozen", released.includes("**bold**"), JSON.stringify(released));

  // ⌘⇧X in a table cell, and zoom following another window.
  await load("| a | b |\n|---|---|\n| cell | x |\n\n", 0);
  await page.locator('.cm-md-cell[data-row="1"]').first().click();
  await page.keyboard.press(`${mod}+a`);
  await page.keyboard.press(`${mod}+Shift+x`); await settle(300);
  await page.locator(".cm-content").click({ position: { x: 5, y: 5 } }); await settle(200);
  check("⌘⇧X strikes through inside a table cell", (await docText()).includes("~~cell~~"), JSON.stringify(await docText()));
  // What another window's zoom change delivers here: a storage event for the shared key.
  const followed = await page.evaluate(() => {
    window.dispatchEvent(new StorageEvent("storage", { key: "openviewer.zoom", newValue: "1.1" }));
    return document.documentElement.style.fontSize;
  });
  await run("actual-size");
  check("zoom follows in other windows", followed === "17.6px", followed);
} catch (error) {
  check("suite ran to the end", false, String(error));
}

console.log(`${results.filter(Boolean).length}/${results.length} passed`);
await browser.close();
process.exit(results.every(Boolean) ? 0 : 1);
