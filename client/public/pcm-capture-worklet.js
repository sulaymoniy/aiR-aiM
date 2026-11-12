// AudioWorklet: downsample the microphone to 16 kHz mono and post 20 ms
// chunks of signed 16-bit PCM to the main thread.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.pos = 0; // fractional read position into the incoming stream
    this.carry = new Float32Array(0);
    this.out = new Int16Array(320);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    // join leftover samples with this block
    const buf = new Float32Array(this.carry.length + ch.length);
    buf.set(this.carry);
    buf.set(ch, this.carry.length);
    let pos = this.pos;
    while (pos + this.ratio <= buf.length) {
      // average the source samples that fall into this output sample (simple low-pass)
      const start = Math.floor(pos);
      const end = Math.min(buf.length, Math.floor(pos + this.ratio));
      let sum = 0;
      for (let i = start; i < end; i++) sum += buf[i];
      const v = sum / Math.max(1, end - start);
      this.out[this.n++] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
      if (this.n === this.out.length) {
        this.port.postMessage(this.out.buffer.slice(0));
        this.n = 0;
      }
      pos += this.ratio;
    }
    const keepFrom = Math.floor(pos);
    this.carry = buf.slice(keepFrom);
    this.pos = pos - keepFrom;
    return true;
  }
}
registerProcessor("pcm-capture", PcmCapture);
