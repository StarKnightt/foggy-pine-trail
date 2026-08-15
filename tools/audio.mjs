/* What System 7 actually produces, measured rather than asserted.
 *
 * This is the audio counterpart of tools/shoot.mjs and it exists for the same
 * reason: the only way to know whether a generator is right is to look at the
 * numbers it makes, and for audio that can be done entirely on the CPU with no
 * browser, no GPU and — critically — no ears. It imports src/audio/*.ts
 * directly, so every number below comes from the exact arithmetic the walk
 * plays back rather than from a reimplementation of it.
 *
 * The check it exists for above all others is the first one in every row:
 * non-silence. A generator that returns zeros and a Web Audio graph with a
 * disconnected node both raise nothing at all, and are indistinguishable from
 * correct until somebody puts headphones on.
 *
 *   node tools/audio.mjs                measure everything, write no files
 *   node tools/audio.mjs --wav          also write shots/audio/*.wav
 *   node tools/audio.mjs --wav --secs 90  a longer walk render
 *   node tools/audio.mjs --verbose      plus the full octave-band table
 *
 * Node strips the types on import; there is no build step and no bundler,
 * which is why nothing under src/audio may use non-erasable TypeScript or the
 * `@/` path alias.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { register } from 'node:module';

/* Dynamic rather than static, because the resolver hook that lets Node follow
 * the extensionless imports inside src/audio has to be registered first, and
 * static imports are hoisted above every statement in the file. */
register('./audiohook.mjs', import.meta.url);

const {
  makeRng, makeGesture, rms, peak, dcOffset, linToDb, dbToLin, clamp,
  lp, bp, hp, runner, biquadInPlace, makePink, peakNormalise, loopify, scale,
} = await import('../src/audio/dsp.ts');
const {
  SR, SEED, WIND, WATER, STEPS, CRACK, BIRDS, BIRD_NAMES, BIRD_BUS, IR, MASTER,
  PANNER, gustEnvelope, windBalance, fogCutoffHz, stepSurface,
} = await import('../src/audio/design.ts');
const {
  boughBed, needleBed, sibilanceBed, nearBed, birdBuffer, footstepBuffer,
  streamBed, dripBuffer, crackBuffer, forestIR,
} = await import('../src/audio/voices.ts');
const {
  makeBirdScheduler, makeDripScheduler, makeCrackScheduler,
} = await import('../src/audio/schedule.ts');

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'shots', 'audio');

const args = process.argv.slice(2);
const WAV = args.includes('--wav');
const VERBOSE = args.includes('--verbose');
const SECS = (() => { const i = args.indexOf('--secs'); return i < 0 ? 60 : Number(args[i + 1]); })();

/* ── Spectral machinery ────────────────────────────────────────────────── */

/** In-place iterative radix-2 FFT over Float64Array of length 2^k. */
function fft(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      const half = len >> 1;
      for (let k = 0; k < half; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + half] * cr - im[i + k + half] * ci;
        const vi = re[i + k + half] * ci + im[i + k + half] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + half] = ur - vr; im[i + k + half] = ui - vi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

/**
 * Welch power spectrum: Hann-windowed, half-overlapped, averaged.
 *
 * A single transform of a whole buffer is the spectrum of one particular noise
 * realisation and is far too ragged to compare a centroid against a threshold.
 * Averaging every frame in the buffer turns it into an estimate whose variance
 * is small enough to assert on.
 */
function spectrum(x, sr, size = 8192) {
  const n = Math.min(size, 1 << Math.floor(Math.log2(Math.max(64, x.length))));
  const hop = n >> 1;
  const win = new Float64Array(n);
  for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  const acc = new Float64Array(n / 2 + 1);
  const re = new Float64Array(n), im = new Float64Array(n);
  let frames = 0;
  for (let off = 0; off + n <= x.length; off += hop) {
    for (let i = 0; i < n; i++) { re[i] = x[off + i] * win[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k <= n / 2; k++) acc[k] += re[k] * re[k] + im[k] * im[k];
    frames++;
  }
  if (frames === 0) {
    for (let i = 0; i < n; i++) { re[i] = (x[i] ?? 0) * win[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k <= n / 2; k++) acc[k] = re[k] * re[k] + im[k] * im[k];
    frames = 1;
  }
  for (let k = 0; k <= n / 2; k++) acc[k] /= frames;
  return { power: acc, binHz: sr / n };
}

const OCTAVES = [63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

/**
 * Loop-seam discontinuity, as a ratio.
 *
 * Concatenate the buffer with itself and look at the first difference: a
 * seamless join has a step at the wrap no larger than the steps the signal
 * makes anywhere else, so the largest difference in a short window around the
 * seam divided by the 99.9th percentile difference over the whole buffer lands
 * near 1. A hard cut through noise puts that ratio well above 3 and is audible
 * as a tick once every loop.
 */
function seamRatio(x, sr) {
  const n = x.length;
  if (n < 64) return 0;
  let worst = 0;
  const w = Math.max(2, Math.round(0.002 * sr));
  for (let i = 0; i < w; i++) {
    const a = x[(n - w + i) % n], b = x[(n - w + i + 1) % n];
    const d = Math.abs(b - a);
    if (d > worst) worst = d;
  }
  const diffs = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i++) diffs[i] = Math.abs(x[i + 1] - x[i]);
  const sorted = Float64Array.from(diffs).sort();
  const p999 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.999))];
  return p999 > 1e-12 ? worst / p999 : 0;
}

/** RMS in 100 ms blocks, for the envelope statistics a bed is judged by. */
function envelope(x, sr, blockSec = 0.1) {
  const b = Math.max(1, Math.round(blockSec * sr));
  const out = [];
  for (let i = 0; i + b <= x.length; i += b) {
    let s = 0;
    for (let k = 0; k < b; k++) s += x[i + k] * x[i + k];
    out.push(Math.sqrt(s / b));
  }
  return out;
}

