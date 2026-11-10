// Runs on the audio thread: downsamples microphone audio to 16 kHz mono and posts Int16 frames
// (~100 ms each) to the page. Nothing is kept beyond the current frame.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;      // input samples per output sample
    this.frame = new Int16Array(1600);
    this.n = 0;
    this.pos = 0;                         // fractional read position carried between blocks
    this.sum = 0;
    this.cnt = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    // Box-filter downsample: average the input samples that fall into each output sample.
    for (let i = 0; i < ch.length; i++) {
      this.sum += ch[i];
      this.cnt++;
      this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        const v = Math.max(-1, Math.min(1, this.sum / this.cnt));
        this.frame[this.n++] = v < 0 ? v * 32768 : v * 32767;
        this.sum = 0;
        this.cnt = 0;
        if (this.n === this.frame.length) {
          const out = this.frame;
          this.frame = new Int16Array(1600);
          this.n = 0;
          this.port.postMessage(out.buffer, [out.buffer]);
        }
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
