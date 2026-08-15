/* System 7 — the graph, and the only file in this system that touches Web Audio.
 *
 * voices.ts makes the sound and design.ts holds the numbers; nothing here
 * invents a level or a frequency. That discipline is what lets the whole system
 * be checked on the CPU by tools/audio.mjs, which loads the same two modules and
 * cannot load this one.
 *
 * Three structural decisions worth knowing before reading it.
 *
 * Every point source is a `Spot`: an input gain, a lowpass whose corner tracks
 * distance, a panner, and a reverb send taken off the mono point before the
 * panner. The lowpass is the important one and it is what `fogCutoffHz` feeds.
 * Attenuation on its own reads as a volume knob, and in a fog scene that is not
 * a small error — the entire reason this walk sounds close and damped rather
 * than open is that distant things arrive dull, not merely quiet.
 *
 * The wind does not use a Spot at all, and that is deliberate rather than a
 * shortcut. Canopy noise is not a point source: it comes from a volume tens of
 * metres across directly overhead, and nobody can localise it. Giving it a
 * panner would put the whole hero layer at a place, which is precisely the way
 * an ambient bed announces that it is a loop being played at you.
 *
 * Every buffer is baked once, at the click that enters the scene, and the
 * runtime only ever plays, gains and pans. Per-sample synthesis in JavaScript
 * cannot share a frame with a 60 fps render, and this bake is several hundred
 * milliseconds of straight-line arithmetic — which is why `build` does a first
 * stage and leaves the rest queued for `update` to drain one per frame.
 */
import * as THREE from 'three';
import {
  type Samples, dbToLin, linToDb, makeGesture, makeRng, qToWebAudio,
} from './dsp';
import {
  BAKE, SR, SEED, WIND, WATER, STEPS, CRACK, BIRDS, BIRD_NAMES, BIRD_BUS, IR, MASTER,
  PANNER, gustEnvelope, windBalance, fogCutoffHz, stepSurface, type BirdName,
} from './design';
import {
  type Render, boughOpts, needleOpts, sibilanceOpts, nearOpts,
  windBedRender, streamBedRender, forestIRRender,
  birdBufferRender, footstepBuffer, dripBuffer, crackBuffer,
} from './voices';

const clock = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());
import {
  makeBirdScheduler, makeDripScheduler, makeCrackScheduler,
  type BirdEvent, type CrackEvent, type DripEvent, type Placement,
} from './schedule';

/* ── Debug surface ─────────────────────────────────────────────────────── */

export type BusReport = {
  gainDb: number;
  nowDb: number;
  /** The loudest thing this bus has ever passed. A bus still reading -Infinity
   *  after a minute of walking has a disconnected node or a zero gain in it,
   *  and that is the entire reason this field exists: a silent Web Audio graph
   *  raises no error and looks exactly like a correct one. */
  everDb: number;
};

export type AudioReport = {
  state: string;
  built: boolean;
  /** Time to wire the graph. Renders no samples, so this should be ~1 ms. */
  buildMs: number;
  /** The most expensive single deferred stage, and which one. This is the
   *  render-hitch number: one stage runs per frame, so its cost lands whole on
   *  one frame's budget, and `stageCost` says where to split next. */
  worstStageMs: number;
  worstStage: string;
  stageCost: Record<string, number>;
  pendingStages: number;
  bufferKb: number;
  voices: number;
  /** Gust strength right now, 0..1, and the four bed gains it produces. */
  gust: number;
  windGains: Record<string, number>;
  buses: Record<string, BusReport>;
  soloed: string | null;
  counts: { steps: number; birds: number; drips: number; cracks: number };
  next: { birdIn: number; dripIn: number; crackIn: number };
  /** Buses that exist and have never passed a sample. Empty is good — but only
   *  once something exists to be listed, which is why it is not the check.
   *  `events` and `birds` stay in here legitimately until one fires. */
  silent: string[];
  /** The check. Everything wrong with the audio right now, as sentences, and
   *  unlike `silent` it cannot come back empty because nothing was built:
   *  absence of a bank is itself the first problem it reports. */
  problems: string[];
  buildError: string | null;
};

export type AudioDebug = {
  report(): AudioReport;
  resume(): Promise<void>;
  setMasterDb(db: number): void;
  solo(bus: string | null): void;
  /** Force an event now, so a varied thrush can be heard without waiting out
   *  the eighty-eight seconds the scene is supposed to make you wait. */
  fire(what: 'bird' | 'drip' | 'crack' | 'step', which?: string): void;
  engine: unknown;
};

