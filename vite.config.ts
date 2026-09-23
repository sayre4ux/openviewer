import { resolve } from "node:path";
import { defineConfig } from "vite";

// Two pages: the editor window and the Preferences window.
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        preferences: resolve(__dirname, "preferences.html"),
      },
    },
  },
});
