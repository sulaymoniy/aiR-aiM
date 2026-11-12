import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { EMOTIONS, type Emotion } from "../shared/protocol.ts";
import type { Config } from "./config.ts";
import { SentenceStreamParser } from "./jsonStream.ts";

const here = dirname(fileURLToPath(import.meta.url));

export type Turn = Anthropic.Beta.BetaMessageParam;

/** Structured output: every reply is a list of spoken sentences, each with an emotion label. */
export const REPLY_SCHEMA = {
  type: "object",
  properties: {
    sentences: {
      type: "array",
      items: {
        type: "object",
        properties: {
          emotion: { type: "string", enum: [...EMOTIONS] },
          text: { type: "string" },
        },
        required: ["emotion", "text"],
        additionalProperties: false,
      },
    },
  },
  required: ["sentences"],
  additionalProperties: false,
} as const;

const VOICE_RULES = `
# How your replies work
Everything you write is spoken aloud by a text-to-speech voice, live, while an animated version of you lip-syncs it. So:
- Usually one to three short sentences. Go longer only when the user explicitly asks for detail, a story or an explanation.
- Plain spoken words only: no Markdown, lists, emojis, stage directions, asterisks, URLs or code. Write numbers, units and symbols the way you'd say them ("about five bucks", "twenty twenty-six").
- Put each sentence in its own entry, each with the emotion your face should show while saying it: neutral, happy, excited, surprised, thinking, sad or annoyed. Let it change from sentence to sentence when your mood does.
- Use punctuation for rhythm: commas and ellipses make pauses, a question mark makes you sound like you're asking.
- The user's words come from speech recognition, so they may contain small mistakes; go with the most likely meaning. If you really can't tell what they said, ask them to say it again.
- When the user's message is "[conversation started]", they just pressed Start and haven't said anything yet: greet them in one or two short sentences, in character.
- A system note may tell you that the user cut you off. Your recorded reply then contains only what they actually heard, so don't assume they heard the rest; respond to what they said next.
`;

export function loadSystemPrompt(): string {
  const persona = readFileSync(join(here, "persona.md"), "utf8").trim();
  return `${persona}\n${VOICE_RULES}`;
}

export interface ReplyHandlers {
  onFirstToken(): void;
  onSentenceStart(index: number, emotion: Emotion): void;
  onTextDelta(index: number, delta: string): void;
  onSentenceEnd(index: number, text: string, emotion: Emotion): void;
}

export interface ReplyResult {
  sentences: { emotion: Emotion; text: string }[];
  stopReason: string | null;
}

function normalizeEmotion(raw: string): Emotion {
  return (EMOTIONS as readonly string[]).includes(raw) ? (raw as Emotion) : "neutral";
}

export class Brain {
  private client: Anthropic;
  private system: string;

  constructor(private cfg: Config) {
    this.client = new Anthropic({ apiKey: cfg.anthropicKey || undefined, maxRetries: 1, timeout: 30_000 });
    this.system = loadSystemPrompt();
  }

  /** Streams one spoken reply. Abort with `signal` on barge-in. */
  async reply(messages: Turn[], handlers: ReplyHandlers, signal: AbortSignal): Promise<ReplyResult> {
    const sentences: ReplyResult["sentences"] = [];
    let first = true;
    const parser = new SentenceStreamParser<Emotion>(
      {
        onSentenceStart: (i, e) => handlers.onSentenceStart(i, e),
        onTextDelta: (i, d) => handlers.onTextDelta(i, d),
        onSentenceEnd: (i, text, emotion) => {
          sentences[i] = { emotion, text };
          handlers.onSentenceEnd(i, text, emotion);
        },
      },
      normalizeEmotion,
    );

    const stream = this.client.beta.messages.stream(
      {
        model: this.cfg.claudeModel,
        max_tokens: 4096,
        // Server-side refusal fallback: if a safety classifier declines, the API
        // re-runs the request on a fallback model instead of returning nothing.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        // The persona is identical on every turn, so cache it (and the history
        // prefix via the top-level breakpoint) to cut time to first token.
        cache_control: { type: "ephemeral" },
        system: [{ type: "text", text: this.system, cache_control: { type: "ephemeral" } }],
        messages,
        // low effort = short thinking, fast spoken replies; structured output
        // guarantees the {sentences:[{emotion,text}]} shape.
        output_config: { effort: "low", format: { type: "json_schema", schema: REPLY_SCHEMA } },
      },
      { signal },
    );

    let blocks = 0;
    for await (const event of stream) {
      if (event.type === "content_block_start" && event.content_block.type === "text") {
        // A second text block means the JSON restarted (e.g. after a fallback).
        if (blocks++ > 0) parser.reset();
      } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        if (first) {
          first = false;
          handlers.onFirstToken();
        }
        parser.push(event.delta.text);
      }
    }
    const final = await stream.finalMessage();
    return { sentences: sentences.filter(Boolean), stopReason: final.stop_reason ?? null };
  }
}
