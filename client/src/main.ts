import type { MicVAD } from "@ricky0123/vad-web";
import type { ConversationState, Emotion, ServerMessage } from "../../shared/protocol";
import { Mic, Player } from "./audio";
import { Connection } from "./conn";
import { AudioMouth, MOUTH, MOUTH_SPEED_RESTING, MOUTH_SPEED_TALKING, type VisemeEvent, charsToVisemes, visemeAt } from "./mouth";
import { CharacterRig } from "./rig";
import { BrowserSpeech } from "./speech";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  canvas: $<HTMLCanvasElement>("rive"),
  start: $<HTMLButtonElement>("startBtn"),
  mute: $<HTMLButtonElement>("muteBtn"),
  dot: $("statusDot"),
  status: $("statusText"),
  capUser: $("capUser"),
  capChar: $("capChar"),
  form: $<HTMLFormElement>("textForm"),
  input: $<HTMLInputElement>("textInput"),
  notice: $("notice"),
  overlay: $("overlay"),
};

// Barge-in tuning. While the character talks we demand stronger, longer speech
// so its own voice (if echo cancellation lets some through) does not cut it off.
const VAD_LISTENING = { positiveSpeechThreshold: 0.5, negativeSpeechThreshold: 0.35, minSpeechMs: 160, redemptionMs: 400 };
const VAD_WHILE_TALKING = { positiveSpeechThreshold: 0.75, negativeSpeechThreshold: 0.5, minSpeechMs: 200, redemptionMs: 400 };
const LIP_LEAD_MS = 40; // show each mouth shape slightly before its sound, like animators do

interface ReplyView {
  id: number;
  visemes: VisemeEvent[];
  chars: string[];
  starts: number[];
  emotions: { atMs: number; emotion: Emotion }[];
  texts: string[];
  hasAudio: boolean;
}

const rig = await CharacterRig.create(ui.canvas);
const conn = new Connection();
let ctx: AudioContext | null = null;
let player: Player | null = null;
let audioMouth: AudioMouth | null = null;
let mic: Mic | null = null;
let vad: MicVAD | null = null;
let running = false; // conversation started
let muted = false;
let serverState: ConversationState = "idle";
let reply: ReplyView | null = null;
let lastEmotion: { emotion: Emotion; until: number } | null = null;
let micError = "";
let sttMode: "browser" | "deepgram" = "browser";
const speech = new BrowserSpeech(
  (text, isFinal) => conn.send({ type: "stt_result", text, isFinal }),
  (msg) => notice(msg),
);
const metrics = { turnAt: 0, speechEndAt: 0 };

// ------------------------------------------------------------------ status

function setStatus() {
  let text: string;
  let cls: string;
  if (!conn.open) {
    text = running ? "Reconnecting…" : "Connecting…";
    cls = "warn";
  } else if (!running) {
    text = "Ready";
    cls = "idle";
  } else if (player?.playing) {
    text = "Speaking";
    cls = "speak";
  } else if (serverState === "thinking") {
    text = "Thinking…";
    cls = "think";
  } else if (muted) {
    text = "Mic muted";
    cls = "warn";
  } else if (micError) {
    text = "No mic: type below";
    cls = "err";
  } else {
    text = "Listening";
    cls = "listen";
  }
  ui.status.textContent = text;
  ui.dot.className = `dot ${cls}`;
}

let noticeTimer = 0;
function notice(msg: string, ms = 6000) {
  ui.notice.textContent = msg;
  ui.notice.hidden = false;
  clearTimeout(noticeTimer);
  if (ms > 0) noticeTimer = window.setTimeout(() => (ui.notice.hidden = true), ms);
}

// -------------------------------------------------------------- connection

conn.onStatus = (s) => {
  if (s === "open" && running) conn.send({ type: "start", greet: false }); // resume after a drop
  if (s === "closed") {
    stopPlayback();
    if (running) notice("Connection lost. Reconnecting…", 4000);
  }
  setStatus();
};

conn.onAudio = (replyId, pcm) => {
  if (!player || !reply || reply.id !== replyId) return;
  if (player.replyId !== replyId) player.begin(replyId);
  reply.hasAudio = true;
  player.push(replyId, pcm);
};

