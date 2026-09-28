// Behavior checks for language switching in the editor and Settings window (browser mode).
// Usage: node scripts/check-l10n.mjs [outDir] [chromium|webkit]
import { chromium, webkit } from "playwright";
import { readFileSync } from "node:fs";

const engine = process.argv[3] ?? "chromium";
const browser = engine === "webkit" ? await webkit.launch() : await chromium.launch({ channel: "chrome" });
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const base = process.env.OV_URL ?? "http://localhost:5173/";

const locales = [
  { id: "zh-Hant", find: "尋找", image: "未載入來自 example.com 的影像", count: "4 個字", general: "一般", shortcuts: "快捷鍵", images: "影像" },
  { id: "zh-Hans", find: "查找", image: "未加载来自 example.com 的图像", count: "4 个字", general: "通用", shortcuts: "快捷键", images: "图像" },
  { id: "ja", find: "検索", image: "example.comからの画像を読み込めませんでした", count: "4文字", general: "一般", shortcuts: "ショートカット", images: "画像" },
];

const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
page.on("pageerror", (error) => console.log("PAGE ERROR:", error.message));
await page.goto(base);
await page.waitForSelector(".cm-content");
await page.evaluate(() => {
  localStorage.clear();
  window.__ov.setLanguage("en");
});
await page.evaluate(() => window.__ov.commands.find());
await page.waitForSelector(".ov-find input[placeholder]");
await page.evaluate(() => window.__ov.commands.outline());

for (const locale of locales) {
  await page.evaluate((lang) => {
    window.__ov.setLanguage(lang);
    window.__ov.load("你好世界\n");
    // Loading a document replaces the editor state, which closes the find bar; open it again.
    window.__ov.commands.find();
  }, locale.id);
  await page.waitForFunction((placeholder) => document.querySelector(".ov-find input[placeholder]")?.getAttribute("placeholder") === placeholder, locale.find);
  await page.waitForFunction((count) => document.querySelector("#status")?.textContent === count, locale.count);
  const find = await page.getAttribute(".ov-find input[placeholder]", "placeholder");
  const count = await page.textContent("#status");
  const emptyOutline = await page.textContent(".ov-outline-empty");
  check(`${locale.id} find bar`, find === locale.find, find ?? "missing");
  check(`${locale.id} word count`, count === locale.count, count ?? "missing");
  check(`${locale.id} empty outline`, Boolean(emptyOutline) && /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(emptyOutline), emptyOutline ?? "missing");

  // Not on the first line: the caret starts there, and a line with the caret shows its source.
  await page.evaluate(() => window.__ov.load("Photo:\n\n![photo](https://example.com/image.png)\n"));
  await page.waitForSelector(".cm-md-image-blocked-note");
  const imageNote = await page.textContent(".cm-md-image-blocked-note");
  check(`${locale.id} remote image placeholder`, imageNote?.includes(locale.image) === true, imageNote ?? "missing");

  const english = await page.evaluate(() => {
    const allowed = new Set(["OpenViewer", "Markdown"]);
    const found = new Set();
    const visible = (el) => {
      const style = getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden" && el.getClientRects().length > 0;
    };
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walk.nextNode()) {
      const node = walk.currentNode;
      const parent = node.parentElement;
      if (!parent || parent.closest(".cm-content") || !visible(parent)) continue;
      const text = node.textContent?.trim() ?? "";
      if (/[A-Za-z]{2,}/.test(text) && !allowed.has(text)) found.add(text);
    }
    for (const el of document.body.querySelectorAll("[title], [aria-label], [placeholder], [alt]")) {
      if (el.closest(".cm-content") || !visible(el)) continue;
      for (const name of ["title", "aria-label", "placeholder", "alt"]) {
        const value = el.getAttribute(name)?.trim() ?? "";
        if (/[A-Za-z]{2,}/.test(value) && !allowed.has(value)) found.add(`${name}=${value}`);
      }
    }
    return [...found];
  });
  check(`${locale.id} editor chrome has no English copy`, english.length === 0, english.join(" | "));
}

await page.evaluate(() => {
  window.__ov.setLanguage("en");
  window.__ov.commands.find();
});
await page.waitForFunction(() => document.querySelector(".ov-find input[placeholder]")?.getAttribute("placeholder") === "Find");
check("switching back restores English", (await page.getAttribute(".ov-find input[placeholder]", "placeholder")) === "Find");
await page.close();

const prefs = await browser.newPage({ viewport: { width: 700, height: 700 } });
prefs.on("pageerror", (error) => console.log("PREFERENCES PAGE ERROR:", error.message));
await prefs.goto(`${base}preferences.html`);
await prefs.evaluate(() => localStorage.clear());
await prefs.reload();
await prefs.waitForFunction(() => !document.querySelector("#language")?.disabled);
for (const locale of locales) {
  await prefs.selectOption("#language", locale.id);
  await prefs.waitForFunction((lang) => document.documentElement.lang === lang, locale.id);
  const tab = prefs.locator('.prefs-tab[data-pane="images"]');
  const tabText = await tab.textContent();
  check(`${locale.id} Settings tabs`, (await prefs.locator('.prefs-tab[data-pane="general"]').textContent()) === locale.general &&
    (await prefs.locator('.prefs-tab[data-pane="shortcuts"]').textContent()) === locale.shortcuts && tabText === locale.images,
  `${await prefs.locator('.prefs-tab[data-pane="general"]').textContent()} / ${await prefs.locator('.prefs-tab[data-pane="shortcuts"]').textContent()} / ${tabText}`);
  await tab.click();
  check(`${locale.id} Settings pane`, (await prefs.locator("#pane-images h1").textContent()) === locale.images);
  await prefs.locator('.prefs-tab[data-pane="general"]').click();
}
await prefs.selectOption("#language", "en");
await prefs.waitForFunction(() => document.documentElement.lang === "en");
check("Settings switching back restores English", (await prefs.locator('.prefs-tab[data-pane="images"]').textContent()) === "Images");

// The browser build's system-language resolver against the cases Rust's resolver is tested with.
const localeCases = JSON.parse(readFileSync(new URL("../src/shared/locale-cases.json", import.meta.url), "utf8"));
const resolvedLocales = await prefs.evaluate(async (cases) => {
  const { resolveSystemLanguage } = await import("/src/shared/i18n.ts");
  return cases.map(([locale]) => resolveSystemLanguage([locale]));
}, localeCases);
const mismatched = localeCases.filter(([, expected], i) => resolvedLocales[i] !== (expected ?? "en"));
check("system language resolves like the app's (shared cases)", mismatched.length === 0, JSON.stringify(mismatched));

console.log(`${results.filter(Boolean).length}/${results.length} passed`);
await browser.close();
process.exit(results.every(Boolean) ? 0 : 1);
