import { TTS_SAMPLE_RATE } from "../../shared/protocol";

/** Microphone with echo cancellation, noise suppression and auto gain, streamed as 16 kHz PCM. */
export class Mic {
  stream!: MediaStream;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  muted = false;

  constructor(private ctx: AudioContext, private onPcm: (pcm: ArrayBuffer) => void) {}

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    await this.ctx.audioWorklet.addModule("/pcm-capture-worklet.js");
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, "pcm-capture");
    this.node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
      if (!this.muted) this.onPcm(e.data);
    };
    // The worklet must be pulled by the graph; route it to a silent sink.
    const sink = this.ctx.createGain();
    sink.gain.value = 0;
    this.source.connect(this.node).connect(sink).connect(this.ctx.destination);
  }

  setMuted(m: boolean) {
    this.muted = m;
    for (const t of this.stream?.getAudioTracks() ?? []) t.enabled = !m;
  }

  stop() {
    this.node?.disconnect();
    this.source?.disconnect();
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.node = null;
    this.source = null;
  }
}

interface Segment {
  streamStart: number; // ms in the reply's audio stream
  streamEnd: number;
  ctxStart: number; // AudioContext time it plays at
}

/**
 * Gapless playback of the character's 24 kHz PCM. Keeps a map from the reply's
 * audio-stream time to the AudioContext clock, so lip sync, emotions and
 * captions follow exactly what is audible (even across network hiccups).
 */
export class Player {
  readonly analyser: AnalyserNode;
  private out: GainNode;
  private sources: AudioBufferSourceNode[] = [];
  private segments: Segment[] = [];
  private nextTime = 0;
  private streamMs = 0;
  replyId = -1;
  private ended = false; // server sent every chunk
  onStart: ((replyId: number, ctxStart: number) => void) | null = null;
  onDone: ((replyId: number, playedMs: number) => void) | null = null;

  constructor(private ctx: AudioContext) {
    this.out = ctx.createGain();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.3;
    this.out.connect(this.analyser);
    this.analyser.connect(ctx.destination);
  }

  /** Quick volume dip the moment the user might be talking; undone if it was a false alarm. */
  duck(on: boolean) {
    const g = this.out.gain;
    g.cancelScheduledValues(this.ctx.currentTime);
    g.setTargetAtTime(on ? 0.2 : 1, this.ctx.currentTime, 0.015);
  }

  get playing() {
    return this.replyId >= 0 && this.segments.length > 0;
  }

  /** Begin a new reply; drops anything still playing. */
  begin(replyId: number) {
    this.stop();
    this.replyId = replyId;
    this.streamMs = 0;
    this.ended = false;
  }

  push(replyId: number, pcm: Int16Array) {
    if (replyId !== this.replyId || !pcm.length) return;
    const buf = this.ctx.createBuffer(1, pcm.length, TTS_SAMPLE_RATE);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i]! / 32768;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.out);
    const now = this.ctx.currentTime;
    // first chunk (or after an underrun): small lead so the start is clean
    const start = Math.max(this.nextTime, now + 0.03);
    src.start(start);
    const first = this.segments.length === 0;
    const durMs = (pcm.length / TTS_SAMPLE_RATE) * 1000;
    this.segments.push({ streamStart: this.streamMs, streamEnd: this.streamMs + durMs, ctxStart: start });
    this.streamMs += durMs;
    this.nextTime = start + durMs / 1000;
    this.sources.push(src);
    src.onended = () => {
      this.sources = this.sources.filter((s) => s !== src);
      if (this.ended && this.sources.length === 0) this.finish();
    };
    if (first) this.onStart?.(replyId, start);
  }

  /** The server has sent all audio for this reply. */
  end(replyId: number) {
    if (replyId !== this.replyId) return;
    this.ended = true;
    if (this.sources.length === 0) this.finish();
  }

  /** Position in the reply's audio stream that is audible right now (ms), or -1. */
  positionMs(): number {
    if (!this.segments.length) return -1;
    const t = this.ctx.currentTime;
    for (let i = this.segments.length - 1; i >= 0; i--) {
      const s = this.segments[i]!;
      if (t >= s.ctxStart) return Math.min(s.streamEnd, s.streamStart + (t - s.ctxStart) * 1000);
    }
    return -1; // scheduled but not started yet
  }

  /** Stop instantly (barge-in). Returns how many ms were heard. */
  stop(): number {
    const played = Math.max(0, this.positionMs());
    for (const s of this.sources) {
      s.onended = null;
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
      s.disconnect();
    }
    this.sources = [];
    this.segments = [];
    this.nextTime = 0;
    this.replyId = -1;
    this.duck(false);
    return played;
  }

  private finish() {
    const id = this.replyId;
    const played = this.streamMs;
    this.segments = [];
    this.replyId = -1;
    this.onDone?.(id, played);
  }
}