/* ── Buses ─────────────────────────────────────────────────────────────── */

class Bus {
  gain: GainNode;
  analyser: AnalyserNode;
  gainDb: number;
  private probe: Samples;
  private ever = 0;
  private now = 0;

  constructor(ctx: AudioContext, gainDb: number, dest: AudioNode) {
    this.gainDb = gainDb;
    this.gain = ctx.createGain();
    this.gain.gain.value = dbToLin(gainDb);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.probe = new Float32Array(this.analyser.fftSize);
    this.gain.connect(this.analyser);
    this.gain.connect(dest);
  }

  meter(): void {
    this.analyser.getFloatTimeDomainData(this.probe);
    let s = 0;
    for (let i = 0; i < this.probe.length; i++) s += this.probe[i] * this.probe[i];
    this.now = Math.sqrt(s / this.probe.length);
    if (this.now > this.ever) this.ever = this.now;
  }

  report(): BusReport {
    return {
      gainDb: +linToDb(this.gain.gain.value).toFixed(1),
      nowDb: +linToDb(this.now).toFixed(1),
      everDb: +linToDb(this.ever).toFixed(1),
    };
  }
}

/* ── Positional sources ────────────────────────────────────────────────── */

/**
 * One place in the world that sound can come from.
 *
 * Allocated once and borrowed. An event fires by moving an existing spot and
 * hanging a fresh AudioBufferSourceNode off it, so a walk that plays sixty
 * drips creates sixty buffer sources and no filters, panners or sends at all.
 */
class Spot {
  input: GainNode;
  air: BiquadFilterNode;
  panner: PannerNode;
  send: GainNode | null = null;
  pos: [number, number, number] = [0, 0, 0];
  dist = 0;

  /* Plain fields with explicit assignment rather than TypeScript's constructor
   * parameter properties, which are not erasable syntax. Nothing under
   * src/audio may use them, because the offline tools load these modules into
   * bare Node whose type stripper erases and does not transform. */
  constructor(ctx: AudioContext, bus: Bus, verb: AudioNode | null, sendDb: number) {
    this.input = ctx.createGain();
    this.air = ctx.createBiquadFilter();
    this.air.type = 'lowpass';
    // Q is read in decibels for this node type, per the Web Audio spec.
    // Butterworth is -3.01, not 0.707.
    this.air.Q.value = qToWebAudio(Math.SQRT1_2);
    this.air.frequency.value = 6000;

    this.panner = ctx.createPanner();
    this.panner.panningModel = PANNER.panningModel;
    this.panner.distanceModel = PANNER.distanceModel;
    this.panner.refDistance = PANNER.refDistance;
    this.panner.rolloffFactor = PANNER.rolloffFactor;
    this.panner.maxDistance = PANNER.maxDistance;

    this.input.connect(this.air);
    this.air.connect(this.panner);
    this.panner.connect(bus.gain);

    if (verb && Number.isFinite(sendDb)) {
      this.send = ctx.createGain();
      this.send.gain.value = dbToLin(sendDb);
      /* Taken off the mono point before the panner on purpose: feeding a
       * stereo signal to the convolver would make it do four convolutions
       * instead of two, for a difference nobody could name. */
      this.air.connect(this.send);
      this.send.connect(verb);
    }
  }

  moveTo(x: number, y: number, z: number, at: number): void {
    this.pos = [x, y, z];
    this.panner.positionX.setValueAtTime(x, at);
    this.panner.positionY.setValueAtTime(y, at);
    this.panner.positionZ.setValueAtTime(z, at);
  }

  /** Retune the fog filter from the current listener distance. */
  refresh(lx: number, ly: number, lz: number, at: number): void {
    this.dist = Math.hypot(this.pos[0] - lx, this.pos[1] - ly, this.pos[2] - lz);
    this.air.frequency.setTargetAtTime(fogCutoffHz(this.dist), at, PANNER.filterGlide);
  }
}

/* Scratch vectors. Events are rare enough that allocating would not matter,
 * but `update` runs sixty times a second and the habit is worth keeping. */
const FWD = new THREE.Vector3();
const RIGHT = new THREE.Vector3();

/* ── The engine ────────────────────────────────────────────────────────── */

