// npm run voice:prepare
//
// For every recording in voice-samples/ (mp3, wav, m4a, flac, ogg, webm):
//   1. convert to 16-bit mono WAV at 44.1 kHz (what ElevenLabs cloning works best with)
//   2. trim leading and trailing silence
//   3. loudness-normalize to -20 LUFS (EBU R128 loudnorm, true peak -1.5 dB)
//   4. measure the result and reject clips that are too short, clipped, or have
//      a noisy / music-filled background (low speech-to-floor ratio)
// and write voice-samples/prepared/<name>.wav plus <name>.txt with its transcript
// (from a .txt next to the source, else from the file name).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import ffmpegPath from "ffmpeg-static";

const SRC = "voice-samples";
const OUT = join(SRC, "prepared");
const RATE = 44100;
const AUDIO = new Set([".mp3", ".wav", ".m4a", ".flac", ".ogg", ".webm", ".aac"]);

const MIN_SECONDS = 1.0;
const MIN_SNR_DB = 18; // speech level vs. the quietest frames; music beds and hiss pull this down
const MAX_CLIPPED = 0.001; // share of samples at full scale

if (!ffmpegPath || !existsSync(ffmpegPath)) {
  console.error("ffmpeg binary not found (ffmpeg-static). Run `npm install` again.");
  process.exit(1);
}
if (!existsSync(SRC)) {
  console.error(`No ${SRC}/ folder. Put your recordings there.`);
  process.exit(1);
}
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const files = readdirSync(SRC).filter((f) => AUDIO.has(extname(f).toLowerCase()));
if (!files.length) {
  console.error(`No audio files in ${SRC}/.`);
  process.exit(1);
}

let total = 0;
const rows: string[][] = [];
for (const file of files) {
  const name = basename(file, extname(file));
  const src = join(SRC, file);
  const dst = join(OUT, `${name}.wav`);
  const trim =
    "silenceremove=start_periods=1:start_threshold=-42dB:start_silence=0.08," +
    "areverse,silenceremove=start_periods=1:start_threshold=-42dB:start_silence=0.12,areverse";
  const norm = "loudnorm=I=-20:TP=-1.5:LRA=11";
  execFileSync(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", "-i", src, "-af", `${trim},${norm}`, "-ac", "1", "-ar", String(RATE), "-c:a", "pcm_s16le", dst]);

  const stats = analyse(readWav(dst));
  const problems: string[] = [];
  if (stats.seconds < MIN_SECONDS) problems.push(`too short (${stats.seconds.toFixed(1)} s)`);
  if (stats.snrDb < MIN_SNR_DB) problems.push(`noisy or music in background (speech/floor ${stats.snrDb.toFixed(0)} dB < ${MIN_SNR_DB})`);
  if (stats.clipped > MAX_CLIPPED) problems.push(`clipped (${(stats.clipped * 100).toFixed(2)} % of samples)`);

  const sidecar = join(SRC, `${name}.txt`);
  const transcript = existsSync(sidecar) ? readFileSync(sidecar, "utf8").trim() : transcriptFromName(name);

  if (problems.length) {
    rmSync(dst, { force: true });
    rows.push([file, `${stats.seconds.toFixed(1)} s`, `${stats.snrDb.toFixed(0)} dB`, `REJECTED: ${problems.join("; ")}`]);
    continue;
  }
  writeFileSync(join(OUT, `${name}.txt`), `${transcript}\n`);
  total += stats.seconds;
  rows.push([file, `${stats.seconds.toFixed(1)} s`, `${stats.snrDb.toFixed(0)} dB`, `ok  "${transcript.slice(0, 60)}${transcript.length > 60 ? "…" : ""}"`]);
}

console.log("\nfile | length | speech/floor | result");
for (const r of rows) console.log(r.join(" | "));
console.log(`\nAccepted: ${total.toFixed(1)} s of speech in ${OUT}/`);
if (total < 10) console.warn("Less than 10 s accepted: cloning will sound generic. Add more clean recordings.");
else if (total < 60)
  console.warn("Tip: 1-3 minutes of clean, varied speech (different moods, questions, laughs) gives a much more natural clone than ~12 s.");

// ---------------------------------------------------------------------------

function transcriptFromName(name: string): string {
  const t = name.replace(/[-_]+/g, " ").replace(/\bi m\b/gi, "I'm").replace(/\bi\b/g, "I").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function readWav(path: string): { samples: Int16Array; rate: number } {
  const buf = readFileSync(path);
  let off = 12;
  let rate = RATE;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "fmt ") rate = buf.readUInt32LE(off + 12);
    if (id === "data") {
      const data = buf.subarray(off + 8, off + 8 + size);
      return { samples: new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.length)), rate };
    }
    off += 8 + size + (size % 2);
  }
  throw new Error(`${path}: no data chunk`);
}

function analyse({ samples, rate }: { samples: Int16Array; rate: number }) {
  const frame = Math.round(rate * 0.02);
  const db: number[] = [];
  let clipped = 0;
  for (let i = 0; i + frame <= samples.length; i += frame) {
    let sum = 0;
    for (let j = i; j < i + frame; j++) {
      const v = samples[j]! / 32768;
      sum += v * v;
      if (Math.abs(samples[j]!) >= 32767) clipped++;
    }
    db.push(10 * Math.log10(sum / frame + 1e-10));
  }
  const sorted = [...db].sort((a, b) => a - b);
  const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? -100;
  return {
    seconds: samples.length / rate,
    snrDb: pct(0.9) - pct(0.08),
    clipped: clipped / Math.max(1, samples.length),
  };
}
