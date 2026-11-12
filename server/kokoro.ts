// Kokoro-82M text-to-speech running locally on the CPU (free, no key).
// Text arrives word by word; each sentence (and, for the very first chunk, the
// first clause) is synthesized as soon as it is complete, in order, while the
// browser is already playing the previous one.
import { KokoroTTS } from "kokoro-js";
import type { Config } from "./config.ts";
import type { Alignment, TtsHandlers, TtsLike } from "./tts.ts";

const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
let model: Promise<KokoroTTS> | null = null;
let loaded = false;
let gpu: Promise<unknown> = Promise.resolve(); // one synthesis at a time across sessions (CPU bound)

/** Load once (first run downloads the model from Hugging Face), then warm up. */
export function loadKokoro(cfg: Config): Promise<KokoroTTS> {
  if (!model) {
    const started = performance.now();
    model = KokoroTTS.from_pretrained(MODEL, { dtype: cfg.kokoroDtype, device: "cpu" }).then(async (tts) => {
      await tts.generate("Hi.", { voice: cfg.kokoroVoice as "am_puck" });
      loaded = true;
      console.log(`[kokoro] ${cfg.kokoroDtype} model ready in ${Math.round(performance.now() - started)} ms, voice ${cfg.kokoroVoice}`);
      return tts;
    });
    model.catch((err) => {
      console.error("[kokoro] failed to load:", err);
      model = null;
    });
  }
  return model;
}

export const kokoroReady = () => loaded;

export class KokoroTts implements TtsLike {
  private buf = "";
  private queue: Promise<void> = Promise.resolve();
  private enqueued = 0;
  private closed = false;

  constructor(private cfg: Config, private h: TtsHandlers) {
    loadKokoro(cfg).catch((err: unknown) => h.onError(err instanceof Error ? err : new Error(String(err))));
  }

  send(text: string, flush = false) {
    if (this.closed) return;
    this.buf += text;
    if (flush) {
      this.enqueue(this.buf);
      this.buf = "";
    } else if (this.enqueued === 0) {
      // first words: start on the first clause so the character speaks sooner
      const m = /^(.{12,}?[,;:—])\s/.exec(this.buf);
      if (m) {
        this.enqueue(m[0]);
        this.buf = this.buf.slice(m[0].length);
      }
    }
  }

  finish() {
    if (this.buf.trim()) this.enqueue(this.buf);
    this.buf = "";
    this.queue = this.queue.then(() => {
      if (!this.closed) this.h.onFinal();
    });
  }

  close() {
    this.closed = true;
  }

  private enqueue(raw: string) {
    if (!raw.trim()) return;
    this.enqueued++;
    this.queue = this.queue
      .then(() => this.synth(raw))
      .catch((err: unknown) => {
        if (!this.closed) this.h.onError(err instanceof Error ? err : new Error(String(err)));
      });
  }

  private async synth(raw: string) {
    if (this.closed) return;
    const tts = await loadKokoro(this.cfg);
    if (this.closed) return;
    const job = gpu.then(() => tts.generate(raw.trim(), { voice: this.cfg.kokoroVoice as "am_puck", speed: this.cfg.kokoroSpeed }));
    gpu = job.catch(() => {});
    const audio = await job;
    if (this.closed) return;
    const f = audio.audio;
    const pcm = Buffer.alloc(f.length * 2);
    for (let i = 0; i < f.length; i++) pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(f[i]! * 32767))), i * 2);
    this.h.onAudio(pcm, estimateAlignment(raw, (f.length / audio.sampling_rate) * 1000));
  }
}

/** Kokoro gives no timing: spread the characters over the audio by rough weight. */
function estimateAlignment(text: string, durMs: number): Alignment {
  const chars = [...text];
  const w = chars.map((c) => (/[a-z0-9]/i.test(c) ? 1 : /[.!?]/.test(c) ? 5 : /[,;:—]/.test(c) ? 4 : c === " " ? 0.6 : 0.5));
  const total = w.reduce((a, b) => a + b, 0) || 1;
  const startsMs: number[] = [];
  const dursMs: number[] = [];
  let t = 0;
  for (const x of w) {
    const d = (x / total) * durMs;
    startsMs.push(t);
    dursMs.push(d);
    t += d;
  }
  return { chars, startsMs, dursMs, approximate: true };
}
