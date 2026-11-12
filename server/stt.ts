// Deepgram live speech-to-text with interim results, endpointing and VAD events.
import WebSocket from "ws";
import { MIC_SAMPLE_RATE } from "../shared/protocol.ts";
import type { Config } from "./config.ts";

export interface SttResult {
  transcript: string;
  isFinal: boolean;
  speechFinal: boolean;
  start: number; // seconds since this Deepgram stream started
  end: number;
}

export interface SttHandlers {
  onResult(r: SttResult): void;
  onUtteranceEnd(): void;
  onSpeechStarted(): void;
  onStatus(ok: boolean, detail?: string): void;
}

interface DgMessage {
  type: string;
  is_final?: boolean;
  speech_final?: boolean;
  start?: number;
  duration?: number;
  channel?: { alternatives?: { transcript?: string }[] };
}

export class Stt {
  private ws: WebSocket | null = null;
  private keepAlive: NodeJS.Timeout | null = null;
  private lastAudio = 0;
  private stopped = false;
  private retries = 0;
  /** Seconds of audio sent on the current Deepgram stream (its clock). */
  audioSec = 0;

  constructor(private cfg: Config, private handlers: SttHandlers) {}

  connect() {
    this.stopped = false;
    const params = new URLSearchParams({
      model: "nova-3",
      language: "en",
      encoding: "linear16",
      sample_rate: String(MIC_SAMPLE_RATE),
      channels: "1",
      interim_results: "true",
      smart_format: "true",
      punctuate: "true",
      endpointing: String(this.cfg.endpointMs),
      utterance_end_ms: String(this.cfg.utteranceEndMs),
      vad_events: "true",
    });
    const ws = new WebSocket(`${this.cfg.deepgramWsBase}/v1/listen?${params}`, {
      headers: { Authorization: `Token ${this.cfg.deepgramKey}` },
    });
    this.ws = ws;
    this.audioSec = 0;
    ws.on("open", () => {
      this.retries = 0;
      this.handlers.onStatus(true);
      this.keepAlive = setInterval(() => {
        if (Date.now() - this.lastAudio > 4000 && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "KeepAlive" }));
      }, 4000);
    });
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      let msg: DgMessage;
      try {
        msg = JSON.parse(data.toString()) as DgMessage;
      } catch {
        return;
      }
      if (msg.type === "Results") {
        const start = msg.start ?? 0;
        this.handlers.onResult({
          transcript: msg.channel?.alternatives?.[0]?.transcript ?? "",
          isFinal: !!msg.is_final,
          speechFinal: !!msg.speech_final,
          start,
          end: start + (msg.duration ?? 0),
        });
      } else if (msg.type === "UtteranceEnd") this.handlers.onUtteranceEnd();
      else if (msg.type === "SpeechStarted") this.handlers.onSpeechStarted();
    });
    ws.on("error", (err) => this.handlers.onStatus(false, err.message));
    ws.on("close", (code) => {
      if (this.keepAlive) clearInterval(this.keepAlive);
      this.keepAlive = null;
      if (this.ws === ws) this.ws = null;
      if (this.stopped) return;
      // reconnect with backoff
      this.handlers.onStatus(false, `speech recognition disconnected (${code}), reconnecting`);
      const delay = Math.min(5000, 300 * 2 ** this.retries++);
      setTimeout(() => {
        if (!this.stopped) this.connect();
      }, delay);
    });
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(pcm: Buffer) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(pcm);
    this.lastAudio = Date.now();
    this.audioSec += pcm.length / 2 / MIC_SAMPLE_RATE;
  }

  close() {
    this.stopped = true;
    if (this.keepAlive) clearInterval(this.keepAlive);
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "CloseStream" }));
      setTimeout(() => ws.close(), 300);
    } else ws?.terminate();
  }
}
