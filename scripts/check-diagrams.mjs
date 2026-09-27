// Mermaid diagrams: the sandboxed frame, the seven common diagram types as images, hostile diagrams
// (no request, no script, no style reaching the editor), forged replies, the hang guard, the setting,
// the caps, and the file staying byte for byte.
// Usage: node scripts/check-diagrams.mjs [outDir] [chromium|webkit]
import { chromium, webkit } from "playwright";
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";

const out = process.argv[2] ?? "shots";
const engine = process.argv[3] ?? "chromium";
const base = process.env.OV_URL ?? "http://localhost:5173/";
mkdirSync(out, { recursive: true });

// Anything that reaches this server is a leak.
const trapped = [];
const trap = createServer((req, res) => { trapped.push(req.url); res.writeHead(200, { "Content-Type": "text/css" }).end("body{}"); });
await new Promise((ok) => trap.listen(0, "127.0.0.1", ok));
const trapUrl = `http://127.0.0.1:${trap.address().port}`;

const browser = engine === "webkit" ? await webkit.launch() : await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1000, height: 1100 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
page.setDefaultTimeout(30000);
// Requests for anything but our own origin. From the editor's document, any attempt fails the check.
// Inside the diagram frame an attempt is expected (a hostile diagram's CSS asks for one) and must be
// blocked there, by the frame's CSP: one that completes fails the check.
const foreign = [];
const blockedInFrame = [];
const isForeign = (r) => !r.url().startsWith(base) && !r.url().startsWith("data:");
page.on("request", (r) => { if (isForeign(r) && r.frame() === page.mainFrame()) foreign.push(r.url()); });
page.on("requestfinished", (r) => { if (isForeign(r) && r.frame() !== page.mainFrame()) foreign.push(`completed in frame: ${r.url()}`); });
page.on("requestfailed", (r) => { if (isForeign(r) && r.frame() !== page.mainFrame()) blockedInFrame.push(`${r.url()} (${r.failure()?.errorText})`); });
await page.goto(base);
await page.waitForSelector(".cm-content");
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };

// Loads a document with the caret on its (blank) last line and waits for diagrams to settle.
const load = async (text) => {
  await page.evaluate((text) => {
    window.__ov.load(text);
    const v = window.__ov.view;
    v.dispatch({ selection: { anchor: v.state.doc.length } });
  }, text);
  await page.waitForFunction(() => document.querySelectorAll(".cm-md-diagram-pending").length === 0, null, { timeout: 20000 }).catch(() => {});
};
const decode = (url) => Buffer.from(url.replace(/^data:image\/svg\+xml;base64,/, ""), "base64").toString("utf8");
const images = () => page.evaluate(() => [...document.querySelectorAll(".cm-md-diagram-image")].map((i) => i.getAttribute("src")));
const notes = () => page.evaluate(() => [...document.querySelectorAll(".cm-md-diagram .cm-md-render-note")].map((n) => n.textContent));

