/* System 7 — the primitives.
 *
 * Parameters in, Float32Array out. Nothing in this file, or in voices.ts which
 * is built on it, touches Web Audio, the DOM or three. The split is not tidiness:
 * a browser audio graph cannot be instantiated in Node, so synthesis welded to
 * one can only ever be judged by ear in a live session. Kept pure, the exact
 * arithmetic the walk plays back is rendered to WAV by tools/audio.mjs and
 * measured there — which is how a system nobody can hear gets verified.
 *
 * Two constraints on the TypeScript here, both load-bearing. It must be
 * erasable-only syntax (no enums, no parameter properties) because
 * tools/audio.mjs imports these files into bare Node, whose type stripper
 * erases and does not transform. And it must not import through the `@/` alias,
 * which the bundler resolves and Node does not.
 */

export type Rng = () => number;

/* Float32Array<ArrayBuffer> rather than the bare Float32Array: under
 * TypeScript 5.7+ the type is generic over its backing store, and a plain
 * Float32Array is also satisfied by one over a SharedArrayBuffer, which
 * `AudioBuffer.copyToChannel` will not accept. Naming the store here keeps the
 * engine's calls type-correct without a cast at every site. */
export type Samples = Float32Array<ArrayBuffer>;

export const TAU = Math.PI * 2;

/* mulberry32. Seeded and reproducible: a render that cannot be reproduced
 * cannot be compared against the previous one, and every measurement in
 * tools/audio.mjs is a comparison against a previous one. Math.random appears
 * nowhere in this system. */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const dbToLin = (db: number): number => Math.pow(10, db / 20);