type Bank = {
  bough: AudioBuffer | null;
  needle: AudioBuffer | null;
  sibilance: AudioBuffer | null;
  near: AudioBuffer | null;
  birds: Map<string, AudioBuffer>;
  steps: AudioBuffer[][];
  stream: AudioBuffer | null;
  drips: AudioBuffer[];
  cracks: AudioBuffer[];
};

/** Baked wetness levels. The runtime picks the nearest to a continuous value. */
const SURFACES = [0, 0.5, 1];

type WindVoice = { gain: GainNode; band: 'bough' | 'needle' | 'sibilance' | 'near'; lag: number };

export class ForestAudio {
  readonly listener: THREE.AudioListener;
  readonly ctx: AudioContext;

  private master!: GainNode;
  private buses = new Map<string, Bus>();
  private verb: ConvolverNode | null = null;
  private bank: Bank = { bough: null, needle: null, sibilance: null, near: null, birds: new Map(), steps: [], stream: null, drips: [], cracks: [] };
  private windVoices: WindVoice[] = [];
  private spots: Record<string, Spot[]> = { bird: [], drip: [], crack: [], stream: [] };
  private stepPan!: StereoPannerNode;
  private stepIn!: GainNode;
  private stepSend!: GainNode;

  private gesture = makeGesture(SEED);
  private rng = makeRng(SEED ^ 0x1d3a7);
  private birdSched = makeBirdScheduler(SEED + 900);
  private dripSched = makeDripScheduler(SEED + 901);
  private crackSched = makeCrackScheduler(SEED + 902);
  private nextBird: BirdEvent | null = null;
  private nextDrip: DripEvent | null = null;
  private nextCrack: CrackEvent | null = null;

  private built = false;
  private buildError: string | null = null;
  private buildMs = 0;
  private worstStageMs = 0;
  private worstStage = '';
  private stageCost: Record<string, number> = {};
  /** A stage returning `false` is not finished and stays at the head of the
   *  queue. That is how the three resumable renders spend more than one frame
   *  without ever spending more than the budget on any single one. */
  private pending: { name: string; run: () => boolean | void }[] = [];
  private bufferBytes = 0;
  private liveVoices = 0;
  private t0 = 0;
  private elapsed = 0;
  private frame = 0;
  private stepIndex = 0;
  private soloed: string | null = null;
  private counts = { steps: 0, birds: 0, drips: 0, cracks: 0 };

  constructor() {
    /* Three's AudioListener owns the page's AudioContext and keeps the Web
     * Audio listener's position and orientation in step with its own world
     * matrix. That is the only thing it is used for: the sources below are raw
     * PannerNodes rather than PositionalAudio objects, because a
     * PositionalAudio is an Object3D per sound and cannot carry the fog filter
     * and reverb send this system needs in the chain. */
    this.listener = new THREE.AudioListener();
    this.ctx = this.listener.context as AudioContext;
  }

  get isBuilt(): boolean { return this.built; }
  get state(): string { return this.ctx.state; }

  /** Hang this off the same gesture that takes pointer lock. */
  async resume(): Promise<void> {
    if (this.ctx.state !== 'running') {
      try { await this.ctx.resume(); } catch { /* a rejected resume is not fatal */ }
    }
  }

  /* ── Construction ────────────────────────────────────────────────────── */

  /**
   * Wire the graph now, render every sample later, one stage per frame.
   *
   * The whole bank is several hundred milliseconds of straight-line arithmetic
   * and it runs on the click that also takes pointer lock — a frozen frame at
   * the exact moment the walk starts. So this method allocates nodes and
   * nothing else: it is a few dozen `createGain` calls and returns in under a
   * millisecond. Every buffer is queued for `update` to drain, and
   * `report().worstStageMs` is the number that says whether any single stage
   * grew big enough to be seen.
   */
  build(): void {
    if (this.built || this.buildError) return;
    /* Recorded and rethrown, never swallowed. This runs inside a
     * requestIdleCallback, so a throw here has no caller to catch it: it
     * becomes a bare page error and every meter downstream then truthfully
     * reports zero, which reads as "the scene is quiet" rather than "the bank
     * is missing". That cost an evening once. `report().problems` now names it. */
    try {
      this.bake();
    } catch (e) {
      this.buildError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      throw e;
    }
  }

