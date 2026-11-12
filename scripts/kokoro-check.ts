// npm run kokoro:check: downloads the Kokoro model once and times a sentence.
import { KokoroTTS } from "kokoro-js";

const voice = process.env.KOKORO_VOICE || "am_puck";
let t = performance.now();
const tts = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", { dtype: (process.env.KOKORO_DTYPE || "q8") as "q8", device: "cpu" });
console.log(`model loaded in ${Math.round(performance.now() - t)} ms`);
for (const text of ["Oh, come on.", "All right, well, I'm gonna go get dressed for the dance."]) {
  t = performance.now();
  const audio = await tts.generate(text, { voice: voice as "am_puck" });
  const ms = Math.round(performance.now() - t);
  console.log(`"${text}" -> ${(audio.audio.length / audio.sampling_rate).toFixed(2)} s of audio @${audio.sampling_rate} Hz in ${ms} ms`);
}
const males = Object.entries(tts.voices).filter(([id]) => id.startsWith("am_")).map(([id, v]) => `${id} (${(v as { traits?: string; overallGrade: string }).overallGrade})`);
console.log("american male voices:", males.join(", "));

