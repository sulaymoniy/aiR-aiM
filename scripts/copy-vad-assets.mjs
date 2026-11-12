// Copies the Silero VAD model, its audio worklet and the onnxruntime-web WASM
// files into client/public/vad so the browser loads them from our own origin
// (no CDN at runtime). Runs automatically after `npm install`.
import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dest = join(root, "client", "public", "vad");
mkdirSync(dest, { recursive: true });

const sources = [
  { dir: join(root, "node_modules", "@ricky0123", "vad-web", "dist"), match: (f) => f.endsWith(".onnx") || f.endsWith(".worklet.bundle.min.js") },
  { dir: join(root, "node_modules", "onnxruntime-web", "dist"), match: (f) => /^ort-wasm.*\.(wasm|mjs)$/.test(f) },
];

let copied = 0;
for (const { dir, match } of sources) {
  if (!existsSync(dir)) {
    console.warn(`[copy-vad-assets] missing ${dir} (skipped)`);
    continue;
  }
  for (const file of readdirSync(dir)) {
    if (!match(file)) continue;
    cpSync(join(dir, file), join(dest, file));
    copied++;
  }
}
console.log(`[copy-vad-assets] copied ${copied} files to client/public/vad`);