/**
 * Amplitude-modulation depth and rate over a fraction of a buffer.
 *
 * Rectify, lowpass to strip the carrier, then take the peak of the envelope's
 * own spectrum. Depth is reported as the classic modulation index
 * (max-min)/(max+min) taken off the smoothed envelope rather than off raw
 * samples, which would just report the crest factor.
 */
function amDepth(x, sr, from, to) {
  const i0 = Math.round(x.length * from), i1 = Math.round(x.length * to);
  const seg = new Float32Array(i1 - i0);
  const f = runner(lp(sr, 300, 0.707));
  /* Prime the detector before the window opens. A filter started from zero
   * state ramps up over its first few milliseconds, and that ramp puts a
   * near-zero sample into the minimum — which reported a modulation depth of
   * exactly 1.00 for a signal whose true depth is 0.62. */
  for (let i = Math.max(0, i0 - Math.round(0.03 * sr)); i < i0; i++) f(Math.abs(x[i]));
  for (let i = i0; i < i1; i++) seg[i - i0] = f(Math.abs(x[i]));
  let mn = Infinity, mx = 0, mean = 0;
  for (let i = 0; i < seg.length; i++) { if (seg[i] < mn) mn = seg[i]; if (seg[i] > mx) mx = seg[i]; mean += seg[i]; }
  mean /= Math.max(1, seg.length);
  for (let i = 0; i < seg.length; i++) seg[i] -= mean;
  const { power, binHz } = spectrum(seg, sr, 4096);
  let best = 1;
  for (let k = 2; k < power.length; k++) if (k * binHz < 400 && power[k] > power[best]) best = k;
  return { depth: (mx - mn) / Math.max(1e-9, mx + mn), rateHz: best * binHz };
}

function analyse(x, sr) {
  const p = peak(x), r = rms(x);
  const { power, binHz } = spectrum(x, sr);
  let tot = 0, wsum = 0;
  for (let k = 1; k < power.length; k++) { tot += power[k]; wsum += power[k] * k * binHz; }
  const centroid = tot > 0 ? wsum / tot : 0;

  const bands = OCTAVES.map((fc) => {
    const lo = fc / Math.SQRT2, hi = fc * Math.SQRT2;
    let s = 0;
    for (let k = 1; k < power.length; k++) {
      const f = k * binHz;
      if (f >= lo && f < hi) s += power[k];
    }
    return tot > 0 ? s / tot : 0;
  });

  const fracAbove = (f) => {
    let s = 0;
    for (let k = 1; k < power.length; k++) if (k * binHz >= f) s += power[k];
    return tot > 0 ? s / tot : 0;
  };

  const env = envelope(x, sr);
  const eMax = env.length ? Math.max(...env) : 0;
  const eMin = env.length ? Math.min(...env) : 0;

  return {
    rmsDb: linToDb(r), peakDb: linToDb(p), crestDb: linToDb(p) - linToDb(r),
    dcDb: linToDb(dcOffset(x)), centroid, bands, fracAbove,
    envRangeDb: linToDb(eMax) - linToDb(Math.max(eMin, 1e-9)),
    dur: x.length / sr,
  };
}

/* ── Reporting ─────────────────────────────────────────────────────────── */

let pass = 0, fail = 0;
const failures = [];
const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : String(v));
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

function check(name, ok, detail) {
  if (ok) pass++; else { fail++; failures.push(`${name}: ${detail}`); }
  return ok;
}
const notSilent = (name, a) =>
  check(`${name} silent`, a.rmsDb > -62, `RMS ${f1(a.rmsDb)} dBFS — the buffer is empty or nearly so`);
const inRange = (name, what, v, lo, hi, unit = '') =>
  check(`${name} ${what}`, v >= lo && v <= hi, `${what} = ${f1(v)}${unit}, wanted ${f1(lo)}..${f1(hi)}${unit}`);
const noClip = (name, a) =>
  check(`${name} clipping`, a.peakDb <= 0.0, `peak ${f1(a.peakDb)} dBFS`);
const noDc = (name, a) =>
  check(`${name} DC`, a.dcDb < a.rmsDb - 34, `DC ${f1(a.dcDb)} dBFS against RMS ${f1(a.rmsDb)}`);

function header(title) {
  console.log(`\n${title}`);
  console.log(`  ${pad('source', 20)} ${padL('rms', 7)} ${padL('peak', 7)} ${padL('crest', 6)} ` +
    `${padL('cent', 7)} ${padL('>3k%', 6)} ${padL('dur', 7)} ${padL('seam', 6)}`);
}
function row(name, a, sr, x, extra = '') {
  const s = x ? seamRatio(x, sr) : NaN;
  console.log(`  ${pad(name, 20)} ${padL(f1(a.rmsDb), 7)} ${padL(f1(a.peakDb), 7)} ${padL(f1(a.crestDb), 6)} ` +
    `${padL(Math.round(a.centroid), 7)} ${padL((a.fracAbove(3000) * 100).toFixed(0), 6)} ` +
    `${padL(a.dur.toFixed(2), 7)} ${padL(Number.isFinite(s) ? s.toFixed(2) : '-', 6)}  ${extra}`);
  if (VERBOSE) {
    const cells = a.bands.map((b, i) =>
      `${OCTAVES[i] >= 1000 ? OCTAVES[i] / 1000 + 'k' : OCTAVES[i]}:${(b * 100).toFixed(1)}`);
    console.log(`      octaves %  ${cells.join('  ')}`);
  }
}

/* ── WAV ───────────────────────────────────────────────────────────────── */

