// Math: what counts as a formula, rendering in place, reveal on click, the file staying byte for
// byte, KaTeX's trust and limits, the sanitizer's fidelity, and the per-document budget.
// Usage: node scripts/check-math.mjs [outDir] [chromium|webkit]
import { chromium, webkit } from "playwright";
import { mkdirSync } from "node:fs";

const out = process.argv[2] ?? "shots";
const engine = process.argv[3] ?? "chromium";
mkdirSync(out, { recursive: true });
const browser = engine === "webkit" ? await webkit.launch() : await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1000, height: 900 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
page.setDefaultTimeout(20000);
const requests = [];
page.on("request", (r) => requests.push(r.url()));
await page.goto(process.env.OV_URL ?? "http://localhost:5173/");
await page.waitForSelector(".cm-content");
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };

// Loads a document, waits for KaTeX, and parks the caret on a last line of its own.
const load = (text) => page.evaluate(async (text) => {
  window.__ov.load(text);
  await window.__ov.math("x"); // KaTeX is loaded once any formula is on screen
  await new Promise((r) => setTimeout(r, 50));
  const v = window.__ov.view;
  v.dispatch({ selection: { anchor: v.state.doc.length } });
  await new Promise((r) => requestAnimationFrame(() => r()));
}, text);
const rendered = () => page.evaluate(() => ({
  inline: document.querySelectorAll(".cm-md-math .katex").length,
  blocks: document.querySelectorAll(".cm-md-math-block .katex").length,
  errors: [...document.querySelectorAll(".cm-md-render-note")].map((n) => n.textContent),
}));