conn.onMessage = (m: ServerMessage) => {
  switch (m.type) {
    case "hello": {
      sttMode = m.stt;
      // warn only about what the selected providers need
      const missing = [!m.llmReady && "Anthropic", !m.sttReady && "Deepgram", m.tts === "elevenlabs" && !m.ttsReady && "ElevenLabs"].filter(Boolean);
      if (missing.length) notice(`Server is missing API keys for: ${missing.join(", ")} (see .env).`, 0);
      else if (m.tts === "kokoro" && !m.ttsReady) notice("The voice model is still loading on the server; the first reply may be slow.", 8000);
      break;
    }
    case "state":
      serverState = m.state;
      break;
    case "user_partial":
      ui.capUser.textContent = m.text;
      ui.capUser.classList.add("live");
      break;
    case "user_final":
      ui.capUser.textContent = m.text;
      ui.capUser.classList.remove("live");
      ui.capChar.textContent = "";
      break;
    case "turn":
      metrics.turnAt = performance.now();
      resetMetrics();
      // a newer reply replaces whatever is playing
      if (player?.playing) stopPlayback();
      reply = { id: m.replyId, visemes: [], chars: [], starts: [], emotions: [], texts: [], hasAudio: false };
      break;
    case "reply_start":
      if (reply?.id === m.replyId) {
        reply.emotions.push({ atMs: 0, emotion: m.emotion });
        player?.begin(m.replyId);
      }
      break;
    case "reply_text":
      if (reply?.id === m.replyId) reply.texts[m.index] = m.text;
      break;
    case "alignment":
      if (reply?.id === m.replyId) {
        reply.chars.push(...m.chars);
        reply.starts.push(...m.startsMs);
        // estimated timing (Kokoro) drives captions only; the mouth then follows the audio itself
        if (!m.approximate) reply.visemes.push(...charsToVisemes(m.chars, m.startsMs, m.dursMs));
      }
      break;
    case "emotion":
      if (reply?.id === m.replyId) {
        reply.emotions.push({ atMs: m.atMs, emotion: m.emotion });
        reply.emotions.sort((a, b) => a.atMs - b.atMs);
      }
      break;
    case "reply_end":
      if (reply?.id === m.replyId) {
        if (m.totalAudioMs > 0) player?.end(m.replyId);
        else {
          // text-only reply (voice unavailable)
          ui.capChar.textContent = reply.texts.filter(Boolean).join(" ");
          reply = null;
        }
      }
      break;
    case "reply_cancelled":
      if (reply?.id === m.replyId) {
        if (player?.replyId === m.replyId) player.stop();
        reply = null;
      }
      break;
    case "metrics":
      show("m-tok", m.endpointToFirstTokenMs);
      show("m-text", m.endpointToFirstTextMs);
      show("m-tts", m.endpointToFirstAudioMs);
      break;
    case "error":
      notice(m.message);
      break;
  }
  setStatus();
};

// ------------------------------------------------------------------ audio

async function ensureAudio() {
  if (!ctx) {
    ctx = new AudioContext({ latencyHint: "interactive" });
    player = new Player(ctx);
    audioMouth = new AudioMouth(player.analyser);
    player.onStart = (_replyId, ctxStart) => {
      const startPerf = performance.now() + (ctxStart - ctx!.currentTime) * 1000;
      if (metrics.turnAt) show("m-play", startPerf - metrics.turnAt);
      if (metrics.speechEndAt && metrics.speechEndAt < metrics.turnAt && metrics.turnAt - metrics.speechEndAt < 5000) {
        show("m-vad", metrics.turnAt - metrics.speechEndAt);
        show("m-total", startPerf - metrics.speechEndAt, true);
      }
      setVad(VAD_WHILE_TALKING);
    };
    player.onDone = (replyId, playedMs) => {
      conn.send({ type: "playback_done", replyId, playedMs });
      if (reply?.id === replyId) {
        ui.capChar.textContent = tail(reply.chars.join("").trim() || reply.texts.join(" "));
        holdLastEmotion();
        reply = null;
      }
      setVad(VAD_LISTENING);
      setStatus();
    };
  }
  if (ctx.state !== "running") await ctx.resume();
}

function stopPlayback(): number {
  if (!player?.playing && player?.replyId === -1) return 0;
  const played = player?.stop() ?? 0;
  holdLastEmotion();
  setVad(VAD_LISTENING);
  return played;
}

