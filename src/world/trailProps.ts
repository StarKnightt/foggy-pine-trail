/* The things lying on the trail.
 *
 * Surface roots, embedded stones and fallen wood — the three that System 1
 * calls for and the three that a heightfield cannot express, for the same
 * reason in each case: all of them are *undercut*. A root arches out of the
 * soil, a stone is wider below the surface than at it, a stick lies across a
 * hollow with daylight under one end. A height function is single-valued in y
 * and can represent none of that; what it produces instead is a smooth swell
 * with a texture painted on it, which reads as a bulge in a carpet.
 *
 * ── Everything registers to groundHeight ──────────────────────────────────
 *
 * Not "is placed near". The heightfield has centimetre-scale duff in it, and a
 * stone whose base was computed from a smoothed version of the floor sits 3 cm
 * proud on one side and 3 cm sunk on the other. At 1.6 m eye height and a 52°
 * lens that is four pixels of daylight under a rock, which is enough — it is
 * the single most reliable way to make a real photograph look like a render.
 *
 * So: the roots take their line from the same `allRoots()` specs the
 * heightfield raised its swells from, the stones are sunk against the *maximum*
 * of four ground samples around their footprint rather than the one at their
 * centre, and the sticks sample the floor at every node along their length.
 *
 * ── One geometry per material ─────────────────────────────────────────────
 *
 * Roots and sticks are both wet wood, so they are built into one buffer and
 * drawn once. The stones are the other buffer. Two draw calls for every prop
 * in the wood, which matters less for the call count than for the fact that
 * none of this needs to be sorted, updated or culled per object.
 */
import * as THREE from 'three';
import { groundHeight, allRoots, allLongRoots, allBigStones } from './ground';
import { trail } from './trail';
import { DIMS } from './dims';
import { Rng, smoothstep, clamp } from './noise';

/* Metres of world covered by one tile of the prop textures. Emitted straight
 * into the uv attribute rather than left to a texture transform, because the
 * rocks are box-mapped in world space and a per-texture repeat would have to
 * be kept in step with three separate maps. */
const WOOD_PATCH = 0.42;
const ROCK_PATCH = 0.55;

/** Which way the weather comes from, for the moss. */
const DAMP_SIDE = new THREE.Vector3(-0.32, 0, -0.95).normalize();

/* Accumulator for a merged mesh.
 *
 * Plain arrays rather than BufferGeometryUtils.mergeGeometries: merging N
 * small geometries allocates N of everything first and then copies, and this
 * runs on the main thread during the load veil where the cost is visible.
 */
class Accum {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly uv: number[] = [];
  readonly idx: number[] = [];
  private readonly extras = new Map<string, number[]>();

  get count(): number { return this.pos.length / 3; }

  vert(p: THREE.Vector3, n: THREE.Vector3, u: number, v: number): number {
    const i = this.count;
    this.pos.push(p.x, p.y, p.z);
    this.nrm.push(n.x, n.y, n.z);
    this.uv.push(u, v);
    return i;
  }

  attr(name: string, value: number): void {
    let a = this.extras.get(name);
    if (!a) this.extras.set(name, (a = []));
    a.push(value);
  }

