/** Small Web Audio synth: every sound is generated, no sample files. */
export class Sfx {
  private ctx: BaseAudioContext | null = null;
  private noise: AudioBuffer | null = null;
  muted = localStorage.getItem("wriggle.muted") === "1";

  unlock(): void {
    if (this.ctx) {
      if (this.ctx instanceof AudioContext && this.ctx.state === "suspended") void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    const len = this.ctx.sampleRate;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  /** Render into a given context (an OfflineAudioContext in tests) instead of the speakers. */
  useContext(ctx: BaseAudioContext): void {
    this.ctx = ctx;
    this.muted = false;
    const len = ctx.sampleRate;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  toggle(): boolean {
    this.muted = !this.muted;
    localStorage.setItem("wriggle.muted", this.muted ? "1" : "0");
    return this.muted;
  }

  private out(gain: number): GainNode | null {
    if (!this.ctx || this.muted) return null;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    g.connect(this.ctx.destination);
    return g;
  }

  boom(size: number): void {
    const g = this.out(0.55);
    if (!g || !this.ctx || !this.noise) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(900 + size * 12, t);
    lp.frequency.exponentialRampToValueAtTime(60, t + 0.5 + size / 80);
    g.gain.setValueAtTime(0.7, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.6 + size / 70);
    src.connect(lp).connect(g);
    src.start(t);
    src.stop(t + 1.4);
    const o = this.ctx.createOscillator();
    const og = this.out(0.5)!;
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(35, t + 0.35);
    og.gain.setValueAtTime(0.5, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    o.connect(og);
    o.start(t);
    o.stop(t + 0.45);
  }

  fire(): void {
    const g = this.out(0.25);
    if (!g || !this.ctx || !this.noise) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = this.ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.setValueAtTime(600, t);
    bp.frequency.exponentialRampToValueAtTime(2400, t + 0.25);
    g.gain.setValueAtTime(0.4, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    src.connect(bp).connect(g);
    src.start(t);
    src.stop(t + 0.35);
  }

  blip(freq = 520, dur = 0.08, gain = 0.12): void {
    const g = this.out(gain);
    if (!g || !this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = "triangle";
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(freq * 1.5, t + dur);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur + 0.05);
    o.connect(g);
    o.start(t);
    o.stop(t + dur + 0.06);
  }

  turn(): void {
    this.blip(660, 0.09, 0.1);
    setTimeout(() => this.blip(880, 0.12, 0.1), 110);
  }

  /**
   * A worm falls: a falling, wobbling whistle that ends in a soft puff. Your own worm's is lower and
   * slower, so a loss reads differently from a takedown.
   */
  death(own: boolean): void {
    const g = this.out(0.16);
    if (!g || !this.ctx || !this.noise) return;
    const t = this.ctx.currentTime;
    const dur = own ? 0.85 : 0.6;
    const o = this.ctx.createOscillator();
    o.type = "triangle";
    o.frequency.setValueAtTime(own ? 520 : 700, t);
    o.frequency.exponentialRampToValueAtTime(own ? 105 : 170, t + dur);
    const lfo = this.ctx.createOscillator();
    const depth = this.ctx.createGain();
    lfo.frequency.value = own ? 7 : 11;
    depth.gain.value = own ? 22 : 30;
    lfo.connect(depth).connect(o.frequency);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.18, t + 0.04);
    g.gain.setValueAtTime(0.18, t + dur * 0.7);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g);
    o.start(t);
    lfo.start(t);
    o.stop(t + dur + 0.05);
    lfo.stop(t + dur + 0.05);
    // the puff
    const pg = this.out(0.25)!;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = own ? 420 : 700;
    pg.gain.setValueAtTime(0.0001, t + dur - 0.05);
    pg.gain.exponentialRampToValueAtTime(0.3, t + dur);
    pg.gain.exponentialRampToValueAtTime(0.001, t + dur + 0.35);
    src.connect(lp).connect(pg);
    src.start(t + dur - 0.05);
    src.stop(t + dur + 0.4);
  }

  splash(): void {
    const g = this.out(0.2);
    if (!g || !this.ctx || !this.noise) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const hp = this.ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 1200;
    g.gain.setValueAtTime(0.3, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    src.connect(hp).connect(g);
    src.start(t);
    src.stop(t + 0.55);
  }
}
