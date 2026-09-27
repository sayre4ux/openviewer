// Export rendering: sanitization, code highlighting, image policy, and the page's look.
// Usage: node scripts/check-export.mjs [outDir] [chromium|webkit]
import { chromium, webkit } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const out = process.argv[2] ?? "shots";
const engine = process.argv[3] ?? "chromium";
const base = process.env.OV_URL ?? "http://localhost:5173/";
mkdirSync(out, { recursive: true });
const browser = engine === "webkit" ? await webkit.launch() : await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 900, height: 1100 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };

await page.goto(base);
await page.waitForSelector(".cm-content");

const hostile = [
  "# Hostile",
  "<script>window.__pwned = 1</script>",
  '<img src="x.png" onerror="window.__pwned = 2">',
  "[click](javascript:alert(1)) and <a href=\"javascript:alert(2)\">raw</a>",
  "<iframe src=\"https://example.com\"></iframe>",
  "<style>body { display: none }</style>",
  "<form action=\"https://example.com\"><input name=q></form>",
  "![lan](http://192.168.1.2/a.png) ![loop](http://127.0.0.1/a.png) ![web](https://example.com/a.png)",
  "![local](assets/pic.png)",
  '<svg><script>window.__pwned = 3</script><circle r="4"/></svg>',
  '<div style="background-image:url(http://127.0.0.1:8080/a)">css</div> <span style="color: red">kept</span>',
  '<video poster="http://192.168.1.1/a.png" src="http://192.168.1.1/v.mp4"></video>',
  '<table background="http://127.0.0.1/a.png"><tr><td>t</td></tr></table>',
  '<svg><image href="http://127.0.0.1/a.png"/><use href="http://127.0.0.1/s.svg#x"/></svg>',
  '<img src="https://example.com/b.png" srcset="http://127.0.0.1/a.png 2x">',
  '<p style="background:image(\'http://127.0.0.1/a.png\')">i</p> <p style="background:CROSS-FADE(image(x), white)">c</p>',
  '<svg><rect fill="url(http://127.0.0.1/p.svg#g)" filter="url(http://127.0.0.1/f.svg#f)"/><linearGradient href="http://127.0.0.1/g.svg#g"/><textPath href="http://127.0.0.1/t.svg#p">t</textPath></svg>',
  '<math><mglyph src="http://127.0.0.1/m.png"/></math>',
  // One local image used many times: each use is charged, not just the first.
  ...Array.from({ length: 8 }, () => "![big](assets/big.png)"),
  // Inline data: images count against the same budget (it is already used up here).
  `![inline](data:image/png;base64,${"B".repeat(40)})`,
].join("\n\n");
const html = await page.evaluate((md) => window.__ov.renderExport(md), hostile);
const doc = await page.evaluate((h) => {
  const d = new DOMParser().parseFromString(h, "text/html");
  return {
    scripts: d.querySelectorAll("script").length,
    handlers: Array.from(d.querySelectorAll("*")).some((el) => Array.from(el.attributes).some((a) => a.name.startsWith("on"))),
    jsLinks: Array.from(d.querySelectorAll("a")).filter((a) => /javascript:/i.test(a.getAttribute("href") ?? "")).length,
    iframes: d.querySelectorAll("iframe").length,
    styles: d.querySelectorAll("body style").length,
    forms: d.querySelectorAll("form, input:not([type=checkbox])").length,
    imgs: Array.from(d.querySelectorAll("img")).map((i) => i.getAttribute("src")),
    missing: Array.from(d.querySelectorAll(".ov-missing-image")).map((s) => s.textContent),
    csp: d.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content") ?? "",
    title: d.title,
    // Every URL the page could load, from any attribute or inline style.
    loads: Array.from(d.body.querySelectorAll("*")).flatMap((el) => Array.from(el.attributes)
      .filter((a) => (/^(src|srcset|poster|background|href|xlink:href|style|data)$/i.test(a.name) || /url\s*\(|image\s*\(/i.test(a.value)) && !(el.tagName === "A" && a.name === "href"))
      .map((a) => `${el.tagName.toLowerCase()}[${a.name}]=${a.value}`)),
    keptStyle: d.querySelector('span[style*="color"]') !== null,
    bigEmbedded: Array.from(d.querySelectorAll("img")).filter((i) => i.getAttribute("src")?.startsWith("data:")).length,
  };
}, html);
check("no scripts or handlers survive", doc.scripts === 0 && !doc.handlers, JSON.stringify({ s: doc.scripts, h: doc.handlers }));
check("javascript: links removed", doc.jsLinks === 0);
check("iframes, raw styles, and forms removed", doc.iframes === 0 && doc.styles === 0 && doc.forms === 0, JSON.stringify(doc));
check("image policy: web kept, LAN and loopback dropped, local without Rust dropped",
  JSON.stringify(doc.imgs.filter((s) => !s.startsWith("data:"))) === JSON.stringify(["https://example.com/a.png", "https://example.com/b.png"]) && doc.missing.join(",") === "image,lan,loop,local,big,big,big,big,big,inline",
  JSON.stringify({ imgs: doc.imgs, missing: doc.missing }));
check("nothing else in the page can load a resource",
  doc.loads.every((l) => /^img\[src\]=(https:\/\/example\.com\/|data:image\/png)/.test(l) || l.startsWith("span[style]=color")) && doc.keptStyle,
  JSON.stringify(doc.loads));
check("the embed budget counts every use of an image", doc.bigEmbedded === 3, String(doc.bigEmbedded));
check("page CSP forbids scripts", doc.csp.startsWith("default-src 'none'") && !doc.csp.includes("script"), doc.csp);

// With remote images off (the default), none is kept and the page can't reach the network at all.
const offline = await page.evaluate(async (md) => {
  const d = new DOMParser().parseFromString(await window.__ov.renderExport(md, false, false), "text/html");
  return {
    imgs: Array.from(d.querySelectorAll("img")).map((i) => i.getAttribute("src")).filter((s) => !s.startsWith("data:")),
    missing: Array.from(d.querySelectorAll(".ov-missing-image")).map((s) => s.textContent).join(","),
    csp: d.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content") ?? "",
  };
}, hostile);
check("remote images off: none exported, CSP has no network source",
  offline.imgs.length === 0 && offline.missing.startsWith("image,lan,loop,web,") && !/https?:/.test(offline.csp) && /img-src data:;/.test(offline.csp),
  JSON.stringify(offline));
check("remote images on: CSP allows them", /img-src data: https: http:;/.test(doc.csp), doc.csp);
check("title from the first heading", doc.title === "Hostile", doc.title);

// Math: KaTeX's HTML and MathML rendered before the page sanitizer runs; KaTeX's fonts as data: URLs;
// nothing that runs or loads; the page CSP unchanged.
const mathMd = [
  "# Math $e^{i\\pi}+1=0$",
  "",
  "Inline $\\frac{a}{b}$, $\\href{javascript:alert(1)}{x}$, $\\htmlId{x}{y}$, $\\includegraphics{http://127.0.0.1/a.png}$, and bad $\\frac{1}{$.",
  "",
  "$$",
  "\\sum_{k=1}^n k = \\frac{n(n+1)}{2} \\qquad \\left( \\int_0^1 \\sqrt{x}\\,dx \\right)",
  "$$",
  "",
  "Prices $5 and $10 stay text, and so does `$x$`.",
].join("\n");
const mathHtml = await page.evaluate((md) => window.__ov.renderExport(md, true, false), mathMd);
const math = await page.evaluate((h) => {
  const d = new DOMParser().parseFromString(h, "text/html");
  const css = [...d.querySelectorAll("style")].map((s) => s.textContent).join("\n");
  return {
    scripts: d.querySelectorAll("script").length,
    handlers: [...d.querySelectorAll("*")].some((el) => [...el.attributes].some((a) => a.name.startsWith("on"))),
    katex: d.querySelectorAll(".katex").length,
    display: d.querySelectorAll(".ov-math-display .katex-display").length,
    semantics: d.querySelectorAll("semantics").length,
    annotations: [...d.querySelectorAll("annotation")].map((a) => a.textContent),
    looseTex: [...d.querySelectorAll("math")].some((m) => [...m.childNodes].some((n) => n.nodeType === 3 && n.textContent.includes("\\"))),
    errors: [...d.querySelectorAll(".ov-math-error")].map((e) => e.textContent),
    links: [...d.querySelectorAll("a, img")].map((a) => a.outerHTML),
    ids: [...d.body.querySelectorAll("[id]")].length,
    csp: d.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content") ?? "",
    title: d.title,
    faces: (css.match(/@font-face\{[^}]*font-family:"?KaTeX_/g) ?? []).length,
    dataFaces: (css.match(/src:url\(data:font\/woff2;base64,/g) ?? []).length,
    otherUrls: (css.match(/url\((?!["']?data:)[^)]*\)/g) ?? []),
    loads: [...d.body.querySelectorAll("*")].flatMap((el) => [...el.attributes]
      .filter((a) => /^(src|srcset|href|xlink:href|data)$/i.test(a.name) || /url\s*\(|image\s*\(/i.test(a.value))
      .map((a) => `${el.tagName.toLowerCase()}[${a.name}]`)),
    text: d.body.textContent,
  };
}, mathHtml);
check("math exports as KaTeX HTML and MathML, with its TeX in <annotation>",
  math.katex === 6 && math.display === 1 && math.semantics === 6 && math.annotations.includes("\\frac{a}{b}") && !math.looseTex,
  JSON.stringify({ katex: math.katex, display: math.display, semantics: math.semantics, annotations: math.annotations, looseTex: math.looseTex }));
check("math export: no scripts, handlers, links, images, ids, or loads",
  math.scripts === 0 && !math.handlers && math.links.length === 0 && math.ids === 0 && math.loads.length === 0,
  JSON.stringify({ links: math.links, ids: math.ids, loads: math.loads }));
check("a formula that fails exports as its source; prices and code stay text",
  math.errors.length === 1 && math.errors[0] === "$\\frac{1}{$" && math.text.includes("Prices $5 and $10 stay text") && math.text.includes("$x$"),
  JSON.stringify(math.errors));
check("KaTeX fonts embedded as woff2 data: URLs, CSP unchanged",
  math.faces === 20 && math.dataFaces === 20 && math.otherUrls.length === 0 &&
  math.csp === "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:" && math.title === "Math e^{i\\pi}+1=0".replace("e^{i\\pi}", "eiπ"),
  JSON.stringify({ faces: math.faces, dataFaces: math.dataFaces, otherUrls: math.otherUrls.slice(0, 3), csp: math.csp, title: math.title }));
writeFileSync(`${out}/export-math.html`, mathHtml);
{
  const mathView = await browser.newPage({ viewport: { width: 900, height: 700 }, deviceScaleFactor: 2, javaScriptEnabled: false });
  await mathView.setContent(mathHtml, { waitUntil: "load" });
  await mathView.evaluate(() => document.fonts.ready);
  const fonts = await mathView.evaluate(() => ({ main: document.fonts.check("16px KaTeX_Main"), math: document.fonts.check("italic 16px KaTeX_Math"), size: document.fonts.check("16px KaTeX_Size2") }));
  await mathView.screenshot({ path: `${out}/e3-export-math.png` });
  check("math renders with JavaScript off, in KaTeX's fonts", fonts.main && fonts.math, JSON.stringify(fonts));
  await mathView.close();
}

// A page with math and diagrams: diagrams are images with SVG data: URLs (the only thing that loads),
// a broken one is its code block, no scripts, KaTeX's fonts embedded, the CSP unchanged, and it all
// shows with JavaScript off.
const bothMd = [
  "# Both",
  "",
  "Energy $E=mc^2$.",
  "",
  "```mermaid",
  "sequenceDiagram",
  "  Alice->>Bob: $x$ Hello",
  "  Bob-->>Alice: Hi",
  "```",
  "",
  "> ```mermaid",
  "> flowchart LR",
  ">   A[Quoted] --> B",
  "> ```",
  "",
  "```mermaid",
  "flowchart LR",
  "  A -->",
  "```",
  "",
  "```js",
  "const mermaid = 1;",
  "```",
].join("\n");
const bothHtml = await page.evaluate((md) => window.__ov.renderExport(md, true, false, 50 * 1024 * 1024), bothMd);
const both = await page.evaluate((h) => {
  const d = new DOMParser().parseFromString(h, "text/html");
  return {
    scripts: d.querySelectorAll("script").length,
    iframes: d.querySelectorAll("iframe, object, embed").length,
    handlers: [...d.querySelectorAll("*")].some((el) => [...el.attributes].some((a) => a.name.startsWith("on"))),
    diagrams: [...d.querySelectorAll("p.ov-diagram img")].map((i) => (i.getAttribute("src") ?? "").slice(0, 26)),
    codeBlocks: [...d.querySelectorAll("pre code")].map((c) => c.textContent.split("\n")[0]),
    katex: d.querySelectorAll(".katex").length,
    dataFaces: ([...d.querySelectorAll("style")].map((s) => s.textContent).join("").match(/src:url\(data:font\/woff2;base64,/g) ?? []).length,
    csp: d.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content") ?? "",
    loads: [...d.body.querySelectorAll("*")].flatMap((el) => [...el.attributes]
      .filter((a) => /^(src|srcset|poster|background|href|xlink:href|style|data)$/i.test(a.name) || /url\s*\(|image\s*\(/i.test(a.value))
      .filter((a) => !(a.name === "style" && !/url\s*\(|image\s*\(/i.test(a.value))) // KaTeX's layout styles
      .map((a) => `${el.tagName.toLowerCase()}[${a.name}]=${a.value.slice(0, 26)}`)),
  };
}, bothHtml);
check("diagrams export as SVG images; a broken one as its code block",
  JSON.stringify(both.diagrams) === JSON.stringify(["data:image/svg+xml;base64,", "data:image/svg+xml;base64,"]) &&
  JSON.stringify(both.codeBlocks) === JSON.stringify(["flowchart LR", "const mermaid = 1;"]) && both.katex === 1,
  JSON.stringify({ diagrams: both.diagrams, codeBlocks: both.codeBlocks, katex: both.katex }));
check("math and diagrams: nothing runs, only SVG data: images load, fonts embedded, CSP unchanged",
  both.scripts === 0 && both.iframes === 0 && !both.handlers && both.loads.every((l) => l === "img[src]=data:image/svg+xml;base64,") && both.loads.length === 2 &&
  both.dataFaces === 20 && both.csp === "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:",
  JSON.stringify({ loads: both.loads, dataFaces: both.dataFaces, csp: both.csp }));
writeFileSync(`${out}/export-both.html`, bothHtml);
{
  const bothView = await browser.newPage({ viewport: { width: 900, height: 1100 }, deviceScaleFactor: 2, javaScriptEnabled: false });
  await bothView.setContent(bothHtml, { waitUntil: "load" });
  const shown = await bothView.evaluate(() => [...document.querySelectorAll("p.ov-diagram img")].map((i) => i.complete && i.naturalWidth > 0));
  await bothView.screenshot({ path: `${out}/e4-export-diagrams.png`, fullPage: true });
  check("diagram images show with JavaScript off", shown.length === 2 && shown.every(Boolean), JSON.stringify(shown));
  await bothView.close();
}
// Diagrams off: every Mermaid block exports as code.
const offHtml = await page.evaluate(async (md) => {
  window.__ov.setDiagrams(false);
  try {
    return await window.__ov.renderExport(md, false, false, 50 * 1024 * 1024);
  } finally {
    window.__ov.setDiagrams(true);
  }
}, bothMd);
const offDiagrams = await page.evaluate((h) => {
  const d = new DOMParser().parseFromString(h, "text/html");
  return { images: d.querySelectorAll("img").length, code: d.querySelectorAll("pre code").length };
}, offHtml);
check("with diagrams off, export keeps them as code", offDiagrams.images === 0 && offDiagrams.code === 4, JSON.stringify(offDiagrams));

// The look: the sample document with fonts, as a page and as print (Chrome only has page.pdf()).
const sample = await page.evaluate(() => window.__ov.source);
const pretty = await page.evaluate((md) => window.__ov.renderExport(md, true), sample);
const highlighted = await page.evaluate((h) => new DOMParser().parseFromString(h, "text/html").querySelectorAll("pre span.k").length, pretty);
check("code blocks are highlighted", highlighted > 0, String(highlighted));
writeFileSync(`${out}/export.html`, pretty);
const view = await browser.newPage({ viewport: { width: 900, height: 1100 }, deviceScaleFactor: 2, javaScriptEnabled: false });
await view.setContent(pretty, { waitUntil: "load" });
await view.screenshot({ path: `${out}/e1-export.png` });
const fontOk = await view.evaluate(() => document.fonts.check("16px 'PT Serif'"));
check("embedded PT Serif loads", fontOk);
if (engine === "chromium") {
  await view.emulateMedia({ media: "print" });
  await view.screenshot({ path: `${out}/e2-print.png` });
  await view.pdf({ path: `${out}/export.pdf`, format: "A4", printBackground: true, margin: { top: "0.75in", bottom: "0.75in", left: "0.75in", right: "0.75in" } });
}

console.log(`${results.filter(Boolean).length}/${results.length} passed`);
await browser.close();
process.exit(results.every(Boolean) ? 0 : 1);
