// Procedural jelly sound with Web Audio. Nothing is sampled: every sound is built when it plays.
// The wet character comes from air-bubble acoustics, where a bubble rings as a sine that glides
// upward as it decays. Each method takes an optional start time so a test can render offline.
import { wobbleHz } from './wobble.js';

const rand = (a, b) => a + Math.random() * (b - a);
const clamp01 = (v) => Math.min(Math.max(v, 0), 1);

export class JellyAudio {
  constructor(ctx) {
    this.ctx = ctx;
    this.muted = false;
    this.lastPeel = -1;

    // Everything meets in the limiter, so stacked hits can't clip.
    this.master = ctx.createGain();
    this.master.gain.value = 0.85;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -14;
    limiter.knee.value = 12;
    limiter.ratio.value = 6;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.14;
    this.master.connect(limiter);
    limiter.connect(ctx.destination);

    // A short, dark room: it places the sound on a table without washing it out.
    this.dry = ctx.createGain();
    this.dry.connect(this.master);
    const wet = ctx.createGain();
    wet.gain.value = 0.14;
    const room = ctx.createConvolver();
    room.buffer = this.makeRoom(0.42);
    this.dry.connect(room);
    room.connect(wet);
    wet.connect(this.master);

    this.noise = this.makeNoise(1.5);
    this.buildContinuous();
  }

