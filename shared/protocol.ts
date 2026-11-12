// Messages exchanged between the browser and the server over the /ws WebSocket.
//
// Text frames carry the JSON messages below. Binary frames carry audio:
//   browser -> server: raw PCM, signed 16-bit little-endian, mono, 16 kHz (microphone)
//   server -> browser: [uint32 LE replyId][PCM s16le mono 24 kHz] (character voice)

export const EMOTIONS = ["neutral", "happy", "excited", "surprised", "thinking", "sad", "annoyed"] as const;
export type Emotion = (typeof EMOTIONS)[number];

export const MIC_SAMPLE_RATE = 16000;
export const TTS_SAMPLE_RATE = 24000;

export type ConversationState = "idle" | "listening" | "thinking" | "speaking";

export type ClientMessage =
  | { type: "start"; greet: boolean } // begin the conversation (greet: false when resuming after a reconnect)
  | { type: "stop" } // end the conversation
  | { type: "text"; text: string } // typed fallback input
  | { type: "interrupt"; replyId: number; playedMs: number } // barge-in: audio already stopped locally
  | { type: "playback_done"; replyId: number; playedMs: number } // the reply finished playing
  | { type: "mute"; muted: boolean }
  | { type: "vad"; speaking: boolean } // hint from the in-browser VAD
  | { type: "stt_result"; text: string; isFinal: boolean }; // browser speech recognition (STT_PROVIDER=browser)

export type ServerMessage =
  | {
      type: "hello";
      stt: "browser" | "deepgram";
      tts: "kokoro" | "elevenlabs";
      sttReady: boolean;
      ttsReady: boolean; // kokoro: model loaded; elevenlabs: key present
      llmReady: boolean;
    }
  | { type: "state"; state: ConversationState }
  | { type: "user_partial"; text: string }
  | { type: "user_final"; text: string }
  | { type: "turn"; replyId: number } // end of user turn detected; the latency clock starts here
  | { type: "reply_start"; replyId: number; emotion: Emotion }
  | { type: "reply_text"; replyId: number; index: number; emotion: Emotion; text: string } // one finished sentence
  | {
      // character timing for the audio already sent, in ms from the start of this reply's audio
      type: "alignment";
      replyId: number;
      chars: string[];
      startsMs: number[];
      dursMs: number[];
      approximate?: boolean; // estimated timing (Kokoro): captions only, lip sync uses the audio
    }
  | { type: "emotion"; replyId: number; emotion: Emotion; atMs: number }
  | { type: "reply_end"; replyId: number; totalAudioMs: number } // every audio chunk has been sent
  | { type: "reply_cancelled"; replyId: number }
  | {
      type: "metrics";
      replyId: number;
      endpointToFirstTokenMs?: number;
      endpointToFirstTextMs?: number;
      endpointToFirstAudioMs?: number;
    }
  | { type: "error"; message: string; recoverable: boolean };