function writeWav(name, channels, sr) {
  if (!WAV) return;
  const n = channels[0].length;
  const ch = channels.length;
  const buf = Buffer.alloc(44 + n * ch * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * ch * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(ch, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * ch * 2, 28);
  buf.writeUInt16LE(ch * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * ch * 2, 40);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, channels[c][i]));
      buf.writeInt16LE(Math.round(v * 32767), o);
      o += 2;
    }
  }
  writeFileSync(join(OUT, name), buf);
  written.push(name);
}
const written = [];

/* ── Offline mix helpers ───────────────────────────────────────────────── */

const MIX_SR = 32000;

/** Linear resample. The browser does the same thing to an AudioBuffer whose
 *  rate differs from the context's, so this is not an approximation of the
 *  runtime — it is the runtime. */
function resample(x, from, to) {
  if (from === to) return x;
  const n = Math.round((x.length * to) / from);
  const out = new Float32Array(n);
  const r = from / to;
  for (let i = 0; i < n; i++) {
    const t = i * r;
    const i0 = Math.floor(t);
    const f = t - i0;
    out[i] = (x[i0] ?? 0) * (1 - f) + (x[i0 + 1] ?? x[i0] ?? 0) * f;
  }
  return out;
}

/** FFT overlap-add convolution, for putting the offline mix in the same room
 *  the browser's ConvolverNode will. */
function convolve(x, h) {
  const N = 1 << Math.ceil(Math.log2(h.length * 4));
  const hop = N - h.length + 1;
  const hr = new Float64Array(N), hi = new Float64Array(N);
  for (let i = 0; i < h.length; i++) hr[i] = h[i];
  fft(hr, hi);
  const out = new Float32Array(x.length + h.length);
  const xr = new Float64Array(N), xi = new Float64Array(N);
  for (let off = 0; off < x.length; off += hop) {
    xr.fill(0); xi.fill(0);
    for (let i = 0; i < hop && off + i < x.length; i++) xr[i] = x[off + i];
    fft(xr, xi);
    for (let k = 0; k < N; k++) {
      const re = xr[k] * hr[k] - xi[k] * hi[k];
      const im = xr[k] * hi[k] + xi[k] * hr[k];
      xr[k] = re; xi[k] = im;
    }
    fft(xr, xi, true);
    for (let i = 0; i < N && off + i < out.length; i++) out[off + i] += xr[i];
  }
  return out;
}

/** Web Audio's `inverse` distance model, so offline and online levels agree. */
function distanceGain(d) {
  const { refDistance: r, rolloffFactor: f } = PANNER;
  return r / (r + f * Math.max(0, d - r));
}

const panGains = (p) => {
  const a = ((clamp(p, -1, 1) + 1) * Math.PI) / 4;
  return [Math.cos(a), Math.sin(a)];
};

/** Stamp a one-shot into a stereo pair plus a mono reverb send. */
function place(dryL, dryR, send, x, sr, at, ev, gainDb, sendDb, fog = true) {
  const g = dbToLin(gainDb) * distanceGain(ev.dist);
  const y = Float32Array.from(x);
  /* One section, because the runtime is one BiquadFilterNode and fogCutoffHz
   * is fitted to that slope. Two passes here would measure a scene the browser
   * never plays — and so would filtering the footsteps, which is why `fog` can
   * be turned off: the engine gives them no Spot at all, because they happen
   * at the listener's own feet where the fog model has nothing to say. */
  if (fog) biquadInPlace(y, lp(sr, fogCutoffHz(ev.dist), 0.707), 1);
  const horiz = Math.cos(Math.atan2(ev.elev, Math.max(0.1, ev.dist)));
  const [gl, gr] = panGains(Math.sin(ev.az) * horiz);
  const s = dbToLin(sendDb) * g;
  const i0 = Math.round(at * sr);
  for (let i = 0; i < y.length; i++) {
    const j = i0 + i;
    if (j < 0 || j >= dryL.length) continue;
    dryL[j] += y[i] * g * gl;
    dryR[j] += y[i] * g * gr;
    send[j] += y[i] * s;
  }
}

/* ══ 1. Wind ═══════════════════════════════════════════════════════════════ */

console.log('System 7 — foggy pine trail, measured');
mkdirSync(OUT, { recursive: true });

const t0 = Date.now();
const beds = {
  bough: { x: boughBed(SEED + 1), sr: SR.bough },
  needle: { x: needleBed(SEED + 2), sr: SR.needle },
  sibilance: { x: sibilanceBed(SEED + 3), sr: SR.sibilance },
  near: { x: nearBed(SEED + 4), sr: SR.near },
};

header('1. wind beds');
for (const [name, b] of Object.entries(beds)) {
  const a = analyse(b.x, b.sr);
  row(`${name} @${b.sr}`, a, b.sr, b.x);
  notSilent(name, a);
  noClip(name, a);
  noDc(name, a);
  check(`${name} seam`, seamRatio(b.x, b.sr) < 3.0,
    `seam ratio ${seamRatio(b.x, b.sr).toFixed(2)} — the loop join is a step, not a crossfade`);
  /* A bed that measures flat has no breathing left in it after normalisation,
   * which is the specific way a wind layer turns into tape hiss. */
  inRange(name, 'envelope range', a.envRangeDb, 3.0, 20, ' dB');
}

/* The claim the brief makes about this scene is that conifer needles sound
 * different from broadleaves, so it has to be checked against a broadleaf and
 * not against nothing. This is the standard broadleaf model — a band around
 * 1.1 kHz gated at ~45 Hz into discrete dry collisions — and the two ways pine
 * differs from it are both measurable: the spectrum sits much higher, and the
 * texture is smooth rather than impulsive, which shows up as a lower crest
 * factor. Either alone could be faked by an EQ; both together cannot. */
