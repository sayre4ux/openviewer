import { createReadStream, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

// Mermaid's single-file build for the diagram frame (public/diagram/), served next to it in dev and
// emitted there in the build. It is a classic script: the frame's opaque origin can't load modules.
// The 3.5 MB file comes from node_modules at the pinned version rather than being committed.
const mermaidBuild = resolve(__dirname, "node_modules/mermaid/dist/mermaid.min.js");
function mermaidForFrame(): Plugin {
  return {
    name: "openviewer-mermaid-frame",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split("?")[0] !== "/diagram/mermaid.min.js") return next();
        res.setHeader("Content-Type", "text/javascript; charset=utf-8");
        createReadStream(mermaidBuild).pipe(res);
      });
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "diagram/mermaid.min.js", source: readFileSync(mermaidBuild) });
    },
  };
}

// KaTeX's stylesheet lists each font as woff2, woff, and ttf. Both engines we run in read woff2, so
// the other two are dropped here rather than shipped unused.
// DECISION: woff2 only; it saves about 800 KB of fonts neither engine would load.
function katexWoff2Only(): Plugin {
  return {
    name: "openviewer-katex-woff2",
    enforce: "pre",
    transform(code, id) {
      if (!/[\\/]katex[\\/]dist[\\/]katex(\.min)?\.css$/.test(id)) return null;
      return code.replace(/,\s*url\(fonts\/[^)]+\.(?:woff|ttf)\)\s*format\("(?:woff|truetype)"\)/g, "");
    },
  };
}

// Two pages: the editor window and the Settings window.
export default defineConfig({
  plugins: [katexWoff2Only(), mermaidForFrame()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        preferences: resolve(__dirname, "preferences.html"),
      },
    },
  },
});
