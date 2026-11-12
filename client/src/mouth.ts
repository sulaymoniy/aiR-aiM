// Mouth shapes of "Coach model" and the mapping from speech to those shapes.
//
// Decided from rendering every "lips sync id" with "timestamp" = 100 (instant blend)
// on the debug page (/debug.html), frame by frame with the low-level runtime:
//
//   id 0  closed, gentle smile ................ REST (silence)
//   id 1  closed, flat pressed line ........... M / B / P
//   id 2  teeth together, lips slightly apart . S Z T D N K G CH SH J Y (most consonants)
//   id 3  wide, thin opening, upper teeth ..... E / I (ee, ih, eh)
//   id 4  wide open, tongue visible ........... A (ah, aa, uh)
//   id 5  half open, both teeth rows + tongue . L / TH (tongue behind teeth), open-mid vowels
//   id 6  small round "o" ..................... O / U / W / OO / R
//   id 7  almost closed, teeth peeking ........ F / V (teeth on lower lip)
//   id 8  no shape of its own: plays the same built-in talking loop as 9
//   id 9  "demo lipsync" state: a built-in 2 s talking loop (the file's default)
//
// "timestamp" is NOT a time: it is the blend speed of the lip layer.
//   0 = the mouth freezes (never use while running), ~20 = ~170 ms to reach a shape,
//   30 = ~120 ms, 50 = ~70 ms, >=100 = instant.

export const MOUTH = {
  REST: 0,
  MBP: 1,
  CONSONANT: 2,
  EE: 3,
  AA: 4,
  L_TH: 5,
  OO: 6,
  FV: 7,
} as const;
export type MouthId = (typeof MOUTH)[keyof typeof MOUTH];

export const MOUTH_TABLE: { id: number; shape: string; phonemes: string; usable: boolean }[] = [
  { id: 0, shape: "Rest (closed smile)", phonemes: "silence", usable: true },
  { id: 1, shape: "Closed, pressed", phonemes: "M B P", usable: true },
  { id: 2, shape: "Teeth together", phonemes: "S Z T D N K G CH SH J Y", usable: true },
  { id: 3, shape: "Wide, thin open", phonemes: "E I (ee, ih, eh)", usable: true },
  { id: 4, shape: "Wide open", phonemes: "A (ah, aa, uh)", usable: true },
  { id: 5, shape: "Half open, tongue", phonemes: "L TH", usable: true },
  { id: 6, shape: "Small round", phonemes: "O U W OO R", usable: true },
  { id: 7, shape: "Nearly closed, teeth", phonemes: "F V", usable: true },
  { id: 8, shape: "(same as 9)", phonemes: "not used", usable: false },
  { id: 9, shape: "Demo talking loop", phonemes: "not used", usable: false },
];

/** Blend speed ("timestamp") while talking and while settling back to rest. */
export const MOUTH_SPEED_TALKING = 45;
export const MOUTH_SPEED_RESTING = 22;

const DIGRAPHS: Record<string, MouthId> = {
  th: MOUTH.L_TH,
  sh: MOUTH.CONSONANT,
  ch: MOUTH.CONSONANT,
  ph: MOUTH.FV,
  oo: MOUTH.OO,
  ou: MOUTH.OO,
  ow: MOUTH.OO,
  ee: MOUTH.EE,
  ea: MOUTH.EE,
  wh: MOUTH.OO,
};

const LETTERS: Record<string, MouthId> = {
  a: MOUTH.AA,
  e: MOUTH.EE,
  i: MOUTH.EE,
  y: MOUTH.EE,
  o: MOUTH.OO,
  u: MOUTH.OO,
  w: MOUTH.OO,
  r: MOUTH.OO,
  q: MOUTH.OO,
  l: MOUTH.L_TH,
  m: MOUTH.MBP,
  b: MOUTH.MBP,
  p: MOUTH.MBP,
  f: MOUTH.FV,
  v: MOUTH.FV,
  s: MOUTH.CONSONANT,
  z: MOUTH.CONSONANT,
  c: MOUTH.CONSONANT,
  t: MOUTH.CONSONANT,
  d: MOUTH.CONSONANT,
  n: MOUTH.CONSONANT,
  k: MOUTH.CONSONANT,
  g: MOUTH.CONSONANT,
  j: MOUTH.CONSONANT,
  x: MOUTH.CONSONANT,
  h: MOUTH.CONSONANT,
};

export interface VisemeEvent {
  atMs: number; // in the reply's audio stream
  id: MouthId;
}

/**
 * Turns character timings from the TTS (one entry per character of the spoken
 * text) into a sequence of mouth shapes. Pauses longer than `pauseMs` close the
 * mouth; very short flickers are dropped, except lip closures which must show.
 */
