/* System 7 — the generators.
 *
 * One function per sound, all of them pure: a seed and a handful of numbers in,
 * a Float32Array out. Nothing here knows what a browser is, which is what lets
 * tools/audio.mjs render and measure the exact samples the walk plays back.
 *
 * The constants live in design.ts. What lives here is the *structure* of each
 * sound — which is where all the realism is, and none of it is filtered noise
 * with a level on it.
 */
import {
  type Biquad, type Rng, type Samples,
  TAU, makeRng, makeGesture, rrange, clamp, lerp, smoothstep,
  lp, hp, bp, peaking, runner, biquadInPlace,
  makePink, peakNormalise, rmsNormalise, peakCeiling, loopify, scale, rms,
} from './dsp';
import { BAKE, SR, WIND, WATER, STEPS, CRACK, IR, PEAK_DB, fogCutoffHz } from './design';

/* ── Resumable renders ─────────────────────────────────────────────────────
 *
 * Three of the generators below — the wind beds, the stream and the room
 * response — are single tight loops over between a quarter and a million
 * samples, and the engine bakes them on the click that also takes pointer lock.
 * Rendered atomically the widest bed measured as one 90 ms frame, which in a
 * scene budgeted at 30 fps is a visible stutter at the exact moment the walk
 * starts. So each of them is written as a generator that yields every few
 * thousand samples, and the engine spends a fixed few milliseconds per frame
 * pumping it.
 *
 * The plain functions keep their signatures and drain the generator, because
 * nothing offline wants to be interrupted and every call site outside the
 * engine — every test, every measurement in tools/audio.mjs — reads better
 * without a pump loop in it.
 */

/** A render in progress. Yields at chunk boundaries, returns the finished buffer. */
export type Render<T> = Generator<void, T, void>;

export function drain<T>(g: Render<T>): T {
  let r = g.next();
  while (!r.done) r = g.next();
  return r.value;
}

/* ── Shared shapes ─────────────────────────────────────────────────────── */

/** Smooth attack and release as fractions of a note. A syrinx cannot start or
 *  stop a tone instantly, and one that does reads as a beep rather than a bird. */
const env = (u: number, atk: number, rel: number): number =>
  smoothstep(0, atk, u) * smoothstep(1, 1 - rel, u);

/** Add a partial stack following a frequency trajectory into `out`. */
function addTone(
  out: Samples, sr: number, t0: number, dur: number,
  fFn: (u: number) => number, aFn: (u: number) => number,
  partials: readonly (readonly [number, number])[],
): void {
  const i0 = Math.round(t0 * sr);
  const n = Math.round(dur * sr);
  if (n <= 0) return;
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const j = i0 + i;
    if (j < 0 || j >= out.length) continue;
    const u = i / n;
    ph += (TAU * fFn(u)) / sr;
    let s = 0;
    for (let k = 0; k < partials.length; k++) s += partials[k][1] * Math.sin(ph * partials[k][0]);
    out[j] += s * aFn(u);
  }
}

/** A short burst of bandpassed noise: the primitive every fracture and grit
 *  sound in this file is built from. */
function addBurst(
  out: Samples, rng: Rng, i0: number, n: number, c: Biquad,
  amp: number, shape: (u: number) => number,
): void {
  const f = runner(c);
  for (let i = 0; i < n; i++) {
    const j = i0 + i;
    const v = f(rng() * 2 - 1);
    if (j >= 0 && j < out.length) out[j] += v * amp * shape(i / n);
  }
}

/* ══ 1. Wind ═══════════════════════════════════════════════════════════════
 *
 * Four beds, all made the same way and differing only in which part of the
 * spectrum they occupy. The runtime crossfades them against gust strength
 * (`windBalance` in design.ts), which is what turns four static textures into
 * one thing that surges, brightens and dies.
 */

export type WindBedOpts = {
  sr: number;
  seconds: number;
  seed: number;
  rmsDb: number;
  /** Shaping sections in order, with a pass count for a steeper slope. */
  sections: readonly { c: Biquad; times?: number }[];
  /** Which independent breathe channel this bed uses. Beds must not share one. */
  breatheChannel: number;
  /** Set false for the bough band: vortex shedding off a branch is at tens of
   *  hertz, far below anything audible as structure. */
  aeolian: boolean;
};

