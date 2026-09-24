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
  JSON.stringify(doc.imgs.filter((s) => !s.startsWith("data:"))) === JSON.stringify(["https://example.com/a.png", "https://example.com/b.png"]) && doc.missing.join(",") === "image,lan,loop,local,big,big,big,big,big",
  JSON.stringify({ imgs: doc.imgs, missing: doc.missing }));
check("nothing else in the page can load a resource",
  doc.loads.every((l) => /^img\[src\]=(https:\/\/example\.com\/|data:image\/png)/.test(l) || l.startsWith("span[style]=color")) && doc.keptStyle,
  JSON.stringify(doc.loads));
check("the embed budget counts every use of an image", doc.bigEmbedded === 3, String(doc.bigEmbedded));
check("page CSP forbids scripts", doc.csp.startsWith("default-src 'none'") && !doc.csp.includes("script"), doc.csp);
check("title from the first heading", doc.title === "Hostile", doc.title);

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