function holdLastEmotion() {
  const e = reply?.emotions.at(-1)?.emotion;
  if (e) lastEmotion = { emotion: e, until: performance.now() + 1500 };
}

/** The user started talking over the character: stop at once and hand the turn back. */
function bargeIn() {
  if (!player?.playing || !reply) return;
  const id = reply.id;
  const played = stopPlayback();
  // caption shows only what was actually said
  const n = reply.starts.findIndex((s) => s > played);
  ui.capChar.textContent = `${reply.chars.slice(0, n < 0 ? undefined : n).join("").trim()}…`;
  conn.send({ type: "interrupt", replyId: id, playedMs: played });
  reply = null;
  rig.setExpression("listening");
  setStatus();
}

function setVad(opts: typeof VAD_LISTENING) {
  try {
    vad?.setOptions(opts);
  } catch {
    /* not ready */
  }
}

async function startVad(stream: MediaStream) {
  // loaded on demand: the model + onnxruntime are only needed once the mic is on
  const { MicVAD } = await import("@ricky0123/vad-web");
  vad = await MicVAD.new({
    model: "v5",
    baseAssetPath: "/vad/",
    onnxWASMBasePath: "/vad/",
    audioContext: ctx!,
    getStream: async () => stream,
    pauseStream: async () => {},
    resumeStream: async () => stream,
    startOnLoad: true,
    ...VAD_LISTENING,
    onSpeechStart: () => {
      // first speech-like frame (~30 ms): dip the voice right away, confirm below
      if (player?.playing) player.duck(true);
      conn.send({ type: "vad", speaking: true });
    },
    onSpeechRealStart: () => bargeIn(), // minSpeechMs of speech: it's real, stop
    onVADMisfire: () => {
      player?.duck(false);
      conn.send({ type: "vad", speaking: false });
    },
    onSpeechEnd: () => {
      player?.duck(false);
      // VAD fires after `redemptionMs` of silence; the speech ended before that
      metrics.speechEndAt = performance.now() - (VAD_LISTENING.redemptionMs + 30);
      conn.send({ type: "vad", speaking: false });
    },
  });
}

// --------------------------------------------------------------- controls

ui.start.onclick = async () => {
  if (running) return endConversation();
  ui.start.disabled = true;
  try {
    await ensureAudio();
    micError = "";
    try {
      // raw audio goes to the server only for Deepgram; the mic stream always feeds the VAD
      mic = new Mic(ctx!, (pcm) => sttMode === "deepgram" && conn.sendAudio(pcm));
      await mic.start();
      try {
        await startVad(mic.stream);
      } catch (err) {
        console.warn("[vad] unavailable, barge-in falls back to transcripts", err);
      }
      if (sttMode === "browser") {
        if (BrowserSpeech.supported) speech.start();
        else notice("Voice input needs Chrome or Edge (Web Speech API). You can type below.", 0);
      }
      ui.mute.disabled = false;
    } catch (err) {
      mic = null;
      const name = err instanceof DOMException ? err.name : "";
      micError =
        name === "NotAllowedError"
          ? "Microphone access was blocked. Allow it in the browser's site settings, or type below."
          : name === "NotFoundError"
            ? "No microphone found. You can type below."
            : `Microphone unavailable (${err instanceof Error ? err.message : String(err)}). You can type below.`;
      notice(micError, 0);
      ui.input.focus();
    }
    running = true;
    ui.start.textContent = "End conversation";
    ui.start.classList.add("end");
    conn.send({ type: "start", greet: true });
  } finally {
    ui.start.disabled = false;
    setStatus();
  }
};

function endConversation() {
  running = false;
  conn.send({ type: "stop" });
  stopPlayback();
  reply = null;
  void vad?.destroy();
  vad = null;
  speech.stop();
  mic?.stop();
  mic = null;
  muted = false;
  ui.mute.disabled = true;
  ui.mute.setAttribute("aria-pressed", "false");
  ui.mute.textContent = "Mute";
  ui.start.textContent = "Start conversation";
  ui.start.classList.remove("end");
  ui.capUser.textContent = "";
  ui.capChar.textContent = "";
  ui.notice.hidden = true;
  setStatus();
}

