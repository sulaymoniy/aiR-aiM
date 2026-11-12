// Drives the "Coach model" Rive character with the low-level runtime so we can
// layer our own control on top of the file's state machine every frame:
//
//   1. advance "State Machine 1" (mouth via "lips sync id" / "timestamp",
//      the file's own idle head bob and eyelid flutter)
//   2. override the "emotion" layer: the file alternates "emotion 1" (neutral)
//      and "emotion 2" (heavy lids, flat brows) every 4 s on its own, so we
//      re-apply "emotion 1" at full strength and blend "emotion 2" in by the
//      amount the current expression asks for
//   3. add procedural life the file does not have: blinks, brow raise, eye
//      widening, pupils that look around, breathing, head tilt and talk bob
//   4. advance the artboard and draw
//
// Nothing in the .riv file is modified.

import { RuntimeLoader } from "@rive-app/canvas";
import riveWasmUrl from "@rive-app/canvas/rive.wasm?url";
import type { Emotion } from "../../shared/protocol";
import { MOUTH, MOUTH_SPEED_RESTING } from "./mouth";

type RC = Awaited<ReturnType<typeof RuntimeLoader.awaitInstance>>;
type RiveFile = Awaited<ReturnType<RC["load"]>>;
type Artboard = ReturnType<RiveFile["artboardByName"]>;
type SMInstance = InstanceType<RC["StateMachineInstance"]>;
type AnimInstance = InstanceType<RC["LinearAnimationInstance"]>;
type Renderer = ReturnType<RC["makeRenderer"]>;
type NumberInput = { value: number; name: string };
type TC = ReturnType<Artboard["transformComponent"]>;

export const ARTBOARD = "Coach model";
export const STATE_MACHINE = "State Machine 1";
export const INPUT_MOUTH = "lips sync id";
export const INPUT_MOUTH_SPEED = "timestamp";
export const ANIMATIONS = {
  neutral: "emotion 1",
  heavyLids: "emotion 2",
  idle: "idle", // 0.67 s ping-pong: whole head bobs ~16 units
  lidFlutter: "Timeline 2", // 0.5 s ping-pong: upper eyelids droop slightly (the spec's "Timeline 29")
  demoTalk: "demo lipsync", // 2 s talking loop, played by lips sync id 9 (and 8)
} as const;

export type Activity = "idle" | "listening" | "thinking" | "speaking";

/** Procedural expression targets. Units are the artboard's local units. */
export interface Expression {
  lids: number; // 0..1 mix of "emotion 2" (heavy lids + lowered brows)
  brow: number; // brow offset, negative = raised
  eyeOpen: number; // eye scale, 1 = normal
  tilt: number; // head tilt in degrees, positive = toward the character's left
  lookX: number; // pupil offset, -1..1
  lookY: number;
  energy: number; // amount of body motion while talking
}

export const EXPRESSIONS: Record<Emotion | "listening", Expression> = {
  // Brows hide under the hair beyond about -28, so raises stay above that.
  neutral: { lids: 0, brow: 0, eyeOpen: 1, tilt: 0, lookX: 0, lookY: 0, energy: 0.6 },
  listening: { lids: 0, brow: -5, eyeOpen: 1.03, tilt: 2, lookX: 0, lookY: 0, energy: 0.3 },
  happy: { lids: 0.12, brow: -9, eyeOpen: 1, tilt: -2, lookX: 0, lookY: 0, energy: 1 },
  excited: { lids: 0, brow: -18, eyeOpen: 1.1, tilt: 0, lookX: 0, lookY: -0.2, energy: 1.6 },
  surprised: { lids: 0, brow: -26, eyeOpen: 1.2, tilt: 0, lookX: 0, lookY: -0.1, energy: 1.2 },
  thinking: { lids: 0.35, brow: -6, eyeOpen: 1, tilt: -4, lookX: 0.8, lookY: -0.7, energy: 0.4 },
  sad: { lids: 0.55, brow: 10, eyeOpen: 0.95, tilt: 4, lookX: 0, lookY: 0.6, energy: 0.35 },
  annoyed: { lids: 1, brow: 6, eyeOpen: 1, tilt: -1.5, lookX: -0.2, lookY: 0, energy: 0.9 },
};