function broadleafControl(sr, seconds) {
  const rng = makeRng(0xb1ea11);
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  // Pink rather than white, for the same reason the beds are: broadband
  // aerodynamic noise falls with frequency, and a white-sourced control would
  // be an unfairly bright straw man to compare the pine layer against.
  const pink = makePink(rng);
  const band = runner(bp(sr, 1100, 0.6));
  const band2 = runner(lp(sr, 2600, 0.707));
  const gate = runner(lp(sr, 45, 0.707));
  for (let i = 0; i < n; i++) {
    const g = Math.max(0, gate((rng() * 2 - 1) * 8));
    out[i] = band2(band(pink())) * (0.15 + 0.85 * Math.min(1, g * g * 3));
  }
  return peakNormalise(loopify(out, sr, 0.1), -3);
}

/**
 * The whole wind layer as the runtime plays it: four beds, two channels each,
 * gains driven by the shared gust envelope with the right channel lagging.
 * This is the hero, and it is the only way to measure the hero — the beds
 * individually say nothing about whether the surge works.
 */
function renderWind(seconds, sr = MIX_SR) {
  const n = Math.round(seconds * sr);
  const L = new Float32Array(n), R = new Float32Array(n);
  const g = makeGesture(SEED);
  const rs = {};
  for (const [k, b] of Object.entries(beds)) rs[k] = resample(b.x, b.sr, sr);

  const layers = [
    { key: 'bough', band: 'bough', db: 0, lag: WIND.lagSec, pan: 0.35 },
    { key: 'needle', band: 'needle', db: 0, lag: WIND.lagSec, pan: 0.55 },
    { key: 'sibilance', band: 'sibilance', db: 0, lag: WIND.lagSec, pan: 0.7 },
    { key: 'near', band: 'near', db: 0, lag: WIND.nearLagSec, pan: 0.85 },
  ];
  const bus = dbToLin(WIND.busDb);
  /* Control rate, then held. Evaluating the gust every sample would be
   * thousands of times more arithmetic for a curve whose fastest term has a
   * period of eight seconds. */
  const CTRL = 128;
  for (const ly of layers) {
    const src = rs[ly.key];
    const m = src.length;
    /* Two voices per bed, reading the same buffer from places 43.7% apart, and
     * panned to opposite sides. That is what decorrelates left from right
     * without a second buffer — and evaluating the gust at two different times
     * for the two voices is what makes a gust *cross* the canopy rather than
     * switch on in both ears at once. */
    const voices = [
      { off: 0, pan: -ly.pan, lag: 0 },
      { off: Math.round(m * 0.437), pan: ly.pan, lag: ly.lag },
    ];
    for (const v of voices) {
      const [pl, pr] = panGains(v.pan);
      for (let i = 0; i < n; i += CTRL) {
        const gg = windBalance(gustEnvelope(g, i / sr - v.lag))[ly.band] * bus;
        for (let k = 0; k < CTRL && i + k < n; k++) {
          const j = i + k;
          const s = src[(v.off + j) % m] * gg;
          L[j] += s * pl;
          R[j] += s * pr;
        }
      }
    }
  }
  return { L, R };
}

const wind60 = renderWind(60);
const windMono = new Float32Array(wind60.L.length);
for (let i = 0; i < windMono.length; i++) windMono[i] = (wind60.L[i] + wind60.R[i]) * 0.5;
const windA = analyse(windMono, MIX_SR);
const broadleaf = broadleafControl(MIX_SR, 12);
const bleafA = analyse(broadleaf, MIX_SR);

header('2. the wind layer, and a broadleaf control');
row('pine wind (60 s)', windA, MIX_SR, null);
row('broadleaf control', bleafA, MIX_SR, null);
notSilent('wind layer', windA);
noClip('wind layer', windA);
check('wind brighter than broadleaf',
  windA.centroid > bleafA.centroid * 1.4,
  `pine centroid ${Math.round(windA.centroid)} Hz vs broadleaf ${Math.round(bleafA.centroid)} Hz — ` +
  'needles are supposed to sit an octave up');
check('wind smoother than broadleaf',
  windA.crestDb < bleafA.crestDb - 2,
  `pine crest ${f1(windA.crestDb)} dB vs broadleaf ${f1(bleafA.crestDb)} dB — ` +
  'a conifer hisses, it does not clatter');
inRange('wind layer', 'gust range', windA.envRangeDb, 8, 34, ' dB');

/* The gust envelope itself, over ten minutes. What is being checked is the
 * brief's own number: gusts that build and die over ten to thirty seconds. */
{
  const g = makeGesture(SEED);
  const dt = 0.05, T = 600;
  let above = false, start = 0, count = 0, total = 0, sum = 0, hi = 0, lo = 1;
  for (let t = 0; t < T; t += dt) {
    const v = gustEnvelope(g, t);
    sum += v; if (v > hi) hi = v; if (v < lo) lo = v;
    if (!above && v > 0.5) { above = true; start = t; }
    else if (above && v < 0.5) { above = false; count++; total += t - start; }
  }
  const mean = total / Math.max(1, count);
  console.log(`\n  gust envelope over ${T} s: ${count} gusts, mean ${mean.toFixed(1)} s above half, ` +
    `range ${lo.toFixed(2)}..${hi.toFixed(2)}, mean ${(sum / (T / dt)).toFixed(2)}`);
  inRange('gust', 'mean duration', mean, 8, 34, ' s');
  inRange('gust', 'rate per minute', (count / T) * 60, 0.6, 4.0, '/min');
  /* Skewed toward the lulls on purpose — see the power curve in gustEnvelope.
   * A mean near 0.5 would be an afternoon, not a dawn. */
  inRange('gust', 'mean level', sum / (T / dt), 0.22, 0.46);
}

/* ══ 3. Birds ══════════════════════════════════════════════════════════════ */

