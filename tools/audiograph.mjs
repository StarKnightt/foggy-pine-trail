/* Is the graph actually connected, and is anything silently zero?
 *
 * tools/audio.mjs proves the arithmetic in src/audio is right. It says nothing
 * about engine.ts, which is the file that could ruin all of it: a Web Audio
 * graph with a node connected to nothing, a gain left at zero, or a source that
 * was built but never started raises no error and produces no output, and is
 * indistinguishable from a working one until somebody puts headphones on. That
 * is precisely the failure this project cannot check by looking.
 *
 * So this builds the real engine — the same class the browser instantiates —
 * against a mock Web Audio implementation that records every node and every
 * connection, drains every deferred build stage, fires one of each event, and
 * then walks the graph backwards from the destination. Anything that cannot
 * reach the output, and any gain sitting at zero once the fade-in has run, is
 * reported.
 *
 * It is not a substitute for hearing it. It is a substitute for the twenty
 * minutes of confusion that a disconnected reverb send otherwise costs.
 *
 *   node tools/audiograph.mjs
 */
import { register } from 'node:module';

register('./audiohook.mjs', import.meta.url);

/* ── A recording mock of the parts of Web Audio the engine uses ────────── */

const nodes = [];
const edges = [];

class Param {
  constructor(v) { this.value = v; this.events = 0; }
  setValueAtTime(v) { this.value = v; this.events++; return this; }
  setTargetAtTime(v) { this.value = v; this.events++; return this; }
  linearRampToValueAtTime(v) { this.value = v; this.events++; return this; }
}

let nextId = 1;
class Node {
  constructor(kind) {
    this.kind = kind;
    this.id = nextId++;
    this.out = [];
    nodes.push(this);
  }
  connect(dst) { this.out.push(dst); edges.push([this, dst]); return dst; }
  disconnect() { this.out.length = 0; }
}

class Gain extends Node { constructor() { super('gain'); this.gain = new Param(1); } }
class Biquad extends Node {
  constructor() { super('biquad'); this.type = 'lowpass'; this.frequency = new Param(350); this.Q = new Param(1); this.gain = new Param(0); }
}
class Comp extends Node {
  constructor() {
    super('compressor');
    for (const k of ['threshold', 'knee', 'ratio', 'attack', 'release', 'reduction']) this[k] = new Param(0);
  }
}
/* The mock enforces the two buffer rules a permissive mock lets through, both
 * learned the hard way. ConvolverNode is the only consumer in Web Audio that
 * will not resample: hand it a buffer at any rate but the context's and Chrome
 * throws NotSupportedError. The whole bank here is deliberately multi-rate, so
 * that is a trap this design walks straight into, and it cost a whole evening
 * of a silent scene once because the throw happened inside a
 * requestIdleCallback where nothing was watching. A mock that accepts anything
 * cannot catch the one class of bug this tool exists to catch. */
class Conv extends Node {
  constructor(ctxRate) {
    super('convolver');
    this.normalize = true;
    this._buffer = null;
    this._rate = ctxRate;
  }
  get buffer() { return this._buffer; }
  set buffer(b) {
    if (b) {
      if (b.sampleRate !== this._rate) {
        const e = new Error(`Failed to set the 'buffer' property on 'ConvolverNode': ` +
          `The buffer sample rate of ${b.sampleRate} does not match the context rate of ${this._rate} Hz.`);
        e.name = 'NotSupportedError';
        throw e;
      }
      if (![1, 2, 4].includes(b.numberOfChannels)) {
        const e = new Error(`ConvolverNode buffer must have 1, 2 or 4 channels, not ${b.numberOfChannels}.`);
        e.name = 'NotSupportedError';
        throw e;
      }
    }
    this._buffer = b;
  }
}
class Analyser extends Node {
  constructor() { super('analyser'); this.fftSize = 2048; }
  getFloatTimeDomainData(a) { a.fill(0); }
}
class Panner extends Node {
  constructor() {
    super('panner');
    for (const k of ['positionX', 'positionY', 'positionZ', 'orientationX', 'orientationY', 'orientationZ']) this[k] = new Param(0);
  }
}
class StereoPanner extends Node { constructor() { super('stereoPanner'); this.pan = new Param(0); } }
/* One-shots have to actually end, or nothing in this file can tell a graph
 * that cleans up after itself from one that leaks a node per footfall — which
 * is one of the two things it is here to detect. `live` is swept by the audit
 * loop below, which is what fires `onended` and lets the engine's own teardown
 * run. */
