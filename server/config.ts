import "dotenv/config";

function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && process.env[name] !== "" ? v : fallback;
}
function str(name: string, fallback = ""): string {
  return (process.env[name] ?? "").trim() || fallback;
}

const clonedVoice = str("VOICE_ID");

function pick<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const v = str(name).toLowerCase() as T;
  return allowed.includes(v) ? v : fallback;
}

export const config = {
  port: num("PORT", 8787),
  // Free by default: speech recognition in the browser, Kokoro voice on this machine.
  sttProvider: pick("STT_PROVIDER", ["browser", "deepgram"] as const, "browser"),
  ttsProvider: pick("TTS_PROVIDER", ["kokoro", "elevenlabs"] as const, "kokoro"),
  kokoroVoice: str("KOKORO_VOICE", "am_puck"),
  kokoroDtype: pick("KOKORO_DTYPE", ["fp32", "fp16", "q8", "q4", "q4f16"] as const, "fp32"),
  kokoroSpeed: num("KOKORO_SPEED", 1.05),
  anthropicKey: str("ANTHROPIC_API_KEY"),
  deepgramKey: str("DEEPGRAM_API_KEY"),
  elevenKey: str("ELEVENLABS_API_KEY"),
  claudeModel: str("CLAUDE_MODEL", "claude-opus-5-5"),
  // The one voice setting: the cloned voice if one was created, else the stock fallback.
  voiceId: clonedVoice || str("STOCK_VOICE_ID", "iP95p4xoKVk53GoZ742B"),
  voiceKind: (clonedVoice ? "cloned" : "stock") as "cloned" | "stock",
  ttsModel: str("TTS_MODEL_ID", "eleven_flash_v2_5"),
  voiceSettings: {
    stability: num("VOICE_STABILITY", 0.35),
    similarity_boost: num("VOICE_SIMILARITY", 0.85),
    style: num("VOICE_STYLE", 0.4),
    use_speaker_boost: true,
    speed: num("VOICE_SPEED", 1.05),
  },
  // Overridable so `npm run dev:mock` can point at local stand-ins.
  elevenWsBase: str("ELEVENLABS_WS_BASE", "wss://api.elevenlabs.io"),
  deepgramWsBase: str("DEEPGRAM_WS_BASE", "wss://api.deepgram.com"),
  endpointMs: num("ENDPOINT_MS", 600),
  continuationHoldMs: num("CONTINUATION_HOLD_MS", 900),
  utteranceEndMs: Math.max(1000, num("UTTERANCE_END_MS", 1200)),
};

export type Config = typeof config;