  private bake(): void {
    const start = clock();
    const ctx = this.ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0;

    const hpf = ctx.createBiquadFilter();
    hpf.type = 'highpass';
    hpf.frequency.value = MASTER.highpassHz;
    hpf.Q.value = qToWebAudio(Math.SQRT1_2);

    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = MASTER.limiter.thresholdDb;
    limiter.knee.value = MASTER.limiter.knee;
    limiter.ratio.value = MASTER.limiter.ratio;
    limiter.attack.value = MASTER.limiter.attack;
    limiter.release.value = MASTER.limiter.release;

    this.master.connect(hpf);
    hpf.connect(limiter);
    limiter.connect(this.listener.getInput());

    this.verb = ctx.createConvolver();
    this.verb.normalize = false;

    this.addBus('verb', IR.returnDb);
    this.addBus('wind', WIND.busDb);
    this.addBus('birds', BIRD_BUS.busDb);
    this.addBus('water', 0);
    this.addBus('steps', STEPS.busDb);
    this.addBus('events', CRACK.busDb);
    this.verb.connect(this.buses.get('verb')!.gain);

    this.t0 = ctx.currentTime;
    this.master.gain.setValueAtTime(0, this.t0);
    this.master.gain.linearRampToValueAtTime(dbToLin(MASTER.gainDb), this.t0 + MASTER.fadeInSec);
    this.built = true;

    /* Everything that renders samples, one stage per frame, drained by
     * `update`. Paced by the render loop rather than by a timer, so it cannot
     * pile up on a slow machine. Every scheduler below guards on its own
     * buffers being present, because for the first dozen frames they are not.
     *
     * Nothing above this line renders a sample, and that is deliberate: the
     * first version baked the IR and the two loudest beds synchronously here,
     * which measured as a single 112 ms frame — a 9 fps hitch in a scene
     * budgeted at 30. Wind arriving three frames after the click instead of one
     * is inaudible; a visible stutter on the first click is not. The order is
     * still by how much each source is missed: the bough and needle beds are
     * the whole noise floor, footsteps next because the player is already
     * walking, and the birds can afford a quarter of a second since the first
     * one is not due for eight seconds. */
    const q = (name: string, run: () => boolean | void) => { this.pending.push({ name, run }); };

    /* Pump a resumable render for at most one frame's allowance. Written once
     * here rather than at each of the three call sites, because getting the
     * "not finished" signal wrong silently drops a buffer and the scene comes
     * up missing a layer with nothing to say so. */
    const qRender = <T,>(name: string, start: () => Render<T>, land: (v: T) => void) => {
      let gen: Render<T> | null = null;
      q(name, () => {
        if (!gen) gen = start();
        const until = clock() + BAKE.budgetMs;
        for (;;) {
          const r = gen.next();
          if (r.done) { land(r.value); return true; }
          if (clock() >= until) return false;
        }
      });
    };

    /* The one buffer whose rate is not free. Every other buffer here is
     * rendered at whatever rate its content needs — 8 kHz for the bough bed,
     * 32 kHz for birds — because an AudioBufferSourceNode resamples on playback
     * and the memory saving is large. ConvolverNode is the exception: the spec
     * requires its buffer to match the context and Chrome throws
     * NotSupportedError rather than resampling, which is exactly how this
     * system spent an evening silent. Rendered at ctx.sampleRate rather than
     * resampled from a fixed rate, because forestIR derives its delays and
     * filters from the rate it is given, so it is rate-invariant. */
    qRender('ir', () => forestIRRender(ctx.sampleRate, SEED + 800), (ir) => {
      const irBuf = ctx.createBuffer(2, ir.left.length, ctx.sampleRate);
      irBuf.copyToChannel(ir.left, 0);
      irBuf.copyToChannel(ir.right, 1);
      this.count(irBuf);
      this.verb!.buffer = irBuf;
    });
    for (const [name, opts] of [
      ['bough', boughOpts(SEED + 1)], ['needle', needleOpts(SEED + 2)],
      ['sibilance', sibilanceOpts(SEED + 3)], ['near', nearOpts(SEED + 4)],
    ] as const) {
      qRender(name, () => windBedRender(opts), (buf) => {
        this.bank[name] = this.toBuffer(buf, opts.sr);
        this.startWind(name);
      });
    }
    q('step-graph', () => this.buildSteps());
    /* One stage per surface *per variant*, not per surface. Four variants of a
     * footstep in one stage was 30 ms of crackle synthesis on a single frame. */
    SURFACES.forEach((s, si) => {
      for (let v = 0; v < STEPS.variants; v++) {
        q(`step-${s}-${v}`, () => {
          const row = this.bank.steps[si] ?? (this.bank.steps[si] = []);
          row[v] = this.toBuffer(footstepBuffer(SR.step, SEED + 300 + si * 61 + v * 7, s), SR.step);
        });
      }
    });
    qRender('stream', () => streamBedRender(SR.stream, SEED + 500), (buf) => {
      this.bank.stream = this.toBuffer(buf, SR.stream);
      this.buildStream();
    });
    for (let v = 0; v < WATER.dripVariants; v++) {
      q(`drip-${v}`, () => {
        this.bank.drips.push(this.toBuffer(dripBuffer(SR.drip, SEED + 600 + v * 13, v), SR.drip));
      });
    }
    q('drip-graph', () => {
      for (let i = 0; i < WATER.dripSites; i++) {
        this.spots.drip.push(new Spot(ctx, this.buses.get('water')!, this.verb, WATER.dripSendDb));
      }
      this.nextDrip = this.dripSched.next();
    });
    /* And one stage per bird *phrase*. A wren's song is six seconds of dense
     * frequency-swept tone at 32 kHz and three of them in one stage was the
     * worst frame in the whole bake. */
    for (const name of BIRD_NAMES) {
      for (let v = 0; v < BIRDS[name].variants; v++) {
        qRender(`bird-${name}-${v}`,
          () => birdBufferRender(SR.bird, name, v, SEED + 100 + name.length * 977 + v * 31),
          (buf) => { this.bank.birds.set(`${name}:${v}`, this.toBuffer(buf, SR.bird)); });
      }
    }
    q('bird-graph', () => {
      for (let i = 0; i < 2; i++) {
        this.spots.bird.push(new Spot(ctx, this.buses.get('birds')!, this.verb, BIRD_BUS.sendDb));
      }
      this.nextBird = this.birdSched.next();
    });
    for (let v = 0; v < CRACK.variants; v++) {
      q(`crack-${v}`, () => {
        this.bank.cracks.push(this.toBuffer(crackBuffer(SR.crack, SEED + 700 + v * 17), SR.crack));
      });
    }
    q('crack-graph', () => {
      this.spots.crack.push(new Spot(ctx, this.buses.get('events')!, this.verb, CRACK.sendDb));
      this.nextCrack = this.crackSched.next();
    });

    this.buildMs = clock() - start;
  }

