/* The trail, as a curve and as a distance field.
 *
 * One curve, and every other system queries it. The ground digs its trough
 * from it, the trees refuse to stand on it, the litter thins over it, the
 * ferns crowd its margin and stop, the fog opens slightly above it because it
 * is the one gap in the canopy. If any of those had its own idea of where the
 * path runs, the seam would be permanent and would move every time one of
 * them was tuned.
 *
 * ── The curve ─────────────────────────────────────────────────────────────
 *
 * The brief asks for a gentle curve, and gives the reason: you must not be
 * able to see too far ahead. That is a stronger constraint than it sounds.
 * With 35 m of visibility a *straight* trail shows you a receding tunnel with
 * a bright vanishing point at the end of it, and a vanishing point is the one
 * composition that tells the viewer the geometry is a corridor of instanced
 * cylinders — everything lines up on it. A curve puts the far end of the
 * visible trail behind a wall of trunks instead, so the picture closes on
 * *wood* rather than on a hole, and the fog is doing its work against
 * something.
 *
 * The amplitude is small: the whole 48 m run wanders about six metres of
 * lateral offset, which is a curve you would not notice walking it and which
 * is enough to move the sightline off the axis inside the visible range.
 *
 * ── The distance field ────────────────────────────────────────────────────
 *
 * Nearest-point-on-curve is called tens of thousands of times during
 * placement and again per ground vertex, so it is not solved analytically. The
 * curve is sampled to a polyline at ~0.25 m and bucketed into a grid; a query
 * walks the buckets within reach and does a segment projection on each. That
 * is exact to the polyline and the polyline is finer than anything that reads
 * it.
 */
import * as THREE from 'three';
import { DIMS } from './dims';

/* Control points, in metres, (x, z). The walk runs from z = 0 towards
 * negative z, and the two points past each end are there so the spline's
 * tangent at the visible ends is set by geometry rather than by the
 * Catmull-Rom end condition, which would otherwise put a small kink exactly
 * where the walk starts. */
const CONTROL: [number, number][] = [
  [-1.4, 14],
  [-0.5, 4],
  [0.0, -3],
  [1.1, -12],
  [1.6, -20],
  [0.7, -27],
  [-1.0, -33],
  [-2.6, -39],
  [-3.2, -46],
  [-2.4, -53],
  [-0.9, -62],
];

export type TrailSample = {
  /** Distance from the trail centreline, metres. */
  dist: number;
  /** Arc-length position along the trail, 0..1 over the walk. */
  t: number;
  /** Signed lateral offset: negative left of travel, positive right. */
  side: number;
  /** Unit tangent in xz at the nearest point. */
  tx: number;
  tz: number;
};

export class Trail {
  readonly curve: THREE.CatmullRomCurve3;
  /** Polyline samples: x, z, and cumulative arc length. */
  private readonly px: Float32Array;
  private readonly pz: Float32Array;
  private readonly plen: Float32Array;
  /* Per-vertex unit tangents, averaged across the two segments meeting there.
   *
   * The tangent cannot be reported as the raw segment direction. It is constant
   * within a segment and jumps at every join, and `ground.ts` reflects a query
   * point across the centreline with it to flatten the hummocks along the trail —
   * so a discontinuous tangent puts a discontinuity in the ground height every
   * 0.25 m. That is the transverse corduroy banding on the tread: it survived
   * halving the mesh row spacing, which is what proved it was in the field rather
   * than in the sampling. Interpolating these by the segment parameter gives a
   * tangent that varies continuously along the curve. */
  private readonly tgx: Float32Array;
  private readonly tgz: Float32Array;
  readonly length: number;

  /* Bucket grid over the polyline. CELL has to be at least as large as the
   * longest query radius the callers use, because the search only visits the
   * 3x3 neighbourhood. 4 m covers the widest thing that asks (the fern margin
   * test at ~2.5 m) with room to spare. */
  private static readonly CELL = 4;
  private readonly grid = new Map<number, number[]>();

