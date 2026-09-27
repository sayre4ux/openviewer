import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

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
  plugins: [katexWoff2Only()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        preferences: resolve(__dirname, "preferences.html"),
      },
    },
  },
});