const live = [];
class Source extends Node {
  constructor() { super('source'); this.buffer = null; this.loop = false; this.playbackRate = new Param(1); this.started = false; this.endAt = Infinity; }
  start(when) {
    this.started = true;
    if (!this.loop && this.buffer) {
      this.endAt = Math.max(when ?? 0, ctx.currentTime) + this.buffer.duration / this.playbackRate.value;
      live.push(this);
    }
  }
  stop() { }
}
class Buffer {
  constructor(ch, len, sr) {
    this.numberOfChannels = ch; this.length = len; this.sampleRate = sr;
    this.duration = len / sr;
    this.data = Array.from({ length: ch }, () => new Float32Array(len));
  }
  copyToChannel(x, c) { this.data[c].set(x); }
  getChannelData(c) { return this.data[c]; }
}

class MockContext {
  constructor() {
    this.state = 'running';
    /* Overridable, because "works at 48 k" is not the claim. Hardware turns up
     * at 44.1 k and 96 k too, and the IR is now rendered at whatever the
     * context reports, so the audit should be runnable at any of them:
     *   node tools/audiograph.mjs --rate=44100 */
    this.sampleRate = Number(
      (process.argv.find((a) => a.startsWith('--rate=')) || '').slice(7) || 48000);
    this.currentTime = 0;
    this.destination = new Node('destination');
    this.listener = {};
    for (const k of ['positionX', 'positionY', 'positionZ', 'forwardX', 'forwardY', 'forwardZ', 'upX', 'upY', 'upZ']) {
      this.listener[k] = new Param(0);
    }
  }
  createGain() { return new Gain(); }
  createBiquadFilter() { return new Biquad(); }
  createDynamicsCompressor() { return new Comp(); }
  createConvolver() { return new Conv(this.sampleRate); }
  createAnalyser() { return new Analyser(); }
  createPanner() { return new Panner(); }
  createStereoPanner() { return new StereoPanner(); }
  createBufferSource() { return new Source(); }
  createBuffer(ch, len, sr) {
    // Chrome's accepted range, so a bed rendered too low fails here not there.
    if (!(sr >= 3000 && sr <= 384000)) throw new Error(`createBuffer: sample rate ${sr} out of range`);
    if (!(len >= 1) || !(ch >= 1)) throw new Error(`createBuffer: ${ch}ch x ${len} samples is not a buffer`);
    return new Buffer(ch, len, sr);
  }
  resume() { this.state = 'running'; return Promise.resolve(); }
  close() { return Promise.resolve(); }
}

/* three reaches for `window.AudioContext` the first time an AudioListener is
 * constructed, and caches the result forever. Both have to exist before three
 * is imported, not merely before the listener is made. */
const ctx = new MockContext();
globalThis.window = globalThis;
globalThis.AudioContext = function () { return ctx; };
globalThis.OfflineAudioContext = globalThis.AudioContext;
globalThis.performance = globalThis.performance ?? { now: () => Date.now() };

const THREE = await import('three');
const { ForestAudio } = await import('../src/audio/engine.ts');

/* ── Build it ──────────────────────────────────────────────────────────── */

console.log('System 7 — graph audit');

const engine = new ForestAudio();
const t0 = Date.now();
engine.build();
const stage1 = Date.now() - t0;