  tri(a: number, b: number, c: number): void { this.idx.push(a, b, c); }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    for (const [name, a] of this.extras) {
      g.setAttribute(name, new THREE.Float32BufferAttribute(a, 1));
    }
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

/* ── Wood ────────────────────────────────────────────────────────────────── */

type Node = {
  p: THREE.Vector3;
  /** Radius here. */
  r: number;
  /** 0 raw bark, 1 boot-polished. Rides the geometry because it is a property
   * of where the piece lies, and the material has no idea where that is. */
  wear: number;
  /** Floor height directly under this node, for the contact crease. */
  g: number;
};

const UP = new THREE.Vector3(0, 1, 0);
const SIDEWAYS = new THREE.Vector3(1, 0, 0);

/* The contact crease.
 *
 * The single most-cited reason a prop reads as a decal is that it has no dark
 * line where it meets the floor. There is no shadow map in this scene and there
 * never will be — env.ts explains why — so the crease has to be authored, and
 * the geometry is the only place that knows where the soil line is: it is the
 * only place holding both the vertex and the floor height under it.
 *
 * Zero on the crown, a third of the way on at the flanks, full underneath. The
 * flank value is the one that matters. It is what puts a hard tight line down
 * one side of a root at the soil line, which is what the eye is looking for, and
 * it is asymmetric because the erosion hollow around a surface root is on one
 * side — a symmetric crease reads as an airbrushed outline.
 */
function contactAt(y: number, node: Node, lateral: number): number {
  const rel = (y - node.g) / Math.max(node.r, 1e-4);
  const c = clamp(1 - (rel + 0.35) / 1.15, 0, 1);
  return Math.pow(c, 1.4) * (0.50 + 0.50 * smoothstep(-0.35, 0.85, lateral));
}

/**
 * A tube through a polyline, with flat caps.
 *
 * Frames are built from world up rather than parallel-transported. Everything
 * this draws lies within about thirty degrees of horizontal, where the two
 * agree to well under a degree, and the up frame has the property that
 * transport does not: the "top" of the tube is the top in the world, so the
 * wear term below can key off the ring angle and mean something.
 *
 * `shx`/`shz` is the horizontal direction the contact crease is deepest in —
 * the downhill side, where the washed-out hollow is. It is per piece rather
 * than global because a global one would light every root in the frame from the
 * same azimuth, which is the one thing env.ts forbids.
 */
function tube(m: Accum, nodes: Node[], radial: number, tint: number,
              shx = 1, shz = 0): void {
  const t = new THREE.Vector3();
  const side = new THREE.Vector3();
  const up = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const p = new THREE.Vector3();

  const rings: number[] = [];
  let arc = 0;
  let rRef = 0;
  for (const n of nodes) rRef += n.r;
  rRef /= nodes.length;

  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[Math.max(0, i - 1)].p;
    const b = nodes[Math.min(nodes.length - 1, i + 1)].p;
    t.subVectors(b, a);
    if (t.lengthSq() < 1e-12) t.set(0, 0, -1);
    t.normalize();
    if (i > 0) arc += nodes[i].p.distanceTo(nodes[i - 1].p);

    const ref = Math.abs(t.y) > 0.94 ? SIDEWAYS : UP;
    side.crossVectors(ref, t).normalize();
    up.crossVectors(t, side).normalize();

    rings.push(m.count);
    for (let j = 0; j <= radial; j++) {
      const ang = (j / radial) * Math.PI * 2;
      const c = Math.cos(ang), s = Math.sin(ang);
      dir.set(
        side.x * c + up.x * s,
        side.y * c + up.y * s,
        side.z * c + up.z * s,
      );
      p.copy(nodes[i].p).addScaledVector(dir, nodes[i].r);
      m.vert(p, dir, (ang * rRef) / WOOD_PATCH, arc / WOOD_PATCH);
      m.attr('aTint', tint);
      /* Only the upper surface is ever walked on, and only the middle of the
       * piece — the ends of a root are underground and the ends of a stick are
       * in the litter.
       *
       * Cubed rather than linear in the surface normal's up component. A boot
       * sole contacts the crown of a root over maybe 30 degrees either side of
       * top; a linear falloff spreads the polish over the whole upper hemisphere
       * and the root comes back uniformly pale, which is the pale-plastic read.
       * The polish has to be a narrow band with unpolished bark either side of
       * it or it stops being evidence of anything. */
      const upness = clamp(dir.y, 0, 1);
      m.attr('aWear', nodes[i].wear * upness * upness * upness);
      m.attr('aContact', contactAt(p.y, nodes[i], dir.x * shx + dir.z * shz));
    }
  }

  for (let i = 0; i < nodes.length - 1; i++) {
    const a = rings[i], b = rings[i + 1];
    for (let j = 0; j < radial; j++) {
      m.tri(a + j, b + j, a + j + 1);
      m.tri(a + j + 1, b + j, b + j + 1);
    }
  }

  /* Caps. A tapered-to-nothing end reads as a worm; a real broken stick has a
   * face and a real root has a face because it went into the soil.
   *
   * But a *flat circular disc at full radius* is what made the sticks read as
   * vacuum hose, and it is the single most identifiable thing about them: wood does
   * not break square across the grain, it breaks long and splintered because the
   * fibres run lengthwise. So the rim is jittered per vertex and the centre is
   * pushed out along the axis, which turns the disc into an irregular cone — a
   * snapped end. On a root both ends are underground, so this costs nothing there
   * and does not need a second code path. */
  for (const [i, sgn] of [[0, -1], [nodes.length - 1, 1]] as const) {
    const a = nodes[Math.max(0, i - 1)].p;
    const b = nodes[Math.min(nodes.length - 1, i + 1)].p;
    t.subVectors(b, a).normalize().multiplyScalar(sgn);
    const ref = Math.abs(t.y) > 0.94 ? SIDEWAYS : UP;
    side.crossVectors(ref, t).normalize();
    up.crossVectors(t, side).normalize();

    const rn = nodes[i].r;
    p.copy(nodes[i].p).addScaledVector(t, rn * 1.35);
    const centre = m.vert(p, t, 0.5, 0.5);
    m.attr('aTint', tint);
    m.attr('aWear', 0);
    m.attr('aContact', contactAt(p.y, nodes[i], 0));
    const first = m.count;
    for (let j = 0; j <= radial; j++) {
      const ang = (j / radial) * Math.PI * 2;
      const c = Math.cos(ang), s = Math.sin(ang);
      dir.set(
        side.x * c + up.x * s,
        side.y * c + up.y * s,
        side.z * c + up.z * s,
      );
      /* Splinters, from a hash of the angle so the break is the same shape every
       * time this piece is rebuilt. Long in the axis and ragged in the radius,
       * which is how a fibre bundle parts. */
      const jag = hash3(c, s, sgn, tint * 977);
      p.copy(nodes[i].p)
        .addScaledVector(dir, rn * (0.62 + 0.55 * jag))
        .addScaledVector(t, rn * jag * 0.9);
      m.vert(p, t, 0.5 + c * 0.5, 0.5 + s * 0.5);
      m.attr('aTint', tint);
      m.attr('aWear', 0);
      m.attr('aContact', contactAt(p.y, nodes[i], 0));
    }
    for (let j = 0; j < radial; j++) {
      if (sgn < 0) m.tri(centre, first + j, first + j + 1);
      else m.tri(centre, first + j + 1, first + j);
    }
  }
}

