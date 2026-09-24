// Serves the production build (dist/) with the app's Content-Security-Policy from tauri.conf.json
// and fails on any violation, so a CSP change can't silently blank the app.
// Usage: npm run build && node scripts/check-csp.mjs [chromium|webkit]
import { chromium, webkit } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const engine = process.argv[2] ?? "chromium";
const conf = JSON.parse(await readFile("src-tauri/tauri.conf.json", "utf8"));
// OV_CSP: try another policy (e.g. to confirm this check fails when it should).
const csp = process.env.OV_CSP ?? Object.entries(conf.app.security.csp).map(([k, v]) => `${k} ${v}`).join("; ");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".txt": "text/plain" };

const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^\/+/, "") || "index.html";
  try {
    const body = await readFile(join("dist", path));
    res.writeHead(200, { "Content-Type": types[extname(path)] ?? "application/octet-stream", "Content-Security-Policy": csp });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const base = `http://127.0.0.1:${server.address().port}/`;

const browser = engine === "webkit" ? await webkit.launch() : await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
const violations = [];
await page.exposeFunction("__cspViolation", (v) => violations.push(v));
await page.addInitScript(() => {
  document.addEventListener("securitypolicyviolation", (e) => window.__cspViolation(`${e.violatedDirective}: ${e.blockedURI}`));
});
page.on("pageerror", (e) => violations.push(`page error: ${e.message}`));

const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };

await page.goto(base);
await page.waitForSelector(".cm-content");
await page.evaluate(() => document.fonts.ready);
await page.waitForSelector(".cm-md-table");
// The html fence's language loads lazily; its highlighting proves dynamic imports pass the CSP.
await page.waitForFunction(() => document.querySelector(".cm-md-fence .ͼ1, .cm-md-fence [class*='ͼ']") !== null, null, { timeout: 5000 }).catch(() => {});
const serif = await page.evaluate(() => document.fonts.check("16px 'PT Serif'"));
const highlighted = await page.evaluate(() => document.querySelectorAll(".cm-md-fence span[class]").length);
check("editor renders under CSP", serif && highlighted > 0, `PT Serif ${serif}, highlighted spans ${highlighted}`);

await page.goto(base + "preferences.html");
await page.waitForSelector(".prefs-row");
const commandCount = JSON.parse(await readFile("src/shared/commands.json", "utf8")).length;
check("preferences render under CSP", (await page.locator(".prefs-row").count()) === commandCount);

check("no CSP violations", violations.length === 0, violations.join(" | "));
console.log(`${results.filter(Boolean).length}/${results.length} passed`);
await browser.close();
server.close();
process.exit(results.every(Boolean) ? 0 : 1);