ui.mute.onclick = () => {
  muted = !muted;
  mic?.setMuted(muted);
  if (muted) {
    void vad?.pause();
    speech.stop();
  } else {
    void vad?.start();
    if (sttMode === "browser" && mic) speech.start();
  }
  conn.send({ type: "mute", muted });
  ui.mute.setAttribute("aria-pressed", String(muted));
  ui.mute.textContent = muted ? "Unmute" : "Mute";
  setStatus();
};

ui.form.onsubmit = async (e) => {
  e.preventDefault();
  const text = ui.input.value.trim();
  if (!text) return;
  ui.input.value = "";
  await ensureAudio();
  if (player?.playing) bargeIn();
  if (!running) {
    running = true;
    ui.start.textContent = "End conversation";
    ui.start.classList.add("end");
  }
  conn.send({ type: "text", text });
  setStatus();
};

// latency overlay: D toggles, ?debug opens it
const showOverlay = (v: boolean) => (ui.overlay.hidden = !v);
showOverlay(new URLSearchParams(location.search).has("debug"));
$("ovClose").onclick = () => showOverlay(false);
window.addEventListener("keydown", (e) => {
  if (e.key.toLowerCase() === "d" && document.activeElement !== ui.input) showOverlay(ui.overlay.hidden);
});

function show(id: string, ms: number | undefined, total = false) {
  const el = $(id);
  if (ms === undefined || !Number.isFinite(ms)) return;
  el.textContent = `${Math.round(ms)} ms`;
  if (total) el.className = ms < 1000 ? "good" : "slow";
}
function resetMetrics() {
  for (const id of ["m-vad", "m-tok", "m-text", "m-tts", "m-play", "m-total"]) {
    $(id).textContent = "…";
    $(id).className = "";
  }
}

// ------------------------------------------------------- per-frame driving

function tick() {
  const pos = player?.playing ? player.positionMs() : -1;
  if (pos >= 0 && reply) {
    rig.setActivity("speaking");
    const [audioShape, level] = audioMouth!.sample();
    const shape = reply.visemes.length ? visemeAt(reply.visemes, pos + LIP_LEAD_MS) : audioShape;
    rig.setMouth(shape, MOUTH_SPEED_TALKING);
    rig.setSpeechLevel(level);
    // expression from the emotion of the sentence being spoken
    let emotion: Emotion = "neutral";
    for (const e of reply.emotions) if (e.atMs <= pos) emotion = e.emotion;
    rig.setExpression(emotion);
    // captions revealed in sync with the voice (last ~2 lines only)
    if (reply.chars.length) {
      let n = 0;
      while (n < reply.starts.length && reply.starts[n]! <= pos) n++;
      ui.capChar.textContent = tail(reply.chars.slice(0, n).join("").trim());
    } else ui.capChar.textContent = tail(reply.texts.filter(Boolean).join(" "));
  } else {
    rig.setMouth(MOUTH.REST, MOUTH_SPEED_RESTING);
    rig.setSpeechLevel(0);
    const now = performance.now();
    if (lastEmotion && now < lastEmotion.until) {
      rig.setExpression(lastEmotion.emotion);
    } else if (running && serverState === "thinking") {
      rig.setActivity("thinking");
      rig.setExpression("thinking");
    } else if (running) {
      rig.setActivity("listening");
      rig.setExpression("listening");
    } else {
      rig.setActivity("idle");
      rig.setExpression("neutral");
    }
  }
  if (pos >= 0 !== wasSpeaking) {
    wasSpeaking = pos >= 0;
    setStatus();
  }
  requestAnimationFrame(tick);
}
let wasSpeaking = false;

/** Keep captions short so they never bury the character: the last ~110 characters. */
function tail(text: string, max = 110): string {
  if (text.length <= max) return text;
  const cut = text.indexOf(" ", text.length - max);
  return `…${text.slice(cut < 0 ? text.length - max : cut + 1)}`;
}

// ?debug exposes internals on window.app for the console
if (new URLSearchParams(location.search).has("debug")) {
  Object.defineProperty(window, "app", {
    get: () => ({ ctx, player, rig, reply, vad, serverState, startVad, ensureAudio }),
  });
}

conn.connect();
setStatus();
requestAnimationFrame(tick);