export interface RigInfo {
  artboards: string[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  animations: { name: string; seconds: number; fps: number; loop: string }[];
  stateMachines: { name: string; inputs: { name: string; type: string; default: number | boolean | undefined }[] }[];
}

const LOOP_NAMES = ["one-shot", "loop", "ping-pong"];
const NAMED_TYPES: Record<number, string> = { 56: "number", 59: "boolean", 58: "trigger" };

export interface RigOptions {
  src?: string;
  /** false shows the raw state machine with none of our overrides (debug page). */
  overrides?: boolean;
}

export class CharacterRig {
  private rive!: RC;
  private file!: RiveFile;
  private ab!: Artboard;
  private sm!: SMInstance;
  private renderer!: Renderer;
  private inputs: Record<string, NumberInput> = {};
  private neutral!: AnimInstance;
  private heavy!: AnimInstance;
  private solo: AnimInstance | null = null;
  private soloName: string | null = null;
  private raf = 0;
  private last = 0;
  private time = 0;
  private offsets = new Map<string, { base: number; written: number }>();
  private nodes: Record<string, TC | null> = {};

  overrides = true;
  activity: Activity = "idle";
  private target: Expression = { ...EXPRESSIONS.neutral };
  private current: Expression = { ...EXPRESSIONS.neutral };
  private speechLevel = 0;
  private blinkT = -1;
  private nextBlink = 2;
  private look = { x: 0, y: 0, tx: 0, ty: 0, next: 1 };
  onStateChange: ((names: string[]) => void) | null = null;

  private constructor(private canvas: HTMLCanvasElement) {}

  static async create(canvas: HTMLCanvasElement, options: RigOptions = {}): Promise<CharacterRig> {
    const rig = new CharacterRig(canvas);
    rig.overrides = options.overrides ?? true;
    await rig.init(options.src ?? "/character.riv");
    return rig;
  }

  private async init(src: string) {
    RuntimeLoader.setWasmUrl(riveWasmUrl);
    this.rive = await RuntimeLoader.awaitInstance();
    const bytes = new Uint8Array(await (await fetch(src)).arrayBuffer());
    this.file = await this.rive.load(bytes);
    this.ab = this.file.artboardByName(ARTBOARD);
    this.sm = new this.rive.StateMachineInstance(this.ab.stateMachineByName(STATE_MACHINE), this.ab);
    for (let i = 0; i < this.sm.inputCount(); i++) {
      const input = this.sm.input(i);
      this.inputs[input.name] = input.asNumber() as unknown as NumberInput;
    }
    this.neutral = new this.rive.LinearAnimationInstance(this.ab.animationByName(ANIMATIONS.neutral), this.ab);
    this.heavy = new this.rive.LinearAnimationInstance(this.ab.animationByName(ANIMATIONS.heavyLids), this.ab);
    for (const name of ["eyes", "brows", "black eye left", "black eye right", "head", "body"]) {
      try {
        this.nodes[name] = this.ab.transformComponent(name);
      } catch {
        this.nodes[name] = null;
      }
    }
    this.renderer = this.rive.makeRenderer(this.canvas);
    // The file starts on id 9 (its demo talking loop); start at rest instead.
    this.setMouth(MOUTH.REST, MOUTH_SPEED_RESTING);
    this.last = performance.now();
    this.raf = this.rive.requestAnimationFrame(this.frame);
  }