/**
 * One wind bed.
 *
 * Three things happen here that a bandpassed noise generator does not do, and
 * each was added because its absence was audible.
 *
 * The source is pink, not white. Broadband aerodynamic noise falls with
 * frequency; starting white and filtering down leaves a fizz above 8 kHz that
 * no forest produces and that dominates the spectral centroid measurement.
 *
 * The narrow peaks are vortex shedding off individual needles — see
 * `WIND.aeolian` for the Strouhal arithmetic. They are scattered at random
 * within the band and are the difference between a texture with faint
 * structure in it and one that is unmistakably a filter.
 *
 * The amplitude breathes at about two hertz from its own lowpassed noise, with
 * a channel index so no two beds breathe together. Beds that pump in lockstep
 * collapse into sounding like a single filter with an LFO, and the impression
 * of a *volume* of needles goes with them.
 */
export function windBed(o: WindBedOpts): Samples { return drain(windBedRender(o)); }

export function* windBedRender(o: WindBedOpts): Render<Samples> {
  const rng = makeRng(o.seed);
  const n = Math.round(o.seconds * o.sr);
  const out = new Float32Array(n) as Samples;
  const pink = makePink(rng);

  const chain: ((x: number) => number)[] = [];
  for (const s of o.sections) {
    for (let p = 0; p < (s.times ?? 1); p++) chain.push(runner(s.c));
  }
  if (o.aeolian) {
    const A = WIND.aeolian;
    for (let k = 0; k < A.count; k++) {
      // Log-uniform, so the peaks are spread evenly by ear rather than piling
      // up at the top of the band the way a linear draw does.
      const f = A.loHz * Math.pow(A.hiHz / A.loHz, rng());
      chain.push(runner(peaking(o.sr, f, A.q * rrange(rng, 0.7, 1.4), A.db * rrange(rng, 0.6, 1.2))));
    }
  }

  /* The modulator is gesture noise evaluated against time, not a lowpassed
   * noise source. Filtering white noise down to two hertz was the first
   * attempt and it does not work: a biquad at 1.9 Hz against a 32 kHz sample
   * rate passes a vanishing fraction of the input variance, so the modulator
   * came out at a few percent of full scale and the beds measured 1.0-2.1 dB
   * of envelope range — flat, and audibly tape hiss. A gesture is unity-scaled
   * by construction and cannot fail that way. */
  const g = makeGesture(o.seed ^ (0x51ed270b + o.breatheChannel * 7919));
  const ch = o.breatheChannel;

  for (let i = 0; i < n; i++) {
    let x = pink();
    for (let c = 0; c < chain.length; c++) x = chain[c](x);
    const t = i / o.sr;
    const m = 0.72 * g(t * WIND.breatheHz, ch) + 0.28 * g(t * WIND.breatheHz2, ch + 8);
    out[i] = x * (1 + WIND.breatheDepth * clamp(m, -1, 1));
    if ((i & (BAKE.chunk - 1)) === 0) yield;
  }

  /* Two lowpasses in series pass DC as well as their band, and the bough bed
   * plays continuously at the loudest level in the mix — enough for the offset
   * to eat real headroom once eight wind sources are summed. */
  biquadInPlace(out, hp(o.sr, Math.max(24, o.sr * 0.0025), 0.707));
  /* Levelled on RMS, because a bed's loudness is its RMS and its peak is an
   * accident of which noise sample happened to be largest. The ceiling after
   * it is the price of that: RMS normalisation cannot know the crest factor,
   * and the sibilance bed measured +0.5 dBFS peak the first time it was
   * levelled this way. It costs a fraction of a decibel of RMS and it
   * guarantees the WAV renders and the AudioBuffer never leaves the [-1, 1]
   * range a later stage might assume. */
  return peakCeiling(rmsNormalise(loopify(out, o.sr, 0.18), o.rmsDb), -1);
}

/* Each bed's recipe is exported separately from the function that renders it,
 * so the engine can hand the recipe to the resumable form and everything
 * offline can keep calling the one-line version. */

/** Air over branches and the crown as a mass. The floor of the wind, never off. */
export function boughOpts(seed: number): WindBedOpts {
  const sr = SR.bough;
  return {
    sr, seconds: WIND.boughSec, seed, rmsDb: WIND.boughDb, breatheChannel: 0, aeolian: false,
    sections: [
      { c: bp(sr, WIND.boughHz, WIND.boughQ) },
      { c: lp(sr, 1500, 0.707) },
    ],
  };
}
export const boughBed = (seed: number): Samples => windBed(boughOpts(seed));

/** The needle band proper — the body of the signature sound. */
export function needleOpts(seed: number): WindBedOpts {
  const sr = SR.needle;
  return {
    sr, seconds: WIND.needleSec, seed, rmsDb: WIND.needleDb, breatheChannel: 1, aeolian: true,
    sections: [
      { c: bp(sr, WIND.needleHz, WIND.needleQ) },
      { c: hp(sr, 700, 0.707) },
    ],
  };
}
export const needleBed = (seed: number): Samples => windBed(needleOpts(seed));