  private addBus(name: string, gainDb: number): Bus {
    const b = new Bus(this.ctx, gainDb, this.master);
    this.buses.set(name, b);
    return b;
  }

  private count(b: AudioBuffer): void {
    this.bufferBytes += b.length * b.numberOfChannels * 4;
  }

  private toBuffer(x: Samples, sr: number): AudioBuffer {
    const b = this.ctx.createBuffer(1, x.length, sr);
    b.copyToChannel(x, 0);
    this.count(b);
    return b;
  }

  /**
   * Two looping voices per bed, panned apart and reading the buffer from
   * places 43.7% apart.
   *
   * The offset is what decorrelates left from right without a second buffer.
   * The lag on the right-hand voice's gust envelope is what makes a gust
   * *cross* the canopy: without it both channels swell at the same instant,
   * which reads as a fader and not as weather.
   */
  private startWind(band: 'bough' | 'needle' | 'sibilance' | 'near'): void {
    const ctx = this.ctx;
    const buf = this.bank[band];
    if (!buf) return;
    const bus = this.buses.get('wind')!;
    const pan = { bough: 0.35, needle: 0.55, sibilance: 0.7, near: 0.85 }[band];
    const lag = band === 'near' ? WIND.nearLagSec : WIND.lagSec;
    const voices: { off: number; pan: number; lag: number }[] = [
      { off: 0, pan: -pan, lag: 0 },
      { off: buf.duration * 0.437, pan, lag },
    ];
    for (const v of voices) {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const g = ctx.createGain();
      g.gain.value = 0;
      const p = ctx.createStereoPanner();
      p.pan.value = v.pan;
      src.connect(g);
      g.connect(p);
      p.connect(bus.gain);
      src.start(ctx.currentTime, v.off);
      this.windVoices.push({ gain: g, band, lag: v.lag });
    }
  }