/* A stand-in for the camera. The engine only reads its position and its world
 * direction, both of which a bare Object3D provides. */
const camera = new THREE.Object3D();
camera.position.set(0, 1.62, 0);
camera.updateMatrixWorld();

/* Drain every deferred stage, then run long enough for the schedulers to have
 * fired at least one of everything. The gust envelope and the event schedules
 * are both functions of accumulated time, so stepping at 1/60 with a virtual
 * clock covers ten minutes in a few thousand iterations. */
const t1 = Date.now();
let steps = 0;
/* Caught and turned into the engine's own diagnosis rather than a bare stack.
 * The bake rethrows so a live page still gets a page error with a source
 * position, and the reason to catch it here is that `report().problems` is the
 * thing under test: it is meant to name a failed bake, and a tool that dies on
 * the throw never checks whether it did. */
try {
  while (engine.report().pendingStages > 0 && steps < 5000) { engine.update(1 / 60, camera); steps++; }
} catch {
  const r = engine.report();
  console.error('\n  FAIL  the bake threw. report().problems says:');
  for (const p of r.problems) console.error(`        ${p}`);
  if (!r.problems.length) {
    console.error('        ...nothing, which is itself the bug: a failed bake must be reported.');
  }
  process.exit(1);
}
const stageAll = Date.now() - t1;
const afterBuild = engine.report();

for (let i = 0; i < 36000; i++) {
  ctx.currentTime += 1 / 60;
  engine.update(1 / 60, camera);
  if (i % 96 === 0) engine.footstep(i & 1);
  for (let k = live.length - 1; k >= 0; k--) {
    if (live[k].endAt <= ctx.currentTime) { live[k].onended?.(); live.splice(k, 1); }
  }
}
const rep = engine.report();

/* ── Reachability ──────────────────────────────────────────────────────── */

/* Backwards from the listener's input. Three's AudioListener owns a GainNode
 * that everything the engine builds must eventually reach; anything outside
 * that set is making sound into a disconnected wire. */
const target = engine.listener.getInput();
/* Built from each node's *current* fan-out rather than from the append-only
 * edge log, because a one-shot that has ended has disconnected itself and must
 * no longer count as reaching anything. Using the log instead was the first
 * attempt and it reported a graph of four hundred nodes that had in fact torn
 * itself down correctly. */
const incoming = new Map();
for (const n of nodes) {
  for (const d of n.out) {
    if (!incoming.has(d)) incoming.set(d, []);
    incoming.get(d).push(n);
  }
}
const reachable = new Set();
const queue = [target];
while (queue.length) {
  const n = queue.pop();
  if (reachable.has(n)) continue;
  reachable.add(n);
  for (const p of incoming.get(n) ?? []) queue.push(p);
}

const byKind = {};
for (const n of nodes) byKind[n.kind] = (byKind[n.kind] ?? 0) + 1;

/* Analysers are deliberate dead ends — they are metering taps, and the bus
 * feeds them in parallel with the real path. Everything else has to arrive. */
const orphans = nodes.filter((n) => n.kind !== 'analyser' && n.kind !== 'destination'
  && n.out.length > 0 && !reachable.has(n));
const deadSources = nodes.filter((n) => n.kind === 'source' && !n.started);
const zeroGains = nodes.filter((n) => n.kind === 'gain' && n.gain.value === 0 && reachable.has(n));

