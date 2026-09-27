// The diagram renderer's side of its frame (the editor's side is src/render/diagram.ts). This page runs
// in an <iframe sandbox="allow-scripts">: an opaque origin, no Tauri IPC, and its own CSP with no
// network and no inline script. It takes diagram source from the editor, renders it with Mermaid, and
// posts back the SVG text; the editor sanitizes that and shows it only as an image.
// A classic script, not a module: a module is fetched with CORS, which an opaque origin can't pass.
"use strict";
(() => {
  const mermaid = globalThis.mermaid;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    htmlLabels: false,
    flowchart: { htmlLabels: false, useMaxWidth: false },
    maxTextSize: 20000,
    maxEdges: 300,
    theme: "neutral",
    // System fonts: an SVG shown as an image can't load any other.
    fontFamily: "Helvetica Neue, Helvetica, Arial, sans-serif",
    deterministicIds: true,
    // Added to Mermaid's own list (securityLevel, maxTextSize, maxEdges, ...), which a diagram's
    // %%{init}%% directive can't change. DECISION: dompurifyConfig too, so a diagram can't loosen
    // Mermaid's own label sanitizer.
    // DECISION: other diagram directives (%%{init}%%: themes, themeCSS, fonts) stay allowed; their CSS
    // lives only in this frame and in the image.
    secure: ["htmlLabels", "dompurifyConfig"],
  });

  const message = (error) => String((error && error.message) || error).slice(0, 300);

  async function render(id, source) {
    try {
      await mermaid.parse(source);
    } catch (error) {
      return { v: 1, id, ok: false, kind: "syntax", message: message(error) };
    }
    try {
      const { svg } = await mermaid.render(`ov-diagram-${id}`, source);
      return { v: 1, id, ok: true, svg };
    } catch (error) {
      return { v: 1, id, ok: false, kind: "error", message: message(error) };
    }
  }

  // One job at a time, in order; only the editor that embeds this frame can send one.
  let queue = Promise.resolve();
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const job = event.data;
    if (!job || job.v !== 1 || typeof job.id !== "number" || typeof job.source !== "string") return;
    queue = queue.then(async () => window.parent.postMessage(await render(job.id, job.source), "*"));
  });
  window.parent.postMessage({ v: 1, ready: true }, "*");
})();