  private buildSteps(): void {
    const ctx = this.ctx;
    this.stepIn = ctx.createGain();
    this.stepPan = ctx.createStereoPanner();
    this.stepIn.connect(this.stepPan);
    this.stepPan.connect(this.buses.get('steps')!.gain);
    /* No Spot and no distance filter for footsteps. They happen at the
     * listener's own feet, where the fog model has nothing to say, and a
     * panner would place them in the world and leave them behind as the walker
     * moves off — which at 1.15 m/s is audible within one step. */
    this.stepSend = ctx.createGain();
    this.stepSend.gain.value = dbToLin(STEPS.sendDb);
    this.stepIn.connect(this.stepSend);
    if (this.verb) this.stepSend.connect(this.verb);
  }

  private buildStream(): void {
    if (!this.bank.stream) return;
    const ctx = this.ctx;
    const spot = new Spot(ctx, this.buses.get('water')!, null, -Infinity);
    /* No reverb send. The stream is already a diffuse field arriving through
     * thirty metres of scattering forest; convolving a diffuse source with a
     * diffuse tail only makes it vaguer, and costs a convolution. */
    spot.input.gain.value = dbToLin(WATER.streamBusDb);
    spot.moveTo(WATER.streamAt[0], WATER.streamAt[1], WATER.streamAt[2], ctx.currentTime);
    const src = ctx.createBufferSource();
    src.buffer = this.bank.stream;
    src.loop = true;
    src.connect(spot.input);
    src.start();
    this.spots.stream.push(spot);
  }

  /* ── Events ──────────────────────────────────────────────────────────── */

  /**
   * A footfall. `surface` is 0 for the compacted tread and 1 for needle duff;
   * omitted, it wanders on its own.
   *
   * The wander is here rather than in the caller because the walker does not
   * know about surfaces and should not have to. A real walker on a three-foot
   * trail drifts between the tread and the litter at its edge over a handful
   * of steps, and `stepSurface` is that drift as a function of step count. If
   * the scene ever gains a real lateral offset, passing it in overrides this
   * and nothing else changes.
   */
  footstep(foot: number, surface?: number): void {
    if (!this.built || !this.stepIn || this.bank.steps.length < SURFACES.length) return;
    const s = surface ?? stepSurface(this.gesture, this.stepIndex);
    this.stepIndex++;

    let si = 0, best = Infinity;
    SURFACES.forEach((w, i) => { const d = Math.abs(w - s); if (d < best) { best = d; si = i; } });
    const row = this.bank.steps[si];
    if (!row) return;

    const buf = row[Math.floor(this.rng() * row.length)];
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = STEPS.rate[0] + this.rng() * (STEPS.rate[1] - STEPS.rate[0]);
    /* The per-step trim gain is handed to `play` so it is torn down with the
     * source. Leaving it connected leaks one node per footfall — two a second
     * for as long as the walk lasts — which tools/audiograph.mjs found as four
     * hundred live GainNodes after ten minutes. */
    const g = ctx.createGain();
    g.gain.value = dbToLin(STEPS.footDb[foot & 1]);
    src.connect(g);
    g.connect(this.stepIn);
    /* The pan alternates with the foot, and only slightly. Your own feet are
     * about fifteen centimetres either side of your ears' midline; anything
     * wider than this reads as two people. */
    this.stepPan.pan.setValueAtTime((foot & 1) ? 0.12 : -0.12, ctx.currentTime);
    this.play(src, 0, g);
    this.counts.steps++;
  }

  /** Put a spot at a bearing and distance from where the listener is now. */
  private placeRelative(spot: Spot, p: Placement, camera: THREE.Object3D, at: number): void {
    /* Resolved to a world position once and then left there, rather than being
     * parented to the listener. A bird that holds its bearing while you walk
     * past it is not at a place, and the drift as you pass is most of what
     * makes it one.
     *
     * The bearing is taken against a flattened forward vector so that where the
     * player happens to be looking vertically does not tilt the whole forest. */
    camera.getWorldDirection(FWD);
    FWD.y = 0;
    if (FWD.lengthSq() < 1e-8) FWD.set(0, 0, -1);
    FWD.normalize();
    RIGHT.set(-FWD.z, 0, FWD.x);
    const horiz = Math.sqrt(Math.max(0, p.dist * p.dist - p.elev * p.elev));
    const c = Math.cos(p.az) * horiz, s = Math.sin(p.az) * horiz;
    spot.moveTo(
      camera.position.x + FWD.x * c + RIGHT.x * s,
      camera.position.y + p.elev,
      camera.position.z + FWD.z * c + RIGHT.z * s,
      at,
    );
    spot.refresh(camera.position.x, camera.position.y, camera.position.z, at);
  }