  /** Everything the debug page lists. */
  info(): RigInfo {
    const anims: RigInfo["animations"] = [];
    for (let i = 0; i < this.ab.animationCount(); i++) {
      // duration (frames) and fps exist at runtime but are missing from the typings
      const a = this.ab.animationByIndex(i) as unknown as { name: string; duration: number; fps: number; loopValue: number };
      anims.push({ name: a.name, seconds: +(a.duration / a.fps).toFixed(3), fps: a.fps, loop: LOOP_NAMES[a.loopValue] ?? String(a.loopValue) });
    }
    const sms: RigInfo["stateMachines"] = [];
    for (let i = 0; i < this.ab.stateMachineCount(); i++) {
      const def = this.ab.stateMachineByIndex(i);
      const fresh = this.file.artboardByName(ARTBOARD);
      const inst = new this.rive.StateMachineInstance(def, fresh);
      const inputs = [];
      for (let k = 0; k < inst.inputCount(); k++) {
        const inp = inst.input(k);
        inputs.push({ name: inp.name, type: NAMED_TYPES[inp.type] ?? `type ${inp.type}`, default: inp.value });
      }
      sms.push({ name: def.name, inputs });
      inst.delete();
      fresh.delete();
    }
    const artboards: string[] = [];
    for (let i = 0; i < this.file.artboardCount(); i++) artboards.push(this.file.artboardByIndex(i).name);
    const b = this.ab.bounds;
    return { artboards, bounds: { minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY }, animations: anims, stateMachines: sms };
  }

  input(name: string): number | undefined {
    return this.inputs[name]?.value;
  }

  setInput(name: string, value: number) {
    const input = this.inputs[name];
    if (input) input.value = value;
  }

  /** Mouth shape (see mouth.ts) and blend speed. Speed must stay above 0. */
  setMouth(id: number, speed?: number) {
    this.setInput(INPUT_MOUTH, id);
    if (speed !== undefined) this.setInput(INPUT_MOUTH_SPEED, Math.max(1, speed));
  }

  setExpression(emotion: Emotion | "listening") {
    this.target = { ...EXPRESSIONS[emotion] };
  }

  setActivity(activity: Activity) {
    this.activity = activity;
  }

  /** Loudness of the voice that is playing right now, 0..1 (drives the talk bob). */
  setSpeechLevel(level: number) {
    this.speechLevel = level;
  }

  blink() {
    if (this.blinkT < 0) this.blinkT = 0;
  }

  /** Debug: play one animation on its own instead of the state machine (null = back to normal). */
  playSolo(name: string | null) {
    this.solo?.delete();
    this.solo = null;
    this.soloName = name;
    if (name) this.solo = new this.rive.LinearAnimationInstance(this.ab.animationByName(name), this.ab);
  }

  get soloAnimation() {
    return this.soloName;
  }

  destroy() {
    this.rive?.cancelAnimationFrame(this.raf);
  }

  private frame = (now: number) => {
    const dt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    this.time += dt;
    this.resize();

    if (this.solo) {
      // fresh pose each frame so only the solo animation shows
      this.solo.advance(dt);
      this.solo.apply(1);
    } else {
      this.sm.advance(dt);
      const changed: string[] = [];
      for (let i = 0; i < this.sm.stateChangedCount(); i++) changed.push(this.sm.stateChangedNameByIndex(i));
      if (changed.length && this.onStateChange) this.onStateChange(changed);
      if (this.overrides) this.applyLife(dt);
    }
    this.ab.advance(dt);
    this.draw();
    this.raf = this.rive.requestAnimationFrame(this.frame);
  };