/** Fine sibilance, reached only by a real gust. */
export function sibilanceOpts(seed: number): WindBedOpts {
  const sr = SR.sibilance;
  return {
    sr, seconds: WIND.sibilanceSec, seed, rmsDb: WIND.sibilanceDb, breatheChannel: 2, aeolian: true,
    sections: [
      { c: hp(sr, WIND.sibilanceLoHz, 0.707), times: 2 },
      { c: lp(sr, WIND.sibilanceHiHz, 0.707), times: 2 },
    ],
  };
}
export const sibilanceBed = (seed: number): Samples => windBed(sibilanceOpts(seed));

/** Understory within a few metres. Undamped by fog, so the brightest thing here. */
export function nearOpts(seed: number): WindBedOpts {
  const sr = SR.near;
  return {
    sr, seconds: WIND.nearSec, seed, rmsDb: WIND.nearDb, breatheChannel: 3, aeolian: true,
    sections: [
      { c: hp(sr, WIND.nearLoHz, 0.707), times: 2 },
      { c: lp(sr, WIND.nearHiHz, 0.707) },
      { c: peaking(sr, 3600, 0.8, 3) },
    ],
  };
}
export const nearBed = (seed: number): Samples => windBed(nearOpts(seed));

/* ══ 2. Birds ══════════════════════════════════════════════════════════════
 *
 * The one layer where the ear grants no statistical mercy. A bed can be
 * texture; a call is a gesture, and a gesture repeated identically is a sample
 * on a timer no matter how good the synthesis is. The defences are the same
 * three the ancestor system used: several seeded variants per species, a small
 * playback-rate jitter on top, and a scheduler that thinks in bouts rather than
 * in calls.
 *
 * All four are rendered dry and close. Distance is applied at runtime by the
 * per-source lowpass, because distance in this scene is a timbre and not a
 * level — see `fogCutoffHz`.
 */

/**
 * Pacific wren. Five to eight seconds of it, which is why it gets one song per
 * bout: it is an event by itself.
 *
 * The song is a chain of elements with almost no silence between them, and the
 * realism is entirely in the element vocabulary. Three kinds:
 *
 *   chips — a few tens of milliseconds, a steep sweep between 2.6 and 7 kHz.
 *   trills — the same chip repeated at 26-38 Hz, done as synchronised FM and
 *     AM rather than as repeated notes, because a syrinx modulates airflow and
 *     pitch with one muscle and amplitude therefore dips exactly when pitch
 *     does. Unsynchronised they read as two effects on one tone.
 *   buzzes — the same trick run at 90-140 Hz, which is above the rate the ear
 *     resolves as separate events and lands in the roughness band instead.
 *
 * A wren song built from chips alone is a bird; built from chips, trills and
 * buzzes in an irregular order, it is this bird.
 */
function* wren(sr: number, rng: Rng): Render<Samples> {
  type El = { kind: number; t: number; dur: number; a: number; f: number; f2: number; rate: number; depth: number };
  const plan: El[] = [];
  let t = 0.04;
  /* Enough phrases to reach the four-to-seven seconds a Pacific wren actually
   * sings for. Seven phrases measured 1.6 s, which is a chickadee's worth of
   * song and loses the one thing that makes this bird recognisable — that it
   * goes on far longer than seems reasonable. */
  const phrases = 11 + Math.floor(rng() * 9);
  for (let p = 0; p < phrases; p++) {
    const kind = rng() < 0.42 ? 0 : rng() < 0.62 ? 1 : 2;
    if (kind === 0) {
      const chips = 2 + Math.floor(rng() * 5);
      for (let c = 0; c < chips; c++) {
        const dur = rrange(rng, 0.018, 0.045);
        const f = rrange(rng, 2700, 6400);
        plan.push({
          kind: 0, t, dur, a: rrange(rng, 0.5, 1),
          f, f2: f * rrange(rng, 0.62, 1.55), rate: 0, depth: 0,
        });
        t += dur + rrange(rng, 0.012, 0.05);
      }
    } else if (kind === 1) {
      const dur = rrange(rng, 0.28, 0.9);
      const f = rrange(rng, 3000, 5200);
      plan.push({ kind: 1, t, dur, a: rrange(rng, 0.6, 1), f, f2: f, rate: rrange(rng, 26, 38), depth: rrange(rng, 420, 1000) });
      t += dur + rrange(rng, 0.02, 0.07);
    } else {
      const dur = rrange(rng, 0.08, 0.24);
      const f = rrange(rng, 3200, 4800);
      plan.push({ kind: 2, t, dur, a: rrange(rng, 0.5, 0.85), f, f2: f, rate: rrange(rng, 90, 145), depth: rrange(rng, 500, 900) });
      t += dur + rrange(rng, 0.015, 0.06);
    }
    t += rrange(rng, 0.02, 0.09);
  }

  const out = new Float32Array(Math.round((t + 0.12) * sr)) as Samples;
  /* A slow arch over the whole song. A wren does not deliver eight seconds at
   * one level, and a flat one reads as a loop of itself. */
  const arch = (tt: number) => 0.62 + 0.38 * Math.sin(Math.PI * clamp(tt / t, 0, 1));

  for (const e of plan) {
    /* Between elements, because a full wren song is a couple of dozen swept
     * partial stacks over six seconds at 32 kHz and was the single most
     * expensive thing in the bake once the beds were chunked. */
    yield;
    const a0 = e.a * arch(e.t);
    if (e.kind === 0) {
      addTone(out, sr, e.t, e.dur,
        (u) => e.f * Math.pow(e.f2 / e.f, u),
        (u) => env(u, 0.22, 0.4) * a0,
        [[1, 1], [2, 0.10]]);
    } else {
      const cyc = e.rate * e.dur;
      addTone(out, sr, e.t, e.dur,
        (u) => e.f + e.depth * Math.sin(TAU * cyc * u),
        (u) => env(u, e.kind === 1 ? 0.06 : 0.15, 0.25) * a0
          * (0.55 + 0.45 * Math.sin(TAU * cyc * u - Math.PI / 2)),
        [[1, 1], [2, 0.07]]);
    }
  }
  return out;
}

