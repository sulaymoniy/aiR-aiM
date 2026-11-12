import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import type { ClientMessage } from "../shared/protocol.ts";
import { config } from "./config.ts";
import { loadKokoro } from "./kokoro.ts";
import { Session } from "./session.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".riv": "application/octet-stream",
  ".onnx": "application/octet-stream",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
};

// Production: serve the built frontend from dist/. In development Vite serves it
// and proxies /ws here.
const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, voice: config.voiceKind }));
    return;
  }
  if (!existsSync(dist)) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Frontend not built. In development open the Vite URL (npm run dev); for production run npm run build first.");
    return;
  }
  let path = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
  if (path.includes("..")) {
    res.writeHead(400);
    res.end();
    return;
  }
  let file = join(dist, path || "index.html");
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(dist, "index.html");
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
});

const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 1 << 20 });

wss.on("connection", (ws) => {
  const session = new Session(ws, config);
  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      session.handleAudio(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
      return;
    }
    let msg: ClientMessage;
    try {
      msg = JSON.parse(data.toString()) as ClientMessage;
    } catch {
      return;
    }
    try {
      session.handleMessage(msg);
    } catch (err) {
      console.error("[session]", err);
    }
  });
  ws.on("close", () => session.close());
  ws.on("error", () => session.close());
});

server.listen(config.port, () => {
  // only the keys the selected providers need
  const missing = [
    !config.anthropicKey && "ANTHROPIC_API_KEY",
    config.sttProvider === "deepgram" && !config.deepgramKey && "DEEPGRAM_API_KEY",
    config.ttsProvider === "elevenlabs" && !config.elevenKey && "ELEVENLABS_API_KEY",
  ].filter(Boolean);
  console.log(`[server] listening on http://localhost:${config.port}  (WebSocket /ws)`);
  const voice = config.ttsProvider === "kokoro" ? `kokoro ${config.kokoroVoice} (${config.kokoroDtype})` : `elevenlabs ${config.voiceKind} ${config.voiceId}`;
  console.log(`[server] stt: ${config.sttProvider} | tts: ${voice} | llm: ${config.claudeModel}`);
  if (missing.length) console.warn(`[server] missing in .env: ${missing.join(", ")}`);
  if (config.ttsProvider === "kokoro") {
    console.log("[kokoro] loading voice model (first run downloads it from Hugging Face)…");
    loadKokoro(config).catch(() => {});
  }
});