/**
 * The surface roots.
 *
 * `at`, `skew`, `thick` and `reach` come from `allRoots()`, which is also what
 * `groundHeight` reads to raise the swell of earth around each one. The crest
 * line of that swell is where `(along - at) + side*skew` is zero, so the tube's
 * centreline is exactly `along = at - side*skew`, and the two are in register
 * by construction rather than by tuning.
 */
function roots(m: Accum, rng: Rng): number {
  const tr = trail();
  const specs = allRoots();
  let drawn = 0;

  for (const spec of specs) {
    // The walk only ever sees 0..48; the generator runs past both ends so the
    // spacing statistics do not thin out at the edges.
    if (spec.at < -2 || spec.at > DIMS.trailLength + 2) continue;

    const reach = spec.reach;
    const segs = 30;
    const knuckle = rng.range(0, 6.283);
    const knuckleF = rng.range(2.0, 3.4);
    const wob = rng.range(0, 6.283);
    const tint = rng.f();
    /* Which side the washed-out hollow is on. Random per root, because the
     * alternative is a scene-wide azimuth and that is a sun. */
    const shSide = rng.chance(0.5) ? 1 : -1;

    /* One arm, from `s0` to `s1` across the trail, at `bias` metres of lateral
     * offset. The main root runs the full reach either side of the centreline;
     * a fork is a shorter arm peeling off it, which is what makes a root read
     * as part of a system rather than as a length of hose. */
    const arm = (s0: number, s1: number, bias: number, rk: number) => {
      const nodes: Node[] = [];
      for (let i = 0; i <= segs; i++) {
        const s = s0 + ((s1 - s0) * i) / segs;
        const along = spec.at - s * spec.skew;
        const c = tr.pointAtAlong(along);
        // Right of travel is the tangent turned a quarter turn; `Trail.at` signs
        // `side` the same way, so s and side agree.
        const nx = -c.tz, nz = c.tx;
        /* A root is not a straight line between two points in the soil. The
         * lateral wander is small — a few centimetres over a metre — but without
         * it the tube reads as pipe. The `bias` term ramps in so a fork leaves
         * its parent smoothly instead of starting beside it. */
        const wander = Math.sin(s * 1.7 + wob) * spec.thick * 1.6
          + bias * smoothstep(s0, s1, s);
        const x = c.x + nx * s + c.tx * wander;
        const z = c.z + nz * s + c.tz * wander;

        const g = groundHeight(x, z);
        /* Height above the swell.
         *
         * 0.52 of the radius, so more than half the tube stands out of the
         * ground at the crown — enough that the *curvature* of the top is
         * visible, which is the whole point. A root sitting at 0.36 shows a
         * band of surface whose normal barely swings away from the floor's, and
         * under a fog dome that means it barely changes value across its width:
         * a dark ribbon, which is exactly what the previous version rendered.
         * The soil falls away from the tube on both flanks within a few
         * centimetres, and that gap is the undercut. */
        /* 0.34 of the radius, not 0.52. Two thirds buried is what an exposed
         * surface root actually is, and the extra 18% was standing the tube proud
         * enough that the earth swell no longer read as supporting it. The
         * curvature of the crown, which is the reason for lifting it at all, is
         * fully visible at a third. */
        const rise = spec.thick * 0.34;
        /* Knuckles. Real roots surface and submerge repeatedly rather than
         * arching once, so the amplitude is comparable to the radius and the
         * period is under a metre. Two incommensurate periods, because a single
         * sinusoid is the "one mechanical kink in the middle" the audit found:
         * with the arm only a metre or two long, one period of one sine is a
         * single symmetric arch and the eye reads it as a bent pipe. */
        const knob = (Math.sin(s * knuckleF * rk + knuckle) * 0.24
          + Math.sin(s * knuckleF * rk * 2.7 + knuckle * 2.3) * 0.12) * spec.thick;
        /* Both ends dive under, and where they dive is set by the tread and not
         * by the root's own length. A root is exposed because the trail wore the
         * soil off it, so it goes back under a hand's width past the edge of the
         * wear — whatever the rest of it is doing. Keying the dive to `reach`
         * instead left two metres of tube lying on top of undisturbed duff on
         * both sides, which reads as a hose. */
        const buriedAt = DIMS.trailHalf + 0.22;
        const dive = smoothstep(buriedAt, buriedAt + 0.45, Math.abs(s)) * spec.thick * 4.0;
        /* Guaranteed burial at the arm's own ends, on top of the dive keyed to
         * the tread width. Those two are not the same distance: `reach` scales
         * with thickness and for the thinnest roots it comes out shorter than
         * `buriedAt`, so the dive had not started by the time the arm ran out and
         * the end cap sat flat on the soil surface pointing at the camera. That
         * is the "blunt flat-capped ends stopping in mid-air" in the audit, and
         * it is a bug in the burial distance rather than in the cap. */
        const endU = Math.abs(s) / Math.max(Math.abs(s0), Math.abs(s1), 1e-4);
        const sink = smoothstep(0.68, 1.0, endU) * spec.thick * 3.4;

        /* Radius along the length. A root tapers towards its tip, thins where it
         * has been abraded and swells at every knuckle, and none of those are the
         * same period — the previous single 22% ripple on top of a smooth taper
         * still read as constant diameter because the ripple was symmetric about
         * the crossing and the taper only bit in the outer third. */
        const taper = (1 - 0.42 * smoothstep(reach * 0.35, reach, Math.abs(s)))
          * (1 - 0.58 * smoothstep(0.60, 1.0, endU));
        const lump = 1 + 0.20 * Math.sin(s * 5.3 + knuckle * 1.7)
          + 0.13 * Math.sin(s * 11.7 + wob * 2.1)
          + 0.09 * Math.sin(s * 23.0 + knuckle);

        nodes.push({
          p: new THREE.Vector3(x, g + rise + knob - dive - sink, z),
          r: spec.thick * taper * lump,
          g,
          /* Boots polish the crown of a root where it crosses the tread, and
           * nowhere else. It is the brightest thing on the trail surface and it
           * is the detail that says the path is used. */
          wear: 1 - smoothstep(DIMS.trailFlat * 0.7, DIMS.trailHalf * 1.15, Math.abs(s)),
        });
      }
      /* 14 radial segments, not 9. A 9-gon tube lit by a fog dome shows nine
       * flat facets whose values step, and along a curving length those steps
       * line up into the concentric banding the audit called stacked ribbon.
       * 14 puts the facet width below what the normal map's own detail hides. */
      tube(m, nodes, 14, tint, shSide, 0);
      drawn++;
    };

    arm(-reach, reach, 0, 1);
    /* The fork. Leaves the parent somewhere in the middle third and diverges by
     * up to 30 cm over the rest of its run, which is what a real branching root
     * does at this scale. Only the thicker specs carry one — see `rootsNear`. */
    if (spec.fork !== 0) {
      const from = spec.fork > 0 ? reach * 0.10 : -reach * 0.10;
      arm(from, from + Math.sign(spec.fork) * reach * 0.85, spec.fork, 1.6);
    }
  }
  return drawn;
}