/**
 * Varied thrush — the eerie one, and the most characteristic sound of a wet
 * Pacific conifer forest.
 *
 * One long note on a single pitch, and everything about how it sounds is in
 * why it is not a single tone. A thrush syrinx has two independently driven
 * halves, and this species drives both at once at slightly different
 * frequencies. The two beat, and because the beat lands between about thirty
 * and seventy hertz it is not heard as a tremolo but as *roughness* — that is
 * the whole reason the note reads as buzzy rather than as a flute.
 *
 * So the note is two detuned voices, and the detuning is specified as a beat
 * rate rather than as a ratio: the roughness has to stay in the same
 * perceptual band whether the note is at 1.7 kHz or 3 kHz, which a fixed cents
 * offset would not do. The second voice is at 0.62 of the first, so the
 * modulation is deep but never nulls — full cancellation gives a stuttering
 * quality that is a different bird altogether.
 *
 * `f0` is passed in rather than drawn, because a thrush works through several
 * pitches in a bout and playback-rate shifting a 1.4-second note far enough to
 * hear also shortens it audibly.
 */
function thrush(sr: number, rng: Rng, f0: number): Samples {
  const dur = rrange(rng, 1.15, 1.7);
  const beat = rrange(rng, 32, 68);
  const out = new Float32Array(Math.round((dur + 0.16) * sr)) as Samples;

  /* Attack and release both long, and the release the longer of the two: the
   * note fades rather than stopping, which is a large part of why it sounds
   * like it comes from somewhere far off in the trees. */
  const shape = (u: number) => Math.pow(env(u, 0.20, 0.34), 0.85);
  /* A slow sag in pitch across the note and a shallow four-hertz vibrato. Both
   * tiny. A perfectly steady 1.4-second tone is a test signal. */
  const traj = (u: number) => (1 - 0.012 * u) * (1 + 0.0035 * Math.sin(TAU * 4.1 * u * dur));

  addTone(out, sr, 0.02, dur, (u) => f0 * traj(u), shape, [[1, 1], [2, 0.055]]);
  addTone(out, sr, 0.02, dur, (u) => (f0 + beat) * traj(u), (u) => shape(u) * 0.62, [[1, 1]]);

  /* A breath of band noise under it, co-enveloped. Real syrinx tone is never
   * fully periodic and the difference between 5% noise and none is the
   * difference between a bird and an oscillator. */
  const nf = runner(bp(sr, f0 * 1.15, 2.2));
  const i0 = Math.round(0.02 * sr), nn = Math.round(dur * sr);
  for (let i = 0; i < nn && i0 + i < out.length; i++) {
    out[i0 + i] += nf(rng() * 2 - 1) * shape(i / nn) * 0.16;
  }
  return out;
}

/**
 * Chestnut-backed chickadee. Hoarse, fast, and the only bird here that ever
 * sounds close.
 *
 * Two very short high introductory chips, then a run of "dee" notes. The dees
 * are not tones — they are a harmonic stack on a ~520 Hz fundamental with the
 * fundamental itself almost absent and the energy sitting in partials six
 * through fourteen. That is what makes the note hoarse: the ear hears a dense
 * comb around 3-6 kHz, not a pitch.
 */