try {
  // The seven common diagram types each become an <img> with an SVG data: URL. Refused types would be
  // listed here, not hidden.
  const fixtures = {
    flowchart: "flowchart LR\n  A[Start] --> B{Choice}\n  B -->|yes| C[Done]\n  B -->|no| A",
    sequence: "sequenceDiagram\n  Alice->>Bob: Hello\n  Bob-->>Alice: Hi back",
    class: "classDiagram\n  Animal <|-- Duck\n  Animal : +int age\n  Duck : +swim()",
    state: "stateDiagram-v2\n  [*] --> Still\n  Still --> Moving\n  Moving --> [*]",
    er: "erDiagram\n  CUSTOMER ||--o{ ORDER : places\n  ORDER ||--|{ LINE-ITEM : contains",
    gantt: "gantt\n  title Plan\n  dateFormat YYYY-MM-DD\n  section A\n  Task one :a1, 2026-01-01, 3d\n  Task two :after a1, 2d",
    pie: "pie title Pets\n  \"Dogs\" : 40\n  \"Cats\" : 35\n  \"Fish\" : 25",
  };
  const refused = [];
  const kinds = {};
  let frame = null;
  for (const [name, source] of Object.entries(fixtures)) {
    await load(`# ${name}\n\n\`\`\`mermaid\n${source}\n\`\`\`\n\n`);
    frame ??= await page.evaluate(() => {
      const el = document.querySelector("iframe");
      return el && { sandbox: el.getAttribute("sandbox"), src: el.getAttribute("src"), hidden: getComputedStyle(el).visibility, display: getComputedStyle(el).display, aria: el.getAttribute("aria-hidden") };
    });
    const srcs = await images();
    if (srcs.length === 1 && srcs[0].startsWith("data:image/svg+xml;base64,")) kinds[name] = decode(srcs[0]).length;
    else refused.push(`${name}: ${(await notes()).join(" ")}`);
  }
  check("the frame is sandboxed with exactly allow-scripts, hidden but laid out",
    frame?.sandbox === "allow-scripts" && frame.src === "/diagram/frame.html" && frame.hidden === "hidden" && frame.display !== "none" && frame.aria === "true",
    JSON.stringify(frame));
  check("flowchart, sequence, class, state, ER, gantt, and pie render as images", refused.length === 0 && Object.keys(kinds).length === 7,
    JSON.stringify({ rendered: Object.keys(kinds), refused }));
  await load(Object.entries(fixtures).slice(0, 3).map(([n, s]) => `## ${n}\n\n\`\`\`mermaid\n${s}\n\`\`\`\n`).join("\n") + "\n");
  await page.screenshot({ path: `${out}/diagrams.png` });

  // Hostile diagrams: callbacks, links, HTML in labels, CSS aimed at the editor, and resources.
  const marker = await page.evaluate(() => {
    const el = document.createElement("div");
    el.id = "ov-style-marker";
    el.className = "cm-content node label";
    el.textContent = "marker";
    document.body.appendChild(el);
    const s = (e) => { const c = getComputedStyle(e); return `${c.display}|${c.color}|${c.backgroundColor}|${c.fontSize}|${c.visibility}`; };
    return { marker: s(el), editor: s(document.querySelector(".cm-content")), body: s(document.body) };
  });
  const hostile = [
    "flowchart LR\n  A[Click me] --> B\n  click A call alert()",
    "flowchart LR\n  A[Link] --> B\n  click A href \"javascript:window.parent.__pwned=1\"",
    "flowchart LR\n  A[\"<img src=x onerror=window.parent.__pwned=2>\"] --> B[\"<script>window.parent.__pwned=3</script>\"]",
    `%%{init:{"themeCSS":"@import url(${trapUrl}/import.css); body, .cm-content, .node, .label { display:none !important; background:red !important }"}}%%\nflowchart LR\n  A --> B`,
    `%%{init:{"fontFamily":"x; background:url(${trapUrl}/font.png)", "themeVariables": {"primaryColor": "url(${trapUrl}/tv.png)"}}}%%\nflowchart LR\n  A --> B`,
    `flowchart LR\n  A --> B\n  classDef evil fill:url(${trapUrl}/fill.png),stroke:#f00\n  class A evil\n  style B fill:url(${trapUrl}/style.png)`,
    "flowchart LR\n  A[\"</style><style>*{display:none}</style>\"] --> B",
    `%%{init:{"securityLevel":"loose","htmlLabels":true,"flowchart":{"htmlLabels":true},"dompurifyConfig":{"ADD_TAGS":["script"]}}}%%\nflowchart LR\n  A["<b>bold</b>"] --> B`,
  ];
  const outcomes = [];
  for (const source of hostile) {
    await load(`\`\`\`mermaid\n${source}\n\`\`\`\n\n`);
    const srcs = await images();
    const svg = srcs[0] ? decode(srcs[0]) : "";
    const bad = ["<script", "onerror", "onclick", "javascript:", "foreignObject", "<a ", "href", trapUrl, "@import", "<img"].filter((s) => svg.includes(s));
    outcomes.push({ image: srcs.length === 1, bad, note: (await notes()).join(" ").slice(0, 80) });
  }
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => {
    const s = (e) => { const c = getComputedStyle(e); return `${c.display}|${c.color}|${c.backgroundColor}|${c.fontSize}|${c.visibility}`; };
    return { marker: s(document.getElementById("ov-style-marker")), editor: s(document.querySelector(".cm-content")), body: s(document.body), pwned: window.__pwned ?? null };
  });
  check("hostile diagrams: each an image without scripts, handlers, links, or loads, or refused",
    outcomes.every((o) => (o.image && o.bad.length === 0) || (!o.image && o.note)), JSON.stringify(outcomes));
  check("no hostile diagram reached the network (the frame's CSP stops its attempts)", trapped.length === 0 && foreign.length === 0,
    JSON.stringify({ trapped, foreign, blockedInFrame }));
  check("no hostile diagram ran script or restyled the editor",
    after.pwned === null && after.marker === marker.marker && after.editor === marker.editor && after.body === marker.body, JSON.stringify({ marker, after }));

  // Forged replies: wrong id, wrong shape, or from another window, are ignored.
  const shapes = await page.evaluate(() => {
    const c = window.__ov.diagram.checkReply;
    const good = { v: 1, id: 7, ok: true, svg: "<svg/>" };
    return {
      good: c(good, 7) !== null,
      goodError: c({ v: 1, id: 7, ok: false, kind: "syntax", message: "m" }, 7) !== null,
      wrongId: c(good, 8),
      extraKey: c({ ...good, html: "<b>" }, 7),
      missingKey: c({ v: 1, id: 7, ok: true }, 7),
      wrongVersion: c({ ...good, v: 2 }, 7),
      wrongKind: c({ v: 1, id: 7, ok: false, kind: "fatal", message: "m" }, 7),
      svgNotString: c({ ...good, svg: { toString: () => "<svg/>" } }, 7),
      okNotBoolean: c({ ...good, ok: "true" }, 7),
      array: c([good], 7),
      nothing: c(null, 7),
    };
  });
  check("replies of the wrong shape or for another job are ignored",
    shapes.good && shapes.goodError && Object.entries(shapes).filter(([k]) => !k.startsWith("good")).every(([, v]) => v === null), JSON.stringify(shapes));
  const forged = await page.evaluate(async () => {
    window.__ov.load("x\n");
    const big = `flowchart TD\n${Array.from({ length: 150 }, (_, i) => `  n${i}[Node ${i}] --> n${i + 1}[Node ${i + 1}]`).join("\n")}`;
    const pending = window.__ov.diagram.render(big);
    const started = performance.now();
    while (window.__ov.diagram.state().inflight === null && performance.now() - started < 10000) await new Promise((r) => setTimeout(r, 1));
    const id = window.__ov.diagram.state().inflight;
    const fake = { v: 1, id, ok: true, svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><desc>FORGED</desc><rect width="10" height="10"/></svg>' };
    window.postMessage(fake, "*");
    const other = document.createElement("iframe");
    other.setAttribute("sandbox", "allow-scripts");
    other.srcdoc = `<script>parent.postMessage(${JSON.stringify(fake)}, "*")<\/script>`;
    document.body.appendChild(other);
    const result = await pending;
    other.remove();
    return { id, ok: result.ok, forged: result.ok && atob(result.dataUrl.split(",")[1]).includes("FORGED"), width: result.width };
  });
  check("a reply from another window is ignored", forged.id !== null && forged.ok && !forged.forged && forged.width > 100, JSON.stringify(forged));

  // The hang guard: a diagram still pending when the app starts is blocked, with "Render anyway".
  const guarded = "flowchart LR\n  G1[Guarded] --> G2[Diagram]";
  const hash = await page.evaluate((s) => window.__ov.diagram.hash(s), guarded);
  await page.evaluate((h) => localStorage.setItem("openviewer.diagram.pending", JSON.stringify([h])), hash);
  await page.reload();
  await page.waitForSelector(".cm-content");
  const lists = await page.evaluate(() => ({ pending: localStorage.getItem("openviewer.diagram.pending"), blocked: localStorage.getItem("openviewer.diagram.blocked") }));
  await load(`Before\n\n\`\`\`mermaid\n${guarded}\n\`\`\`\n\n`);
  const blocked = { notes: await notes(), button: await page.locator(".cm-md-render-anyway").count(), images: (await images()).length };
  await page.screenshot({ path: `${out}/diagram-blocked.png` });
  await page.locator(".cm-md-render-anyway").click();
  await page.waitForSelector(".cm-md-diagram-image");
  const unblocked = await page.evaluate(() => ({ images: document.querySelectorAll(".cm-md-diagram-image").length, blocked: localStorage.getItem("openviewer.diagram.blocked") }));
  check("a diagram pending at startup is blocked until \"Render anyway\"",
    lists.pending === null && JSON.parse(lists.blocked ?? "[]").includes(hash) &&
    blocked.notes[0] === "This diagram stopped OpenViewer last time" && blocked.button === 1 && blocked.images === 0 &&
    unblocked.images === 1 && !JSON.parse(unblocked.blocked ?? "[]").includes(hash),
    JSON.stringify({ lists, blocked, unblocked }));

  // The setting: off, a Mermaid block is an ordinary code block, and nothing renders.
  await page.evaluate(() => window.__ov.setDiagrams(false));
  await load("```mermaid\nflowchart LR\n  Off --> Code\n```\n\n");
  const off = await page.evaluate(async () => ({
    diagrams: document.querySelectorAll(".cm-md-diagram").length,
    fence: document.querySelectorAll(".cm-md-fence").length,
    frames: document.querySelectorAll("iframe").length,
    render: (await window.__ov.diagram.render("flowchart LR\n  X --> Y")).reason,
  }));
  await page.evaluate(() => window.__ov.setDiagrams(true));
  await page.waitForSelector(".cm-md-diagram-image");
  check("with diagrams off, a Mermaid block is a code block", off.diagrams === 0 && off.fence >= 3 && off.frames === 0 && off.render === "off", JSON.stringify(off));

  // Click shows the source; the file stays byte for byte (CRLF) through render, reveal, and failure.
  const crlf = "# Doc\r\n\r\n> ```mermaid\r\n> flowchart LR\r\n>   Q[In a quote] --> R\r\n> ```\r\n\r\n```Mermaid\r\nflowchart LR\r\n  A --> B --> C\r\n```\r\n\r\n```mermaid\r\nflowchart LR\r\n  A -->\r\n```\r\n\r\nend\r\n";
  await load(crlf);
  const crlfState = { images: (await images()).length, notes: await notes(), same: await page.evaluate((t) => window.__ov.view.state.sliceDoc() === t, crlf) };
  await page.locator(".cm-md-diagram-image").nth(1).click();
  const revealed = await page.evaluate((t) => ({
    same: window.__ov.view.state.sliceDoc() === t && !window.__ov.isDirty(),
    images: document.querySelectorAll(".cm-md-diagram-image").length,
    fenceLines: document.querySelectorAll(".cm-md-fence").length,
    caretLine: window.__ov.view.state.doc.lineAt(window.__ov.view.state.selection.main.head).number,
  }), crlf);
  check("CRLF file unchanged through render, reveal, and failure; a click shows the source",
    crlfState.images === 2 && crlfState.notes.length === 1 && crlfState.same && revealed.same && revealed.images === 1 && revealed.fenceLines >= 4 && revealed.caretLine === 9,
    JSON.stringify({ crlfState, revealed }));

  // Caps: source length, output size, and diagrams per document.
  const caps = await page.evaluate(async () => {
    const long = await window.__ov.diagram.render(`flowchart LR\n  A --> B\n%%${"x".repeat(20000)}`);
    const huge = await window.__ov.diagram.sanitize(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><desc>${"x".repeat(1024 * 1024)}</desc></svg>`);
    const wide = await window.__ov.diagram.sanitize('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20000 10"><rect width="1" height="1"/></svg>');
    const one = "```mermaid\nflowchart LR\n  A --> B\n```\n\n";
    window.__ov.load(one.repeat(101));
    window.__ov.forceParsing();
    const v = window.__ov.view;
    v.dispatch({ selection: { anchor: v.state.doc.length } });
    return { long: long.reason, huge: huge.reason, wide: wide.reason, blocks: window.__ov.diagram.blocks() };
  });
  check("caps: long source, large output, oversized image, and 100 diagrams per document",
    caps.long === "too-long" && caps.huge === "too-large" && caps.wide === "unsafe-output" && caps.blocks.diagrams === 100 && caps.blocks.shown === 100,
    JSON.stringify(caps));

  // A syntax error shows the code and Mermaid's message, as text.
  await load("```mermaid\nflowchart LR\n  A[<b>bad --> \n```\n\n");
  const syntax = await page.evaluate(() => {
    const failed = document.querySelector(".cm-md-diagram .cm-md-render-failed");
    return { text: failed?.querySelector(".cm-md-render-source")?.textContent ?? "", elements: failed ? failed.querySelectorAll("b, img, script").length : -1 };
  });
  check("a broken diagram shows its source as text", syntax.text.includes("A[<b>bad") && syntax.elements === 0, JSON.stringify(syntax));

  // Keyboard: arrows step onto a rendered formula or diagram (showing its source) rather than over it,
  // and Backspace just below one shows it instead of joining a line to its closing fence.
  const nav = "Above\n$$\n\\frac{a}{b}\n$$\nMiddle\n\n```mermaid\nflowchart LR\n  K --> L\n```\nBelow\n";
  await page.evaluate(async (t) => { window.__ov.load(t); await window.__ov.math("x"); }, nav);
  await page.evaluate(() => { const v = window.__ov.view; v.focus(); v.dispatch({ selection: { anchor: v.state.doc.length } }); });
  await page.waitForSelector(".cm-md-diagram-image");
  const at = () => page.evaluate(() => {
    const v = window.__ov.view;
    return [v.state.doc.lineAt(v.state.selection.main.head).number, document.querySelectorAll(".cm-md-math-block").length, document.querySelectorAll(".cm-md-diagram").length].join(":");
  });
  await page.evaluate(() => window.__ov.view.dispatch({ selection: { anchor: 5 } }));
  const steps = [];
  for (const key of ["ArrowDown", "ArrowDown", "ArrowDown", "ArrowDown", "ArrowDown", "ArrowDown", "ArrowUp"]) {
    await page.keyboard.press(key);
    steps.push(await at());
  }
  await page.evaluate(() => { const v = window.__ov.view; v.dispatch({ selection: { anchor: v.state.doc.line(5).from } }); });
  await page.keyboard.press("Backspace");
  const back = { at: await at(), same: await page.evaluate((t) => window.__ov.view.state.sliceDoc() === t, nav) };
  check("arrow keys step into rendered blocks; Backspace below one shows it",
    steps.join(" ") === "2:0:1 3:0:1 4:0:1 5:1:1 6:1:1 7:1:0 6:1:1" && back.at === "4:0:1" && back.same,
    JSON.stringify({ steps, back }));

  check("diagrams load nothing from another origin", foreign.length === 0 && trapped.length === 0, JSON.stringify({ foreign, trapped }));
} finally {
  console.log(`${results.filter(Boolean).length}/${results.length} passed`);
  await browser.close();
  trap.close();
}
process.exit(results.every(Boolean) ? 0 : 1);