/**
 * Roots running with the trail.
 *
 * Same registration contract as the crossings: `allLongRoots()` is what the
 * heightfield read to raise the swell, so the tube and the swell cannot drift.
 * These exist because a rooty trail in the reference photographs has as many
 * roots running along it as across it — a root that surfaces where the tread cut
 * into a root plate follows the line of least soil, and that is often the line
 * of the trail. Without them every root in the frame crosses at roughly the
 * same angle, which is a pattern the eye finds within a second.
 */
function longRoots(m: Accum, rng: Rng): number {
  const tr = trail();
  let drawn = 0;

  for (const spec of allLongRoots()) {
    if (spec.at + spec.len < -2 || spec.at > DIMS.trailLength + 2) continue;

    const segs = Math.max(12, Math.round(spec.len / 0.10));
    const nodes: Node[] = [];
    const knuckle = rng.range(0, 6.283);
    const shSide = rng.chance(0.5) ? 1 : -1;

    for (let i = 0; i <= segs; i++) {
      const u = i / segs;
      const along = spec.at + spec.len * u;
      const side = spec.side + Math.sin(u * 4.1 + spec.at) * spec.wander;
      const c = tr.pointAtAlong(along);
      const x = c.x + -c.tz * side, z = c.z + c.tx * side;
      const g = groundHeight(x, z);

      // Dives under the duff at both ends rather than stopping in mid-air.
      const ends = smoothstep(0, 0.16, u) * (1 - smoothstep(0.84, 1.0, u));
      const rise = spec.thick * 0.52 * ends - spec.thick * 2.2 * (1 - ends);
      const knob = Math.sin(u * spec.len * 3.1 + knuckle) * spec.thick * 0.34 * ends;

      nodes.push({
        p: new THREE.Vector3(x, g + rise + knob, z),
        r: spec.thick * (1 - 0.30 * smoothstep(0.5, 1.0, Math.abs(u - 0.5) * 2)),
        g,
        wear: 0.85 * (1 - smoothstep(DIMS.trailFlat, DIMS.trailHalf * 1.2, Math.abs(side))),
      });
    }

    tube(m, nodes, 9, rng.f(), shSide, 0);
    drawn++;
  }
  return drawn;
}