function chickadee(sr: number, rng: Rng): Samples {
  const dees = 2 + Math.floor(rng() * 3);
  const chipDur = 0.026, deeDur = rrange(rng, 0.10, 0.155);
  const total = 2 * (chipDur + 0.045) + dees * (deeDur + 0.075) + 0.1;
  const out = new Float32Array(Math.round(total * sr)) as Samples;

  let t = 0.015;
  for (let k = 0; k < 2; k++) {
    const f = rrange(rng, 7200, 8600);
    addTone(out, sr, t, chipDur, (u) => f * (1 - 0.22 * u), (u) => env(u, 0.2, 0.4) * 0.42, [[1, 1]]);
    t += chipDur + rrange(rng, 0.03, 0.055);
  }

  const f0 = rrange(rng, 470, 570);
  const partials: [number, number][] = [];
  for (let h = 5; h <= 15; h++) {
    // Weighted to peak around 4 kHz, which for this fundamental is partial 8.
    const f = f0 * h;
    partials.push([h, Math.exp(-Math.pow((f - 4000) / 2100, 2)) / Math.pow(h, 0.25)]);
  }
  for (let k = 0; k < dees; k++) {
    addTone(out, sr, t, deeDur,
      (u) => f0 * (1 - 0.06 * u),
      (u) => env(u, 0.13, 0.28) * rrange(rng, 0.8, 1.0) * 0.5,
      partials);
    t += deeDur + rrange(rng, 0.055, 0.095);
  }
  return out;
}

/**
 * Common raven, one croak.
 *
 * Rendered with its full harmonic stack and its rasp intact even though it
 * will be heard at ninety metres, because the point of the distance filter is
 * that it removes things. A pre-dulled source filtered again arrives with
 * nothing in it at all; the hollow, woody quality of a far-off raven is what
 * is *left* of a harsh croak, and it can only be left of one that was there.
 *
 * The jitter is the rasp. Corvid phonation is irregular at the cycle level, so
 * the fundamental wanders by a couple of percent at a few tens of hertz, and
 * every harmonic wanders with it. That coherent wander is the difference
 * between a croak and a sawtooth.
 */
function raven(sr: number, rng: Rng): Samples {
  const dur = rrange(rng, 0.34, 0.52);
  const f0 = rrange(rng, 215, 400);
  const out = new Float32Array(Math.round((dur + 0.14) * sr)) as Samples;

  const jr = makeRng((rng() * 1e9) | 0);
  const jlp = runner(lp(sr, 45, 0.7));
  const i0 = Math.round(0.01 * sr), n = Math.round(dur * sr);
  let ph = 0;
  const harmonics = 14;
  for (let i = 0; i < n && i0 + i < out.length; i++) {
    const u = i / n;
    const j = jlp((jr() * 2 - 1) * 3);
    const f = f0 * (1 - 0.10 * u) * (1 + 0.028 * clamp(j, -1, 1));
    ph += (TAU * f) / sr;
    let s = 0;
    for (let h = 1; h <= harmonics; h++) s += Math.sin(ph * h) / Math.pow(h, 0.78);
    out[i0 + i] += s * env(u, 0.10, 0.36) * 0.22;
  }
  /* The breath at the front. A croak begins with air before it begins with
   * tone, and without it the note switches on. */
  addBurst(out, rng, i0, Math.round(0.04 * sr), bp(sr, 1200, 0.9), 0.18, (u) => 1 - u);
  return out;
}

const THRUSH_PITCHES = [1780, 2120, 2510, 2980] as const;

export function birdBuffer(sr: number, name: string, variant: number, seed: number): Samples {
  return drain(birdBufferRender(sr, name, variant, seed));
}

export function* birdBufferRender(
  sr: number, name: string, variant: number, seed: number,
): Render<Samples> {
  const rng = makeRng(seed);
  let x: Samples;
  if (name === 'wren') x = yield* wren(sr, rng);
  else if (name === 'thrush') x = thrush(sr, rng, THRUSH_PITCHES[variant % THRUSH_PITCHES.length]);
  else if (name === 'chickadee') x = chickadee(sr, rng);
  else if (name === 'raven') x = raven(sr, rng);
  else throw new Error('birdBuffer: unknown species ' + name);
  return peakNormalise(x, PEAK_DB);
}

/* ══ 3. Footsteps ══════════════════════════════════════════════════════════ */