  constructor() {
    this.curve = new THREE.CatmullRomCurve3(
      CONTROL.map(([x, z]) => new THREE.Vector3(x, 0, z)),
      false,
      'catmullrom',
      0.5,
    );

    const n = 520;
    this.px = new Float32Array(n);
    this.pz = new Float32Array(n);
    this.plen = new Float32Array(n);
    const v = new THREE.Vector3();
    let acc = 0;
    for (let i = 0; i < n; i++) {
      this.curve.getPoint(i / (n - 1), v);
      this.px[i] = v.x;
      this.pz[i] = v.z;
      if (i > 0) {
        acc += Math.hypot(this.px[i] - this.px[i - 1], this.pz[i] - this.pz[i - 1]);
      }
      this.plen[i] = acc;
    }
    this.length = acc;

    this.tgx = new Float32Array(n);
    this.tgz = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
      let ex = this.px[b] - this.px[a], ez = this.pz[b] - this.pz[a];
      const el = Math.hypot(ex, ez) || 1;
      this.tgx[i] = ex / el;
      this.tgz[i] = ez / el;
    }

    for (let i = 0; i < n - 1; i++) {
      // Register the segment in every cell either endpoint touches. A segment
      // is 0.25 m and a cell is 4 m, so this is at most two cells and the
      // duplicate work is negligible.
      for (const [x, z] of [[this.px[i], this.pz[i]], [this.px[i + 1], this.pz[i + 1]]]) {
        const k = this.key(x, z);
        let list = this.grid.get(k);
        if (!list) this.grid.set(k, (list = []));
        if (list[list.length - 1] !== i) list.push(i);
      }
    }
  }

  private key(x: number, z: number): number {
    const cx = Math.floor(x / Trail.CELL) + 512;
    const cz = Math.floor(z / Trail.CELL) + 512;
    return cx * 1024 + cz;
  }

  /**
   * Nearest point on the trail to (x, z).
   *
   * Returns a large `dist` rather than failing when the query is far from
   * every bucket — callers use this to mean "not on the trail", which is the
   * right answer for a point forty metres into the wood.
   */
  at(x: number, z: number): TrailSample {
    let best = Infinity, bi = -1, bu = 0;

    const cx = Math.floor(x / Trail.CELL), cz = Math.floor(z / Trail.CELL);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const list = this.grid.get(
          (cx + dx + 512) * 1024 + (cz + dz + 512),
        );
        if (!list) continue;
        for (const i of list) {
          const ax = this.px[i], az = this.pz[i];
          const bx = this.px[i + 1], bz = this.pz[i + 1];
          const ex = bx - ax, ez = bz - az;
          const l2 = ex * ex + ez * ez;
          let u = l2 > 1e-9 ? ((x - ax) * ex + (z - az) * ez) / l2 : 0;
          u = u < 0 ? 0 : u > 1 ? 1 : u;
          const qx = ax + ex * u, qz = az + ez * u;
          const d = (x - qx) * (x - qx) + (z - qz) * (z - qz);
          if (d < best) { best = d; bi = i; bu = u; }
        }
      }
    }

    /* Nothing in the 3x3 neighbourhood, so the query is further from the trail
     * than one cell. Fall back to scanning the whole polyline.
     *
     * This used to return a sentinel `dist: 1e6`, which was correct while the
     * only caller was placement asking "is this spot on the path" — and became
     * a hard bug the moment free roam let the walker stand 30 m out. The
     * walker's boundary computes a push proportional to how far past the limit
     * it is, so a sentinel distance produced a push of a million metres and
     * the body was flung to the edge of the world in one frame. A distance
     * field that answers "very far" instead of a distance is only safe for
     * predicates, and there is no way to tell from the call site which kind of
     * caller you have.
     *
     * 520 segments is a few microseconds and only runs off-trail, where by
     * definition nothing else is competing for the frame.
     */
    if (bi < 0) {
      for (let i = 0; i < this.px.length - 1; i++) {
        const ax = this.px[i], az = this.pz[i];
        const ex = this.px[i + 1] - ax, ez = this.pz[i + 1] - az;
        const l2 = ex * ex + ez * ez;
        let u = l2 > 1e-9 ? ((x - ax) * ex + (z - az) * ez) / l2 : 0;
        u = u < 0 ? 0 : u > 1 ? 1 : u;
        const qx = ax + ex * u, qz = az + ez * u;
        const d = (x - qx) * (x - qx) + (z - qz) * (z - qz);
        if (d < best) { best = d; bi = i; bu = u; }
      }
    }
    if (bi < 0) {
      return { dist: 1e6, t: 0, side: 1e6, tx: 0, tz: -1 };
    }

    const ax = this.px[bi], az = this.pz[bi];
    const bx = this.px[bi + 1], bz = this.pz[bi + 1];
    let ex = this.tgx[bi] + (this.tgx[bi + 1] - this.tgx[bi]) * bu;
    let ez = this.tgz[bi] + (this.tgz[bi + 1] - this.tgz[bi]) * bu;
    const el = Math.hypot(ex, ez) || 1;
    ex /= el; ez /= el;

    const qx = ax + (bx - ax) * bu, qz = az + (bz - az) * bu;
    const dist = Math.sqrt(best);
    // Cross product of tangent with the offset, in xz. Positive is to the
    // right of travel when travel is -z and right is +x.
    const side = Math.sign(ex * (z - qz) - ez * (x - qx)) * dist;

    const arc = this.plen[bi] + (this.plen[bi + 1] - this.plen[bi]) * bu;
    return { dist, t: arc / this.length, side, tx: ex, tz: ez };
  }

  /** Just the distance. Placement calls this millions of times. */
  distance(x: number, z: number): number {
    return this.at(x, z).dist;
  }

  /**
   * The point `along` metres down the trail, in the same units the props and
   * the heightfield use.
   *
   * "Along" is not the polyline's own arc length. `at()` reports `t` as a
   * fraction of the whole spline — which runs off both ends of the walk — and
   * everything downstream turns that back into metres by multiplying by
   * `trailLength`. So the trail is, by that convention, 48 m long however long
   * its polyline actually is, and this has to undo exactly the same scaling or
   * the root tubes land a metre or two from the swells raised for them.
   */
  pointAtAlong(along: number): { x: number; z: number; tx: number; tz: number } {
    const arc = (along / DIMS.trailLength) * this.length;
    let bi = 0;
    // The polyline is 520 samples and this is called a few hundred times at
    // build; a scan is exact and a binary search is not worth the risk.
    for (let i = 0; i < this.plen.length - 1; i++) {
      if (this.plen[i + 1] >= arc) { bi = i; break; }
      bi = i;
    }
    const span = this.plen[bi + 1] - this.plen[bi];
    const f = span > 1e-6 ? (arc - this.plen[bi]) / span : 0;
    let ex = this.px[bi + 1] - this.px[bi], ez = this.pz[bi + 1] - this.pz[bi];
    const el = Math.hypot(ex, ez) || 1;
    return {
      x: this.px[bi] + (this.px[bi + 1] - this.px[bi]) * f,
      z: this.pz[bi] + (this.pz[bi + 1] - this.pz[bi]) * f,
      tx: ex / el,
      tz: ez / el,
    };
  }

  /**
   * Where the walk is at normalised progress `u`.
   *
   * Not the same parameter as the curve's own: the curve runs off both ends of
   * the walk so that its tangents are clean, and `u = 0` should be where the
   * walker starts, not where the spline does.
   */
  walkAt(u: number): { x: number; z: number; tx: number; tz: number } {
    const zStart = 0;
    const zEnd = -DIMS.trailLength;
    // Solve for the polyline sample nearest the target z. Monotone in z over
    // the walk, so a scan is exact and a binary search is not worth writing.
    const targetZ = zStart + (zEnd - zStart) * u;
    let bi = 0;
    for (let i = 0; i < this.pz.length - 1; i++) {
      if (this.pz[i] >= targetZ && this.pz[i + 1] <= targetZ) { bi = i; break; }
    }
    const span = this.pz[bi] - this.pz[bi + 1];
    const f = span > 1e-6 ? (this.pz[bi] - targetZ) / span : 0;
    const x = this.px[bi] + (this.px[bi + 1] - this.px[bi]) * f;
    let ex = this.px[bi + 1] - this.px[bi], ez = this.pz[bi + 1] - this.pz[bi];
    const el = Math.hypot(ex, ez) || 1;
    return { x, z: targetZ, tx: ex / el, tz: ez / el };
  }
}

/* One instance, shared. Building it costs about a millisecond and every
 * system needs the same one — two Trails would be two different paths that
 * happened to look alike. */
let cached: Trail | null = null;
export function trail(): Trail {
  return (cached ??= new Trail());
}