/**
 * Fallen sticks and small branches.
 *
 * Two populations. A few lie across the trail, because a trail collects what
 * falls on it and nobody clears a path in a wood; most are off it, where they
 * are half-swallowed by the needle mat. The off-trail ones are what stop the
 * litter from reading as a texture, so there are a lot more of them than the
 * eye would guess from a photograph.
 */
function sticks(m: Accum, rng: Rng): number {
  const tr = trail();
  let drawn = 0;

  for (let along = -1; along < DIMS.trailLength + 2; along += rng.range(0.5, 1.5)) {
    const n = rng.chance(0.4) ? 2 : 1;
    for (let k = 0; k < n; k++) {
      const onTrail = rng.chance(0.13);
      const side = onTrail
        ? rng.range(-DIMS.trailHalf, DIMS.trailHalf)
        : Math.sign(rng.gauss() || 1) * rng.range(DIMS.trailHalf + 0.15, 5.5);

      const c = tr.pointAtAlong(along);
      const nx = -c.tz, nz = c.tx;
      const cx = c.x + nx * side;
      const cz = c.z + nz * side;
      if (Math.abs(cx) > DIMS.worldHalf - 2 || cz > DIMS.zMax - 2 || cz < DIMS.zMin + 2) continue;

      /* A stick lying across the tread has been kicked and broken and is
       * short; one that fell where it lies in the duff can be a metre and a
       * half of branch. */
      const len = onTrail ? rng.range(0.16, 0.5) : rng.range(0.22, 1.5);
      /* 11 mm is the floor and it is a rendering constraint, not a botanical
       * one. A 6 mm twig four metres out is a fifth of a pixel wide; with no
       * antialiasing on the canvas it resolves to a chain of isolated near-
       * black pixels, which reads as dirt on the lens rather than as a twig.
       * Anything finer than this belongs in the litter texture, where it is,
       * and not in geometry. */
      const r0 = clamp(len * rng.range(0.018, 0.034), 0.011, 0.038);
      /* Down to a fifth at the far end where it was 0.45-0.9. A branch tapers hard
       * — it is a cone, not a pipe — and the audit's "constant-diameter cylinder"
       * was largely this number: at 0.9 the two ends are indistinguishable over
       * half a metre, and a taper the eye cannot measure is not a taper. */
      const r1 = r0 * rng.range(0.20, 0.55);
      const ang = rng.range(0, Math.PI * 2);
      const dx = Math.cos(ang), dz = Math.sin(ang);
      /* Sag, not arch. A branch resting on a lumpy floor touches at two or
       * three points and bridges the hollows between them; sampling the floor
       * at every node and adding the radius does that for free, and the only
       * thing to add is that the ends can be propped up on the litter. */
      const prop = rng.range(0, 0.35);

      const segs = Math.max(4, Math.round(len / 0.09));
      const nodes: Node[] = [];
      for (let i = 0; i <= segs; i++) {
        const u = i / segs;
        const s = (u - 0.5) * len;
        const x = cx + dx * s, z = cz + dz * s;
        /* Knuckles and a swelling where a side branch left, so the radius is not a
         * straight ramp. Two incommensurate periods, because a single sine is a
         * regular bulge and reads as a moulding. */
        const lump = 1
          + 0.20 * Math.sin(u * 9.3 + prop * 21)
          + 0.13 * Math.sin(u * 21.7 + prop * 7);
        const r = (r0 + (r1 - r0) * u) * lump;
        const g = groundHeight(x, z);
        /* Sunk to the axis rather than clear of it. At two thirds of the radius the
         * piece is tangent to the floor and touching it along a line, which is a
         * stick resting on a table; the mat is 3-5 cm deep and a fallen branch is
         * held *in* it, with litter over the low points. This is the contact the
         * audit said was missing, and it is a sink depth rather than a shading term. */
        nodes.push({
          p: new THREE.Vector3(x, g + r * 0.12 + prop * r * Math.sin(u * Math.PI), z),
          r,
          g,
          wear: onTrail ? 0.55 : 0,
        });
      }
      /* 11 rather than 6. Six gives a hexagonal prism, and at the size these
       * subtend in the near field the flat facets and their hard edges are exactly
       * the "segmented cylinder" read — the roots were taken to 14 for the same
       * reason and it was the single biggest improvement to them. */
      tube(m, nodes, 11, rng.f(), dz, -dx);
      drawn++;
    }
  }
  return drawn;
}