header('3. birds (dry, before distance)');
const birds = {};
for (const name of BIRD_NAMES) {
  for (let v = 0; v < BIRDS[name].variants; v++) {
    birds[`${name}:${v}`] = birdBuffer(SR.bird, name, v, SEED + 100 + name.length * 977 + v * 31);
  }
}
for (const [k, x] of Object.entries(birds)) {
  const a = analyse(x, SR.bird);
  row(k, a, SR.bird, null);
  notSilent(k, a);
  noClip(k, a);
}
{
  const w = analyse(birds['wren:0'], SR.bird);
  inRange('wren', 'duration', w.dur, 3.0, 9.0, ' s');
  inRange('wren', 'centroid', w.centroid, 2600, 6000, ' Hz');
  const t = analyse(birds['thrush:0'], SR.bird);
  inRange('thrush', 'duration', t.dur, 1.1, 2.0, ' s');
  /* The whole character of this note is roughness from two detuned voices
   * beating, so both the depth and the rate of that beating are asserted. The
   * rate has to land in the roughness band — above about twenty hertz, where
   * the ear stops hearing a tremolo and starts hearing a texture — and the
   * depth has to be deep enough to be that texture without nulling, which
   * would turn it into a stutter. Measured over the sustain only, because the
   * long attack and release are not part of the claim. */
  const { depth, rateHz } = amDepth(birds['thrush:0'], SR.bird, 0.35, 0.75);
  console.log(`      thrush beating: depth ${depth.toFixed(2)}, rate ${rateHz.toFixed(0)} Hz`);
  inRange('thrush', 'beat depth', depth, 0.25, 0.95);
  inRange('thrush', 'beat rate', rateHz, 22, 90, ' Hz');
  const c = analyse(birds['chickadee:0'], SR.bird);
  inRange('chickadee', 'centroid', c.centroid, 3000, 8000, ' Hz');
  const r = analyse(birds['raven:0'], SR.bird);
  inRange('raven', 'centroid', r.centroid, 300, 2600, ' Hz');
}

/* What the listener actually gets, which is the dry call through the fog at
 * the distance the scheduler puts it. This is the measurement that proves the
 * fog is doing something, and it is the reason the raven is worth having. */
/**
 * What arrives at the listener, which is the only level that matters.
 *
 * Everything is quoted against the wind bed, because an absolute dBFS figure
 * is meaningless when the master fader can move the whole mix. "Fourteen
 * decibels under the wind" is a statement about whether a listener will notice
 * the thing, and it is what the source gains in design.ts were solved from.
 */
function asHeard(x, sr, dist, gainDb, label, extra = '', fog = true) {
  const y = Float32Array.from(x);
  if (fog) biquadInPlace(y, lp(sr, fogCutoffHz(dist), 0.707), 1);
  scale(y, distanceGain(dist) * dbToLin(gainDb));
  const a = analyse(y, sr);
  row(label, a, sr, null, `fc ${fog ? Math.round(fogCutoffHz(dist)) + ' Hz' : 'none'}  ` +
    `${(a.rmsDb - windRefDb).toFixed(1)} dB vs wind  ${extra}`);
  return a;
}

/** The wind's own RMS at the same point in the chain, as the reference. */
const windRefDb = windA.rmsDb;

/* ══ 4. Footsteps ══════════════════════════════════════════════════════════ */

header('4. footsteps');
const SURFACES = [0, 0.5, 1];
const steps = {};
SURFACES.forEach((s, si) => {
  for (let v = 0; v < STEPS.variants; v++) {
    steps[`${si}:${v}`] = footstepBuffer(SR.step, SEED + 300 + si * 61 + v * 7, s);
  }
});
for (const si of [0, 2]) {
  const a = analyse(steps[`${si}:0`], SR.step);
  row(si === 0 ? 'dirt tread' : 'needle duff', a, SR.step, null);
  notSilent(`step${si}`, a);
  noClip(`step${si}`, a);
  noDc(`step${si}`, a);
}
{
  const dirt = analyse(steps['0:0'], SR.step);
  const duff = analyse(steps['2:0'], SR.step);
  check('duff brighter than dirt', duff.centroid > dirt.centroid * 1.5,
    `duff ${Math.round(duff.centroid)} Hz vs dirt ${Math.round(dirt.centroid)} Hz — ` +
    'needle fracture should put duff an octave up');
  check('duff has fracture content', duff.fracAbove(3000) > 0.25,
    `only ${(duff.fracAbove(3000) * 100).toFixed(0)}% above 3 kHz`);
  check('dirt is dull', dirt.fracAbove(3000) < 0.12,
    `${(dirt.fracAbove(3000) * 100).toFixed(0)}% above 3 kHz on damp soil`);
  /* Six variants exist so that two steps a second do not read as one sample on
   * a timer. If two of them are nearly the same buffer that has failed
   * silently, so the spread of their centroids is asserted rather than hoped
   * for. */
  const cents = [];
  for (let v = 0; v < STEPS.variants; v++) cents.push(analyse(steps[`2:${v}`], SR.step).centroid);
  const spread = (Math.max(...cents) - Math.min(...cents)) / (cents.reduce((a, b) => a + b) / cents.length);
  inRange('duff variants', 'centroid spread', spread * 100, 4, 90, '%');
}

/* ══ 5. Water and cracks ═══════════════════════════════════════════════════ */

