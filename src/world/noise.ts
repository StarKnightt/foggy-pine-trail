/* CPU noise. The authority for anything the geometry has to agree with.
 *
 * There are two noise implementations in this project and the split is
 * deliberate. `glsl.ts` has the GPU one, which bakes textures; this one runs
 * in JavaScript and decides where things physically *are* — the ground
 * heightfield, where a tree is allowed to stand, which way it leans. The two
 * never have to produce the same number, and the moment either of them tries
 * to, the seam becomes a permanent source of bugs.
 *
 * Seeded, because a forest that reshuffles itself on every reload cannot be
 * critiqued. Two screenshots of two builds have to be two pictures of the same
 * wood or there is nothing to compare.
 */

/** Deterministic permutation table from a 32-bit seed. */
function permTable(seed: number): Uint8Array {
  const p = new Uint8Array(512);
  const order = new Uint8Array(256);
  for (let i = 0; i < 256; i++) order[i] = i;

  // xorshift32 — small, fast, and reproducible across engines, which
  // Math.random with a seed shim is not.
  let s = seed >>> 0 || 1;
  const next = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s;
  };
  for (let i = 255; i > 0; i--) {
    const j = next() % (i + 1);
    const t = order[i]; order[i] = order[j]; order[j] = t;
  }
  for (let i = 0; i < 512; i++) p[i] = order[i & 255];
  return p;
}

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;

function grad(hash: number, x: number, y: number): number {
  // 8 gradient directions. The diagonal set matters: an axis-only set puts a
  // visible plus-shaped bias into fbm at low octave counts.
  switch (hash & 7) {
    case 0: return x + y;
    case 1: return -x + y;
    case 2: return x - y;
    case 3: return -x - y;
    case 4: return x;
    case 5: return -x;
    case 6: return y;
    default: return -y;
  }
}

export class Noise2D {
  private readonly p: Uint8Array;

  constructor(seed = 20260814) {
    this.p = permTable(seed);
  }

  /** Classic Perlin. Roughly [-1, 1]. */
  n(x: number, y: number): number {
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
    const xf = x - Math.floor(x), yf = y - Math.floor(y);
    const u = fade(xf), v = fade(yf);
    const p = this.p;
    const aa = p[p[X] + Y], ab = p[p[X] + Y + 1];
    const ba = p[p[X + 1] + Y], bb = p[p[X + 1] + Y + 1];
    return lerp(
      lerp(grad(aa, xf, yf), grad(ba, xf - 1, yf), u),
      lerp(grad(ab, xf, yf - 1), grad(bb, xf - 1, yf - 1), u),
      v,
    );
  }

  /** Sum of octaves, normalised to roughly [-1, 1]. */
  fbm(x: number, y: number, oct = 4, gain = 0.5, lac = 2.0): number {
    let s = 0, a = 0.5, norm = 0;
    for (let i = 0; i < oct; i++) {
      s += a * this.n(x, y);
      norm += a;
      x *= lac; y *= lac; a *= gain;
    }
    return s / Math.max(norm, 1e-6);
  }

  /** |noise| inverted. Ridges and creases — root buttresses, eroded shoulders. */
  ridged(x: number, y: number, oct = 4, gain = 0.5, lac = 2.0): number {
    let s = 0, a = 0.5, norm = 0;
    for (let i = 0; i < oct; i++) {
      s += a * (1 - Math.abs(this.n(x, y)));
      norm += a;
      x *= lac; y *= lac; a *= gain;
    }
    return s / Math.max(norm, 1e-6);
  }
}

/**
 * A small seeded PRNG for placement decisions.
 *
 * Separate from the noise field on purpose. Scatter wants a stream of
 * independent numbers — "how tall is this tree, how far does it lean, is it
 * dead" — and pulling those out of a spatial noise field correlates them with
 * position in ways that show: every tree in one corner of the wood ends up
 * tall, which reads as a gradient nobody put there.
 */
export class Rng {
  private s: number;

  constructor(seed = 1) { this.s = seed >>> 0 || 1; }

  /** Uniform [0, 1). */
  f(): number {
    let s = this.s;
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    this.s = s;
    return s / 4294967296;
  }

  /** Uniform [a, b). */
  range(a: number, b: number): number { return a + (b - a) * this.f(); }

  /** True with probability p. */
  chance(p: number): boolean { return this.f() < p; }

  /** Roughly normal, mean 0, sd ~0.29. Three uniforms is close enough and has
   * bounded tails, which a Box-Muller pair does not — an outlier tree leaning
   * eighty degrees is not a nice surprise. */
  gauss(): number { return (this.f() + this.f() + this.f()) / 1.5 - 1; }
}

export const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a || 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
};
export const mix = lerp;
