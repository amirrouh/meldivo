import { createReadStream } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react(), {
    name: "local-voice-assets",
    configureServer(server) {
      // ORT dynamically imports its runtime. Serve these generated files as
      // static assets in development, just as the production server does.
      const assets = new Set(["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm", "silero_vad_v5.onnx", "vad.worklet.bundle.min.js"]);
      server.middlewares.use((req, res, next) => {
        const path = new URL(req.url || "/", "http://localhost").pathname;
        const name = path.slice("/voice-assets/".length);
        if (!path.startsWith("/voice-assets/") || !assets.has(name)) return next();
        res.setHeader("Content-Type", name.endsWith("wasm") ? "application/wasm" : name.endsWith("onnx") ? "application/octet-stream" : "text/javascript");
        const file = createReadStream(resolve(server.config.publicDir, "voice-assets", name));
        file.on("error", () => { res.statusCode = 404; res.end(); });
        file.pipe(res);
      });
    },
  }],
  build: { outDir: "../dist/web", emptyOutDir: true },
  server: { port: 5190, proxy: { "/api": "http://localhost:4100" } },
});
