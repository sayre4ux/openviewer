// Clipboard HTML conversion and paste handling, against `vite` in browser mode.
// Usage: node scripts/check-paste.mjs [outDir] [chromium|webkit]
import { chromium, webkit } from "playwright";
import { mkdirSync } from "node:fs";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";

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
      // Google Docs wraps a multi-block selection in one inline <b>; the blocks must stay blocks.
      wrappedBlocks: convert('<b style="font-weight:normal" id="docs-internal-guid-1"><h2>Notes</h2><p>Some <span style="font-weight:700">bold</span>.</p><ul><li>one</li></ul><table><tr><th>A</th></tr><tr><td>1</td></tr></table></b>'),
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
    wrappedBlocks: "## Notes\n\nSome **bold**.\n\n- one\n\n| A |\n| --- |\n| 1 |",
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

  // A pasted table gets blank lines around it, as ⌥⌘T's does, so neighbouring text isn't read as rows.
  const tablePaste = await page.evaluate(() => {
    const view = window.__ov.view;
    const html = "<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>";
    const table = window.__ov.htmlToMarkdown(html);
    const paste = (text, anchor) => {
      window.__ov.load(text);
      view.dispatch({ selection: { anchor } });
      const transfer = new DataTransfer();
      transfer.setData("text/html", html);
      transfer.setData("text/plain", "a b 1 2");
      view.contentDOM.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
      return view.state.sliceDoc();
    };
    const crlf = table.replace(/\n/g, "\r\n");
    return {
      table,
      blankLine: [paste("Intro\n\nSee below.\n", 6), `Intro\n\n${table}\n\nSee below.\n`],
      midLine: [paste("foobar\r\n", 3), `foo\r\n\r\n${crlf}\r\n\r\nbar\r\n`],
      alone: [paste("\n\nafter\n", 0), `${table}\n\nafter\n`],
      end: [paste("text\n\n", 6), `text\n\n${table}`],
      // Inside a quote or a list item every new line keeps the container's prefix.
      quote: [paste("> Intro\n> \n> After\n", 10), `> Intro\n> \n${table.replace(/^/gm, "> ")}\n>\n> After\n`],
      list: [paste("- item\n\nafter\n", 6), `- item\n\n${table.replace(/^/gm, "  ")}\n\nafter\n`],
      quoteMid: [paste("> foobar\n", 5), `> foo\n>\n${table.replace(/^/gm, "> ")}\n>\n> bar\n`],
    };
  });
  check("a pasted table is kept apart from the lines around it",
    ["blankLine", "midLine", "alone", "end", "quote", "list", "quoteMid"].every((k) => tablePaste[k][0] === tablePaste[k][1]) && tablePaste.table.startsWith("| a | b |"),
    JSON.stringify(tablePaste));
  // And the parser agrees: in the pasted results, the Table sits inside the Blockquote and the ListItem.
  const containerOf = (text) => {
    const state = EditorState.create({ doc: text, extensions: [markdown({ base: markdownLanguage })] });
    let parent = null;
    ensureSyntaxTree(state, text.length, 5000).iterate({ enter: (n) => {
      if (n.name === "Table" && !parent) parent = n.node.parent?.name ?? null;
    } });
    return parent;
  };
  const containers = { quote: containerOf(tablePaste.quote[0]), list: containerOf(tablePaste.list[0]), top: containerOf(tablePaste.blankLine[0]) };
  check("a table pasted in a quote or list item is a table inside it", containers.quote === "Blockquote" && containers.list === "ListItem" && containers.top === "Document", JSON.stringify(containers));

  // Plain multi-line paste into files with other line breaks: the text gets the file's breaks and the
  // caret lands after it. In a CR file, CRLF text used to throw (the rewrite shortened the insert).
  const lineBreakPaste = await page.evaluate(() => {
    const view = window.__ov.view;
    const paste = (doc, at, text) => {
      window.__ov.load(doc);
      view.dispatch({ selection: { anchor: at } });
      const transfer = new DataTransfer();
      transfer.setData("text/plain", text);
      let error = null;
      try {
        view.contentDOM.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
      } catch (e) { error = String(e); }
      const head = view.state.selection.main.head;
      return { doc: view.state.sliceDoc(), before: view.state.sliceDoc(0, head), error };
    };
    // Transactions that don't leave the caret at the end of the insert, as other commands send them.
    const direct = (doc, spec) => {
      window.__ov.load(doc);
      view.dispatch(spec);
      const { anchor, head } = view.state.selection.main;
      return { doc: view.state.sliceDoc(), anchor, head };
    };
    return {
      crlf: paste("abc\r\ndef", 3, "one\ntwo\nthree"), cr: paste("ab\rcd", 5, "x\r\ny\r\nz"), crMid: paste("ab\rcd", 1, "x\r\ny"),
      caretBefore: direct("ab\rcd", { changes: { from: 2, insert: "x\r\ny" }, selection: { anchor: 2 } }),
      rangeOver: direct("ab\rcd", { changes: { from: 2, insert: "x\r\ny" }, selection: { anchor: 2, head: 6 } }),
      twoInserts: direct("ab\rcd", { changes: [{ from: 0, insert: "p\r\nq" }, { from: 5, insert: "r\r\ns" }], selection: { anchor: 10 } }),
    };
  });
  const lb = lineBreakPaste;
  check("a multi-line plain paste takes the file's line breaks and leaves the caret after it",
    lb.crlf.doc === "abcone\r\ntwo\r\nthree\r\ndef" && lb.crlf.before === "abcone\r\ntwo\r\nthree" &&
    lb.cr.doc === "ab\rcdx\ry\rz" && lb.cr.before === "ab\rcdx\ry\rz" && !lb.cr.error &&
    lb.crMid.doc === "ax\ryb\rcd" && lb.crMid.before === "ax\ry" &&
    // The caret stays before the insert, a range still covers it, and a caret inside the second of two
    // inserts stays inside it (after "r", before its line break).
    lb.caretBefore.doc === "abx\ry\rcd" && lb.caretBefore.head === 2 &&
    lb.rangeOver.anchor === 2 && lb.rangeOver.head === 5 &&
    lb.twoInserts.doc === "p\rqab\rcdr\rs" && lb.twoInserts.head === 9,
    JSON.stringify(lineBreakPaste));

  // Inside code, math, or HTML a rich paste is plain text; right next to them it is still rich.
  const literalPaste = await page.evaluate(() => {
    const view = window.__ov.view;
    const paste = (doc, html = "<pre><code>foo_bar(*args)</code></pre>", text = "foo_bar(*args)") => {
      window.__ov.load(doc.replace("|", ""));
      view.dispatch({ selection: { anchor: doc.indexOf("|") } });
      const transfer = new DataTransfer();
      transfer.setData("text/html", html);
      transfer.setData("text/plain", text);
      view.contentDOM.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
      return view.state.sliceDoc();
    };
    return {
      fence: paste("```js\n|\n```\n"),
      display: paste("$$\nx|\n$$\n"),
      inlineCode: paste("see `a|b` here\n"),
      inlineMath: paste("see $a|b$ here\n"),
      html: paste("<div>\nx|\n</div>\n"),
      // Blocks with no closing mark end at their last character; the caret there is still inside.
      openFence: paste("```js\n|"),
      openFenceAfterCode: paste("```js\ncode\n\n|"),
      indented: paste("text\n\n    code|\n\nafter\n"),
      htmlEnd: paste("<div>\nx\n|"),
      afterClosedFence: paste("```\nx\n```\n\n|"),
      nextTo: paste("see `ab`|\n", "<b>bold</b> text", "bold text"),
      // `<pre>` ends at its closing tag, so the next line is outside the HTML block.
      afterPre: paste("<pre>x</pre>\n|", "<b>bold</b> text", "bold text"),
    };
  });
  const lp = literalPaste;
  check("rich paste inside code, math, or HTML is plain text",
    lp.fence === "```js\nfoo_bar(*args)\n```\n" && lp.display === "$$\nxfoo_bar(*args)\n$$\n" &&
    lp.inlineCode === "see `afoo_bar(*args)b` here\n" && lp.inlineMath === "see $afoo_bar(*args)b$ here\n" &&
    lp.html === "<div>\nxfoo_bar(*args)\n</div>\n" && lp.nextTo === "see `ab`**bold** text\n" && lp.afterPre === "<pre>x</pre>\n**bold** text" &&
    lp.openFence === "```js\nfoo_bar(*args)" && lp.openFenceAfterCode === "```js\ncode\n\nfoo_bar(*args)" &&
    lp.indented === "text\n\n    codefoo_bar(*args)\n\nafter\n" && lp.htmlEnd === "<div>\nx\nfoo_bar(*args)" &&
    lp.afterClosedFence.startsWith("```\nx\n```\n\n```"),
    JSON.stringify(literalPaste));

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