export function charsToVisemes(chars: string[], startsMs: number[], dursMs: number[], pauseMs = 140): VisemeEvent[] {
  const raw: VisemeEvent[] = [];
  for (let i = 0; i < chars.length; i++) {
    const c = (chars[i] ?? "").toLowerCase();
    const start = startsMs[i] ?? 0;
    const dur = dursMs[i] ?? 0;
    if (!/[a-z]/.test(c)) {
      // whitespace / punctuation: close the mouth only on a real pause
      const nextLetter = findNextLetter(chars, i + 1);
      const gap = nextLetter >= 0 ? (startsMs[nextLetter] ?? start) - start : Infinity;
      if (gap >= pauseMs || /[.,!?;:]/.test(c)) {
        if (gap >= pauseMs * 0.7) raw.push({ atMs: start, id: MOUTH.REST });
      }
      continue;
    }
    const pair = c + (chars[i + 1] ?? "").toLowerCase();
    const di = DIGRAPHS[pair];
    if (di !== undefined) {
      raw.push({ atMs: start, id: di });
      i++; // consume the second letter of the digraph
      void dur;
      continue;
    }
    raw.push({ atMs: start, id: LETTERS[c] ?? MOUTH.CONSONANT });
  }
  return smooth(raw);
}

function findNextLetter(chars: string[], from: number): number {
  for (let j = from; j < chars.length; j++) if (/[a-z]/i.test(chars[j] ?? "")) return j;
  return -1;
}

/** Merge repeats and drop shapes held for less than ~45 ms (lip closures need 30 ms). */
function smooth(events: VisemeEvent[]): VisemeEvent[] {
  const out: VisemeEvent[] = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    const next = events[i + 1];
    const held = next ? next.atMs - e.atMs : Infinity;
    const min = e.id === MOUTH.MBP ? 30 : 45;
    if (held < min && e.id !== MOUTH.REST) continue;
    if (out.length && out[out.length - 1]!.id === e.id) continue;
    out.push(e);
  }
  return out;
}

/** The shape active at `ms`, given events sorted by time. */
export function visemeAt(events: VisemeEvent[], ms: number): MouthId {
  let lo = 0;
  let hi = events.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid]!.atMs <= ms) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found >= 0 ? events[found]!.id : MOUTH.REST;
}

/**
 * Fallback lip sync without timing data: loudness + a rough low/high frequency
 * split of the audio that is actually playing.
 */
export class AudioMouth {
  private freq: Uint8Array<ArrayBuffer>;
  private time: Uint8Array<ArrayBuffer>;
  private level = 0;
  private ratioAvg = 0.6; // running average of high/low energy, so "bright" voices still vary
  lastRatio = 0;
  constructor(private analyser: AnalyserNode) {
    this.freq = new Uint8Array(analyser.frequencyBinCount);
    this.time = new Uint8Array(analyser.fftSize);
  }
  /** Returns [mouth shape, loudness 0..1]. */
  sample(): [MouthId, number] {
    this.analyser.getByteTimeDomainData(this.time);
    let sum = 0;
    for (const v of this.time) {
      const x = (v - 128) / 128;
      sum += x * x;
    }
    const rms = Math.sqrt(sum / this.time.length);
    this.level = this.level * 0.6 + Math.min(1, rms * 4) * 0.4;
    if (this.level < 0.05) return [MOUTH.REST, this.level];
    this.analyser.getByteFrequencyData(this.freq);
    const binHz = this.analyser.context.sampleRate / 2 / this.freq.length;
    let low = 0;
    let high = 0;
    for (let i = 0; i < this.freq.length; i++) {
      const hz = i * binHz;
      if (hz > 200 && hz < 1200) low += this.freq[i]!;
      else if (hz >= 2500 && hz < 7000) high += this.freq[i]!;
    }
    // Loudness picks how open the mouth is; brightness relative to this voice's
    // own average picks between shapes of similar openness.
    const ratio = high / (low + 1);
    this.lastRatio = ratio;
    this.ratioAvg = this.ratioAvg * 0.97 + ratio * 0.03;
    const bright = ratio > this.ratioAvg * 1.25;
    const dark = ratio < this.ratioAvg * 0.8;
    if (ratio > this.ratioAvg * 2.2 && this.level < 0.35) return [MOUTH.CONSONANT, this.level]; // hiss: s, sh, t
    if (this.level > 0.55) return [dark ? MOUTH.OO : MOUTH.AA, this.level];
    if (this.level > 0.3) return [bright ? MOUTH.EE : dark ? MOUTH.OO : MOUTH.L_TH, this.level];
    if (this.level > 0.15) return [bright ? MOUTH.CONSONANT : MOUTH.L_TH, this.level];
    return [this.level > 0.08 ? MOUTH.FV : MOUTH.MBP, this.level];
  }
}