header('5. water, cracks, room');
const stream = streamBed(SR.stream, SEED + 500);
{
  const a = analyse(stream, SR.stream);
  row('stream (dry)', a, SR.stream, stream);
  notSilent('stream', a);
  noDc('stream', a);
  check('stream seam', seamRatio(stream, SR.stream) < 3.0,
    `seam ratio ${seamRatio(stream, SR.stream).toFixed(2)}`);
  /* No chirps in it, and that is a design requirement rather than an accident.
   * Bubble chirps are near-field, and any of them surviving here would make
   * this read as a small stream just out of sight instead of a large one a
   * long way off. */
  check('stream has no near-field detail', a.fracAbove(3000) < 0.02,
    `${(a.fracAbove(3000) * 100).toFixed(1)}% above 3 kHz`);
}
const drips = [];
for (let v = 0; v < WATER.dripVariants; v++) drips.push(dripBuffer(SR.drip, SEED + 600 + v * 13, v));
{
  const a = analyse(drips[0], SR.drip);
  row('drip', a, SR.drip, null);
  notSilent('drip', a);
  noClip('drip', a);
  inRange('drip', 'duration', a.dur, 0.15, 0.4, ' s');
  inRange('drip', 'centroid', a.centroid, 900, 6000, ' Hz');
}
const cracks = [];
for (let v = 0; v < CRACK.variants; v++) cracks.push(crackBuffer(SR.crack, SEED + 700 + v * 17));
{
  const a = analyse(cracks[0], SR.crack);
  row('branch crack', a, SR.crack, null);
  notSilent('crack', a);
  noClip('crack', a);
  /* A crack is a transient. If the crest factor falls to bed levels it has
   * stopped being one, which is the way this sound fails: too many bursts
   * smeared together is a rustle, not a break. */
  inRange('crack', 'crest', a.crestDb, 11, 30, ' dB');
}
const ir = forestIR(SR.ir, SEED + 800);
{
  const a = analyse(ir.left, SR.ir);
  row('IR left', a, SR.ir, null);
  notSilent('IR', a);
  noClip('IR', a);
  /* The measured RT60 per band, taken off the Schroeder integral. The design
   * asks for a room that is short at the bottom and much shorter at the top;
   * this is where that is confirmed rather than assumed, because a wrong
   * frequency-dependent decay is the single fastest way to turn a fog forest
   * into a cathedral. */
  const rt = (x, sr, coeff) => {
    const y = Float32Array.from(x);
    biquadInPlace(y, coeff, 2);
    let e = 0;
    const sch = new Float64Array(y.length);
    for (let i = y.length - 1; i >= 0; i--) { e += y[i] * y[i]; sch[i] = e; }
    if (sch[0] <= 0) return 0;
    const db = (i) => 10 * Math.log10(Math.max(1e-20, sch[i] / sch[0]));
    let i5 = 0, i25 = 0;
    for (let i = 0; i < y.length; i++) { if (db(i) > -5) i5 = i; if (db(i) > -25) i25 = i; }
    return ((i25 - i5) / sr) * 3;
  };
  const rLow = rt(ir.left, SR.ir, lp(SR.ir, IR.crossLoHz, 0.707));
  const rHigh = rt(ir.left, SR.ir, hp(SR.ir, IR.crossHiHz, 0.707));
  console.log(`      measured RT60  low ${rLow.toFixed(2)} s   high ${rHigh.toFixed(2)} s ` +
    `(design ${IR.rtLowSec} / ${IR.rtHighSec})`);
  check('room is damp', rHigh < rLow * 0.65,
    `high RT ${rHigh.toFixed(2)} s against low ${rLow.toFixed(2)} s — ` +
    'needles and fog absorb the top, and if they do not this is a stone room');
  check('room is short', rLow < 0.9, `low RT60 ${rLow.toFixed(2)} s is a hall, not a wet forest`);
  /* Left and right must not be the same noise, or the reverb collapses to the
   * middle of the head. */
  let dot = 0, nl = 0, nr = 0;
  for (let i = 0; i < ir.left.length; i++) { dot += ir.left[i] * ir.right[i]; nl += ir.left[i] ** 2; nr += ir.right[i] ** 2; }
  const corr = dot / Math.sqrt(nl * nr);
  check('room is wide', Math.abs(corr) < 0.35, `L/R correlation ${corr.toFixed(3)}`);
}

/* ══ 6. Everything as it arrives ═══════════════════════════════════════════ */

header('6. as heard: distance, fog, and level against the wind bed');
for (const name of BIRD_NAMES) {
  const d = (BIRDS[name].dist[0] + BIRDS[name].dist[1]) / 2;
  const dry = analyse(birds[`${name}:0`], SR.bird);
  const a = asHeard(birds[`${name}:0`], SR.bird, d, BIRDS[name].gainDb + BIRD_BUS.busDb,
    `${name} @${Math.round(d)} m`);
  check(`${name} dulled by distance`, a.centroid < dry.centroid, 'the distance filter did nothing');
  /* Audible but not in front. A call more than about twenty-six decibels under
   * the bed is not sparse, it is missing; one within three of it is sitting on
   * the microphone. */
  inRange(name, 'level vs wind', a.rmsDb - windRefDb, -26, -3, ' dB');
}
{
  const near = Math.abs(WATER.streamAt[0]);
  const far = Math.hypot(WATER.streamAt[0], WATER.streamAt[2]);
  const s = asHeard(stream, SR.stream, near, WATER.streamBusDb,
    `stream @${near} m`, `from ${far.toFixed(0)} m at the start`);
  inRange('stream', 'level vs wind', s.rmsDb - windRefDb, -30, -8, ' dB');
  const dr = asHeard(drips[0], SR.drip, 3, WATER.dripBusDb, 'drip @3 m');
  inRange('drip', 'peak vs wind', dr.peakDb - windRefDb, -12, 12, ' dB');
  const cr = asHeard(cracks[0], SR.crack, 38, CRACK.busDb, 'crack @38 m');
  inRange('crack', 'peak vs wind', cr.peakDb - windRefDb, -8, 16, ' dB');
  const st = asHeard(steps['2:0'], SR.step, 1.1, STEPS.busDb, 'footstep @1.1 m', '', false);
  inRange('footstep', 'peak vs wind', st.peakDb - windRefDb, 0, 22, ' dB');
}
check('raven arrives dark',
  analyse((() => {
    const y = Float32Array.from(birds['raven:0']);
    biquadInPlace(y, lp(SR.bird, fogCutoffHz(95), 0.707), 1);
    return y;
  })(), SR.bird).fracAbove(2500) < 0.03,
  'a raven at ninety metres through fog should have essentially nothing above 2.5 kHz left');