  private fireAt(spot: Spot, buf: AudioBuffer, gainDb: number, rate: number, when: number): void {
    spot.input.gain.setValueAtTime(dbToLin(gainDb), when);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    src.connect(spot.input);
    this.play(src, when);
  }

  private play(src: AudioBufferSourceNode, when = 0, also?: AudioNode): void {
    this.liveVoices++;
    src.onended = () => { this.liveVoices--; src.disconnect(); also?.disconnect(); };
    src.start(when || this.ctx.currentTime);
  }

  /* ── The frame ───────────────────────────────────────────────────────── */

  update(dt: number, camera: THREE.Object3D): void {
    if (!this.built) return;
    const ctx = this.ctx;
    this.elapsed += dt;
    this.frame++;

    /* One stage, and its cost recorded. The whole reason the bake is spread
     * across frames is that it must not be seen, and a claim like that is worth
     * nothing unmeasured: `worstStageMs` is what a caller compares against the
     * scene's frame budget. */
    const job = this.pending[0];
    if (job) {
      const t0 = clock();
      let done = true;
      try {
        done = job.run() !== false;
      } catch (e) {
        /* The same discipline as `build`, and for the same reason: now that the
         * bank is rendered in stages, a throw lands here rather than there.
         * Recorded so `report().problems` names it, and the queue is abandoned
         * so the scene is not throwing sixty times a second — one clear failure
         * beats a flood that buries the first one. */
        this.buildError = `stage ${job.name}: ` +
          (e instanceof Error ? `${e.name}: ${e.message}` : String(e));
        this.pending.length = 0;
        throw e;
      } finally {
        const ms = clock() - t0;
        this.stageCost[job.name] = +((this.stageCost[job.name] ?? 0) + ms).toFixed(2);
        if (ms > this.worstStageMs) { this.worstStageMs = ms; this.worstStage = job.name; }
      }
      if (done) this.pending.shift();
    }

    /* The wind. One gust evaluation per band per side per frame is eight
     * cheap calls; the gains are ramped rather than set, because a step in a
     * gain applied to a continuous noise bed is a click. */
    const t = this.elapsed;
    for (const v of this.windVoices) {
      const g = windBalance(gustEnvelope(this.gesture, t - v.lag))[v.band];
      v.gain.gain.setTargetAtTime(g, ctx.currentTime, 0.12);
    }

    if (this.frame % PANNER.filterEveryFrames === 0) {
      const p = camera.position;
      for (const key of Object.keys(this.spots)) {
        for (const s of this.spots[key]) s.refresh(p.x, p.y, p.z, ctx.currentTime);
      }
      for (const b of this.buses.values()) b.meter();
    }

    this.schedule(camera);
  }

  private schedule(camera: THREE.Object3D): void {
    const t = this.elapsed;
    const at = this.ctx.currentTime;

    if (this.nextBird && this.spots.bird.length && t >= this.nextBird.time) {
      const e = this.nextBird;
      const buf = this.bank.birds.get(`${e.species}:${e.variant}`);
      if (buf) {
        const spot = this.spots.bird[this.counts.birds % this.spots.bird.length];
        this.placeRelative(spot, e, camera, at);
        this.fireAt(spot, buf, e.gainDb, e.rate, at);
        this.counts.birds++;
      }
      this.nextBird = this.birdSched.next();
    }

    if (this.nextDrip && this.spots.drip.length && t >= this.nextDrip.time) {
      const e = this.nextDrip;
      const buf = this.bank.drips[e.variant];
      if (buf) {
        const spot = this.spots.drip[e.site % this.spots.drip.length];
        this.placeRelative(spot, e, camera, at);
        this.fireAt(spot, buf, e.gainDb + WATER.dripBusDb, e.rate, at);
        this.counts.drips++;
      }
      this.nextDrip = this.dripSched.next();
    }

    if (this.nextCrack && this.spots.crack.length && t >= this.nextCrack.time) {
      const e = this.nextCrack;
      const buf = this.bank.cracks[e.variant];
      if (buf) {
        this.placeRelative(this.spots.crack[0], e, camera, at);
        this.fireAt(this.spots.crack[0], buf, e.gainDb, e.rate, at);
        this.counts.cracks++;
      }
      this.nextCrack = this.crackSched.next();
    }
  }