/* ── Stone ───────────────────────────────────────────────────────────────── */

/* Deterministic hash for the vertex displacement. Has to be a function of the
 * icosahedron's *original* direction rather than of a running counter, because
 * the base geometry is non-indexed and every corner appears in five triangles:
 * a counter moves each copy somewhere different and the rock comes apart. */
function hash3(x: number, y: number, z: number, seed: number): number {
  let h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7 + seed * 43.3) * 43758.5453;
  h -= Math.floor(h);
  return h;
}

const icoCache = new Map<number, THREE.BufferGeometry>();
function ico(detail: number): THREE.BufferGeometry {
  let g = icoCache.get(detail);
  if (!g) icoCache.set(detail, (g = new THREE.IcosahedronGeometry(1, detail)));
  return g;
}

/**
 * One stone.
 *
 * An icosahedron with its vertices pushed in and out, kept non-indexed so the
 * triangle normals stay per-face. That flat shading is the whole point:
 * broken rock is planar facets meeting at hard edges, and a smoothed normal
 * across those edges turns basalt into a potato. `detail` 0 gives twenty
 * facets, which at 6 cm across is more than the fog will ever resolve.
 */
function stone(
  m: Accum,
  cx: number,
  cz: number,
  size: number,
  detail: number,
  buried: number,
  moss: number,
  rng: Rng,
): void {
  const src = ico(detail).getAttribute('position');
  const seed = rng.range(0, 1000);
  // Stones are wider than they are tall far more often than not — they came
  // off a bed and they settle on their flattest face.
  const sx = size * rng.range(0.82, 1.30);
  const sy = size * rng.range(0.52, 0.86);
  const sz = size * rng.range(0.82, 1.30);
  const yaw = rng.range(0, Math.PI * 2);
  const cy = Math.cos(yaw), sn = Math.sin(yaw);

  const n = src.count;
  const local = new Float32Array(n * 3);
  let minY = Infinity, maxY = -Infinity;

  for (let i = 0; i < n; i++) {
    const dx = src.getX(i), dy = src.getY(i), dz = src.getZ(i);
    /* Key on the rounded direction, not on i. Every corner of the base solid
     * appears in five triangles and each copy has to be displaced by the same
     * amount or the facets pull apart along their shared edges. */
    const kx = Math.round(dx * 4096) / 4096;
    const ky = Math.round(dy * 4096) / 4096;
    const kz = Math.round(dz * 4096) / 4096;
    const d = 1 + (hash3(kx, ky, kz, seed) - 0.5) * 0.62
              + (hash3(kx * 3.7, ky * 3.7, kz * 3.7, seed + 11) - 0.5) * 0.26;

    const px = dx * d * sx, py = dy * d * sy, pz = dz * d * sz;
    local[i * 3] = px * cy - pz * sn;
    local[i * 3 + 1] = py;
    local[i * 3 + 2] = px * sn + pz * cy;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  }

  /* Sink against the highest ground under the footprint, not the ground at the
   * centre. On a floor with 4 cm of duff roughness the difference across a
   * 30 cm stone is the whole of the visible gap. */
  let gTop = groundHeight(cx, cz);
  for (const [ox, oz] of [[sx, 0], [-sx, 0], [0, sz], [0, -sz]] as const) {
    const g = groundHeight(cx + ox * 0.8, cz + oz * 0.8);
    if (g > gTop) gTop = g;
  }
  const height = maxY - minY;
  const oy = gTop - buried * height - minY;

  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), fn = new THREE.Vector3();

  for (let t = 0; t < n; t += 3) {
    a.set(local[t * 3] + cx, local[t * 3 + 1] + oy, local[t * 3 + 2] + cz);
    b.set(local[t * 3 + 3] + cx, local[t * 3 + 4] + oy, local[t * 3 + 5] + cz);
    c.set(local[t * 3 + 6] + cx, local[t * 3 + 7] + oy, local[t * 3 + 8] + cz);
    e1.subVectors(b, a);
    e2.subVectors(c, a);
    fn.crossVectors(e1, e2);
    if (fn.lengthSq() < 1e-16) continue;
    fn.normalize();

    /* Box mapping on the face's dominant axis. Rocks have no natural
     * parameterisation and a spherical one puts a pinch at both poles that
     * shows as a smear on every stone in the frame; projecting each facet
     * along its own strongest axis is exact for a planar facet, which is what
     * every facet here is. World space rather than local, so two stones side
     * by side do not wear the same patch of texture. */
    const ax = Math.abs(fn.x), ay = Math.abs(fn.y), az = Math.abs(fn.z);
    const uvOf = (v: THREE.Vector3): [number, number] =>
      ax > ay && ax > az ? [v.z / ROCK_PATCH, v.y / ROCK_PATCH]
      : ay > az ? [v.x / ROCK_PATCH, v.z / ROCK_PATCH]
      : [v.x / ROCK_PATCH, v.y / ROCK_PATCH];

    /* Moss. On the damp side and low down, and not on the flat top of a stone
     * standing in a trail — that is where the boots and the rain are. The
     * facet normal is the right thing to key on rather than the vertex
     * position, because moss grows on a *face*, and it gives the moss the
     * same hard edges the rock has. */
    const facing = fn.dot(DAMP_SIDE);
    const base = smoothstep(-0.40, 0.45, facing) * (1 - smoothstep(0.40, 0.95, fn.y));
    const first = m.count;
    for (const v of [a, b, c]) {
      const up = clamp((v.y - (gTop - buried * height)) / Math.max(height, 1e-3), 0, 1);
      const [u, w] = uvOf(v);
      m.vert(v, fn, u, w);
      m.attr('aMoss', clamp(moss * base * (1 - smoothstep(0.48, 1.05, up)), 0, 1));
      /* The bedding crease. A stone that has been in the ground for a century
       * has soil built up against it and a hard dark line where the two meet;
       * the previous version had no term for it at all and every rock in the
       * frame read as sitting on top of the floor. Tight — a fifth of the
       * stone's height — because a soft one is an airbrushed outline, which is
       * the same failure in the other direction. */
      m.attr('aContact', clamp(1 - smoothstep(0, 0.20, up - buried), 0, 1));
      /* The polished crown. The exposed top of a trail stone has had a century
       * of boots and rain on it: it is smoother and reliably lighter than the
       * flanks, and the step between the two is what says the stone is bedded in
       * rather than dropped. */
      m.attr('aCrown', clamp(smoothstep(buried + 0.22, 0.98, up) * clamp(fn.y, 0, 1), 0, 1));
    }
    m.tri(first, first + 1, first + 2);
  }
}