  makeNoise(seconds) {
    const { ctx } = this;
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  makeRoom(seconds) {
    const { ctx } = this;
    const n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / n;
        const e = Math.pow(1 - t, 3.2) * (Math.random() * 2 - 1);
        lp += (e - lp) * (0.5 - 0.42 * t); // highs die first, as they do in a furnished room
        d[i] = lp;
      }
    }
    return buf;
  }

  /** A gooey body tone and a wet slosh, both silent until the jelly moves. */
  buildContinuous() {
    const { ctx } = this;
    this.bodyGain = ctx.createGain();
    this.bodyGain.gain.value = 0;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 340;
    this.body = ctx.createOscillator();
    this.body.type = 'triangle';
    this.body.frequency.value = 96;
    this.body.connect(lp);
    lp.connect(this.bodyGain);
    this.bodyGain.connect(this.dry);
    this.body.start();

    this.sloshGain = ctx.createGain();
    this.sloshGain.gain.value = 0;
    this.sloshFilter = ctx.createBiquadFilter();
    this.sloshFilter.type = 'bandpass';
    this.sloshFilter.frequency.value = 520;
    this.sloshFilter.Q.value = 1.3;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.connect(this.sloshFilter);
    this.sloshFilter.connect(this.sloshGain);
    this.sloshGain.connect(this.dry);
    src.start();
  }

  /** Called every physics frame with the top's speed (m/s) and how hard the grab is pulling (0-1). */
  setMotion(speed, tension, G, at = this.ctx.currentTime) {
    const m = clamp01(speed / 0.7);
    const base = 62 + 8.5 * wobbleHz(G);
    this.body.frequency.setTargetAtTime(base * (1 + 0.28 * m), at, 0.03);
    this.bodyGain.gain.setTargetAtTime(0.13 * Math.pow(m, 1.4), at, 0.035);
    this.sloshFilter.frequency.setTargetAtTime(420 + 1150 * m + 900 * tension, at, 0.05);
    this.sloshGain.gain.setTargetAtTime(0.055 * Math.pow(m, 1.7) + 0.022 * tension * m, at, 0.04);
  }

  env(gain, at, peak, attack, tau) {
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), at + attack);
    gain.gain.setTargetAtTime(0.0001, at + attack, tau);
    return at + attack + tau * 7;
  }

  /** One sine voice with a pitch glide; cleans itself up when finished. */
  tone(at, f0, f1, glide, peak, attack, tau, dest = this.dry) {
    const { ctx } = this;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.setValueAtTime(f0, at);
    o.frequency.exponentialRampToValueAtTime(f1, at + glide);
    o.connect(g);
    g.connect(dest);
    const end = this.env(g, at, peak, attack, tau);
    o.start(at);
    o.stop(end);
    o.onended = () => { o.disconnect(); g.disconnect(); };
  }

  /** One filtered noise burst; `f1` lets the band sweep, which is what makes it sound wet. */
  burst(at, f0, f1, q, peak, attack, tau, sweep = 0.1) {
    const { ctx } = this;
    const s = ctx.createBufferSource();
    s.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, at);
    f.frequency.exponentialRampToValueAtTime(f1, at + sweep);
    const g = ctx.createGain();
    s.connect(f);
    f.connect(g);
    g.connect(this.dry);
    const end = this.env(g, at, peak, attack, tau);
    s.start(at, Math.random() * 1.2);
    s.stop(end);
    s.onended = () => { s.disconnect(); f.disconnect(); g.disconnect(); };
  }

  /** The wobble itself: one soft bubble per real oscillation. Softer jelly sounds lower. */
  blub(level, G, at = this.ctx.currentTime) {
    if (level <= 0) return;
    const hz = wobbleHz(G);
    const f0 = (118 + 44 * hz) * rand(0.93, 1.07);
    const tau = 0.038 + 0.05 / Math.sqrt(hz);
    this.tone(at, f0, f0 * rand(1.42, 1.62), tau * 2.4, 0.42 * level, 0.005, tau);
    this.tone(at, f0 * 2.03, f0 * 3.1, tau * 1.6, 0.075 * level, 0.004, tau * 0.55);
  }

  /** Clicking: the surface dents with a falling thup, then a bubble rises out of it. */
  poke(G, at = this.ctx.currentTime) {
    const hz = wobbleHz(G);
    const f = 150 + 34 * hz;
    this.tone(at, f * 1.5, f * 0.62, 0.075, 0.58, 0.003, 0.045);
    this.tone(at + 0.038, f * 1.05, f * 2.0, 0.1, 0.34, 0.006, 0.05);
    this.burst(at, 2600, 900, 1.1, 0.05, 0.001, 0.011, 0.03);
  }

  /** Taking hold: a short suck of wet noise. */
  grab(at = this.ctx.currentTime) {
    this.burst(at, 620, 1900, 2.2, 0.11, 0.008, 0.035, 0.09);
    this.tone(at, 170, 118, 0.08, 0.17, 0.006, 0.04);
  }

  /** Letting go: the schlop. Its size and pitch sweep grow with how far it was stretched. */
  release(tension, G, at = this.ctx.currentTime) {
    const s = clamp01(tension);
    const hz = wobbleHz(G);
    const f = 92 + 22 * hz;
    const up = 2.2 + 1.8 * s;
    this.tone(at, f, f * up, 0.09 + 0.05 * s, 0.34 + 0.34 * s, 0.004, 0.05 + 0.035 * s);
    this.tone(at + 0.012, f * 2.4, f * 2.4 * up * 0.8, 0.08, 0.1 + 0.06 * s, 0.004, 0.03);
    this.burst(at, 700 + 700 * s, 2500, 1.5, 0.05 + 0.09 * s, 0.002, 0.024, 0.06);
  }

  /** Tiny sticky ticks as base nodes actually come unstuck from the plate. */
  peel(count, at = this.ctx.currentTime) {
    if (count <= 0 || at - this.lastPeel < 1 / 16) return;
    this.lastPeel = at;
    const level = Math.min(0.05 + 0.014 * count, 0.15);
    this.burst(at, rand(2200, 4800), rand(1400, 2600), 3.2, level, 0.001, 0.0035, 0.012);
  }

  /** Bumping the table: a knock in the wood and a small ring from the ceramic plate. */
  bump(at = this.ctx.currentTime) {
    this.tone(at, 92, 48, 0.09, 0.62, 0.002, 0.06);
    this.burst(at, 520, 300, 1.4, 0.2, 0.001, 0.02, 0.05);
    for (const [f, a, tau] of [[2380, 0.03, 0.06], [3910, 0.018, 0.042], [5620, 0.009, 0.026]]) {
      this.tone(at + 0.006, f, f * 0.998, 0.1, a, 0.001, tau);
    }
  }

  setMuted(m) {
    this.muted = m;
    this.master.gain.setTargetAtTime(m ? 0 : 0.85, this.ctx.currentTime, 0.015);
  }
}