/**
 * One footfall, `surface` 0 for the damp dirt tread and 1 for needle duff.
 *
 * Three components, and the surface parameter does not simply filter between
 * them — it changes which ones exist.
 *
 * The thump is a decaying sine whose pitch falls through the hit, because the
 * ground compresses and the cavity under the sole shrinks. A fixed-frequency
 * thump is a kick drum. Duff sits higher and dies faster than dirt: it is a
 * light springy mat over air, where damp mineral soil is a heavy mass that
 * takes the load lower and holds it slightly longer.
 *
 * The crackle is needle and twig fracture and it belongs to duff alone — a few
 * dozen sub-five-millisecond bursts up between 1.8 and 8.5 kHz, in two
 * clusters ninety milliseconds apart because a walking step is a heel strike
 * and then a toe roll, and one evenly-spread cluster reads as a single crunch
 * with no anatomy in it. Damp dirt has almost none of this.
 *
 * The scuff belongs to dirt alone: grit dragging under the sole as it rolls,
 * which is a swell rather than a transient and is the thing that makes a
 * compacted surface identifiable.
 */
export function footstepBuffer(sr: number, seed: number, surface: number): Samples {
  const rng = makeRng(seed);
  const s = clamp(surface, 0, 1);
  const n = Math.round(STEPS.seconds * sr);
  const out = new Float32Array(n) as Samples;

  const f0 = lerp(rrange(rng, 44, 56), rrange(rng, 62, 80), s);
  const decay = lerp(4.6, 6.8, s);
  let ph = 0;
  const thumpN = Math.round(lerp(0.11, 0.075, s) * sr);
  for (let i = 0; i < thumpN && i < n; i++) {
    const u = i / thumpN;
    ph += (TAU * f0 * (1 - 0.34 * u)) / sr;
    out[i] += Math.sin(ph) * Math.exp(-u * decay) * lerp(1.0, 0.72, s);
  }

  const crackles = Math.round(lerp(5, 40, s));
  for (let c = 0; c < crackles; c++) {
    const cluster = rng() < 0.6 ? 0 : 0.088;
    const i0 = Math.round((cluster + Math.pow(rng(), 1.5) * 0.055) * sr);
    const nn = Math.round(rrange(rng, 0.0012, 0.0042) * sr);
    /* High and short. Needle fracture is a millimetre-scale event and its
     * energy is far above where a leaf-litter crunch sits; putting these in the
     * 900 Hz-4 kHz band a broadleaf floor uses makes duff sound like autumn
     * oak, which is the wrong forest entirely. */
    addBurst(out, rng, i0, nn, bp(sr, rrange(rng, 1800, 8500), 2.4),
      Math.pow(rng(), 2) * 0.55 * lerp(0.35, 1, s), (u) => 1 - u);
  }

  if (s < 0.95) {
    const i0 = Math.round(rrange(rng, 0.035, 0.06) * sr);
    const nn = Math.round(rrange(rng, 0.09, 0.14) * sr);
    // A swell, not a hit: the sole is already down and rolling.
    addBurst(out, rng, i0, nn, bp(sr, rrange(rng, 1300, 2600), 1.1),
      0.30 * (1 - s), (u) => Math.sin(Math.PI * u) * Math.sin(Math.PI * u));
  }

  biquadInPlace(out, lp(sr, lerp(2800, 9500, s), 0.707));
  /* A sine whose pitch falls through the hit has a non-zero integral, and two
   * of these a second accumulate into a measurable offset in the mix. */
  biquadInPlace(out, hp(sr, 28, 0.707));
  return peakNormalise(out, STEPS.peakDb);
}

/* ══ 4. Water ══════════════════════════════════════════════════════════════ */

/** Slow unevenness. Water is stationary in spectrum but not in envelope — the
 *  mass passing any point fluctuates at a few hertz, and without that the
 *  texture reads as a detuned radio. */
function churn(sr: number, rng: Rng, rate: number, depth: number): () => number {
  const f = runner(lp(sr, rate, 0.707));
  return () => 1 - depth + depth * clamp(0.5 + f((rng() * 2 - 1) * 6), 0, 1) * 2;
}

/**
 * A stream at some tens of metres, which is a filtered wash and nothing else.
 *
 * Deliberately no bubble chirps. Minnaert chirps are what the ear identifies
 * running water by, and they are also entirely a near-field phenomenon: thirty
 * metres of wet conifer removes every one of them. A distant stream with
 * babble in it does not sound like a big stream far away, it sounds like a
 * small one just out of sight, which is a different scene.
 */
export function streamBed(sr: number, seed: number): Samples { return drain(streamBedRender(sr, seed)); }