  private applyLife(dt: number) {
    // ease the expression toward its target (~250 ms)
    const k = 1 - Math.exp(-dt * 6);
    const c = this.current;
    const t = this.target;
    for (const key of Object.keys(c) as (keyof Expression)[]) c[key] += (t[key] - c[key]) * k;

    // emotion layer: neutral, then heavy lids by the expression's amount
    this.neutral.apply(1);
    if (c.lids > 0.01) this.heavy.apply(Math.min(1, c.lids));

    // blinks every 2.5-6 s, sometimes a double blink; 70 ms close, 110 ms open
    this.nextBlink -= dt;
    if (this.nextBlink <= 0 && this.blinkT < 0) {
      this.blinkT = 0;
      this.nextBlink = 2.5 + Math.random() * 3.5;
      if (Math.random() < 0.15) this.nextBlink = 0.35;
    }
    let lid = 1;
    if (this.blinkT >= 0) {
      this.blinkT += dt;
      const close = 0.07;
      const open = 0.11;
      if (this.blinkT < close) lid = 1 - this.blinkT / close;
      else if (this.blinkT < close + open) lid = (this.blinkT - close) / open;
      else this.blinkT = -1;
      lid = 0.08 + 0.92 * lid;
    }

    // pupils: small saccades around the expression's gaze target
    this.look.next -= dt;
    if (this.look.next <= 0) {
      const wander = this.activity === "listening" ? 0.15 : this.activity === "thinking" ? 0.25 : 0.35;
      this.look.tx = (Math.random() * 2 - 1) * wander;
      this.look.ty = (Math.random() * 2 - 1) * wander * 0.6;
      this.look.next = 0.8 + Math.random() * 2.2;
    }
    const lk = 1 - Math.exp(-dt * 18); // saccades are quick
    this.look.x += (c.lookX + this.look.tx - this.look.x) * lk;
    this.look.y += (c.lookY + this.look.ty - this.look.y) * lk;

    // breathing (~0.25 Hz), slow sway, and a bob that follows the voice
    const breath = Math.sin(this.time * Math.PI * 2 * 0.25);
    const sway = Math.sin(this.time * Math.PI * 2 * 0.09) * 0.8;
    const talk = this.activity === "speaking" ? this.speechLevel * c.energy : 0;

    this.offset("eyes", "scaleY", c.eyeOpen * lid, "mul");
    this.offset("eyes", "scaleX", c.eyeOpen, "mul");
    this.offset("brows", "y", c.brow - talk * 6);
    this.offset("black eye left", "x", this.look.x * 12);
    this.offset("black eye left", "y", this.look.y * 9);
    this.offset("black eye right", "x", this.look.x * 12);
    this.offset("black eye right", "y", this.look.y * 9);
    this.offset("body", "scaleY", 1 + breath * 0.008, "mul");
    this.offset("head", "y", -breath * 3 - talk * 7);
    this.offset("head", "rotation", ((c.tilt + sway) * Math.PI) / 180);
  }

  /**
   * Adds `value` to a property (or multiplies it). Works whether or not the
   * file's animations key that property: if an animation wrote a new value
   * since our last write we offset that, otherwise we offset our saved base.
   */
  private offset(node: string, prop: "x" | "y" | "rotation" | "scaleX" | "scaleY", value: number, mode: "add" | "mul" = "add") {
    const tc = this.nodes[node] as unknown as Record<string, number> | null;
    if (!tc || !(prop in tc)) return;
    const key = `${node}.${prop}`;
    const cur = tc[prop]!;
    const saved = this.offsets.get(key);
    const base = saved && cur === saved.written ? saved.base : cur;
    const next = mode === "mul" ? base * value : base + value;
    tc[prop] = next;
    this.offsets.set(key, { base, written: Math.fround(next) });
  }

  private resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(this.canvas.clientWidth * dpr);
    const h = Math.round(this.canvas.clientHeight * dpr);
    if (w > 0 && h > 0 && (this.canvas.width !== w || this.canvas.height !== h)) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  private draw() {
    const w = this.canvas.width;
    const h = this.canvas.height;
    const b = this.ab.bounds;
    // Show the whole artboard. On tall screens, trim only the empty sides so
    // the full character (head and body) stays as large as possible.
    const fullW = b.maxX - b.minX;
    const fullH = b.maxY - b.minY;
    const minCharW = 1250; // head + shoulders span ~1050..2150
    const wantW = Math.min(fullW, Math.max(minCharW, (fullH * w) / Math.max(1, h)));
    const cx = 1594; // character centre in artboard units
    const minX = Math.max(b.minX, Math.min(b.maxX - wantW, cx - wantW / 2));
    const content = { minX, minY: b.minY, maxX: minX + wantW, maxY: b.maxY };
    this.renderer.clear();
    this.renderer.save();
    this.renderer.align(this.rive.Fit.contain, this.rive.Alignment.center, { minX: 0, minY: 0, maxX: w, maxY: h }, content);
    this.ab.draw(this.renderer);
    this.renderer.restore();
  }
}