/* ══ 7. Event density ══════════════════════════════════════════════════════ */

console.log('\n7. how busy the forest is');
{
  const b = makeBirdScheduler(SEED + 900);
  const counts = {};
  let e = b.next();
  const T = 600;
  while (e.time < T) { counts[e.species] = (counts[e.species] ?? 0) + 1; e = b.next(); }
  const total = Object.values(counts).reduce((a, c) => a + c, 0);
  console.log(`  birds in ${T} s: ${total} calls  ${JSON.stringify(counts)}`);
  inRange('birds', 'calls per minute', (total / T) * 60, 0.4, 3.2, '/min');

  const b45 = makeBirdScheduler(SEED + 900);
  let first = b45.next().time;
  check('a bird inside the walk', first < 24,
    `first call at ${first.toFixed(1)} s — a forty-five second walk would contain none`);

  const d = makeDripScheduler(SEED + 901);
  let dc = 0, de = d.next();
  while (de.time < T) { dc++; de = d.next(); }
  console.log(`  drips in ${T} s: ${dc}  (one every ${(T / Math.max(1, dc)).toFixed(1)} s)`);
  inRange('drips', 'seconds between', T / Math.max(1, dc), 4, 16, ' s');

  const c = makeCrackScheduler(SEED + 902);
  let cc = 0, ce = c.next();
  while (ce.time < T) { cc++; ce = c.next(); }
  console.log(`  branch cracks in ${T} s: ${cc}`);
  inRange('cracks', 'per 10 min', cc, 1, 12);
}

/* ══ 8. The whole walk ═════════════════════════════════════════════════════
 *
 * Everything at once, through the same distance model, fog filter and room the
 * browser will use. This is the artefact a human can actually listen to, and
 * it is also the only place the layers are measured against each other rather
 * than in isolation — which is where a mix goes wrong.
 */
function renderWalk(seconds) {
  const sr = MIX_SR;
  const n = Math.round(seconds * sr);
  const { L, R } = renderWind(seconds, sr);
  const send = new Float32Array(n);

  /* Compressed schedules. At the real rates a sixty-second render would
   * contain one bird and no crack, which is correct for the scene and useless
   * as a check on whether birds and cracks work at all. */
  const bs = makeBirdScheduler(SEED + 900, 0.14);
  for (let e = bs.next(); e.time < seconds; e = bs.next()) {
    const src = birds[`${e.species}:${e.variant}`];
    place(L, R, send, resample(src, SR.bird, sr), sr, e.time, e,
      e.gainDb + BIRD_BUS.busDb, BIRD_BUS.sendDb);
  }
  const ds = makeDripScheduler(SEED + 901);
  for (let e = ds.next(); e.time < seconds; e = ds.next()) {
    place(L, R, send, resample(drips[e.variant], SR.drip, sr), sr, e.time, e,
      e.gainDb + WATER.dripBusDb, WATER.dripSendDb);
  }
  const cs = makeCrackScheduler(SEED + 902, 0.25);
  for (let e = cs.next(); e.time < seconds; e = cs.next()) {
    place(L, R, send, resample(cracks[e.variant], SR.crack, sr), sr, e.time, e,
      e.gainDb + CRACK.busDb, CRACK.sendDb);
  }

  /* Footsteps at the walker's own cadence: DIMS.walkSpeed over the 0.66 m step
   * length the gait uses, which is 1.74 steps a second. Taken from the same
   * arithmetic rather than typed, so a change to the walk cannot silently
   * desynchronise the render from the scene. */
  const g = makeGesture(SEED);
  const period = 0.66 / 1.15;
  let k = 0;
  for (let t = 0.4; t < seconds; t += period, k++) {
    const s = stepSurface(g, k);
    const si = s < 0.25 ? 0 : s < 0.75 ? 1 : 2;
    const src = resample(steps[`${si}:${k % STEPS.variants}`], SR.step, sr);
    place(L, R, send, src, sr, t,
      { az: (k % 2 ? 0.24 : -0.24), dist: 1.1, elev: -1.5 },
      STEPS.busDb + STEPS.footDb[k % 2], STEPS.sendDb, false);
  }

  /* The stream, which is placed in the world and therefore changes across the
   * walk. The listener starts at z = 0 and walks to z = -48 at 1.15 m/s. */
  {
    const src = resample(stream, SR.stream, sr);
    const m = src.length;
    const CTRL = 256;
    const fl = [];
    for (let i = 0; i < n; i += CTRL) {
      const t = i / sr;
      const z = -Math.min(48, 1.15 * t);
      const dx = WATER.streamAt[0] - 0, dz = WATER.streamAt[2] - z;
      const d = Math.hypot(dx, dz);
      fl.push({ i, d, fc: fogCutoffHz(d), g: distanceGain(d), pan: clamp(dx / Math.max(1, d), -1, 1) });
    }
    /* One section, tracking the corner as the walker closes on it. The runtime
     * does exactly this with a BiquadFilterNode and setTargetAtTime; here the
     * corner is stepped every 256 samples, which is finer than the runtime's
     * six-frame update and therefore cannot hide a glide artefact the runtime
     * would have. */
    const coef = lp(sr, fl[0].fc, 0.707);
    const fs = runner(coef);
    let seg = 0;
    const busG = dbToLin(WATER.streamBusDb);
    for (let i = 0; i < n; i++) {
      if (seg + 1 < fl.length && i >= fl[seg + 1].i) { seg++; Object.assign(coef, lp(sr, fl[seg].fc, 0.707)); }
      const s = fl[seg];
      const [gl, gr] = panGains(s.pan);
      const v = fs(src[i % m]) * s.g * busG;
      L[i] += v * gl;
      R[i] += v * gr;
    }
  }

  /* The room. One mono send convolved with each side of the IR, which is what
   * the browser's ConvolverNode does with a mono input and a stereo response. */
  const irL = resample(ir.left, SR.ir, sr);
  const irR = resample(ir.right, SR.ir, sr);
  const wetL = convolve(send, irL);
  const wetR = convolve(send, irR);
  const ret = dbToLin(IR.returnDb);
  for (let i = 0; i < n; i++) { L[i] += wetL[i] * ret; R[i] += wetR[i] * ret; }

  const master = dbToLin(MASTER.gainDb);
  biquadInPlace(L, hp(sr, MASTER.highpassHz, 0.707));
  biquadInPlace(R, hp(sr, MASTER.highpassHz, 0.707));
  scale(L, master); scale(R, master);
  return { L, R, sr };
}

