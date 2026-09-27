// Clipboard HTML conversion and paste handling, against `vite` in browser mode.
// Usage: node scripts/check-paste.mjs [outDir] [chromium|webkit]
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
  const fixtures = await page.evaluate(() => {
    const convert = window.__ov.htmlToMarkdown;
    return {
      googleDocs: convert('<div><b style="font-weight:normal" id="docs-internal-guid-abc"><span style="font-weight:700">Bold</span> and <span style="font-style:italic">italic</span></b></div><h2>Title</h2><ul><li>One</li><li>Two</li></ul>'),
      webArticle: convert('<p>Read <a href="https://example.com/guide">the guide</a> and <code>npm `run` dev</code>.</p><p>Next.</p><p>Break<br>here</p><pre class="language-ts"><code>const x = "```";</code></pre>'),
      nestedList: convert('<ul><li>Parent<ol start="3"><li>Step</li><li><input type="checkbox" checked>Checked</li></ol></li><li>End</li></ul>'),
      table: convert('<table><thead><tr><th align="left">Name</th><th style="text-align:center">Value</th></tr></thead><tbody><tr><td>A</td><td>one | two</td></tr></tbody></table><p>After table</p>'),
      oneRowTable: convert('<table><tr><td>Only</td><td>Row</td></tr></table>'),
      nestedQuote: convert('<blockquote><p>outer</p><blockquote><p>inner</p></blockquote></blockquote>'),
      // Formatting makes it convert; the rest must stay literal text.
      escapedText: convert('<p><b>Note</b>: 2 * 3 = 6</p><p># not a heading</p><p>[not a link]</p>'),
      plain: convert('<p>Just plain text &nbsp; with spaces.</p>'),
    };
  });
  const expected = {
    googleDocs: "**Bold** and *italic*\n\n## Title\n\n- One\n- Two",
    webArticle: "Read [the guide](https://example.com/guide) and ``npm `run` dev``.\n\nNext.\n\nBreak\\\nhere\n\n````ts\nconst x = \"```\";\n````",
    nestedList: "- Parent\n  3. Step\n  4. [x] Checked\n- End",
    table: "| Name | Value |\n| :--- | :---: |\n| A | one \\| two |\n\nAfter table",
    oneRowTable: "|  |  |\n| --- | --- |\n| Only | Row |",
    nestedQuote: "> outer\n>\n> > inner",
    escapedText: "**Note**: 2 \\* 3 = 6\n\n\\# not a heading\n\n\\[not a link\\]",
    plain: null,
  };
  for (const [name, value] of Object.entries(expected)) {
    check(`${name} fixture`, fixtures[name] === value, JSON.stringify(fixtures[name]));
  }

  const resourceRequests = [];
  const watchResource = (request) => {
    if (["/x", "/y"].includes(new URL(request.url()).pathname)) resourceRequests.push(request.url());
  };
  page.on("request", watchResource);
  const hostile = await page.evaluate(() => {
    delete window.__pasteRan;
    const markdown = window.__ov.htmlToMarkdown('<script>window.__pasteRan = true</script><style>body { display:none }</style><p>Safe <a href="javascript:alert(1)">script link</a> and <a href="data:text/html,boom">data link</a><img src="x" onerror="window.__pasteRan = true"></p><iframe src="javascript:alert(2)"></iframe>');
    return { markdown, ran: window.__pasteRan };
  });
  await page.waitForTimeout(100);
  page.off("request", watchResource);
  // Other attributes and elements that fetch in a live page; converting must fetch none of them.
  const fetchers = await page.evaluate(() => window.__ov.htmlToMarkdown(
    '<p><b>Bold</b></p><img srcset="/y 2x"><picture><source srcset="/y"></picture><video poster="/y" src="/y"></video>' +
    '<svg><image href="/y"/></svg><link rel="stylesheet" href="/y"><table background="/y"><tr><td>t</td></tr></table>' +
    '<object data="/y"></object><div style="background:url(/y)">styled</div>'));
  await page.waitForTimeout(400);
  check("hostile HTML stays inert and unsafe links keep only text",
    hostile.ran === undefined && hostile.markdown === "Safe script link and data link![](x)" && !hostile.markdown.includes("javascript:") && resourceRequests.length === 0,
    JSON.stringify({ ...hostile, resourceRequests }));
  check("converting clipboard HTML fetches nothing", resourceRequests.length === 0 && fetchers.includes("**Bold**"), JSON.stringify({ fetchers, resourceRequests }));

  const richPaste = await page.evaluate(() => {
    window.__ov.load("a\r\nb\r\n");
    const view = window.__ov.view;
    const selected = view.state.doc.line(2);
    view.dispatch({ selection: { anchor: selected.from, head: selected.to } });
    const transfer = new DataTransfer();
    transfer.setData("text/html", "<p><strong>rich</strong></p><p>paste</p>");
    transfer.setData("text/plain", "rich\npaste");
    const event = new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true });
    view.contentDOM.dispatchEvent(event);
    const pasted = view.state.sliceDoc();
    const caret = view.state.doc.lineAt(view.state.selection.main.head);
    const caretAtEnd = view.state.selection.main.head === caret.to;
    window.__ov.commands.undo();
    return {
      pasted,
      expected: "a\r\n**rich**\r\n\r\npaste\r\n",
      prevented: event.defaultPrevented,
      caretText: caret.text,
      caretAtEnd,
      undo: view.state.sliceDoc(),
    };
  });
  check("rich paste uses CRLF, replaces selection, and is one undo step",
    richPaste.pasted === richPaste.expected && richPaste.prevented && richPaste.caretText === "paste" && richPaste.caretAtEnd && richPaste.undo === "a\r\nb\r\n",
    JSON.stringify(richPaste));

  const plainPaste = await page.evaluate(() => {
    window.__ov.load("x\r\ny\r\n");
    const view = window.__ov.view;
    const selected = view.state.doc.line(2);
    view.dispatch({ selection: { anchor: selected.from, head: selected.to } });
    const transfer = new DataTransfer();
    transfer.setData("text/plain", "plain only");
    const event = new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true });
    view.contentDOM.dispatchEvent(event);
    return { document: view.state.sliceDoc(), prevented: event.defaultPrevented };
  });
  check("plain-text paste still uses the editor's normal handler",
    plainPaste.document === "x\r\nplain only\r\n" && plainPaste.prevented,
    JSON.stringify(plainPaste));
} finally {
  console.log(`${results.filter(Boolean).length}/${results.length} passed`);
  await browser.close();
}
process.exit(results.every(Boolean) ? 0 : 1);