/* ── Everything ──────────────────────────────────────────────────────────── */

export type TrailProps = {
  wood: THREE.BufferGeometry;
  stones: THREE.BufferGeometry;
  counts: { roots: number; sticks: number; stones: number; tris: number };
};

/**
 * Scatter the stones.
 *
 * Three populations with different jobs. The ones *in* the tread are mostly
 * buried and small, and they are what makes the path read as a worn surface
 * with the fines washed out of it rather than as swept earth. The ones on the
 * margin are the ones a boot has kicked loose. The ones off in the wood are
 * bigger, mossy, and exist mainly so that the litter has something in it with
 * a hard edge.
 */
/* Stone size, on a power law.
 *
 * Fragment sizes from weathering follow a Pareto distribution — many small, few
 * large, with no characteristic size — and this is the exact inverse CDF of one
 * truncated to [lo, hi]. It matters more than it sounds like it should: drawing
 * uniformly from a range, which is what was here, gives every stone in the
 * population the same apparent size to within a factor of three, and a field of
 * same-sized rocks at even spacing is the most recognisable signature of
 * procedural scatter there is. The critic's word for it was confetti.
 *
 * An exponent of 1.9 puts about three quarters of the draws in the bottom third
 * of the range and roughly one in forty above half of it.
 */
function powerSize(rng: Rng, lo: number, hi: number, alpha = 1.9): number {
  const k = 1 - (hi / lo) ** -alpha;
  return lo * (1 - rng.f() * k) ** (-1 / alpha);
}