export const linToDb = (x: number): number => 20 * Math.log10(Math.max(1e-12, Math.abs(x)));
export const clamp = (x: number, a: number, b: number): number => (x < a ? a : x > b ? b : x);
export const lerp = (a: number, b: number, u: number): number => a + (b - a) * u;
export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp((x - e0) / (e1 - e0 || 1e-9), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Uniform in [a, b). */
export const rrange = (rng: Rng, a: number, b: number): number => a + rng() * (b - a);

/* Exponentially distributed waits are what make sparse event timing sound
 * natural. A uniform jitter around a mean still has a mean the ear locates
 * inside a minute; the exponential is memoryless, so the next call is never
 * "due" — which is exactly the property that makes a real bird impossible to
 * anticipate, and the property this scene's silences depend on. */
export const expRand = (rng: Rng, mean: number): number => -Math.log(1 - rng()) * mean;

/* ── Biquads ───────────────────────────────────────────────────────────── */

export type Biquad = { b0: number; b1: number; b2: number; a1: number; a2: number };

/* Web Audio's BiquadFilterNode.Q is in decibels for the peaking and shelving
 * types and linear elsewhere, but its `lowpass`/`highpass` Q is also read in
 * dB. Anywhere the engine has to reproduce a corner designed here, it converts
 * through this rather than passing 0.707 and quietly getting a Q of 1.08. */
export const qToWebAudio = (q: number): number => 20 * Math.log10(q);

/* RBJ cookbook. f0 is clamped under Nyquist because several of these are asked
 * for 11 kHz corners and the low-rate buffers run at 8 kHz: a filter designed
 * above Nyquist does not degrade gracefully, it produces NaN, and a NaN in one
 * sample of a noise bed silently zeroes the whole loop. */
function rbj(kind: string, sr: number, f0: number, q: number, dbGain: number): Biquad {
  const A = Math.pow(10, dbGain / 40);
  const w0 = (TAU * Math.min(f0, sr * 0.47)) / sr;
  const cw = Math.cos(w0), sw = Math.sin(w0);
  const al = sw / (2 * q);
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
  switch (kind) {
    case 'lowpass':
      b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; break;
    case 'highpass':
      b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; break;
    /* The constant-0dB-peak bandpass, so moving a band's centre never moves its
     * level. Centre frequency and loudness stay independent knobs, which is the
     * only way the wind's three bands could be voiced separately from where
     * they sit. */
    case 'bandpass':
      b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; break;
    case 'peaking':
      b0 = 1 + al * A; b1 = -2 * cw; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cw; a2 = 1 - al / A; break;
    case 'lowshelf': {
      const s = 2 * Math.sqrt(A) * al;
      b0 = A * ((A + 1) - (A - 1) * cw + s);
      b1 = 2 * A * ((A - 1) - (A + 1) * cw);
      b2 = A * ((A + 1) - (A - 1) * cw - s);
      a0 = (A + 1) + (A - 1) * cw + s;
      a1 = -2 * ((A - 1) + (A + 1) * cw);
      a2 = (A + 1) + (A - 1) * cw - s;
      break;
    }
    case 'highshelf': {
      const s = 2 * Math.sqrt(A) * al;
      b0 = A * ((A + 1) + (A - 1) * cw + s);
      b1 = -2 * A * ((A - 1) + (A + 1) * cw);
      b2 = A * ((A + 1) + (A - 1) * cw - s);
      a0 = (A + 1) - (A - 1) * cw + s;
      a1 = 2 * ((A - 1) - (A + 1) * cw);
      a2 = (A + 1) - (A - 1) * cw - s;
      break;
    }
    default: throw new Error('biquad: unknown kind ' + kind);
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

export const lp = (sr: number, fc: number, q = Math.SQRT1_2): Biquad => rbj('lowpass', sr, fc, q, 0);
export const hp = (sr: number, fc: number, q = Math.SQRT1_2): Biquad => rbj('highpass', sr, fc, q, 0);
export const bp = (sr: number, fc: number, q = 1): Biquad => rbj('bandpass', sr, fc, q, 0);
export const peaking = (sr: number, fc: number, q: number, db: number): Biquad => rbj('peaking', sr, fc, q, db);
export const lowshelf = (sr: number, fc: number, db: number): Biquad => rbj('lowshelf', sr, fc, Math.SQRT1_2, db);
export const highshelf = (sr: number, fc: number, db: number): Biquad => rbj('highshelf', sr, fc, Math.SQRT1_2, db);

/** A stateful evaluator for one section, for generators that stream. */
export function runner(c: Biquad): (x: number) => number {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return (x: number) => {
    const y = c.b0 * x + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    return y;
  };
}

/** Run one section over a buffer, `times` cascaded passes for a steeper slope. */
export function biquadInPlace(x: Samples, c: Biquad, times = 1): Samples {
  for (let p = 0; p < times; p++) {
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const v = x[i];
      const y = c.b0 * v + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
      x2 = x1; x1 = v; y2 = y1; y1 = y;
      x[i] = y;
    }
  }
  return x;
}

/**
 * One-pole lowpass with a settable corner, for moving a cutoff at control rate
 * rather than shaping a spectrum. The biquads above would need their five
 * coefficients recomputed per block to do the same job, and their resonance is
 * unwanted when the thing being modelled is absorption.
 */
export function onePole(sr: number, fc: number): { step: (x: number) => number; set: (f: number) => void } {
  let a = 1 - Math.exp((-TAU * fc) / sr);
  let y = 0;
  return {
    step(x: number) { y += a * (x - y); return y; },
    set(f: number) { a = 1 - Math.exp((-TAU * Math.max(1, f)) / sr); },
  };
}

/* ── Noise ─────────────────────────────────────────────────────────────── */

export const whiteAt = (rng: Rng): number => rng() * 2 - 1;

/* Paul Kellet's economy pink filter. Wind and water are both far closer to
 * pink than to white — equal energy per octave is what broadband natural
 * sources do — and starting from white and equalising down by hand always
 * leaves a fizz above 8 kHz that nothing outdoors produces. */
export function makePink(rng: Rng): () => number {
  let b0 = 0, b1 = 0, b2 = 0;
  return () => {
    const w = rng() * 2 - 1;
    b0 = 0.99765 * b0 + w * 0.0990460;
    b1 = 0.96300 * b1 + w * 0.2965164;
    b2 = 0.57000 * b2 + w * 1.0526913;
    return (b0 + b1 + b2 + w * 0.1848) * 0.18;
  };
}

/* ── Measurement (shared with the offline tool, so both agree) ─────────── */

export function rms(x: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, x.length));
}