let pass = 0, fail = 0;
const say = (ok, name, detail) => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : ' — ' + detail}`);
};

console.log(`\n  build: wiring ${stage1} ms, ${steps} deferred stages in ${stageAll} ms`);
/* Named, because "one stage is too slow" is unactionable and "the wren is too
 * slow" is one line to fix. Node is slower than Chrome here and the absolute
 * numbers are not the browser's, but the ranking is. */
const costs = Object.entries(rep.stageCost).sort((a, b) => b[1] - a[1]);
console.log(`  worst single frame of bake: ${rep.worstStageMs} ms (${rep.worstStage})`);
console.log(`  total per stage: ${costs.slice(0, 5).map(([n, ms]) => `${n} ${ms}ms`).join(', ')}`);
console.log(`  nodes: ${JSON.stringify(byKind)}`);
/* The audit loop ends one-shots at their natural length, so this counter is
 * meaningful: anything still live after ten minutes of walking is a source
 * whose `onended` never ran. */
console.log(`  buffers: ${rep.bufferKb} kB   one-shots still live: ${rep.voices}`);
console.log(`  fired: ${JSON.stringify(rep.counts)}`);
console.log(`  gust now ${rep.gust}  wind gains ${JSON.stringify(rep.windGains)}\n`);

say(orphans.length === 0, 'every node reaches the output',
  orphans.map((n) => `${n.kind}#${n.id}`).join(', '));
say(deadSources.length === 0, 'every buffer source was started',
  `${deadSources.length} built but never started`);
say(zeroGains.length === 0, 'no reachable gain is stuck at zero',
  `${zeroGains.length} at zero`);
say(rep.pendingStages === 0, 'the build drained', `${rep.pendingStages} stages left`);
/* `build()` renders nothing, by design: the version that baked the IR and the
 * two loudest beds inline cost a single 112 ms frame in the browser. Node is not
 * the browser and this is a coarse guard, but a stage that grows past a frame's
 * worth of work here has certainly grown past one there. */
say(rep.buildMs < 20, 'wiring the graph renders no samples', `build() took ${rep.buildMs} ms`);
say(rep.worstStageMs < 33, 'no single deferred stage exceeds a 30 fps frame',
  `worst stage ${rep.worstStageMs} ms`);
say(rep.voices === 0, 'every one-shot was reclaimed', `${rep.voices} still live`);
/* The wind is the hero and it is the one layer with no event behind it: if its
 * eight voices are not all playing a buffer, the scene is quiet and nothing
 * else in this audit would notice. */
const windSources = nodes.filter((n) => n.kind === 'source' && n.loop && n.started);
say(windSources.length === 9, 'eight wind voices and the stream are looping',
  `${windSources.length} looping sources`);
say(rep.counts.birds > 0 && rep.counts.drips > 0 && rep.counts.cracks > 0 && rep.counts.steps > 0,
  'every event class fired inside ten minutes', JSON.stringify(rep.counts));
say(rep.bufferKb > 2000 && rep.bufferKb < 16000, 'buffer memory is in budget', `${rep.bufferKb} kB`);
/* Named rather than left to the setter's throw, because this is the one buffer
 * in the bank whose rate is not free and the assertion should say so out loud.
 * Run with --rate=44100 as well; hardware is not all 48 k. */
const conv = nodes.find((n) => n.kind === 'convolver');
say(!!(conv && conv.buffer && conv.buffer.sampleRate === ctx.sampleRate),
  `the IR is at the context rate (${ctx.sampleRate} Hz)`,
  conv && conv.buffer ? `IR is ${conv.buffer.sampleRate} Hz` : 'the convolver has no buffer');
/* Node leakage. Ten minutes of walking fires several hundred one-shots, and if
 * each of them left a node behind the graph would grow without bound; the
 * footstep path did exactly that until this check found it. The permanent
 * population is buses, spots, wind voices and the master chain — a few dozen. */
const persistent = nodes.filter((n) => n.kind !== 'source' && reachable.has(n)).length;
say(persistent < 70, 'the graph does not grow with events',
  `${persistent} non-source nodes after ${rep.counts.steps} steps and ` +
  `${rep.counts.birds + rep.counts.drips + rep.counts.cracks} events`);

/* The one measurement a browser can make that this cannot is whether audio
 * actually flowed: the mocked analysers return zeros, so every bus reads
 * silent here by construction. The live equivalent is
 * `window.__audio.report().silent`, which must be empty after a minute of
 * walking, and that is the check to run once this is mounted in the scene. */

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