  /* ── Reporting ───────────────────────────────────────────────────────── */

  report(): AudioReport {
    const g = gustEnvelope(this.gesture, this.elapsed);
    const buses: Record<string, BusReport> = {};
    const silent: string[] = [];
    for (const [name, b] of this.buses) {
      buses[name] = b.report();
      if (!Number.isFinite(buses[name].everDb)) silent.push(name);
    }
    const w = windBalance(g);

    /* Structural failures first, because each one makes the ones below it
     * unanswerable rather than merely absent. */
    const problems: string[] = [];
    if (this.buildError) problems.push(`the bake threw: ${this.buildError}`);
    else if (!this.built) problems.push('build() has not run — no gesture yet, or the kick never fired');
    if (this.built && !this.buildError) {
      if (!this.buses.size) problems.push('no buses exist');
      if (!this.bufferBytes) problems.push('the bank is empty — no buffer was rendered');
      if (this.ctx.state !== 'running') problems.push(`context is ${this.ctx.state}`);
      /* Only the two continuously-fed buses. `birds`, `events` and `verb` are
       * driven by sparse schedules and are correctly silent for minutes at a
       * time, so they belong in `silent` for a caller to interpret and not in
       * a list that is meant to mean something is broken. */
      for (const name of ['wind', 'water']) {
        const b = this.buses.get(name);
        if (b && this.elapsed > 3 && !Number.isFinite(b.report().everDb)) {
          problems.push(`bus ${name} has never passed a sample`);
        }
      }
      if (this.pending.length && this.elapsed > 10) {
        problems.push(`${this.pending.length} stages still pending after ${this.elapsed.toFixed(0)}s — the drain is not running`);
      }
    }

    return {
      state: this.ctx.state,
      built: this.built,
      buildMs: +this.buildMs.toFixed(1),
      worstStageMs: +this.worstStageMs.toFixed(1),
      worstStage: this.worstStage,
      stageCost: { ...this.stageCost },
      pendingStages: this.pending.length,
      bufferKb: Math.round(this.bufferBytes / 1024),
      voices: this.liveVoices,
      gust: +g.toFixed(3),
      windGains: {
        bough: +w.bough.toFixed(3), needle: +w.needle.toFixed(3),
        sibilance: +w.sibilance.toFixed(3), near: +w.near.toFixed(3),
      },
      buses,
      soloed: this.soloed,
      counts: { ...this.counts },
      next: {
        birdIn: this.nextBird ? +(this.nextBird.time - this.elapsed).toFixed(1) : -1,
        dripIn: this.nextDrip ? +(this.nextDrip.time - this.elapsed).toFixed(1) : -1,
        crackIn: this.nextCrack ? +(this.nextCrack.time - this.elapsed).toFixed(1) : -1,
      },
      silent,
      problems,
      buildError: this.buildError,
    };
  }

  debug(): AudioDebug {
    return {
      report: () => this.report(),
      resume: () => this.resume(),
      setMasterDb: (db) => { this.master.gain.value = dbToLin(db); },
      solo: (bus) => {
        this.soloed = bus;
        for (const [name, b] of this.buses) {
          b.gain.gain.value = bus && name !== bus && name !== 'verb' ? 0 : dbToLin(b.gainDb);
        }
      },
      fire: (what, which) => {
        if (what === 'step') { this.footstep(this.counts.steps & 1); return; }
        if (what === 'bird' && this.nextBird) {
          this.nextBird = { ...this.nextBird, time: this.elapsed, species: (which as BirdName) ?? this.nextBird.species };
        } else if (what === 'drip' && this.nextDrip) {
          this.nextDrip = { ...this.nextDrip, time: this.elapsed };
        } else if (what === 'crack' && this.nextCrack) {
          this.nextCrack = { ...this.nextCrack, time: this.elapsed };
        }
      },
      engine: this,
    };
  }

  /** Everything, on unmount. An orphaned AudioContext keeps an audio thread
   *  alive for the life of the page and the browser only allows a handful. */
  dispose(): void {
    for (const v of this.windVoices) v.gain.disconnect();
    this.windVoices = [];
    try { void this.ctx.close(); } catch { /* already closed */ }
  }
}