export function peak(x: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > m) m = a; }
  return m;
}

export function dcOffset(x: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i];
  return s / Math.max(1, x.length);
}

export function scale(x: Samples, g: number): Samples {
  for (let i = 0; i < x.length; i++) x[i] *= g;
  return x;
}

/** Scale so the largest magnitude sits at `targetDb` dBFS. */
export function peakNormalise(x: Samples, targetDb = -3): Samples {
  const p = peak(x);
  return p > 1e-9 ? scale(x, dbToLin(targetDb) / p) : x;
}

/** Scale so the RMS sits at `targetDb`. What beds are levelled by: a noise
 *  bed's peak is a property of its longest tail, its RMS is its loudness. */
export function rmsNormalise(x: Samples, targetDb: number): Samples {
  const r = rms(x);
  return r > 1e-9 ? scale(x, dbToLin(targetDb) / r) : x;
}

/** Pull the peak down to a ceiling if it exceeds it, and otherwise do nothing. */
export function peakCeiling(x: Samples, ceilingDb: number): Samples {
  const c = dbToLin(ceilingDb);
  const p = peak(x);
  return p > c ? scale(x, c / p) : x;
}

/* ── Looping ───────────────────────────────────────────────────────────── */

/**
 * Fold a buffer's tail into its head with an equal-power crossfade, returning
 * one shorter by the fade so the join is seamless.
 *
 * Equal-power and not linear because everything looped in this scene is
 * noise-like: the two ends are uncorrelated, so a linear fade dips ~3 dB
 * through the midpoint and the seam becomes an audible periodic breath. On a
 * wind bed that is fatal — a breath every 11.17 s is exactly the thing the
 * incommensurate loop lengths exist to prevent, arriving by another door.
 */
export function loopify(src: Samples, sr: number, fadeSec = 0.12): Samples {
  const F = Math.min(src.length >> 1, Math.round(fadeSec * sr));
  const N = src.length - F;
  const out = new Float32Array(N) as Samples;
  out.set(src.subarray(0, N));
  for (let i = 0; i < F; i++) {
    const w = ((i + 1) / (F + 1)) * (Math.PI / 2);
    out[i] = src[i] * Math.sin(w) + src[N + i] * Math.cos(w);
  }
  return out;
}

/* ── Control-rate gesture noise ────────────────────────────────────────── */

/**
 * Smooth 1-D value noise with a cubic interpolant, in -1..1.
 *
 * This drives every slow envelope in the system — the gust, the stream's
 * churn, the drift of footfall surface. Smoothness is the whole requirement:
 * a gain curve driven by white noise sounds like a faulty cable, and one
 * driven by a sine sounds like an LFO. `k` selects a statistically independent
 * channel so one generator serves every layer without a table per layer.
 */
export function makeGesture(seed: number): (t: number, k?: number) => number {
  const h = (i: number, k: number): number => {
    let x = Math.imul(i | 0, 0x27d4eb2d) ^ Math.imul(k | 0, 0x165667b1) ^ (seed | 0);
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 2147483648 - 1;
  };
  return (t: number, k = 0) => {
    const i = Math.floor(t);
    const f = t - i;
    const u = f * f * (3 - 2 * f);
    return h(i, k) * (1 - u) + h(i + 1, k) * u;
  };
}

/** Equal-power stereo pan gains for p in [-1, 1]. */
export function panGains(p: number): [number, number] {
  const a = ((clamp(p, -1, 1) + 1) * Math.PI) / 4;
  return [Math.cos(a), Math.sin(a)];
}
