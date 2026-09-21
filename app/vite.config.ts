import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import pkg from "./package.json";

// The packaged app runs off file://, where a module worker is blocked by the
// same-origin rules that protocol has no way to satisfy. Every worker here is
// imported with ?worker&inline, so Vite emits it as a blob instead of a file
// and it loads identically in dev and in the installer. The CSP below allows
// exactly that and nothing more.
const devCsp: Plugin = {
  name: "dev-csp-hmr",
  apply: "serve",
  transformIndexHtml(html) {
    return html.replace(
      "connect-src 'self' blob: data:",
      "connect-src 'self' blob: data: ws://localhost:5174",
    );
  },
};

// Relative base so the built files load from file:// inside the packaged app.
export default defineConfig({
  plugins: [react(), devCsp],
  base: "./",
  // The one number the interface reports about itself. Read from package.json
  // so the About row and a .svxp's writer stamp can never drift from the
  // version electron-builder actually ships.
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  server: { port: 5174, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true, target: "chrome128" },
});
