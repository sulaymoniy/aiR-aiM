// Incrementally reads Claude's structured reply
//   {"sentences":[{"emotion":"happy","text":"..."}, ...]}
// while it streams, so each sentence's emotion is known before its text and the
// text can be sent to the TTS word by word instead of waiting for the whole reply.

export interface SentenceHandlers<E extends string> {
  onSentenceStart(index: number, emotion: E): void;
  onTextDelta(index: number, delta: string): void;
  onSentenceEnd(index: number, text: string, emotion: E): void;
}

interface ItemState {
  emotion: string | null;
  emittedLen: number;
  started: boolean;
  ended: boolean;
}

export class SentenceStreamParser<E extends string> {
  private buf = "";
  private items: ItemState[] = [];
  private offset = 0; // index shift after a reset (e.g. a fallback model restarts the JSON)

  constructor(
    private handlers: SentenceHandlers<E>,
    private normalizeEmotion: (raw: string) => E,
  ) {}

  /** Start over on a new text block, keeping the sentences already emitted. */
  reset() {
    this.offset += this.items.length;
    this.items = [];
    this.buf = "";
  }

  push(chunk: string) {
    this.buf += chunk;
    this.scan();
  }

  get count() {
    return this.offset + this.items.length;
  }

  private scan() {
    // Find each object at depth 3 (root {} -> "sentences" [] -> item {}).
    const s = this.buf;
    let depth = 0;
    let inStr = false;
    let esc = false;
    let itemStart = -1;
    let n = 0;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{" || ch === "[") {
        depth++;
        if (depth === 3 && ch === "{") itemStart = i;
      } else if (ch === "}" || ch === "]") {
        if (depth === 3 && ch === "}" && itemStart >= 0) {
          this.update(n++, s.slice(itemStart, i + 1), true);
          itemStart = -1;
        }
        depth--;
      }
    }
    if (itemStart >= 0) this.update(n, s.slice(itemStart), false);
  }

  private update(n: number, raw: string, closed: boolean) {
    let st = this.items[n];
    if (!st) {
      st = { emotion: null, emittedLen: 0, started: false, ended: false };
      this.items[n] = st;
    }
    if (st.ended) return;
    const idx = this.offset + n;

    if (st.emotion === null) {
      const m = /"emotion"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw);
      if (m) st.emotion = m[1]!;
    }
    const text = partialString(raw, "text", closed);
    // Text before emotion (unexpected key order): wait for the emotion or the end.
    if (!st.started && (st.emotion !== null || closed)) {
      st.started = true;
      this.handlers.onSentenceStart(idx, this.normalizeEmotion(st.emotion ?? "neutral"));
    }
    if (st.started && text !== null && text.length > st.emittedLen) {
      this.handlers.onTextDelta(idx, text.slice(st.emittedLen));
      st.emittedLen = text.length;
    }
    if (closed) {
      st.ended = true;
      let full = text ?? "";
      try {
        const obj = JSON.parse(raw) as { text?: unknown };
        if (typeof obj.text === "string") full = obj.text;
      } catch {
        /* keep the partial decode */
      }
      if (full.length > st.emittedLen) this.handlers.onTextDelta(idx, full.slice(st.emittedLen));
      st.emittedLen = full.length;
      this.handlers.onSentenceEnd(idx, full, this.normalizeEmotion(st.emotion ?? "neutral"));
    }
  }
}

/** Decodes the (possibly unfinished) JSON string value of `key` inside `raw`. */
function partialString(raw: string, key: string, closed: boolean): string | null {
  const m = new RegExp(`"${key}"\\s*:\\s*"`).exec(raw);
  if (!m) return null;
  let i = m.index + m[0].length;
  let body = "";
  let done = false;
  while (i < raw.length) {
    const ch = raw[i]!;
    if (ch === "\\") {
      if (i + 1 >= raw.length) break; // escape split across chunks
      if (raw[i + 1] === "u" && i + 6 > raw.length) break; // \uXXXX not complete yet
      const len = raw[i + 1] === "u" ? 6 : 2;
      body += raw.slice(i, i + len);
      i += len;
      continue;
    }
    if (ch === '"') {
      done = true;
      break;
    }
    body += ch;
    i++;
  }
  void closed;
  try {
    return JSON.parse(`"${body}"`) as string;
  } catch {
    return done ? body : null;
  }
}
