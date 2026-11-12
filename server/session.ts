// One conversation = one browser WebSocket. Orchestrates:
//   mic audio -> Deepgram (partials, endpointing) -> turn detection
//   -> Claude (streamed structured sentences) -> ElevenLabs (streamed audio + timing)
//   -> browser, with barge-in, echo guarding and per-session history.
import type { WebSocket } from "ws";
import type { ClientMessage, ConversationState, Emotion, ServerMessage } from "../shared/protocol.ts";
import type { Config } from "./config.ts";
import { Brain, type Turn } from "./llm.ts";
import { Stt, type SttResult } from "./stt.ts";
import { KokoroTts, kokoroReady } from "./kokoro.ts";
import { type Alignment, type TtsHandlers, type TtsLike, TtsStream } from "./tts.ts";

const FILLER_ONLY = /^(?:(?:um+|uh+|hmm+|mm+|ah+|er+|erm|oh|huh)[\s.,!?…-]*)+$/i;
const ENDS_MID_THOUGHT = /(?:,|…|\.\.\.|\b(?:and|but|so|or|because|cause|like|um|uh|the|a|an|to|of|with|if|then|that|which|my|your|i|i'm|is|was|are|for|about|just|maybe))\s*[.,]?$/i;
const MAX_HISTORY_TURNS = 60; // keep the request small; older turns fall off

interface Reply {
  id: number;
  abort: AbortController;
  tts: TtsLike | null;
  endpointAt: number;
  sentText: string; // everything sent to the TTS, in order
  pendingWord: string; // text not yet sent (partial word)
  markers: { charIdx: number; emotion: Emotion; sent: boolean }[];
  sentences: { emotion: Emotion; text: string }[];
  alignChars: string[];
  alignStarts: number[]; // ms from the start of this reply's audio
  audioMs: number;
  audioStarted: boolean;
  llmDone: boolean;
  ttsDone: boolean;
  firstTokenMs?: number;
  firstTextMs?: number;
  finished: boolean; // committed to history or cancelled
}

export class Session {
  private history: Turn[] = [];
  private brain: Brain;
  private stt: Stt | null = null;
  private active = false;
  private muted = false;
  private state: ConversationState = "idle";
  private finals: string[] = [];
  private interim = "";
  private commitTimer: NodeJS.Timeout | null = null;
  private reply: Reply | null = null;
  private replySeq = 0;
  private interruptedNote = false;
  /** While the character talks, transcripts are held (they may be its own echo). */
  private held: SttResult[] = [];
  private acceptAfterSec = 0;
  private userSpeaking = false;

  constructor(private ws: WebSocket, private cfg: Config) {
    this.brain = new Brain(cfg);
    this.send({
      type: "hello",
      stt: cfg.sttProvider,
      tts: cfg.ttsProvider,
      sttReady: cfg.sttProvider === "browser" || !!cfg.deepgramKey,
      ttsReady: cfg.ttsProvider === "kokoro" ? kokoroReady() : !!cfg.elevenKey,
      llmReady: !!cfg.anthropicKey,
    });
  }

  /** Clock for matching transcripts to playback: Deepgram's audio time, or wall time for browser STT. */
  private clock() {
    return this.cfg.sttProvider === "deepgram" ? (this.stt?.audioSec ?? 0) : performance.now() / 1000;
  }

  // ---------------------------------------------------------------- inbound

  handleMessage(msg: ClientMessage) {
    switch (msg.type) {
      case "start":
        if (this.active) return;
        this.active = true;
        this.history = [];
        this.setState("listening");
        if (msg.greet) {
          this.pushUser("[conversation started]");
          this.startReply();
        }
        break;
      case "stop":
        this.stop();
        break;
      case "text": {
        const text = msg.text.trim().slice(0, 2000);
        if (!text) return;
        if (!this.active) {
          this.active = true;
          this.setState("listening");
        }
        this.clearPending();
        this.supersedeReply();
        this.send({ type: "user_final", text });
        this.pushUser(text);
        this.startReply();
        break;
      }
      case "interrupt":
        if (this.reply && this.reply.id === msg.replyId) this.interrupt(msg.playedMs);
        break;
      case "playback_done":
        if (this.reply && this.reply.id === msg.replyId) {
          this.commitAssistant(this.reply, msg.playedMs, false);
          this.reply = null;
          this.held = []; // anything heard while it talked was its own voice
          // browser STT delivers late: also drop what arrives in the next 0.8 s (its tail echo)
          this.acceptAfterSec = this.clock() + (this.cfg.sttProvider === "browser" ? 0.8 : 0);
          this.setState("listening");
        }
        break;
      case "mute":
        this.muted = msg.muted;
        break;
      case "stt_result": {
        if (!this.active || this.muted || this.cfg.sttProvider !== "browser") return;
        const now = this.clock();
        // end of a recognized phrase = end of speech; turn logic below still holds mid-thought pauses
        this.onStt({ transcript: msg.text.slice(0, 2000), isFinal: msg.isFinal, speechFinal: msg.isFinal, start: now, end: now });
        break;
      }
      case "vad":
        this.userSpeaking = msg.speaking;
        if (msg.speaking && this.commitTimer) {
          // the user picked up again before we committed: keep listening
          clearTimeout(this.commitTimer);
          this.commitTimer = null;
        }
        break;
    }
  }

  handleAudio(pcm: Buffer) {
    if (!this.active || this.muted || this.cfg.sttProvider !== "deepgram" || !this.cfg.deepgramKey) return;
    if (!this.stt) {
      this.stt = new Stt(this.cfg, {
        onResult: (r) => this.onStt(r),
        onUtteranceEnd: () => this.scheduleCommit(true),
        onSpeechStarted: () => {
          if (this.commitTimer && !this.isTalking()) {
            clearTimeout(this.commitTimer);
            this.commitTimer = null;
          }
        },
        onStatus: (ok, detail) => {
          if (!ok && detail) this.send({ type: "error", message: detail, recoverable: true });
        },
      });
      this.stt.connect();
    }
    this.stt.send(pcm);
  }

  close() {
    this.stop();
  }

  // ---------------------------------------------------------- turn taking

  private isTalking() {
    return !!this.reply && this.reply.audioStarted && !this.reply.finished;
  }

  private onStt(r: SttResult) {
    if (r.end <= this.acceptAfterSec) return;
    if (this.isTalking()) {
      // Could be the character's own voice leaking into the mic. Hold it until
      // the browser either reports a barge-in (then we use it) or playback ends.
      if (r.isFinal && r.transcript) this.held.push(r);
      return;
    }
    this.applyResult(r);
  }

  private applyResult(r: SttResult) {
    const text = r.transcript.trim();
    if (r.isFinal) {
      if (text) this.finals.push(text);
      this.interim = "";
    } else {
      this.interim = text;
    }
    const live = [...this.finals, this.interim].join(" ").trim();
    if (text) {
      this.send({ type: "user_partial", text: live });
      // The user kept talking after we had already ended their turn and the
      // reply has not started playing: drop the reply and keep listening.
      if (this.reply && !this.reply.audioStarted && !this.reply.finished && this.isRealSpeech(text)) {
        this.cancelReply(this.reply);
        this.reply = null;
        this.setState("listening");
      }
      if (this.commitTimer) {
        clearTimeout(this.commitTimer);
        this.commitTimer = null;
      }
    }
    if (r.speechFinal) this.scheduleCommit(false);
  }

  private isRealSpeech(text: string) {
    return !FILLER_ONLY.test(text) && text.split(/\s+/).length >= 2;
  }

  /** End of the user's turn, unless the words so far sound unfinished. */
  private scheduleCommit(utteranceEnd: boolean) {
    const text = this.finals.join(" ").trim();
    if (!text || this.commitTimer) return;
    if (this.userSpeaking && !utteranceEnd) return; // VAD says they are still talking
    const wait = ENDS_MID_THOUGHT.test(text) && !utteranceEnd ? this.cfg.continuationHoldMs : 0;
    this.commitTimer = setTimeout(() => {
      this.commitTimer = null;
      this.commitTurn();
    }, wait);
  }

  private commitTurn() {
    const text = this.finals.join(" ").trim();
    this.finals = [];
    this.interim = "";
    if (!text || FILLER_ONLY.test(text) || text.replace(/[^a-z0-9]/gi, "").length < 2) return; // noise
    this.supersedeReply();
    this.send({ type: "user_final", text });
    this.pushUser(text);
    this.startReply();
  }

  private clearPending() {
    if (this.commitTimer) clearTimeout(this.commitTimer);
    this.commitTimer = null;
    this.finals = [];
    this.interim = "";
  }

  // ---------------------------------------------------------------- reply

  private startReply() {
    const id = ++this.replySeq;
    const reply: Reply = {
      id,
      abort: new AbortController(),
      tts: null,
      endpointAt: performance.now(),
      sentText: "",
      pendingWord: "",
      markers: [],
      sentences: [],
      alignChars: [],
      alignStarts: [],
      audioMs: 0,
      audioStarted: false,
      llmDone: false,
      ttsDone: false,
      finished: false,
    };
    this.reply = reply;
    this.send({ type: "turn", replyId: id });
    this.setState("thinking");

    // (No ANTHROPIC_API_KEY is fine if `ant auth login` set up a profile: the SDK finds it.)
    // Open the voice socket now, in parallel with the LLM call.
    if (this.cfg.ttsProvider === "kokoro" || this.cfg.elevenKey) reply.tts = this.openTts(reply);

    const messages = this.requestMessages();
    this.brain
      .reply(
        messages,
        {
          onFirstToken: () => (reply.firstTokenMs = performance.now() - reply.endpointAt),
          onSentenceStart: (i, emotion) => {
            if (reply.finished) return;
            if (i === 0) this.send({ type: "reply_start", replyId: id, emotion });
            reply.markers.push({ charIdx: reply.sentText.length + reply.pendingWord.length, emotion, sent: false });
          },
          onTextDelta: (_i, delta) => {
            if (reply.finished) return;
            reply.pendingWord += delta;
            const cut = reply.pendingWord.lastIndexOf(" ");
            if (cut > 0) {
              this.ttsSend(reply, reply.pendingWord.slice(0, cut + 1), false);
              reply.pendingWord = reply.pendingWord.slice(cut + 1);
            }
          },
          onSentenceEnd: (i, text, emotion) => {
            if (reply.finished) return;
            if (reply.firstTextMs === undefined) reply.firstTextMs = performance.now() - reply.endpointAt;
            const rest = reply.pendingWord;
            reply.pendingWord = "";
            this.ttsSend(reply, `${rest} `, true);
            reply.sentences[i] = { emotion, text };
            this.send({ type: "reply_text", replyId: id, index: i, emotion, text });
          },
        },
        reply.abort.signal,
      )
      .then((result) => {
        if (reply.finished) return;
        reply.llmDone = true;
        if (result.stopReason === "refusal" || result.sentences.length === 0) {
          this.fail(reply, result.stopReason === "refusal" ? "The model declined to answer that." : "Empty reply.");
          return;
        }
        if (reply.tts) reply.tts.finish();
        else this.finishWithoutAudio(reply);
      })
      .catch((err: unknown) => {
        if (reply.finished || reply.abort.signal.aborted) return;
        console.error("[llm]", err);
        this.fail(reply, `The brain hiccuped: ${err instanceof Error ? err.message : String(err)}`);
      });
  }

  private openTts(reply: Reply): TtsLike {
    const handlers: TtsHandlers = {
      onAudio: (pcm, alignment) => {
        if (reply.finished) return;
        const chunkStart = reply.audioMs;
        if (alignment) this.addAlignment(reply, alignment, chunkStart);
        const header = Buffer.alloc(4);
        header.writeUInt32LE(reply.id, 0);
        this.sendBinary(Buffer.concat([header, pcm]));
        reply.audioMs += (pcm.length / 2 / 24000) * 1000;
        if (!reply.audioStarted) {
          reply.audioStarted = true;
          this.setState("speaking");
          this.send({
            type: "metrics",
            replyId: reply.id,
            endpointToFirstTokenMs: reply.firstTokenMs,
            endpointToFirstTextMs: reply.firstTextMs,
            endpointToFirstAudioMs: performance.now() - reply.endpointAt,
          });
        }
      },
      onFinal: () => {
        reply.ttsDone = true;
        if (!reply.finished) this.send({ type: "reply_end", replyId: reply.id, totalAudioMs: reply.audioMs });
      },
      onError: (err) => {
        console.error("[tts]", err.message);
        if (reply.finished) return;
        if (!reply.audioStarted) {
          // No voice: still show the text reply so the conversation goes on.
          this.send({ type: "error", message: `Voice failed: ${err.message}`, recoverable: true });
          reply.tts = null;
          if (reply.llmDone) this.finishWithoutAudio(reply);
        } else {
          this.send({ type: "reply_end", replyId: reply.id, totalAudioMs: reply.audioMs });
        }
      },
    };
    return this.cfg.ttsProvider === "kokoro" ? new KokoroTts(this.cfg, handlers) : new TtsStream(this.cfg, handlers);
  }

  private ttsSend(reply: Reply, text: string, flush: boolean) {
    if (!text.trim() && !flush) return;
    reply.sentText += text;
    reply.tts?.send(text, flush);
  }

  private addAlignment(reply: Reply, a: Alignment, offsetMs: number) {
    const starts = a.startsMs.map((s) => s + offsetMs);
    reply.alignChars.push(...a.chars);
    reply.alignStarts.push(...starts);
    this.send({ type: "alignment", replyId: reply.id, chars: a.chars, startsMs: starts, dursMs: a.dursMs, approximate: a.approximate });
    for (const m of reply.markers) {
      if (m.sent || m.charIdx >= reply.alignChars.length) continue;
      m.sent = true;
      const at = reply.alignStarts[Math.min(m.charIdx, reply.alignStarts.length - 1)] ?? offsetMs;
      this.send({ type: "emotion", replyId: reply.id, emotion: m.emotion, atMs: at });
    }
  }

  /** Voice unavailable: the reply is text only, commit it right away. */
  private finishWithoutAudio(reply: Reply) {
    this.send({ type: "reply_end", replyId: reply.id, totalAudioMs: 0 });
    this.commitAssistant(reply, Infinity, false);
    if (this.reply === reply) this.reply = null;
    this.setState("listening");
  }

  private interrupt(playedMs: number) {
    const reply = this.reply;
    if (!reply) return;
    this.cancelReply(reply, playedMs);
    this.reply = null;
    // The barge-in speech started roughly 0.6 s before the browser told us.
    this.acceptAfterSec = Math.max(0, this.clock() - 1.2);
    const keep = this.held.filter((r) => r.end > this.acceptAfterSec);
    this.held = [];
    for (const r of keep) this.applyResult(r);
    this.setState("listening");
  }

  /** A new user turn arrived while a reply exists (typed text, or STT without a barge-in). */
  private supersedeReply() {
    const reply = this.reply;
    if (!reply || reply.finished) return;
    this.cancelReply(reply, reply.audioStarted ? reply.audioMs : 0);
    this.reply = null;
  }

  /** Stop LLM + TTS. Records only what was heard (playedMs of audio). */
  private cancelReply(reply: Reply, playedMs = 0) {
    if (reply.finished) return;
    reply.abort.abort();
    reply.tts?.close();
    this.send({ type: "reply_cancelled", replyId: reply.id });
    if (playedMs > 0) this.commitAssistant(reply, playedMs, true);
    reply.finished = true;
  }

  private commitAssistant(reply: Reply, playedMs: number, interrupted: boolean) {
    if (reply.finished) return;
    reply.finished = true;
    let sentences = reply.sentences.filter(Boolean);
    if (interrupted || (Number.isFinite(playedMs) && reply.alignChars.length && playedMs < reply.audioMs - 150)) {
      // keep only the characters whose audio had started playing
      let n = 0;
      while (n < reply.alignStarts.length && reply.alignStarts[n]! <= playedMs) n++;
      const heard = reply.alignChars.slice(0, n).join("");
      sentences = splitHeard(heard, reply.markers);
      if (sentences.length && interrupted) {
        const last = sentences[sentences.length - 1]!;
        last.text = `${last.text.trimEnd()}—`;
      }
      if (interrupted) this.interruptedNote = true;
    }
    if (!sentences.length) return;
    this.history.push({ role: "assistant", content: JSON.stringify({ sentences }) });
  }

  private pushUser(text: string) {
    this.history.push({ role: "user", content: text });
    if (this.interruptedNote) {
      this.interruptedNote = false;
      // Mid-conversation system message: must directly follow a user message.
      this.history.push({
        role: "system",
        content: "Note: the user interrupted your previous reply. Your recorded reply above is only the part they heard before cutting you off.",
      } as unknown as Turn);
    }
    if (this.history.length > MAX_HISTORY_TURNS) {
      // drop from the front, keeping the first message a user turn
      let cut = this.history.length - MAX_HISTORY_TURNS;
      while (cut < this.history.length && this.history[cut]!.role !== "user") cut++;
      this.history = this.history.slice(cut);
    }
  }

  private requestMessages(): Turn[] {
    return this.history.slice();
  }

  private fail(reply: Reply, message: string) {
    if (!reply.finished) {
      reply.abort.abort();
      reply.tts?.close();
      reply.finished = true;
      this.send({ type: "reply_cancelled", replyId: reply.id });
    }
    if (this.reply === reply) this.reply = null;
    this.send({ type: "error", message, recoverable: true });
    this.setState(this.active ? "listening" : "idle");
  }

  private stop() {
    this.active = false;
    this.clearPending();
    if (this.reply) this.cancelReply(this.reply, this.reply.audioStarted ? this.reply.audioMs : 0);
    this.reply = null;
    this.stt?.close();
    this.stt = null;
    this.held = [];
    this.setState("idle");
  }

  // ---------------------------------------------------------------- output

  private setState(state: ConversationState) {
    if (this.state === state) return;
    this.state = state;
    this.send({ type: "state", state });
  }

  private send(msg: ServerMessage) {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private sendBinary(buf: Buffer) {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(buf, { binary: true });
  }
}

/** Split the heard text back into sentences with their emotions (by TTS char index). */
function splitHeard(heard: string, markers: Reply["markers"]): { emotion: Emotion; text: string }[] {
  const out: { emotion: Emotion; text: string }[] = [];
  for (let i = 0; i < markers.length; i++) {
    const from = markers[i]!.charIdx;
    if (from >= heard.length) break;
    const to = Math.min(heard.length, markers[i + 1]?.charIdx ?? heard.length);
    const text = heard.slice(from, to).trim();
    if (text) out.push({ emotion: markers[i]!.emotion, text });
  }
  if (!out.length && heard.trim()) out.push({ emotion: "neutral", text: heard.trim() });
  return out;
}