export function* streamBedRender(sr: number, seed: number): Render<Samples> {
  const rng = makeRng(seed);
  const n = Math.round(WATER.streamSec * sr);
  const out = new Float32Array(n) as Samples;
  const pink = makePink(rng);
  const h1 = runner(hp(sr, WATER.streamLoHz, 0.707));
  const h2 = runner(hp(sr, WATER.streamLoHz, 0.707));
  const l1 = runner(lp(sr, WATER.streamHiHz, 0.707));
  const l2 = runner(lp(sr, WATER.streamHiHz, 0.707));
  const slow = churn(sr, rng, 0.65, 0.28);
  const fast = churn(sr, rng, 3.3, 0.14);
  for (let i = 0; i < n; i++) {
    out[i] = l2(l1(h2(h1(pink())))) * slow() * fast();
    if ((i & (BAKE.chunk - 1)) === 0) yield;
  }
  return rmsNormalise(loopify(out, sr, 0.2), WATER.streamDb);
}

/**
 * One drip. Fog condensing on needles and falling onto the litter — the sound
 * this forest makes all morning, and the most specifically-this-place thing in
 * the whole system.
 *
 * The resonance is Minnaert's: a bubble entrained by the impact rings at a
 * frequency inversely proportional to its radius, and the pitch *rises* as it
 * decays because the bubble shrinks on its way to the surface. That upward
 * chirp is the entire difference between a drip and a click, and no amount of
 * filtered noise produces it.
 *
 * Odd variants land on the mat and even ones in standing water, which is a
 * real distinction here: a fog forest floor has both, and a run of identical
 * drips is the one way this layer can turn into a metronome.
 */
export function dripBuffer(sr: number, seed: number, variant: number): Samples {
  const rng = makeRng(seed);
  const n = Math.round(WATER.dripSeconds * sr);
  const out = new Float32Array(n) as Samples;
  const wet = variant % 2 === 0 ? 1 : 0.35;

  addBurst(out, rng, 0, Math.round(rrange(rng, 0.0012, 0.0026) * sr),
    bp(sr, rrange(rng, 2500, 6500), 1.4), 0.5, (u) => 1 - u);

  const bubbles = 1 + (rng() < 0.35 ? 1 : 0);
  for (let b = 0; b < bubbles; b++) {
    const t0 = b === 0 ? rrange(rng, 0.001, 0.004) : rrange(rng, 0.02, 0.07);
    const f0 = rrange(rng, 700, 2800) * (b === 0 ? 1 : rrange(rng, 1.2, 2.0));
    const tau = rrange(rng, 0.008, 0.022);
    const i0 = Math.round(t0 * sr);
    const nn = Math.round(tau * 5 * sr);
    let ph = TAU * rng();
    for (let i = 0; i < nn && i0 + i < n; i++) {
      const tt = i / sr;
      ph += (TAU * f0 * (1 + 0.55 * (tt / (tau * 5)))) / sr;
      out[i0 + i] += Math.sin(ph) * Math.exp(-tt / tau) * 0.7 * wet * (b === 0 ? 1 : 0.5);
    }
  }

  /* The mat. A drip onto needles is half a small dry impact, and the drier
   * variants are mostly this. */
  addBurst(out, rng, Math.round(0.0005 * sr), Math.round(rrange(rng, 0.004, 0.012) * sr),
    bp(sr, rrange(rng, 1400, 4200), 1.0), 0.34 * (1.4 - wet), (u) => Math.pow(1 - u, 1.6));

  biquadInPlace(out, hp(sr, 190, 0.707));
  return peakNormalise(out, WATER.dripPeakDb);
}

/* ══ 5. Branch crack ═══════════════════════════════════════════════════════ */

/**
 * A limb letting go out in the trees.
 *
 * A break is not one transient. Wood fails fibre bundle by fibre bundle, and
 * the interval between failures shortens as the remaining section is
 * overloaded — so the bursts here accelerate toward the final one rather than
 * being evenly spread. That acceleration is what makes it read as something
 * breaking instead of something being hit.
 *
 * The break excites the limb's own bending modes, which are low and lightly
 * damped in green wood; three of them between 150 and 800 Hz is enough to give
 * it a body. And the tail is not reverb, it is the needles the limb shook on
 * its way down, which is why it starts late and is broadband.
 */
