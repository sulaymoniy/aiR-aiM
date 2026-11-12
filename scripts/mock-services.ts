// npm run dev:mock
//
// Runs the real server against local stand-ins for Claude and ElevenLabs that
// speak the same wire formats (SSE Messages stream; stream-input WebSocket with
// PCM + character alignment). Lets you try the whole pipeline, lip sync,
// emotions, captions, barge-in and the latency overlay without API keys or cost.
// Typed input only: speech recognition is not mocked.
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

const PORT = 8790;
const RATE = 24000;

const server = createServer((req, res) => {
  if (req.method !== "POST" || !req.url?.startsWith("/v1/messages")) {
    res.writeHead(404);
    res.end();
    return;
  }
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", async () => {
    const body = JSON.parse(raw) as {
      model: string;
      messages: { role: string; content: string }[];
      output_config?: unknown;
      fallbacks?: unknown;
      stream?: boolean;
    };
    console.log(
      `[mock claude] model=${body.model} stream=${body.stream} turns=${body.messages.length} beta=${req.headers["anthropic-beta"]} fallbacks=${JSON.stringify(body.fallbacks)} output_config=${JSON.stringify(body.output_config).slice(0, 80)}…`,
    );
    const lastUser = [...body.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const interrupted = body.messages.some((m) => m.role === "system");
    const sentences =
      lastUser === "[conversation started]"
        ? [
            { emotion: "happy", text: "Oh, hey! There you are." },
            { emotion: "neutral", text: "I'm Dex. What's going on?" },
          ]
        : [
            { emotion: interrupted ? "surprised" : "thinking", text: interrupted ? "Whoa, okay, you cut me off." : "Hmm, let me think about that." },
            { emotion: "excited", text: `You said: ${lastUser.slice(0, 80)}.` },
            { emotion: "annoyed", text: "Honestly? That's a pretty bold move, and I'm not sure it's gonna work." },
            { emotion: "sad", text: "But hey, what do I know, I'm a cartoon." },
          ];
    const json = JSON.stringify({ sentences });
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const ev = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`);
    const id = `msg_mock_${Date.now()}`;
    ev("message_start", {
      message: { id, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 500, output_tokens: 1 } },
    });
    await sleep(350); // time to first token
    ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    for (let i = 0; i < json.length; i += 6) {
      if (res.destroyed) return;
      ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: json.slice(i, i + 6) } });
      await sleep(12);
    }
    ev("content_block_stop", { index: 0 });
    ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: Math.ceil(json.length / 4) } });
    ev("message_stop", {});
    res.end();
  });
});

const wss = new WebSocketServer({ server });
wss.on("connection", (ws, req) => {
  console.log(`[mock tts] ${req.url?.split("?")[0]}`);
  let queue = Promise.resolve();
  let first = true;
  let ending = false;
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString()) as { text: string; flush?: boolean; voice_settings?: unknown };
    if (msg.voice_settings) return; // init message
    if (msg.text === "") {
      ending = true;
      queue = queue.then(() => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ isFinal: true }));
      });
      return;
    }
    const text = msg.text;
    queue = queue.then(async () => {
      if (first) {
        first = false;
        await sleep(150); // time to first audio
      }
      await speak(text, (m) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m)));
    });
    void ending;
  });
});

/** Fake "voice": voiced buzz for vowels, hiss for consonants, silence for gaps; with per-char timing. */
async function speak(text: string, send: (m: unknown) => void) {
  const chars = [...text];
  const durs = chars.map((c) => (/[aeiouy]/i.test(c) ? 85 : /[a-z0-9']/i.test(c) ? 60 : /[.,!?;:]/.test(c) ? 230 : 45));
  // send in slices of ~4 chars so audio streams like the real thing
  for (let i = 0; i < chars.length; i += 4) {
    const cs = chars.slice(i, i + 4);
    const ds = durs.slice(i, i + 4);
    const starts: number[] = [];
    let t = 0;
    for (const d of ds) {
      starts.push(t);
      t += d;
    }
    const pcm = new Int16Array(Math.round((t / 1000) * RATE));
    let s = 0;
    cs.forEach((c, k) => {
      const n = Math.round((ds[k]! / 1000) * RATE);
      const vowel = /[aeiouy]/i.test(c);
      const cons = /[a-z0-9']/i.test(c) && !vowel;
      for (let j = 0; j < n && s < pcm.length; j++, s++) {
        const env = Math.sin((Math.PI * j) / n);
        const tt = s / RATE;
        let v = 0;
        if (vowel) v = 0.35 * env * (Math.sin(2 * Math.PI * 140 * tt) + 0.5 * Math.sin(2 * Math.PI * 280 * tt) + 0.25 * Math.sin(2 * Math.PI * 700 * tt));
        else if (cons) v = 0.08 * env * (Math.random() * 2 - 1);
        pcm[s] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
      }
    });
    send({
      audio: Buffer.from(pcm.buffer).toString("base64"),
      alignment: { chars: cs, charStartTimesMs: starts, charDurationsMs: ds },
      normalizedAlignment: { chars: cs, charStartTimesMs: starts, charDurationsMs: ds },
    });
    await sleep(t * 0.35); // generate faster than real time
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

server.listen(PORT, async () => {
  console.log(`[mock] Claude + ElevenLabs stand-ins on http://localhost:${PORT}`);
  process.env.ANTHROPIC_BASE_URL = `http://localhost:${PORT}`;
  process.env.ANTHROPIC_API_KEY = "mock";
  process.env.ELEVENLABS_API_KEY = "mock";
  process.env.ELEVENLABS_WS_BASE = `ws://localhost:${PORT}`;
  process.env.DEEPGRAM_API_KEY = "";
  process.env.TTS_PROVIDER = "elevenlabs"; // the mock stands in for ElevenLabs
  process.env.STT_PROVIDER = "browser";
  process.env.VOICE_ID = "mock-voice";
  await import("../server/index.ts");
});
