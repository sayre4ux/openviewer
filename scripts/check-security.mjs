// Security regressions: save snapshots, blocked images, huge tables, line endings.
// Usage: node scripts/check-security.mjs [outDir] [chromium|webkit]
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

try {
  // Saving the pre-edit snapshot leaves later keystrokes dirty. Saving the current one clears it.
  const dirty = await page.evaluate(() => {
    window.__ov.load("hello");
    const snap = window.__ov.snapshot();
    const v = window.__ov.view;
    v.dispatch({ changes: { from: v.state.doc.length, insert: "!" } });
    window.__ov.saved(snap.doc);
    return window.__ov.isDirty() && window.__ov.view.state.sliceDoc() === "hello!";
  });
  check("edit after snapshot stays dirty", dirty);
  const clean = await page.evaluate(() => {
    const snap = window.__ov.snapshot();
    window.__ov.saved(snap.doc);
    return window.__ov.isDirty() === false && snap.text === "hello!";
  });
  check("current snapshot marks clean", clean);

  const endings = await page.evaluate(() => ({
    lf: window.__ov.lineEndings("a\nb\n"),
    crlf: window.__ov.lineEndings("a\r\nb\r\n"),
    cr: window.__ov.lineEndings("a\rb\r"),
    mixed: window.__ov.lineEndings("a\r\nb\nc"),
    mixedCr: window.__ov.lineEndings("a\rb\nc"),
  }));
  check("line endings classified", endings.lf === "lf" && endings.crlf === "crlf" && endings.cr === "cr" && endings.mixed === "mixed" && endings.mixedCr === "mixed", JSON.stringify(endings));
  const cr = "alpha\rbeta\rgamma";
  const round = await page.evaluate((text) => {
    window.__ov.load(text);
    const v = window.__ov.view;
    return { text: v.state.sliceDoc(), br: v.state.lineBreak, lines: v.state.doc.lines };
  }, cr);
  check("CR-only round trip", round.text === cr && round.br === "\r" && round.lines === 3, JSON.stringify(round));

  const hosts = await page.evaluate(() => {
    const ok = window.__ov.imageUrlAllowed;
    return {
      loop: ok("http://127.0.0.1/x.png"),
      lan: ok("http://192.168.1.2/x.png"),
      js: ok("javascript:alert(1)"),
      https: ok("https://example.com/x.png"),
      rel: ok("pics/local.png"),
      v6: ok("http://[::1]/x.png"),
      mapped: ok("http://[::ffff:10.1.2.3]/x.png"),
      local: ok("https://printer.local/x.png"),
      ten: ok("http://10.9.8.7/x.png"),
      link: ok("http://169.254.1.1/x.png"),
      zero: ok("http://0.0.0.0/x.png"),
      ula: ok("http://[fc00::1]/x.png"),
      ll6: ok("http://[fe80::1]/x.png"),
      decimal: ok("http://2130706433/x.png"),
      data: ok("data:image/png;base64,aaaa"),
      html: ok("data:text/html,x"),
      abs: ok("/tmp/pic.png"),
      proto: ok("//evil.example/x.png"),
      cgnat: ok("http://100.64.0.1/x.png") || ok("http://100.127.255.1/x.png"),
      zeroNet: ok("http://0.1.2.3/x.png"),
      publicHundred: ok("http://100.128.0.1/x.png"),
    };
  });
  check("image url policy",
    !hosts.loop && !hosts.lan && !hosts.js && hosts.https && hosts.rel && !hosts.v6 && !hosts.mapped && !hosts.local && !hosts.ten && !hosts.link && !hosts.zero && !hosts.ula && !hosts.ll6 && !hosts.decimal && hosts.data && !hosts.html && hosts.abs && !hosts.proto && !hosts.cgnat && !hosts.zeroNet && hosts.publicHundred,
    JSON.stringify(hosts));

  const localPaths = await page.evaluate(() => {
    const candidate = window.__ov.localImageCandidate;
    const doc = "/Users/example/Notes/page.md";
    return {
      relative: candidate("images/pic.png", doc),
      insideAbsolute: candidate("/Users/example/Notes/pic.png", doc),
      insideDots: candidate("images/../pic.png", doc),
      outsideRelative: candidate("../secret.png", doc),
      outsideThenBack: candidate("../Notes/pic.png", doc),
      outsideAbsolute: candidate("/Users/example/secret.png", doc),
      outsideBackslash: candidate("..\\secret.png", doc),
    };
  });
  const decoded = await page.evaluate(() => {
    const c = window.__ov.localImageCandidate;
    return {
      encoded: c("assets/my%20shot.png", "/Users/example/Notes/page.md"),
      angle: c("<assets/my shot.png>", "/Users/example/Notes/page.md"),
      badEscape: c("a%zz.png", "/Users/example/Notes/page.md"),
      windowsRelative: c("..\\img\\a.png", "C:\\Users\\me\\Docs\\page.md"),
      windowsAbsolute: c("D:/pics/b.png", "C:\\Users\\me\\Docs\\page.md"),
      encodedSlash: c("images%2Fpic.png", "/Users/example/Notes/page.md"),
      driveAllowed: window.__ov.imageUrlAllowed("C:\\pics\\a.png") && window.__ov.imageUrlAllowed("d:/pics/a.png"),
      names: [
        window.__ov.pastedImageName("image.png", "image/png", new Date(2026, 8, 24, 9, 5, 7)),
        window.__ov.pastedImageName("", "image/jpeg", new Date(2026, 8, 24, 9, 5, 7)),
        window.__ov.pastedImageName("diagram.webp", "image/webp", new Date()),
      ].join(","),
    };
  });
  // A pasted image at the end of a line shows at once: the caret moves below it instead of touching it.
  const pasted = await page.evaluate(async () => {
    window.__ov.load("Here:\n");
    const v = window.__ov.view;
    v.dispatch({ selection: { anchor: v.state.doc.length } });
    window.__ov.insertImages("![shot](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==)");
    await new Promise((r) => setTimeout(r, 200));
    return { rendered: document.querySelectorAll(".cm-md-image").length, text: v.state.doc.toString(), caretLine: v.state.doc.lineAt(v.state.selection.main.head).number };
  });
  check("a pasted image renders right away", pasted.rendered === 1 && pasted.caretLine === 3 && pasted.text.endsWith(")\n"), JSON.stringify(pasted));
  const midLine = await page.evaluate(() => {
    window.__ov.load("before after\n");
    window.__ov.insertImages("![x](a.png)", 7);
    return window.__ov.view.state.doc.toString();
  });
  // Images that resolve asynchronously (the app asks Rust) still appear, and blocked ones say so.
  const asyncImages = await page.evaluate(async () => {
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    window.__ov.useAsyncImages(80);
    window.__ov.load(`# A\n\n![ok](${png})\n\n![no](blocked.png)\n\ntext\n`);
    await new Promise((r) => setTimeout(r, 400));
    const img = document.querySelector(".cm-md-image");
    const result = { loaded: img?.complete && img.naturalWidth > 0, blocked: document.querySelectorAll(".cm-md-image-blocked").length };
    window.__ov.useAsyncImages(null);
    return result;
  });
  check("asynchronously resolved images appear", asyncImages.loaded === true && asyncImages.blocked === 1, JSON.stringify(asyncImages));
  check("an image pasted mid-line adds no line break", midLine === "before ![x](a.png)after\n", JSON.stringify(midLine));

  check("image paths: percent-encoding, <...>, Windows, pasted names",
    decoded.encoded === "/Users/example/Notes/assets/my shot.png" &&
    decoded.angle === "/Users/example/Notes/assets/my shot.png" &&
    decoded.badEscape === "/Users/example/Notes/a%zz.png" &&
    decoded.windowsRelative === "C:/Users/me/img/a.png" &&
    decoded.windowsAbsolute === "D:/pics/b.png" &&
    decoded.encodedSlash === "/Users/example/Notes/images/pic.png" &&
    decoded.driveAllowed &&
    decoded.names === "image-20260924-090507.png,image-20260924-090507.jpg,diagram.webp",
    JSON.stringify(decoded));

  // The prefilter only normalizes; the folder/repository boundary is enforced in Rust (cargo tests).
  check("local image paths are normalized",
    localPaths.relative === "/Users/example/Notes/images/pic.png" &&
    localPaths.insideAbsolute === "/Users/example/Notes/pic.png" &&
    localPaths.insideDots === "/Users/example/Notes/pic.png" &&
    localPaths.outsideRelative === "/Users/example/secret.png" &&
    localPaths.outsideThenBack === "/Users/example/Notes/pic.png" &&
    localPaths.outsideAbsolute === "/Users/example/secret.png" &&
    localPaths.outsideBackslash === "/Users/example/secret.png",
    JSON.stringify(localPaths));

  const markdown = [
    "Images",
    "",
    "![a](http://127.0.0.1/x.png)",
    "",
    "![b](http://192.168.1.2/x.png)",
    "",
    "![c](javascript:alert(1))",
    "",
    "![d](https://example.com/x.png)",
    "",
    "![e](pics/local.png)",
    "",
  ].join("\n");
  const rendered = await page.evaluate((markdown) => {
    window.__ov.load(markdown);
    const blocked = [...document.querySelectorAll(".cm-md-image-blocked")].map((el) => ({
      alt: el.querySelector(".cm-md-image-blocked-alt")?.textContent ?? "",
      note: el.querySelector(".cm-md-image-blocked-note")?.textContent ?? "",
      imgs: el.querySelectorAll("img").length,
      html: el.innerHTML.includes("<img"),
    }));
    // img.cm-md-image only: CodeMirror also puts empty <img class="cm-widgetBuffer"> around widgets.
    const imgs = [...document.querySelectorAll("#editor img.cm-md-image")].map((img) => ({
      alt: img.getAttribute("alt"),
      src: img.getAttribute("src"),
    }));
    return { blocked, imgs };
  }, markdown);
  const blockedAlts = rendered.blocked.map((b) => b.alt).sort().join(",");
  check("blocked images are placeholders",
    blockedAlts === "a,b,c" && rendered.blocked.every((b) => b.note === "image blocked" && b.imgs === 0 && !b.html),
    JSON.stringify(rendered.blocked));
  const byAlt = Object.fromEntries(rendered.imgs.map((img) => [img.alt, img.src]));
  check("public and relative images load",
    rendered.imgs.length === 2 && byAlt.d?.includes("https://example.com/x.png") && byAlt.e?.includes("pics/local.png"),
    JSON.stringify(rendered.imgs));
  check("no remote private image element",
    rendered.imgs.every((img) => !/127\.0\.0\.1|192\.168\.1\.2|javascript:/i.test(img.src ?? "")));
  await page.screenshot({ path: `${out}/sec-images.png` });

  const huge = await page.evaluate(() => {
    const body = Array.from({ length: 1999 }, () => "| 1 | 2 | 3 |").join("\n");
    window.__ov.load(`| a | b | c |\n|---|---|---|\n${body}\n\nEND`);
    return document.querySelectorAll(".cm-md-table").length;
  });
  check("huge table stays raw", huge === 0, String(huge));
  await page.locator(".cm-content").click();
  await page.evaluate(() => {
    const v = window.__ov.view;
    v.dispatch({ selection: { anchor: v.state.doc.length } });
    v.focus();
  });
  await page.keyboard.type("Z");
  const typed = await page.evaluate(() => window.__ov.view.state.sliceDoc().endsWith("ENDZ") && document.querySelectorAll(".cm-md-table").length === 0);
  check("huge table still accepts typing", typed);

  await page.evaluate(() => window.__ov.load("| A | B |\n|---|---|\n| 1 | 2 |\n"));
  await page.waitForSelector(".cm-md-table");
  const small = await page.evaluate(() => document.querySelectorAll(".cm-md-table").length);
  check("small table is still a widget", small === 1, String(small));

  // Save during close must not drop keystrokes that landed while the write was in flight.
  const closeRace = await page.evaluate(async () => {
    const run = async (answers, onSave) => {
      let asks = 0;
      let dirty = true;
      const closed = await window.__ov.resolveClose(
        () => dirty,
        async () => answers[asks++] ?? "Cancel",
        async () => onSave((value) => { dirty = value; }),
      );
      return { closed, asks, dirty };
    };
    return {
      stillDirty: await run(["Save", "Cancel"], (setDirty) => { setDirty(true); return true; }),
      clean: await run(["Save", "Cancel"], (setDirty) => { setDirty(false); return true; }),
      failed: await run(["Save", "Save"], () => false),
      discard: await run(["No"], () => true),
    };
  });
  check("close asks again when save leaves the document dirty",
    closeRace.stillDirty.closed === false && closeRace.stillDirty.asks === 2 && closeRace.stillDirty.dirty === true,
    JSON.stringify(closeRace.stillDirty));
  check("close finishes when save leaves the document clean",
    closeRace.clean.closed === true && closeRace.clean.asks === 1 && closeRace.clean.dirty === false,
    JSON.stringify(closeRace.clean));
  check("failed save does not close",
    closeRace.failed.closed === false && closeRace.failed.asks === 1,
    JSON.stringify(closeRace.failed));
  check("discard closes without saving",
    closeRace.discard.closed === true && closeRace.discard.asks === 1,
    JSON.stringify(closeRace.discard));

  // Ten tables under the per-table cap still have to share one document budget.
  // The decoration set is the whole document; the DOM only mounts widgets in the viewport.
  page.setDefaultTimeout(120000);
  const many = await page.evaluate(() => {
    const row = "| 1 | 2 | 3 |";
    const one = ["| a | b | c |", "|---|---|---|", ...Array.from({ length: 799 }, () => row)].join("\n");
    const tables = Array.from({ length: 10 }, (_, i) => (i === 9 ? one.replace("| a |", "| late |") : one));
    window.__ov.load(`${tables.join("\n\n")}\n\nEND`);
    const parsed = window.__ov.forceParsing();
    const at = window.__ov.view.state.sliceDoc().lastIndexOf("| late |");
    const stats = window.__ov.tableRenderStats();
    const lateCovered = stats.ranges.some(([from, to]) => at >= from && at < to);
    return {
      parsed,
      widgets: stats.widgets,
      widgetCells: stats.cells,
      lateCovered,
      drawn: document.querySelectorAll(".cm-md-table").length,
    };
  });
  check("document table budget leaves later tables raw",
    many.parsed === true && many.widgetCells > 0 && many.widgetCells <= 20000 &&
    many.widgets > 0 && many.widgets < 10 && !many.lateCovered && many.drawn > 0,
    JSON.stringify(many));
  await page.locator(".cm-content").click();
  await page.evaluate(() => {
    const v = window.__ov.view;
    v.dispatch({ selection: { anchor: v.state.doc.length } });
    v.focus();
  });
  await page.keyboard.type("Z");
  const manyTyped = await page.evaluate(() => window.__ov.view.state.sliceDoc().endsWith("ENDZ"));
  check("document table budget still accepts typing", manyTyped);
} finally {
  console.log(`${results.filter(Boolean).length}/${results.length} passed`);
  await browser.close();
}
process.exit(results.every(Boolean) ? 0 : 1);