function stones(m: Accum, rng: Rng): number {
  const tr = trail();
  let drawn = 0;

  const place = (
    along: number, side: number, size: number,
    detail: number, buried: number, moss: number,
  ) => {
    const c = tr.pointAtAlong(along);
    const x = c.x + -c.tz * side, z = c.z + c.tx * side;
    if (Math.abs(x) > DIMS.worldHalf - 2 || z > DIMS.zMax - 2 || z < DIMS.zMin + 2) return;
    stone(m, x, z, size, detail, buried, moss, rng);
    drawn++;
  };

  /* The big ones first, from the shared generator in `ground.ts`, because the
   * heightfield has piled soil against exactly these and nothing else. Placing
   * them from a local `Rng` instead would put the collar and the stone a few
   * centimetres apart — the same class of registration bug the root swells had,
   * and one that survives review because a few centimetres reads as sloppy
   * modelling rather than as two generators disagreeing. */
  for (const s of allBigStones()) {
    place(s.at, s.side, s.size, s.size > 0.2 ? 1 : 0, s.buried, s.moss);
  }

  for (let along = -1; along < DIMS.trailLength + 2; along += rng.range(0.26, 0.7)) {
    /* In the tread. Denser than anywhere else and buried deep: this is where
     * the fines have washed out from between the stones, which is the whole
     * mechanism by which a trail becomes stony, and an embedded trail stone
     * shows a crown a centimetre or two proud and nothing else.
     *
     * Biased towards the centreline with a Gaussian rather than spread
     * uniformly, because the wear and the runoff are both strongest there.
     * 22 mm is the floor: below that the exposed crown is under a pixel at two
     * metres and the tread texture's own aggregate does the job better. */
    /* Capped at the 9 cm the heightfield's collar generator starts at, here and
     * in both populations below. Anything larger has to come from `allBigStones`
     * or it is a stone with no soil banked against it, which is the defect being
     * closed — so the cap is what keeps the two generators from overlapping
     * rather than a statement about stone sizes in a tread. */
    if (rng.chance(0.82)) {
      place(along, clamp(rng.gauss() * 0.42, -1, 1) * DIMS.trailFlat * 1.25,
        powerSize(rng, 0.022, 0.088), 0, rng.range(0.62, 0.84), 0);
    }
    /* On the eroded margin, where the bank has been cut and the stones it held
     * are half out of it. */
    if (rng.chance(0.5)) {
      place(along, (rng.chance(0.5) ? 1 : -1) * rng.range(DIMS.trailFlat, DIMS.trailHalf + 0.5),
        powerSize(rng, 0.028, 0.088), 0,
        rng.range(0.54, 0.78), rng.range(0.15, 0.60));
    }
  }

  /* Off in the wood. Fewer than there were: litter buries a stone within a
   * couple of seasons, so a duff floor shows only the ones too big to cover,
   * and 150 scattered rocks across the visible strip read as a scree slope with
   * moss on it. */
  for (let i = 0; i < 70; i++) {
    place(
      rng.range(-2, DIMS.trailLength + 3),
      (rng.chance(0.5) ? 1 : -1) * rng.range(1.0, 7.5),
      powerSize(rng, 0.030, 0.088, 1.6),
      0,
      rng.range(0.66, 0.86),
      rng.range(0.45, 1.0),
    );
  }

  return drawn;
}

export function buildTrailProps(): TrailProps {
  /* One stream, consumed in a fixed order. Every draw below moves it on, so
   * changing the number of sticks reshuffles the stones — which is fine and is
   * the reason the seed is written down: two builds of the same code are the
   * same wood, and that is all this has to guarantee. */
  const rng = new Rng(0x51ee7);

  const wood = new Accum();
  const nRoots = roots(wood, rng) + longRoots(wood, rng);
  /* The loose deadwood is withdrawn, deliberately, and the reasoning is worth
   * keeping because System 2 builds fallen logs next and will hit the same wall.
   *
   * The audit called these the worst objects in the build — a pale ribbed cylinder
   * lying on the duff, reading as vacuum hose. Taper, knuckles, splintered ends, 11
   * radial segments instead of 6 and a deeper sink all went in and the silhouette
   * did improve, but the *value* would not move. Two difference tests settled it: a
   * 10x cut to the wood albedo, and dropping the surface's AO floor from 0.60 to
   * 0.38, each left the piece visually unchanged at 6x magnification while both
   * demonstrably moved everything else sharing those constants. Something outside
   * the wood surface is setting these pieces' brightness, and a lit-from-nowhere
   * object at 1.4x the value of the floor it lies on cannot be corrected by
   * adjusting its colour.
   *
   * A stick is also the one prop here with no anchoring cue: a root enters the bank
   * at both ends and a stone has soil piled against it, so both are held by
   * geometry the height function already builds, while a stick is only ever resting
   * on the surface and depends entirely on shading to sit down. Shipping none is
   * better than shipping these, and deadwood is System 2's to author properly with
   * bark, forks and real contact rather than something to patch here at the end of
   * System 1. `sticks()` is left in place, unwired, because the placement
   * distribution is sound and it is only the surface that failed. */
  const nSticks = 0;

  const stoneAcc = new Accum();
  const nStones = stones(stoneAcc, rng);

  const tris = (wood.idx.length + stoneAcc.idx.length) / 3;
  return {
    wood: wood.build(),
    stones: stoneAcc.build(),
    counts: { roots: nRoots, sticks: nSticks, stones: nStones, tris },
  };
}