export function crackBuffer(sr: number, seed: number): Samples {
  const rng = makeRng(seed);
  const n = Math.round(CRACK.seconds * sr);
  const out = new Float32Array(n) as Samples;

  const bursts = 4 + Math.floor(rng() * 6);
  const span = rrange(rng, 0.055, 0.11);
  const tBreak = span;
  for (let k = 0; k < bursts; k++) {
    const t0 = span * Math.pow(k / bursts, 1.7);
    addBurst(out, rng, Math.round(t0 * sr), Math.round(rrange(rng, 0.0008, 0.003) * sr),
      bp(sr, rrange(rng, 700, 3800), 2.0),
      0.18 + 0.5 * Math.pow(k / bursts, 2), (u) => 1 - u);
  }
  addBurst(out, rng, Math.round(tBreak * sr), Math.round(0.006 * sr),
    bp(sr, rrange(rng, 500, 1800), 1.1), 0.9, (u) => Math.pow(1 - u, 0.7));

  for (let m = 0; m < 3; m++) {
    const f = rrange(rng, 150, 800);
    const tau = rrange(rng, 0.045, 0.14);
    const i0 = Math.round(tBreak * sr);
    const nn = Math.round(tau * 5 * sr);
    let ph = TAU * rng();
    const a = 0.42 / (1 + m * 0.8);
    for (let i = 0; i < nn && i0 + i < n; i++) {
      ph += (TAU * f) / sr;
      out[i0 + i] += Math.sin(ph) * Math.exp(-(i / sr) / tau) * a;
    }
  }

  const tailAt = Math.round((tBreak + 0.05) * sr);
  addBurst(out, rng, tailAt, n - tailAt, bp(sr, rrange(rng, 2200, 3600), 0.7),
    0.10, (u) => Math.exp(-u * 4.5) * smoothstep(0, 0.15, u));

  biquadInPlace(out, hp(sr, 42, 0.707));
  return peakNormalise(out, CRACK.peakDb);
}

/* ══ 6. The room ═══════════════════════════════════════════════════════════ */

/**
 * The forest impulse response — short, dark, and barely there.
 *
 * Built as three band-limited noise decays with separate time constants, so
 * high frequencies die roughly four times faster than low ones. That
 * frequency-dependent decay is the entire acoustic signature of dense wet
 * vegetation: needles are a broadband absorber that works best at the top,
 * saturated duff reflects almost nothing, and fog droplets scatter the rest.
 *
 * The early reflections come off trunks, and they are short noise bursts
 * rather than scaled impulses because a fluted, mossy, half-metre stem is a
 * diffuse scatterer, not a mirror. Each is filtered by `fogCutoffHz` at its
 * own path length, which is the same function the direct sound goes through —
 * so a reflection that has travelled twenty metres is exactly as dull as a
 * direct sound that has.
 *
 * Left and right are independent noise under a shared envelope. Correlated
 * channels collapse a reverb to the centre, and a forest is the last place
 * that should happen.
 */
export function forestIR(sr: number, seed: number): { left: Samples; right: Samples } {
  return drain(forestIRRender(sr, seed));
}

export function* forestIRRender(sr: number, seed: number): Render<{ left: Samples; right: Samples }> {
  const n = Math.round(IR.seconds * sr);
  const make = function* (chSeed: number): Render<Samples> {
    const rng = makeRng(chSeed);
    const out = new Float32Array(n) as Samples;

    const bands: { f: (x: number) => number; tau: number }[] = [
      { f: runner(lp(sr, IR.crossLoHz, 0.707)), tau: IR.rtLowSec / 6.908 },
      { f: runner(bp(sr, Math.sqrt(IR.crossLoHz * IR.crossHiHz), 0.7)), tau: IR.rtMidSec / 6.908 },
      { f: runner(hp(sr, IR.crossHiHz, 0.707)), tau: IR.rtHighSec / 6.908 },
    ];
    /* The tail does not start at zero. Sound has to reach a scatterer and come
     * back before there is any reverberation at all, and starting the noise on
     * sample zero produces a click fused to the direct sound rather than a
     * space around it. */
    const preDelay = Math.round(0.008 * sr);
    for (let i = 0; i < n; i++) {
      const t = Math.max(0, i - preDelay) / sr;
      const w = rng() * 2 - 1;
      let s = 0;
      for (const b of bands) s += b.f(w) * Math.exp(-t / b.tau);
      out[i] = s * (i < preDelay ? 0 : 1);
      if ((i & (BAKE.chunk - 1)) === 0) yield;
    }

    for (const d of IR.earlyDistances) {
      const path = 2 * d;
      const i0 = Math.round((path / 343) * sr);
      if (i0 >= n) continue;
      addBurst(out, rng, i0, Math.round(rrange(rng, 0.0015, 0.004) * sr),
        lp(sr, fogCutoffHz(path), 0.707),
        (0.55 / (1 + path / 4)) * rrange(rng, 0.6, 1.1), (u) => Math.pow(1 - u, 1.5));
    }
    return out;
  };

  const left = yield* make(seed);
  const right = yield* make(seed ^ 0x5bd1e995);
  /* Levelled on energy rather than RMS. A convolution's output gain is set by
   * the total energy in the response, and two IRs with the same RMS but
   * different lengths are not the same send level. */
  const e = Math.sqrt((rms(left) ** 2 + rms(right) ** 2) * n);
  const g = Math.pow(10, IR.energyDb / 20) / Math.max(1e-9, e);
  return { left: peakCeiling(scale(left, g), -1), right: peakCeiling(scale(right, g), -1) };
}
