import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

// Where the Node server listens (not PORT: dev launchers set PORT for Vite itself).
const serverPort = Number(process.env.SERVER_PORT ?? 8787);

/**
 * onnxruntime-web (used by the Silero VAD) dynamically imports its loader from
 * /vad/*.mjs. Vite's dev server refuses to serve public/ files as modules, so
 * serve that folder raw, ahead of Vite's own middleware. (Production is plain
 * static files and needs nothing special.)
 */
function serveVadRaw(): Plugin {
  const dir = resolve(import.meta.dirname, "client/public/vad");
  const types: Record<string, string> = { ".mjs": "text/javascript", ".js": "text/javascript", ".wasm": "application/wasm", ".onnx": "application/octet-stream" };
  return {
    name: "serve-vad-raw",
    configureServer(server) {
      server.middlewares.use("/vad", (req, res, next) => {
        const rel = normalize(decodeURIComponent((req.url ?? "/").split("?")[0]!)).replace(/^[/\\]+/, "");
        const file = join(dir, rel);
        if (!rel || rel.includes("..") || !existsSync(file) || statSync(file).isDirectory()) return next();
        res.setHeader("Content-Type", types[extname(file)] ?? "application/octet-stream");
        createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  root: "client",
  publicDir: "public",
  plugins: [serveVadRaw()],
  server: {
    port: 5173,
    // Browsers only allow the microphone on https or localhost.
    host: "localhost",
    proxy: {
      "/ws": { target: `ws://localhost:${serverPort}`, ws: true },
    },
  },
  build: {
    outDir: resolve(import.meta.dirname, "dist"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "client/index.html"),
        debug: resolve(import.meta.dirname, "client/debug.html"),
      },
    },
  },
});