try {
  // What counts as a formula. Each document ends in a blank line, where the caret sits.
  const cases = {
    "$x$": 1, "$2+2$": 1, "a $x$ and $y$ b": 2, "$5 and $10": 0, "\\$x\\$": 0, "\\\\$x$": 1, "`$x$`": 0,
    "[link](http://a.example/$x$)": 0, "costs $5, see `$PATH`": 0, "$ x$": 0, "$x $": 0, "$x$5": 0,
    "$$x$$": 0, "a$x$b": 1, "<span title=\"$x$\">t</span>": 0,
  };
  const counts = {};
  for (const [text, want] of Object.entries(cases)) {
    await load(`${text}\n\n`);
    counts[text] = (await rendered()).inline;
    if (counts[text] !== want) counts[text] = `${counts[text]} (want ${want})`;
  }
  check("inline formulas: what is and isn't one", Object.values(counts).every((n) => typeof n === "number"), JSON.stringify(counts));

  // Display blocks, in quotes and lists too; unclosed or broken by a blank line, they stay text.
  await load("Text above\n$$\n\\int_0^1 x\\,dx\n$$\n\n> $$\n> \\frac{a}{b}\n> $$\n\n- $$\n  \\sqrt{2}\n  $$\n\n$$\nunclosed\n\n$$\na\n\nb\n$$\n\nend\n");
  const blocks = await rendered();
  const blockText = await page.evaluate(() => window.__ov.view.contentDOM.textContent);
  check("display formulas render, also in quotes and lists", blocks.blocks === 3 && blockText.includes("unclosed") && blockText.includes("Text above"), JSON.stringify(blocks));
  await page.screenshot({ path: `${out}/math-blocks.png` });

  // The file stays byte for byte: CRLF, through render, reveal, and a failure.
  const crlf = "# Sum $\\sum_i x_i$\r\n\r\nInline $a^2$ and bad $\\frac{1}{$ here.\r\n\r\n$$\r\n\\begin{aligned} a &= b \\\\ c &= d \\end{aligned}\r\n$$\r\n\r\nend\r\n";
  await load(crlf);
  const crlfRendered = await rendered();
  const same1 = await page.evaluate((t) => window.__ov.view.state.sliceDoc() === t, crlf);
  // Click the inline formula and the block: each shows its source.
  await page.locator(".cm-md-math").nth(1).click();
  const inlineRevealed = await page.evaluate(() => document.querySelectorAll(".cm-md-math-src").length);
  await page.locator(".cm-md-math-block").click();
  const blockRevealed = await page.evaluate(() => ({ lines: document.querySelectorAll(".cm-md-math-lines").length, blocks: document.querySelectorAll(".cm-md-math-block").length }));
  const same2 = await page.evaluate((t) => window.__ov.view.state.sliceDoc() === t && !window.__ov.isDirty(), crlf);
  check("CRLF file unchanged through render, reveal, and failure",
    crlfRendered.inline === 2 && crlfRendered.blocks === 1 && crlfRendered.errors.length === 1 && same1 && same2 &&
    inlineRevealed >= 1 && blockRevealed.lines === 3 && blockRevealed.blocks === 0,
    JSON.stringify({ crlfRendered, same1, same2, inlineRevealed, blockRevealed }));

  // Typing inside a revealed formula edits only its text; leaving it renders it again.
  await load("Say $a+b$ now\n\nend\n");
  await page.locator(".cm-md-math").click();
  await page.keyboard.press("End");
  const afterClick = await page.evaluate(() => window.__ov.view.state.selection.main.head);
  await page.evaluate(() => { const v = window.__ov.view; v.dispatch({ selection: { anchor: 8 } }); });
  await page.keyboard.type("c");
  await page.evaluate(() => { const v = window.__ov.view; v.dispatch({ selection: { anchor: v.state.doc.length } }); });
  const edited = await page.evaluate(() => ({ text: window.__ov.view.state.sliceDoc(), inline: document.querySelectorAll(".cm-md-math .katex").length }));
  check("editing a revealed formula changes only what was typed", edited.text === "Say $a+bc$ now\n\nend\n" && edited.inline === 1 && afterClick > 0, JSON.stringify(edited));

  // trust: false. None of these may produce a link, image, id, data attribute, or handler.
  const hostile = [
    "\\href{javascript:alert(1)}{x}", "\\url{https://example.com/}", "\\includegraphics{https://example.com/a.png}",
    "\\htmlClass{evil}{x}", "\\htmlData{foo=bar}{x}", "\\htmlStyle{background:url(https://example.com/a)}{x}",
    "\\htmlId{target}{x}", "\\text{<img src=x onerror=alert(1)>}",
  ];
  const attacks = [];
  for (const tex of hostile) {
    for (const kind of ["inline", "display"]) {
      const r = await page.evaluate(({ tex, kind }) => window.__ov.math(tex, kind), { tex, kind });
      const found = await page.evaluate((html) => {
        const t = document.createElement("template");
        t.innerHTML = html ?? "";
        const all = [...t.content.querySelectorAll("*")];
        return all.flatMap((el) => [
          ...(/^(a|img|image|script|iframe|use|style)$/i.test(el.localName) ? [el.localName] : []),
          ...[...el.attributes].filter((a) => a.name === "id" || a.name.startsWith("data-") || a.name.startsWith("on") || /href|src/i.test(a.name) || /url\(/i.test(a.value)).map((a) => `${el.localName}[${a.name}]`),
        ]);
      }, r.ok ? r.html : "");
      if (found.length) attacks.push(`${tex}: ${found.join(",")}`);
    }
  }
  await load(`${hostile.map((h) => `$${h}$`).join(" ")}\n\n$$\n${hostile.join("\n")}\n$$\n\n`);
  const editorDom = await page.evaluate(() => [...document.querySelectorAll(".cm-md-math *, .cm-md-math-block *")]
    .filter((el) => /^(a|img|image|script|iframe|use)$/i.test(el.localName) || [...el.attributes].some((a) => a.name === "id" || a.name.startsWith("data-") || a.name.startsWith("on")))
    .map((el) => el.outerHTML.slice(0, 80)));
  check("trust is off: no links, images, ids, data attributes, or handlers", attacks.length === 0 && editorDom.length === 0, JSON.stringify({ attacks, editorDom }));

  // Macros never outlive their formula.
  const macros = await page.evaluate(async () => {
    const a = await window.__ov.math("\\gdef\\ovtest{1} \\ovtest", "inline");
    const b = await window.__ov.math("\\ovtest", "inline");
    const c = await window.__ov.math("\\def\\ovtwo{2}\\ovtwo", "display");
    const d = await window.__ov.math("\\ovtwo", "display");
    return { a: a.ok, b: b.ok, bReason: b.reason, c: c.ok, d: d.ok };
  });
  check("\\gdef in one formula is undefined in the next", macros.a && !macros.b && macros.bReason === "syntax" && macros.c && !macros.d, JSON.stringify(macros));

  // Limits: over-long input is refused before KaTeX sees it; runaway expansion stops quickly.
  const limits = await page.evaluate(async () => {
    const inline = await window.__ov.math("x".repeat(2001), "inline");
    const display = await window.__ov.math("x".repeat(10001), "display");
    const inlineOk = await window.__ov.math("x".repeat(2000), "inline");
    const loop = await window.__ov.math("\\def\\a{\\a\\a}\\a", "display");
    const edef = await window.__ov.math("\\def\\b{xxxx}\\edef\\c{\\b\\b\\b\\b\\b\\b\\b\\b}\\edef\\d{\\c\\c\\c\\c\\c\\c\\c\\c}\\edef\\e{\\d\\d\\d\\d\\d\\d\\d\\d}\\e", "display");
    const huge = await window.__ov.math("\\rule{100000em}{100000em}", "display");
    return {
      inline: [inline.ok, inline.reason, inline.katexCalls], display: [display.ok, display.reason, display.katexCalls],
      inlineOk: inlineOk.ok, loop: [loop.ok, loop.reason, Math.round(loop.ms)], edef: [edef.ok, edef.reason],
      hugeSize: huge.ok ? /height:\s*(\d+(?:\.\d+)?)em/.exec(huge.html)?.[1] ?? "none" : huge.reason,
    };
  });
  check("over-limit input is refused without calling KaTeX",
    limits.inline[0] === false && limits.inline[1] === "too-long" && limits.inline[2] === 0 &&
    limits.display[0] === false && limits.display[1] === "too-long" && limits.display[2] === 0 && limits.inlineOk,
    JSON.stringify(limits));
  check("\\def\\a{\\a\\a}\\a stops with an error in under a second",
    limits.loop[0] === false && limits.loop[1] === "limit" && limits.loop[2] < 1000 && limits.edef[0] === false,
    JSON.stringify(limits));
  check("maxSize clamps huge dimensions", limits.hugeSize === "none" || Number(limits.hugeSize) <= 21, JSON.stringify(limits.hugeSize));

  // Sanitizer fidelity: benign formulas come out of DOMPurify exactly as KaTeX made them. This is
  // what catches a KaTeX or DOMPurify upgrade that silently drops markup.
  const benign = [
    "x^2", "\\frac{a}{b}", "\\sqrt[3]{x}", "\\sum_{i=1}^n i", "\\int_0^\\infty e^{-x}\\,dx", "\\prod_k a_k",
    "\\left(\\frac{a}{b}\\right)", "\\overbrace{a+b}^{c}", "\\underbrace{x+y}_{z}", "\\widehat{abc}",
    "\\overrightarrow{AB}", "\\xrightarrow{f}", "\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}",
    "\\begin{aligned}a&=b\\\\c&=d\\end{aligned}", "\\begin{cases}1&x>0\\\\0&\\text{else}\\end{cases}",
    "\\mathbb{R}", "\\mathcal{L}", "\\mathfrak{g}", "\\color{red}{x}", "\\colorbox{yellow}{y}", "\\boxed{E=mc^2}",
    "\\cancel{x}", "\\not= \\neq \\leq", "\\binom{n}{k}", "\\lim_{x\\to 0}\\frac{\\sin x}{x}", "\\vec{v}\\cdot\\hat{n}",
    "\\text{中文} + \\alpha", "\\hspace{1em}a\\kern2em b", "\\rule{1em}{0.5em}", "\\tag{1} a=b",
  ];
  const mismatches = [];
  for (const tex of benign) {
    const kind = tex.startsWith("\\tag") ? "display" : "inline";
    const { raw, sanitized } = await page.evaluate(({ tex, kind }) => window.__ov.mathFidelity(tex, kind), { tex, kind });
    const diff = await page.evaluate(({ raw, sanitized }) => {
      if (sanitized === null) return "not rendered";
      const parse = (html) => { const t = document.createElement("template"); t.innerHTML = html; return t.content; };
      const describe = (n) => n.nodeType === 3 ? `#text:${n.data}` : `${n.namespaceURI}|${n.localName}|${[...n.attributes].map((a) => `${a.name}=${a.value}`).sort().join("&")}`;
      const walk = (a, b, path) => {
        if (describe(a) !== describe(b)) return `${path}: ${describe(a).slice(0, 120)} ≠ ${describe(b).slice(0, 120)}`;
        const ac = [...a.childNodes].filter((n) => n.nodeType === 1 || n.nodeType === 3);
        const bc = [...b.childNodes].filter((n) => n.nodeType === 1 || n.nodeType === 3);
        if (ac.length !== bc.length) return `${path}: ${ac.length} children ≠ ${bc.length}`;
        for (let i = 0; i < ac.length; i++) {
          const d = walk(ac[i], bc[i], `${path}/${ac[i].localName ?? "#"}[${i}]`);
          if (d) return d;
        }
        return null;
      };
      const a = parse(raw);
      const b = parse(sanitized);
      if (a.childNodes.length !== b.childNodes.length) return "root children differ";
      for (let i = 0; i < a.childNodes.length; i++) {
        const d = walk(a.childNodes[i], b.childNodes[i], "");
        if (d) return d;
      }
      return null;
    }, { raw, sanitized });
    if (diff) mismatches.push(`${tex}: ${diff}`);
  }
  check(`sanitizer keeps ${benign.length} benign formulas node for node`, mismatches.length === 0, mismatches.join(" | "));

  // The document's formula budget: past 2,000, formulas stay as source.
  const budget = await page.evaluate(async () => {
    const line = Array.from({ length: 100 }, (_, i) => `$x_{${i}}$`).join(" ");
    window.__ov.load(`${Array.from({ length: 21 }, () => line).join("\n\n")}\n\nlast $y$\n`);
    window.__ov.forceParsing();
    const v = window.__ov.view;
    v.dispatch({ selection: { anchor: 0 }, effects: [] });
    const cutoff = window.__ov.mathCutoff();
    const text = v.state.sliceDoc();
    let n = 0;
    let at = -1;
    for (const m of text.matchAll(/\$x_\{\d+\}\$/g)) if (++n === 2001) { at = m.index; break; }
    v.dispatch({ effects: window.__ov.scrollTo(text.length) });
    await new Promise((r) => setTimeout(r, 200));
    const lastLine = [...document.querySelectorAll(".cm-line")].find((l) => l.textContent.startsWith("last"));
    const firstLine = document.querySelector(".cm-line");
    return { cutoff, at, lastFound: Boolean(lastLine), lastRendered: Boolean(lastLine?.querySelector(".katex")), source: Boolean(lastLine?.querySelector(".cm-md-math-src")), first: Boolean(firstLine) };
  });
  check("past 2,000 formulas a document keeps the rest as source",
    budget.cutoff === budget.at && budget.at > 0 && budget.lastFound && !budget.lastRendered && budget.source, JSON.stringify(budget));

  // A long line of lone dollars parses in linear time.
  const linear = await page.evaluate(() => {
    const started = performance.now();
    window.__ov.load(`${"$a ".repeat(30000)}\n\nend\n`);
    const parsed = window.__ov.forceParsing();
    return { parsed, ms: Math.round(performance.now() - started), rendered: document.querySelectorAll(".cm-md-math").length };
  });
  check("a line of 30,000 lone dollars parses quickly", linear.parsed && linear.ms < 3000 && linear.rendered === 0, JSON.stringify(linear));

  // Source mode shows every formula as text.
  await load("A $x^2$ b\n\n$$\ny\n$$\n\n");
  await page.evaluate(() => window.__ov.commands["source-mode"]());
  const source = await rendered();
  await page.evaluate(() => window.__ov.commands["source-mode"]());
  const back = await rendered();
  check("source mode shows formulas as text", source.inline === 0 && source.blocks === 0 && back.inline === 1 && back.blocks === 1, JSON.stringify({ source, back }));

  // Nothing about math reaches the network: KaTeX, its stylesheet, and fonts come from our own origin.
  const origin = new URL(page.url()).origin;
  const foreign = requests.filter((u) => !u.startsWith(origin) && !u.startsWith("data:"));
  check("math loads nothing from another origin", foreign.length === 0, foreign.join(", "));

  await load("# The $e^{i\\pi}+1=0$ identity\n\nInline $\\frac{a}{b}$ and $\\sqrt{x^2+y^2}$ in running text.\n\n$$\n\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}\n$$\n\n> $$\n> \\left\\{ \\begin{array}{ll} a & b \\\\ c & d \\end{array} \\right.\n> $$\n\nBroken $\\frac{1}{$ formula.\n\n");
  await page.screenshot({ path: `${out}/math.png` });
} finally {
  console.log(`${results.filter(Boolean).length}/${results.length} passed`);
  await browser.close();
}
process.exit(results.every(Boolean) ? 0 : 1);