header(`8. the whole walk (${SECS} s)`);
const walk = renderWalk(SECS);
{
  const mono = new Float32Array(walk.L.length);
  for (let i = 0; i < mono.length; i++) mono[i] = (walk.L[i] + walk.R[i]) * 0.5;
  const a = analyse(mono, walk.sr);
  row('full mix', a, walk.sr, null);
  notSilent('walk', a);
  /* The limiter in the live graph would catch an overshoot, but a mix that
   * needs it is a mix whose levels are wrong; the offline render has no
   * limiter precisely so that this check is meaningful. */
  check('walk headroom', a.peakDb < -0.5, `peak ${f1(a.peakDb)} dBFS before any limiting`);
  noDc('walk', a);
  inRange('walk', 'loudness', a.rmsDb, -34, -18, ' dBFS');
  /* Correlation. Two independent noise beds panned apart is the intent; a
   * correlation near 1 would mean the decorrelation offsets are not working
   * and the whole thing is mono. */
  let dot = 0, nl = 0, nr = 0;
  for (let i = 0; i < walk.L.length; i++) { dot += walk.L[i] * walk.R[i]; nl += walk.L[i] ** 2; nr += walk.R[i] ** 2; }
  const corr = dot / Math.sqrt(nl * nr);
  console.log(`      L/R correlation ${corr.toFixed(3)}`);
  inRange('walk', 'L/R correlation', corr, -0.2, 0.75);
}

/* ── Files ─────────────────────────────────────────────────────────────── */

if (WAV) {
  writeWav('wind-bough.wav', [beds.bough.x], SR.bough);
  writeWav('wind-needle.wav', [beds.needle.x], SR.needle);
  writeWav('wind-sibilance.wav', [beds.sibilance.x], SR.sibilance);
  writeWav('wind-near.wav', [beds.near.x], SR.near);
  writeWav('wind-layer-60s.wav', [wind60.L, wind60.R], MIX_SR);
  writeWav('control-broadleaf.wav', [broadleaf], MIX_SR);

  for (const name of BIRD_NAMES) {
    const parts = [];
    for (let v = 0; v < BIRDS[name].variants; v++) {
      parts.push(birds[`${name}:${v}`], new Float32Array(Math.round(0.8 * SR.bird)));
    }
    const total = parts.reduce((a, p) => a + p.length, 0);
    const cat = new Float32Array(total);
    let o = 0;
    for (const p of parts) { cat.set(p, o); o += p.length; }
    writeWav(`bird-${name}.wav`, [cat], SR.bird);
  }

  for (const [si, label] of [[0, 'dirt'], [2, 'duff']]) {
    const period = Math.round((0.66 / 1.15) * SR.step);
    const cat = new Float32Array(period * (STEPS.variants + 1));
    for (let v = 0; v < STEPS.variants; v++) {
      const s = steps[`${si}:${v}`];
      const at = v * period;
      for (let i = 0; i < s.length; i++) cat[at + i] += s[i] * dbToLin(STEPS.footDb[v % 2]);
    }
    writeWav(`steps-${label}.wav`, [cat], SR.step);
  }

  writeWav('water-stream.wav', [stream], SR.stream);
  {
    const gap = Math.round(0.45 * SR.drip);
    const cat = new Float32Array(gap * (drips.length + 1));
    drips.forEach((d, i) => { for (let k = 0; k < d.length; k++) cat[i * gap + k] += d[k]; });
    writeWav('water-drips.wav', [cat], SR.drip);
  }
  {
    const gap = Math.round(0.9 * SR.crack);
    const cat = new Float32Array(gap * (cracks.length + 1));
    cracks.forEach((c, i) => { for (let k = 0; k < c.length; k++) cat[i * gap + k] += c[k]; });
    writeWav('branch-cracks.wav', [cat], SR.crack);
  }
  writeWav('room-ir.wav', [ir.left, ir.right], SR.ir);
  writeWav(`walk-${SECS}s.wav`, [walk.L, walk.R], walk.sr);
}

/* ── Verdict ───────────────────────────────────────────────────────────── */

console.log(`\n${pass} passed, ${fail} failed   (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
if (written.length) {
  console.log(`\nwrote ${written.length} files to shots/audio/:`);
  for (const w of written) console.log(`  ${w}`);
} else if (!WAV) {
  console.log('(pass --wav to write shots/audio/*.wav)');
}
if (fail) {
  console.log('\nfailures:');
  for (const f of failures) console.log(`  ${f}`);
  process.exitCode = 1;
}
