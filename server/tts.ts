// ElevenLabs streaming text-to-speech over WebSocket ("stream-input"):
// text goes in word by word, 24 kHz PCM comes back with per-character timing.
import WebSocket from "ws";
import type { Config } from "./config.ts";

export interface Alignment {
  chars: string[];
  startsMs: number[];
  dursMs: number[];
  /** Estimated from text length, not measured (Kokoro): fine for captions, not for visemes. */
  approximate?: boolean;
}

/** What the session needs from any voice: text in (word chunks, flush at sentence end), audio out. */
export interface TtsLike {
  send(text: string, flush?: boolean): void;
  finish(): void;
  close(): void;
}

export interface TtsHandlers {
  onAudio(pcm: Buffer, alignment: Alignment | null): void;
  onFinal(): void;
  onError(err: Error): void;
}

interface ElevenMessage {
  audio?: string | null;
  isFinal?: boolean | null;
  alignment?: { chars: string[]; charStartTimesMs: number[]; charDurationsMs: number[] } | null;
  normalizedAlignment?: { chars: string[]; charStartTimesMs: number[]; charDurationsMs: number[] } | null;
  error?: string;
  message?: string;
}

export class TtsStream implements TtsLike {
  private ws: WebSocket;
  private queue: string[] = [];
  private isOpen = false;
  private closed = false;
  private finished = false;

  constructor(cfg: Config, private handlers: TtsHandlers) {
    const params = new URLSearchParams({
      model_id: cfg.ttsModel,
      output_format: "pcm_24000",
      sync_alignment: "true",
      inactivity_timeout: "60",
    });
    this.ws = new WebSocket(`${cfg.elevenWsBase}/v1/text-to-speech/${encodeURIComponent(cfg.voiceId)}/stream-input?${params}`, {
      headers: { "xi-api-key": cfg.elevenKey },
    });
    this.ws.on("open", () => {
      this.isOpen = true;
      this.ws.send(
        JSON.stringify({
          text: " ",
          voice_settings: cfg.voiceSettings,
          // Start generating after ~50 characters so the first words come out fast;
          // every sentence end is flushed explicitly anyway.
          generation_config: { chunk_length_schedule: [50, 90, 140, 200] },
        }),
      );
      for (const m of this.queue) this.ws.send(m);
      this.queue = [];
    });
    this.ws.on("message", (data) => this.onMessage(data.toString()));
    this.ws.on("error", (err) => {
      if (!this.closed) this.handlers.onError(err);
    });
    this.ws.on("close", (code, reason) => {
      if (!this.closed && !this.finished && code !== 1000) {
        this.handlers.onError(new Error(`TTS socket closed (${code}) ${reason.toString()}`));
      }
      this.closed = true;
    });
  }

  /** Send text; it should end on a word boundary. `flush` forces generation now (sentence end). */
  send(text: string, flush = false) {
    if (this.closed || !text) return;
    const t = text.endsWith(" ") ? text : `${text} `;
    this.raw({ text: t, flush });
  }

  /** No more text: ElevenLabs finishes the audio and sends isFinal. */
  finish() {
    if (this.closed) return;
    this.raw({ text: "" });
  }

  /** Stop immediately (barge-in). */
  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws.close(1000);
    } catch {
      this.ws.terminate();
    }
  }

  private raw(obj: unknown) {
    const msg = JSON.stringify(obj);
    if (this.isOpen && this.ws.readyState === WebSocket.OPEN) this.ws.send(msg);
    else this.queue.push(msg);
  }

  private onMessage(text: string) {
    if (this.closed) return;
    let msg: ElevenMessage;
    try {
      msg = JSON.parse(text) as ElevenMessage;
    } catch {
      return;
    }
    if (msg.error || (msg.message && !msg.audio && !msg.isFinal)) {
      this.handlers.onError(new Error(`TTS: ${msg.error ?? msg.message}`));
      return;
    }
    if (msg.audio) {
      const pcm = Buffer.from(msg.audio, "base64");
      const a = msg.alignment ?? msg.normalizedAlignment;
      const alignment = a ? { chars: a.chars, startsMs: a.charStartTimesMs, dursMs: a.charDurationsMs } : null;
      this.handlers.onAudio(pcm, alignment);
    }
    if (msg.isFinal) {
      this.finished = true;
      this.handlers.onFinal();
      this.close();
    }
  }
}
