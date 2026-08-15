/* The ground cover: what grows on the floor and what lies against everything
 * standing in it.
 *
 * ── The one shape requirement ─────────────────────────────────────────────
 *
 * The brief states it exactly: dense near the ground but open above waist
 * height — you can see through the trunks but not through the base. That is a
 * statement about a *height distribution* and it is the constraint that sets
 * every number in this file. Nothing here is allowed above about 1.0 m, and
 * almost everything is under 0.7 m; the band from waist to eye is deliberately
 * empty, so the long sightlines between boles survive while the floor plane
 * stops being visible as a plane. A single salal cane at 1.4 m would undo it.
 *
 * The near ground before this system existed was measurably a plane: an
 * unbroken duff surface running from the camera's feet to the fog with nothing
 * on it but a few dark branches, and every trunk meeting it along a hard line.
 * Three of the critic's findings were classified as masked-by-undergrowth and
 * are therefore this file's to actually cover — the trunk/ground line with no
 * litter drift and no moss collar, the root plates reading as flat polygons,
 * and the near ground being dead neutral at (57, 56, 55).
 *
 * ── Three mechanisms, and they do different jobs ──────────────────────────
 *
 *   Plants        instanced, tile-bucketed, hi/lo per tile. Sword fern, salal,
 *                 deer fern, Oregon grape. These carry the silhouette.
 *   Ground mats   merged per tile, conformed to `groundHeight` at build time.
 *                 Moss cushions and needle drift, laid flat or banked up
 *                 against a bole. These carry the contact.
 *   Mushrooms     crossed cards, in the merged buffer with the mats.
 *
 * The mats cannot be instanced and the plants should not be merged, and both
 * halves of that are load-bearing. A mat has to follow the exact height field
 * across its own width or it lifts off the floor at one corner — which is the
 * defect it exists to fix, arriving one level up. A plant is a rosette a metre
 * across of which there are hundreds, so merging it would cost fifty times the
 * memory to buy a per-vertex placement nothing can see.
 *
 * ── Registration ──────────────────────────────────────────────────────────
 *
 * Everything is placed from `groundHeight(x, z)` at build time and nothing is
 * baked against a snapshot of the mesh, because the ground mesh is a *graded*
 * sampling of that function — 6 cm columns near the trail, up to 3 m at the
 * world edge — so the rendered surface departs from the analytic one by up to
 * a centimetre near the trail and by rather more out in the wood. Two
 * defences, and they are the same two `forest.ts` uses for stems:
 *
 *   every plant is sunk `SINK` below its own ground sample, so the join is
 *   under the surface wherever the mesh happens to be;
 *   every plant carries a small skirt of litter cards lying flat at its foot,
 *   which is what a real crown has anyway and which covers the join in either
 *   direction.
 *
 * ── Wind ──────────────────────────────────────────────────────────────────
 *
 * `aFlex` rides the geometry and the displacement happens in the vertex
 * shader; see `Undergrowth.tsx`. The amplitude is deliberately tiny. The brief
 * asks for still air with drifting needles, and a fern twitching in dead calm
 * fog is worse than a static one — the wind here exists only so that the frame
 * is not provably a photograph of a diorama.
 */
import * as THREE from 'three';
import { groundHeight, groundNormal, trailShape } from './ground';
import { trail } from './trail';
import { DIMS } from './dims';
import { Noise2D, Rng, clamp, smoothstep } from './noise';
import { standSpecs, type TreeSpec } from './forest';
import { CELL, cellUv } from '@/scene/plantMaterials';

/* Tile edge for the draw-call grid.
 *
 * 18 m against a 26 m cull leaves five or six tiles alive and the frustum
 * rejects the ones behind the walker. Smaller tiles cull tighter and cost a
 * draw call per species per tile to do it, and this system already multiplies
 * the scene's call count by more than any other — the balance is different
 * from `forest.ts`'s because there are three species here and one there. */
const TILE = 18;

/* How far out anything is built at all.
 *
 * The fog reaches 2% contrast at 36 m, but undergrowth is not a trunk: it is
 * 60 cm tall, so its whole silhouette sits in the densest metre of the layer
 * and it is gone much earlier. Measured off the base captures, a dark object
 * at 24 m is already within nine display levels of the air behind it, and the
 * ground mesh's own texture is carrying that distance perfectly well. Past
 * this the plants are memory and vertex work spent on a uniform grey field. */
const BUILD_RADIUS = 27;

/* Sunk below the ground sample. See the header — this is a defence against the
 * mesh's grading, not an aesthetic choice, and 3 cm is the interpolation error
 * of a 22 cm row against the duff term's shortest band. */
const SINK = 0.030;

/* Lift for anything lying flat on the floor.
 *
 * Positive, where the plants are sunk, and for the opposite reason: a mat is a
 * *surface* and if any part of it falls below the rendered ground it is not
 * partly buried, it is punched full of holes. A real moss mat stands two to
 * five centimetres proud of the duff it grows on, so this is also just the
 * thickness of the thing. */
const MAT_LIFT = 0.028;

const veg = new Noise2D(0x5eed4);

/* Patchiness, at three scales.
 *
 * Two was not enough and the reason is arithmetic rather than taste: the
 * product of two unit fields still has a recognisable mean everywhere, so the
 * floor comes out as an even sprinkle with soft density variation — which is
 * the jittered grid the clumping was supposed to hide. A third octave makes
 * the product properly heavy-tailed, so most of the floor sits well below the
 * mean and a small fraction saturates. That is what gives thickets you cannot
 * see the ground through, with open shaded floor between them, and it is the
 * whole difference between undergrowth and a lawn.
 *
 * The three periods are 17, 6.3 and 2.4 m and they are deliberately
 * incommensurate: a Worley field or a set of harmonically related scales puts
 * exactly one feature per cell and reads as a lattice.
 */
function patch(x: number, z: number, seed: number): number {
  const a = veg.fbm(x / 17.0 + seed, z / 17.0 - seed, 2) * 0.5 + 0.5;
  const b = veg.fbm(x / 6.3 - seed * 2.1, z / 6.3 + seed, 2) * 0.5 + 0.5;
  const c = veg.fbm(x / 2.4 + seed * 3.7, z / 2.4 + seed * 1.3, 2) * 0.5 + 0.5;
  return a * (0.28 + 0.72 * b) * (0.55 + 0.45 * c);
}

/* ── The mesh accumulator ─────────────────────────────────────────────────
 *
 * Plain arrays rather than BufferGeometryUtils, for the reason `trailProps.ts`
 * records: merging N small geometries allocates N of everything and then
 * copies, and this runs on the main thread under the load veil.
 *
 * Six attributes. `color` is per-vertex rather than per-instance because the
 * merged ground buffer has no instances to colour — and having it on both
 * means the material needs only one path. On the instanced plants three
 * multiplies `instanceColor` into the same varying, so a plant gets both a
 * per-vertex tone from the builder and a per-plant tone from placement.
 */
class Build {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly uv: number[] = [];
  readonly col: number[] = [];
  readonly flex: number[] = [];
  readonly occ: number[] = [];
  readonly idx: number[] = [];

  get count(): number { return this.pos.length / 3; }

  vert(p: THREE.Vector3, n: THREE.Vector3, u: number, v: number,
       tone: number, flex: number, occ: number): number {
    const i = this.count;
    this.pos.push(p.x, p.y, p.z);
    this.nrm.push(n.x, n.y, n.z);
    this.uv.push(u, v);
    this.col.push(tone, tone, tone);
    this.flex.push(flex);
    this.occ.push(occ);
    return i;
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d);
  }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aFlex', new THREE.Float32BufferAttribute(this.flex, 1));
    g.setAttribute('aOcc', new THREE.Float32BufferAttribute(this.occ, 1));
    /* `aOpen` is an *instanced* attribute on the plants and a plain per-vertex
     * one here, and it has to exist in both places even though the mats have
     * nothing to say through it. One material means one program, and an
     * attribute a program declares but a geometry does not supply reads as the
     * default vertex attribute — (0, 0, 0, 1) — so leaving it off the merged
     * buffer would multiply every moss mat in the wood by zero openness and
     * render the entire collar system black. The mats carry their own
     * exposure in `aOcc`, so this is a constant. */
    const open = new Float32Array(this.count * 2);
    open.fill(1);
    g.setAttribute('aOpen', new THREE.Float32BufferAttribute(open, 2));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

/* ── Cards ───────────────────────────────────────────────────────────────── */

const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _n = new THREE.Vector3();
const _t = new THREE.Vector3();
const _nn = new THREE.Vector3();
const _q = new THREE.Vector3();

type CardOpts = {
  cell: number;
  /** Along the growth axis, metres. */
  len: number;
  /** Across, metres. The artwork fills about 92% of it; the rest is the mip
   * margin the atlas leaves so a distant frond does not bleed into the cell
   * next to it. */
  wid: number;
  /** Total arc swept from the base direction to the tip, radians. */
  bend: number;
  /** A second, non-monotone bend so the arc is not a machined curve. */
  sag?: number;
  phase?: number;
  /** Rotation of the blade about its own growth axis, at the tip. */
  twist?: number;
  /** Cross-section dish. Positive cups the blade upward. */
  cup?: number;
  nv: number;
  nu: number;
  /** Wind flex at the base and at the tip. */
  flex0?: number;
  flex1?: number;
  /** Occlusion at the base and at the tip. */
  occ0: number;
  occ1: number;
  tone?: number;
};

/**
 * One blade, frond or stem, as a curved and cupped strip cut out of an atlas
 * cell.
 *
 * The arc is sampled rather than being a single rotation because the thing
 * that makes a fern read as a fern is that its fronds *arch* — they leave the
 * crown at fifty degrees and come over to horizontal at the tip — and a
 * straight card at an angle is a spike. The angle law is a power rather than a
 * circle: a frond is stiff for its first third and gives way after that, and a
 * constant-curvature arc is instantly a machined bend.
 *
 * `m` places the card. Occlusion is computed after the transform, off the
 * vertex's height above the plant's own origin, because how much sky a leaf
 * sees in a closed stand is very largely a question of how far off the floor
 * it is — and that is not knowable in the card's own frame.
 */
function card(b: Build, m: THREE.Matrix4, o: CardOpts): void {
  const {
    cell, len, wid, bend, sag = 0, phase = 0, twist = 0, cup = 0,
    nv, nu, flex0 = 0.1, flex1 = 1, occ0, occ1, tone = 1,
  } = o;
  const uv = cellUv(cell);
  const base = b.count;

  /* The rib. Angles measured from the card's own +Z, swinging towards -Y, with
   * the sag term zeroed at s = 0 so adding sag never rotates the whole leaf
   * out of the direction the caller's matrix asked for. */
  const ang = (s: number) =>
    -bend * Math.pow(s, 1.25) + sag * (Math.sin(s * 5.1 + phase) - Math.sin(phase));

  const C: THREE.Vector3[] = [];
  const F: THREE.Vector3[] = [];
  let py = 0, pz = 0;
  for (let i = 0; i <= nv; i++) {
    const th = ang(i / nv);
    C.push(new THREE.Vector3(0, py, pz));
    F.push(new THREE.Vector3(0, Math.sin(th), Math.cos(th)));
    if (i < nv) {
      const th2 = ang((i + 0.5) / nv);
      const d = len / nv;
      py += Math.sin(th2) * d;
      pz += Math.cos(th2) * d;
    }
  }

  const hw = wid * 0.5;
  for (let i = 0; i <= nv; i++) {
    const s = i / nv;
    const f = F[i];
    /* The twist is a power so most of it lands near the tip. A blade's base is
     * held rigid by its petiole and only the far half of it rolls over, and a
     * linear twist puts a visible spiral in a part of the leaf that cannot
     * bend. */
    const tw = twist * Math.pow(s, 1.3);
    _s.set(Math.cos(tw), Math.sin(tw) * f.z, -Math.sin(tw) * f.y);
    _n.copy(f).cross(_s).normalize();

    for (let j = 0; j <= nu; j++) {
      const q = nu === 0 ? 0 : (j / nu) * 2 - 1;
      /* Dish, relaxing towards the tip. Holding the cup constant puts the same
       * V-section at the base and at the tip, so the crease runs the whole
       * length at one angle — which is what a sheet of card folded once looks
       * like, and nothing that grew looks like that. */
      const k = cup * (1 - 0.62 * s);
      const cs = k * q * q;
      const dcs = 2 * k * q;
      _p.copy(C[i]).addScaledVector(_s, q * hw).addScaledVector(_n, cs * hw);
      _t.copy(_s).addScaledVector(_n, dcs).normalize();
      _nn.copy(f).cross(_t).normalize();
      _p.applyMatrix4(m);
      _nn.transformDirection(m);

      /* Occlusion. Two independent statements folded together: how far out
       * along the blade this vertex is, and how far off the floor it is.
       *
       * The second one is the important one and it is the reason this is
       * computed after the transform. Under a fog dome a surface's value is
       * set almost entirely by how much of the dome it can see, and a leaf
       * five centimetres above the duff inside a metre-wide rosette sees very
       * little of it — perhaps a tenth. Routing this into occlusion rather
       * than into albedo is not interchangeable: `treeMaterials.ts` records
       * the measurement, which is that a dielectric under this dome returns
       * about 4% of the sky as specular whatever its albedo, so a leaf
       * darkened only in diffuse has a floor it cannot get below. */
      const lift = clamp(_p.y / 0.62, 0, 1);
      const occ = (occ0 + (occ1 - occ0) * s) * (0.42 + 0.58 * lift);

      b.vert(_p, _nn, uv.u0 + (j / Math.max(nu, 1)) * uv.span, uv.v0 + s * uv.span,
             tone, flex0 + (flex1 - flex0) * s, occ);
    }
  }

  /* Wound so the face normal agrees with the vertex normal.
   *
   * Rows advance along the growth axis and columns across it, so the naive
   * a, a+1, a+row+1 ordering crosses to point *away* from the side the
   * analytic normal is on. On a double-sided material that does not render
   * black — three flips the interpolated normal by `gl_FrontFacing` — it does
   * something worse and harder to find: every leaf is shaded as though it were
   * facing the other way, so the whole undergrowth's shading is inverted
   * against its own geometry and no amount of adjusting the occlusion helps. */
  const row = nu + 1;
  for (let i = 0; i < nv; i++) {
    for (let j = 0; j < nu; j++) {
      const a = base + i * row + j;
      b.quad(a, a + row, a + row + 1, a + 1);
    }
  }
}

/* ── Plants ──────────────────────────────────────────────────────────────── */

const _e = new THREE.Euler();
const _m = new THREE.Matrix4();

/** Position and orient one organ growing out of a crown at the origin. */
function organ(yaw: number, pitch: number, roll: number,
               x: number, y: number, z: number): THREE.Matrix4 {
  _e.set(-pitch, yaw, roll, 'YXZ');
  _m.makeRotationFromEuler(_e);
  _m.setPosition(x, y, z);
  return _m;
}

/* The litter collar every plant wears.
 *
 * Three flat cards at the foot of the crown, and they do two jobs at once. A
 * real fern crown sits in a heap of its own shed material — the reference
 * photographs never show a clean junction between a plant and the floor — and
 * the same cards are what covers the join if the ground mesh's graded sampling
 * has left the analytic height a centimetre out at this spot. Without them a
 * plant either floats or is cut off by the floor, and both are unmistakable.
 */
function footSkirt(b: Build, rng: Rng, r: number, lod: number, tone: number): void {
  const n = lod === 0 ? 3 : 1;
  for (let i = 0; i < n; i++) {
    const yaw = rng.range(0, Math.PI * 2);
    const rr = r * rng.range(0.7, 1.35);
    /* Laid flat. `organ`'s pitch is an elevation off horizontal, so nearly
     * zero is the floor and a quarter turn would stand the card on end. */
    const m = organ(yaw, 0.04, 0,
                    Math.sin(yaw) * rr * 0.20, 0.012 + i * 0.004, Math.cos(yaw) * rr * 0.20);
    card(b, m, {
      cell: rng.chance(0.55) ? CELL.litter : CELL.mossA,
      len: rr, wid: rr * rng.range(0.8, 1.2),
      bend: 0.06, nv: 1, nu: lod === 0 ? 2 : 1,
      flex0: 0, flex1: 0,
      /* Nearly buried. This is duff level, it is inside a rosette, and it is
       * the darkest thing the plant carries. */
      occ0: 0.30, occ1: 0.46, tone: tone * 0.85,
    });
  }
}

/**
 * Sword fern.
 *
 * The species this system is built around, and the plant a walker on this
 * trail is closest to for most of the walk. Measured from the references: a
 * crown of 75-100 fronds 50-180 cm long, arching outward from a short vertical
 * rhizome, with the withered fronds of previous years still attached and lying
 * flat on the litter.
 *
 * Sixteen fronds rather than eighty. The count is the one botanical fact this
 * cannot afford, and the compensation is that the fronds are wide, overlapping
 * and unequal — a crown of sixteen at varied length and pitch closes its own
 * outline, which is what the eye is reading, where sixteen evenly spaced ones
 * would read as a parasol. The dead skirt matters more than another four live
 * fronds would: it is the only warm colour in the undergrowth and every real
 * crown has one.
 */
function swordFern(rng: Rng, lod: number, variant: number): THREE.BufferGeometry {
  const b = new Build();
  const scale = 1;

  /* One crown-wide lean. Real ferns lean towards their light and the whole
   * rosette is asymmetric because of it; jittering each frond independently
   * around a symmetric mean still averages back to a parasol. */
  const leanA = rng.range(0, Math.PI * 2);
  const leanK = 0.28 + rng.f() * 0.52;

  const live = lod === 0 ? 17 + (variant % 3) : 10;
  for (let i = 0; i < live; i++) {
    const yaw = (i / live) * Math.PI * 2 + rng.range(-0.9, 0.9);
    const lw = Math.cos(yaw - leanA);
    /* Pitch above horizontal at the base. The crown's outline is set by this
     * far more than by the frond length: at 20 degrees it is a starfish lying
     * on the floor and at 70 it is a shuttlecock. Sword fern is a shuttlecock
     * that has relaxed. */
    const pitch = 0.82 + rng.f() * 0.52 - leanK * 0.30 * lw;
    const len = (0.50 + rng.f() * 0.46) * scale * (1 + leanK * 0.22 * lw);
    card(b, organ(yaw, pitch, rng.range(-0.28, 0.28), 0, 0.035 + rng.f() * 0.05, 0), {
      /* Two cuts of the same species, alternating on a hash rather than in
       * turn. Fifteen fronds of one outline in a rosette a metre across at two
       * metres from the eye is a repeat the viewer finds immediately. */
      cell: rng.chance(0.5) ? CELL.fernA : CELL.fernB,
      len, wid: len * 0.225,
      /* Arch. Combined with the base pitch this brings the tip to somewhere
       * between level and slightly drooping, which is the sword fern outline —
       * a fountain rather than a fan. */
      bend: 1.00 + rng.f() * 0.80,
      sag: rng.range(-0.35, 0.35), phase: rng.range(0, 6.283),
      twist: rng.range(-0.55, 0.55),
      /* Cupped along the rachis, which is what gives a frond two highlights
       * instead of one and is the only cross-sectional shape it has. */
      cup: rng.range(0.18, 0.45),
      nv: lod === 0 ? 5 : 3, nu: lod === 0 ? 2 : 1,
      flex0: 0.06, flex1: 1,
      /* The inner third of every frond is looking at the rest of its own
       * crown; the tips are out in the open. */
      occ0: 0.30, occ1: 0.80,
      tone: 0.86 + rng.f() * 0.28,
    });
  }

  /* Last year's fronds, collapsed. They lie almost flat, they are brown, and
   * they are what makes the base of the plant opaque — which is the brief's
   * requirement, not a detail. */
  const dead = lod === 0 ? 4 + (variant % 2) : 2;
  for (let i = 0; i < dead; i++) {
    const yaw = rng.range(0, Math.PI * 2);
    const len = (0.34 + rng.f() * 0.36) * scale;
    card(b, organ(yaw, rng.range(0.10, 0.42), rng.range(-0.5, 0.5), 0, 0.03, 0), {
      cell: CELL.fernDead,
      len, wid: len * 0.24,
      bend: 1.5 + rng.f() * 0.9,
      sag: rng.range(-0.5, 0.5), phase: rng.range(0, 6.283),
      twist: rng.range(-0.9, 0.9), cup: rng.range(-0.3, 0.3),
      nv: lod === 0 ? 3 : 2, nu: lod === 0 ? 2 : 1,
      flex0: 0.03, flex1: 0.35,
      occ0: 0.28, occ1: 0.58,
      tone: 0.80 + rng.f() * 0.34,
    });
  }

  footSkirt(b, rng, 0.34, lod, 1);
  return b.geometry();
}

/**
 * Salal.
 *
 * Thick leathery ovate leaves alternating up reddish arching canes, forming a
 * thicket. It is the second most important plant here and it does a different
 * job from the fern: a fern is a rosette with air through it, and salal is a
 * solid mass of overlapping blades — so this is what actually closes the floor
 * at knee height where the ferns only interrupt it.
 *
 * The canes are drawn. A shrub built as floating foliage with no wood in it is
 * the commonest way undergrowth reads as a texture rather than as a plant, and
 * salal's canes are red and conspicuous between the leaves.
 */
function salal(rng: Rng, lod: number, variant: number): THREE.BufferGeometry {
  const b = new Build();
  const canes = lod === 0 ? 5 + (variant % 2) : 3;
  /* Huckleberry, one bush in four: the same construction with small leaves on
   * long thin canes, which is an airy open shrub rather than a solid one.
   * Cheap variety, and it is the plant that actually grows out of the nurse
   * logs on this floor. */
  const huck = variant >= 2;

  for (let c = 0; c < canes; c++) {
    const yaw = (c / canes) * Math.PI * 2 + rng.range(-0.8, 0.8);
    const pitch = huck ? rng.range(1.05, 1.35) : rng.range(0.72, 1.24);
    const len = (huck ? rng.range(0.46, 0.86) : rng.range(0.40, 0.78));
    /* Arched harder. A salal cane read as a straight rod because the low end
     * of this range was flat enough to project as a line, and a straight rod of
     * uniform diameter in saturated red-brown is the "plastic drinking straw"
     * the review found in the `94.png` undergrowth. Salal arches -- that is the
     * entire habit of the plant -- and nothing in the range below is straight. */
    const bend = huck ? rng.range(0.80, 1.35) : rng.range(1.00, 1.65);
    const roll = rng.range(-0.2, 0.2);
    const mCane = organ(yaw, pitch, roll, 0, 0.02, 0).clone();

    card(b, mCane, {
      cell: CELL.stem,
      len, wid: len * (huck ? 0.036 : 0.058),
      bend, sag: rng.range(-0.2, 0.2), phase: rng.range(0, 6.283),
      nv: lod === 0 ? 3 : 2, nu: 1,
      flex0: 0.04, flex1: 0.9,
      occ0: 0.22, occ1: 0.62,
      tone: 0.85 + rng.f() * 0.3,
    });

    /* Leaves, alternating up the cane and each one turned to face outward and
     * a little upward. A blade whose plane contains the cane is invisible edge
     * on, and a rank of them all in one plane is a louvre. */
    const nLeaf = lod === 0 ? (huck ? 12 : 11) : (huck ? 6 : 5);
    for (let i = 0; i < nLeaf; i++) {
      const s = (i + 0.5 + rng.range(-0.25, 0.25)) / nLeaf;
      /* Where on the cane. Integrating the same angle law the card itself
       * uses is the only way to land a leaf *on* its stem rather than a
       * centimetre off it, and a shrub whose leaves are visibly detached from
       * its wood is worse than one with no wood at all. */
      let ly = 0, lz = 0;
      const steps = 8;
      for (let k = 0; k < steps; k++) {
        const t2 = -bend * Math.pow(((k + 0.5) / steps) * s, 1.25);
        ly += Math.sin(t2) * (len * s / steps);
        lz += Math.cos(t2) * (len * s / steps);
      }
      _q.set(0, ly, lz).applyMatrix4(mCane);
      const side = i % 2 === 0 ? 1 : -1;
      const ll = (huck ? rng.range(0.022, 0.038) : rng.range(0.066, 0.108));
      /* Elevation follows the cane's own at this point, so a leaf near the
       * drooping tip hangs and one at the stiff base stands up. Yaw is thrown
       * out to one side or the other, alternating: a rank of leaves all in the
       * plane of their cane is invisible edge on and reads as a louvre. */
      const elev = pitch - bend * Math.pow(s, 1.25) + rng.range(-0.30, 0.20);
      card(b, organ(yaw + side * rng.range(0.7, 1.35), elev, rng.range(-0.5, 0.5),
                    _q.x, _q.y, _q.z), {
        cell: CELL.salal,
        len: ll, wid: ll * rng.range(0.62, 0.80),
        bend: rng.range(0.25, 0.75),
        sag: rng.range(-0.3, 0.3), phase: rng.range(0, 6.283),
        twist: rng.range(-0.4, 0.4),
        /* Salal blades are strongly keeled along the midrib and reflex at the
         * margin, which is what gives the bush its broken-up highlight instead
         * of a sheet of gloss. */
        cup: rng.range(0.20, 0.48),
        nv: lod === 0 ? 2 : 1, nu: lod === 0 ? 2 : 1,
        flex0: 0.10 + 0.7 * s, flex1: 0.2 + 0.8 * s,
        occ0: 0.40 + 0.34 * s, occ1: 0.62 + 0.36 * s,
        tone: 0.82 + rng.f() * 0.34,
      });
    }
  }

  footSkirt(b, rng, 0.26, lod, 1);
  return b.geometry();
}

/**
 * The low storey: deer fern and Oregon grape.
 *
 * Both are knee height or under and both exist for silhouette contrast rather
 * than for coverage — a floor with one fern outline on it is a floor with one
 * plant on it however many copies are placed. Deer fern's sterile fronds are
 * broad blunt straps lying almost flat; Oregon grape is a stiff upright pinnate
 * leaf with widely separated holly leaflets and daylight between them.
 */
function lowStorey(rng: Rng, lod: number, variant: number): THREE.BufferGeometry {
  const b = new Build();
  const deer = variant % 2 === 0;

  if (deer) {
    const n = lod === 0 ? 8 : 5;
    for (let i = 0; i < n; i++) {
      const yaw = (i / n) * Math.PI * 2 + rng.range(-0.7, 0.7);
      /* Deer fern's sterile rosette lies nearly flat — it is a plate on the
       * duff, which is exactly the outline the sword ferns are not. */
      const pitch = rng.range(0.16, 0.52);
      const len = rng.range(0.24, 0.46);
      card(b, organ(yaw, pitch, rng.range(-0.3, 0.3), 0, 0.02, 0), {
        cell: CELL.deerFern,
        len, wid: len * 0.20,
        bend: rng.range(0.55, 1.15),
        sag: rng.range(-0.3, 0.3), phase: rng.range(0, 6.283),
        twist: rng.range(-0.4, 0.4), cup: rng.range(0.05, 0.28),
        nv: lod === 0 ? 4 : 2, nu: 1,
        flex0: 0.06, flex1: 0.9,
        occ0: 0.26, occ1: 0.66,
        tone: 0.86 + rng.f() * 0.26,
      });
    }
    footSkirt(b, rng, 0.20, lod, 1);
  } else {
    const n = lod === 0 ? 5 : 3;
    for (let i = 0; i < n; i++) {
      const yaw = (i / n) * Math.PI * 2 + rng.range(-0.8, 0.8);
      /* Upright and stiff. Mahonia holds its leaves nearly vertical, which is
       * why it reads as a different plant from four metres away even though it
       * is also a pinnate frond. */
      const pitch = rng.range(1.02, 1.38);
      const len = rng.range(0.28, 0.52);
      card(b, organ(yaw, pitch, rng.range(-0.25, 0.25), 0, 0.02, 0), {
        cell: CELL.mahonia,
        len, wid: len * 0.36,
        bend: rng.range(0.30, 0.75),
        sag: rng.range(-0.2, 0.2), phase: rng.range(0, 6.283),
        twist: rng.range(-0.6, 0.6), cup: rng.range(0.05, 0.2),
        nv: lod === 0 ? 4 : 2, nu: lod === 0 ? 2 : 1,
        flex0: 0.05, flex1: 0.7,
        occ0: 0.30, occ1: 0.72,
        tone: 0.84 + rng.f() * 0.30,
      });
    }
    footSkirt(b, rng, 0.18, lod, 1);
  }

  return b.geometry();
}

/* ── Ground mats ─────────────────────────────────────────────────────────── */

/**
 * One patch of moss or litter, lying on the floor and following it.
 *
 * A 3x3 grid rather than a quad, and the extra eight triangles are the whole
 * point: the floor has centimetre-scale duff roughness in it and a flat quad
 * 60 cm across bridges that, so one corner buries itself and the opposite one
 * lifts clear with daylight under it. Sampling the height field at every
 * vertex is the only thing that makes a mat read as *on* the ground.
 *
 * `rise` banks the mat's inner edge up, which is how it becomes a collar
 * against a bole rather than a doormat around one.
 */
function mat(b: Build, cx: number, cz: number, size: number, yaw: number,
             cell: number, tone: number, occIn: number, occOut: number,
             rise = 0, riseDir = 0): void {
  const uv = cellUv(cell);
  const base = b.count;
  const N = 2;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const rc = Math.cos(riseDir), rs = Math.sin(riseDir);

  for (let i = 0; i <= N; i++) {
    for (let j = 0; j <= N; j++) {
      const u = j / N, v = i / N;
      const lx = (u - 0.5) * size, lz = (v - 0.5) * size;
      const x = cx + lx * c - lz * s;
      const z = cz + lx * s + lz * c;
      /* The bank. Keyed on how far this vertex is towards `riseDir`, so the
       * mat climbs on one side only — which is what a drift banked against a
       * trunk by a century of rain running off it actually looks like. A
       * symmetric rise is a volcano. */
      const towards = (lx * c - lz * s) * rc + (lx * s + lz * c) * rs;
      const bank = rise * clamp(0.5 - towards / Math.max(size, 1e-3), 0, 1) ** 1.6;
      const g = groundHeight(x, z);
      _p.set(x, g + MAT_LIFT + bank, z);
      const gn = groundNormal(x, z);
      _n.set(gn[0], gn[1], gn[2]);
      /* Tilted with the bank, so the collar catches the dome differently from
       * the flat mat beside it and the two do not read as one decal. */
      if (rise > 0.001) {
        _n.x -= rc * rise * 2.4;
        _n.z -= rs * rise * 2.4;
        _n.normalize();
      }
      const occ = occIn + (occOut - occIn) * clamp(0.5 + towards / Math.max(size, 1e-3), 0, 1);
      b.vert(_p, _n, uv.u0 + u * uv.span, uv.v0 + v * uv.span, tone, 0, occ);
    }
  }

  const row = N + 1;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const a = base + i * row + j;
      b.quad(a, a + row, a + row + 1, a + 1);
    }
  }
}

/**
 * A troop of mushrooms.
 *
 * Two crossed cards, four triangles, and the whole cluster is in the artwork.
 * A 3 cm cap does not repay geometry: at the 1.6 m eye height and 52 degree
 * lens of this walk it is under twenty pixels across from a metre away, and
 * the parallax error of a crossed pair at that size is well under one.
 *
 * These are the palest objects in the frame and they are worth their area
 * several times over for exactly that reason — everything else down here lives
 * between 0.02 and 0.08 linear, so a buff cap is the only small bright thing
 * the eye can find on the whole floor.
 */
function shrooms(b: Build, cx: number, cz: number, size: number, rng: Rng): void {
  const uv = cellUv(CELL.shroom);
  const g = groundHeight(cx, cz);
  const yaw0 = rng.range(0, Math.PI * 2);
  for (let k = 0; k < 2; k++) {
    const yaw = yaw0 + k * Math.PI * 0.5;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const base = b.count;
    for (let i = 0; i <= 1; i++) {
      for (let j = 0; j <= 1; j++) {
        const lx = (j - 0.5) * size;
        /* Sunk a centimetre, because the artwork's ground line is at the
         * bottom of the cell and a stipe that starts exactly at the surface
         * looks stuck on rather than growing out. */
        _p.set(cx + lx * c, g + i * size - 0.012, cz + lx * s);
        _n.set(-s, 0.35, c).normalize();
        b.vert(_p, _n, uv.u0 + j * uv.span, uv.v0 + i * uv.span,
               0.88 + rng.f() * 0.24, 0, i === 0 ? 0.24 : 0.62);
      }
    }
    b.quad(base, base + 1, base + 3, base + 2);
  }
}

/* ── Placement ───────────────────────────────────────────────────────────── */

export type Instance = {
  m: THREE.Matrix4;
  /** Per-plant tone, into instanceColor. */
  tone: number;
  /** Per-plant openness, into an instanced attribute and thence occlusion. */
  open: number;
};

export type UgTile = {
  cx: number; cz: number;
  /** Key is `${species}:${variant}`. */
  groups: Map<string, Instance[]>;
  /** Merged mats, collars and mushrooms, conformed to the floor. */
  ground: THREE.BufferGeometry | null;
};

export type Species = 'fern' | 'bush' | 'low';

export type Undergrowth = {
  tiles: UgTile[];
  /** `variants[species][v] = { hi, lo }`. */
  variants: Record<Species, { hi: THREE.BufferGeometry; lo: THREE.BufferGeometry }[]>;
  counts: {
    fern: number; bush: number; low: number;
    mats: number; collars: number; shrooms: number;
    plantTris: number; matTris: number;
    /** Mean openness over the placed plants, for the attribute audit. */
    openMean: number;
  };
};

const VARIANTS: Record<Species, number> = { fern: 3, bush: 3, low: 2 };

/* Stem exclusion.
 *
 * A fern growing out of the side of a Douglas-fir is the one placement error
 * fog cannot hide, because it happens at eye level in the near field. The
 * radius has to clear the *flared* bole and the flare multiplier is a species
 * constant inside `forest.ts` that this file cannot see and must not copy — a
 * hand-copied constant that quietly stopped matching would put every fern in
 * the wood a few centimetres inside a trunk.
 *
 * It was 2.6, and the claim that "the ground mats below deliberately reach
 * inside it" was not true of the shipped code -- every population, mats
 * included, goes through the one `clearance(...) < 0` gate in `scatter`, so
 * nothing reached inside anything. What 2.6 actually bought was a bare disc of
 * base terrain 2.3 m in radius around a veteran, and the pre-release review
 * found it as the worst defect in the best frame in the project: "a large flat
 * khaki-tan plane with visible polygon facet edges, zero needles, zero leaves,
 * zero stones, zero moss, and a hard straight boundary against the mossy
 * litter", at the foot of the hero bole in `78.png`. It was hidden while the
 * scene was two stops dark and it is now the brightest surface in the near
 * field.
 *
 * 1.7 is the flare and nothing else. The largest `flare` in the table is 0.55,
 * so a flared bole is 1.55 r0 at the soil line and 1.7 leaves a 15% margin --
 * the margin this number was supposed to have before it was rounded up twice.
 * It cuts the bare area by 57% and lets the litter and the moss mats close on
 * the bark, which is where they grow.
 */
const STEM_CLEAR = 1.7;

class StemGrid {
  private readonly g = new Map<number, TreeSpec[]>();
  private static readonly CELL_M = 4;

  constructor(readonly trees: TreeSpec[]) {
    for (const t of trees) {
      const k = this.key(t.x, t.z);
      let l = this.g.get(k);
      if (!l) this.g.set(k, (l = []));
      l.push(t);
    }
  }

  private key(x: number, z: number): number {
    return (Math.floor(x / StemGrid.CELL_M) + 512) * 1024
      + Math.floor(z / StemGrid.CELL_M) + 512;
  }

  /** Distance to the nearest bole surface, negative inside the clear radius. */
  clearance(x: number, z: number): number {
    let best = 1e6;
    const cx = Math.floor(x / StemGrid.CELL_M), cz = Math.floor(z / StemGrid.CELL_M);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const l = this.g.get((cx + dx + 512) * 1024 + cz + dz + 512);
        if (!l) continue;
        for (const t of l) {
          const d = Math.hypot(x - t.x, z - t.z) - t.r0 * STEM_CLEAR;
          if (d < best) best = d;
        }
      }
    }
    return best;
  }
}

/**
 * How much sky the floor at this point can see, roughly, as a multiplier on
 * everything's occlusion.
 *
 * Not a ray cast. What it is capturing is that the trail is the one continuous
 * gap in the canopy — the same fact `fog.ts` reads for its in-scattering — so
 * the vegetation along the margin is genuinely better lit than the vegetation
 * ten metres into the stand, and it is also why the ferns crowd there. A plant
 * standing in a closed stand is at the bottom of a well and should render
 * close to black.
 */
function openness(dist: number, x: number, z: number): number {
  const corridor = 1 - smoothstep(0.9, 5.5, dist);
  const gap = smoothstep(0.62, 0.90, veg.fbm(x * 0.085 + 11, z * 0.085 - 7, 2) * 0.5 + 0.5);
  return clamp(0.42 + 0.42 * corridor + 0.30 * gap, 0, 1);
}

/**
 * Scan a jittered grid over the corridor and decide what grows where.
 *
 * `accept` returns a probability rather than a boolean, so density varies
 * continuously with distance from the trail — a hard cutoff produces a band of
 * vegetation with a visible edge, which on a 3 ft trail would be a hedge.
 */
type Cand = {
  x: number; z: number; dist: number; side: number; along: number;
  clear: number; patchV: number; open: number; rng: Rng;
};

function scatter(
  spacing: number,
  seed: number,
  accept: (c: Cand) => number,
  emit: (c: Cand) => void,
  stems: StemGrid,
): void {
  const rng = new Rng(seed);
  const tr = trail();
  for (let z = DIMS.zMax; z > DIMS.zMin; z -= spacing) {
    for (let x = -DIMS.worldHalf; x < DIMS.worldHalf; x += spacing) {
      const px = x + rng.range(-0.85, 0.85) * spacing;
      const pz = z + rng.range(-0.85, 0.85) * spacing;
      /* The distance test first, before the height, clearance and noise
       * lookups. Almost every candidate on a 0.95 m lattice over an 88 x 84 m
       * world is rejected for being too far from the trail, and testing that
       * first is the difference between a build that takes half a second and
       * one that takes six. */
      const t = tr.at(px, pz);
      if (t.dist > BUILD_RADIUS) continue;
      const clear = stems.clearance(px, pz);
      if (clear < 0) continue;
      const patchV = patch(px, pz, seed * 0.017);
      const open = openness(t.dist, px, pz);
      const ctx = {
        x: px, z: pz, dist: t.dist, side: t.side,
        along: t.t * DIMS.trailLength, clear, patchV, open, rng,
      };
      /* Renormalised, and the gain matters: squaring a field whose mean is
       * about a third drops the mean of the product to a sixth, so applying
       * the patch field naively removes five sixths of the vegetation instead
       * of redistributing it. The gain puts the expectation back above one,
       * and probabilities over one simply always accept — which is what lets
       * the dense knots saturate into ground you cannot see through. */
      const p = accept(ctx) * (0.10 + 9.4 * patchV * patchV);
      if (p <= 0 || rng.f() > p) continue;
      emit(ctx);
    }
  }
}

/**
 * Density along the trail margin.
 *
 * The brief asks for ferns growing along the trail edges and the ecology
 * agrees with it for a reason worth stating: the trail is the only permanent
 * break in the canopy, so it is a light well, and the understory closes in on
 * it from both sides. Nothing at all on the tread — boots keep it bare — a
 * hard peak in the first two metres of the margin, and a long tail out into
 * the stand where the floor is genuinely more open.
 */
function marginBoost(dist: number): number {
  const off = smoothstep(DIMS.trailEdge, DIMS.trailEdge + 0.42, dist);
  const near = Math.exp(-(((dist - 1.7) / 2.6) ** 2));
  return off * (0.34 + 0.90 * near);
}

export function buildUndergrowth(): Undergrowth {
  const trees = standSpecs();
  const stems = new StemGrid(trees);
  const tr = trail();

  const variants: Undergrowth['variants'] = { fern: [], bush: [], low: [] };
  const vrng = new Rng(0x9e441);
  const build: Record<Species, (r: Rng, lod: number, v: number) => THREE.BufferGeometry> = {
    fern: swordFern, bush: salal, low: lowStorey,
  };
  let plantTris = 0;
  for (const sp of ['fern', 'bush', 'low'] as Species[]) {
    for (let v = 0; v < VARIANTS[sp]; v++) {
      /* The two levels are the same seed run twice rather than one build
       * decimated. Every builder is written so the detail flag reaches only
       * the segment counts and the organ counts, so the coarse pass draws the
       * same random numbers in the same order and produces a recognisably
       * identical plant — which is what stops a tile changing shape as it
       * crosses the switch radius. */
      const seed = 0x1000 + v * 7919 + sp.length * 131;
      const hi = build[sp](new Rng(seed), 0, v);
      const lo = build[sp](new Rng(seed), 1, v);
      plantTris += hi.index!.count / 3;
      variants[sp].push({ hi, lo });
    }
  }

  const tiles = new Map<number, UgTile>();
  const tileAt = (x: number, z: number): UgTile => {
    const ti = Math.floor(x / TILE), tj = Math.floor(z / TILE);
    const k = (ti + 64) * 256 + tj + 64;
    let t = tiles.get(k);
    if (!t) {
      tiles.set(k, t = {
        cx: (ti + 0.5) * TILE, cz: (tj + 0.5) * TILE,
        groups: new Map(), ground: null,
      });
    }
    return t;
  };
  const matBuilds = new Map<UgTile, Build>();
  const matAt = (x: number, z: number): Build => {
    const t = tileAt(x, z);
    let b = matBuilds.get(t);
    if (!b) matBuilds.set(t, b = new Build());
    return b;
  };

  const counts = {
    fern: 0, bush: 0, low: 0, mats: 0, collars: 0, shrooms: 0,
    plantTris: 0, matTris: 0, openMean: 0,
    treadDrop: 0, treadTrim: 0, treadMin: Infinity, sizeLo: Infinity, sizeHi: 0,
  };
  let openSum = 0;

  /* Horizontal reach of each species at unit scale, read off the geometry
   * rather than typed in, because the tread rule below is a statement about
   * where the *tips* land and a hand-copied number that stopped matching the
   * builder would put fronds back on the path silently. */
  const reach: Record<Species, number> = { fern: 0, bush: 0, low: 0 };
  for (const sp of ['fern', 'bush', 'low'] as Species[]) {
    for (const v of variants[sp]) {
      const p = v.hi.getAttribute('position').array as Float32Array;
      for (let i = 0; i < p.length; i += 3) {
        const r = Math.hypot(p[i], p[i + 2]);
        if (r > reach[sp]) reach[sp] = r;
      }
    }
  }

  const place = (sp: Species, c: { x: number; z: number; open: number; rng: Rng;
                                   dist: number; along: number },
                 sizeLo: number, sizeHi: number, tilt: number) => {
    const v = Math.floor(c.rng.f() * VARIANTS[sp]);
    const t = tileAt(c.x, c.z);
    const key = `${sp}:${v}`;
    let list = t.groups.get(key);
    if (!list) t.groups.set(key, (list = []));
    /* Non-uniform scale, independently per axis. A stand of one shape at
     * twelve sizes still reads as one shape, because the eye normalises for
     * scale before it compares outlines; fifteen per cent of independent
     * stretch is invisible as distortion and turns every instance into a squat
     * or a leggy version of its variant, which is another multiplier on the
     * variant count for no draw calls at all. */
    /* Size, and the shape of this distribution is the whole of the critic's
     * "one plant at one size". A single power law over a 3.5:1 range put its
     * interquartile band at 2.5:1 on paper and still delivered a hedge, because
     * the near margin saturates and what the eye compares is the dozen crowns
     * that are *drawn*, not the population they were drawn from. A hedge is
     * what you get when every one of those dozen is near the mean.
     *
     * So the tail is made explicit rather than left to an exponent. One plant
     * in six is a veteran drawn from the top third of the range and the rest
     * come from a steep law over the bottom two thirds, which puts a 2.4 m
     * crown next to three 0.5 m ones — the arrangement the reference
     * photographs show and the reason real sword fern reads as a population
     * with a history rather than as planting.
     *
     * Deliberately not Rng.gauss(): its sigma is a third and its support is
     * bounded, so it cannot produce a tail at all, and it has already silently
     * flattened one distribution in this project.
     */
    const vet = c.rng.f() < 0.17;
    const s0 = vet
      ? sizeLo + (sizeHi - sizeLo) * (0.66 + 0.34 * c.rng.f())
      : sizeLo + (sizeHi - sizeLo) * 0.66 * c.rng.f() ** 1.9;

    /* The tread, and this is a hard geometric rule rather than a density taper.
     *
     * The margin boost already tapered the *probability* to zero on the path,
     * but a probability taper only controls where a plant's origin lands — and
     * a 2 m sword fern whose origin sits 60 cm off the centreline has its
     * crown standing squarely in the boot track. That is what the captures
     * showed at stops 03 and 60: the ground between eight and twenty metres was
     * entirely under crowns, and the converging wedge that makes a trail shot
     * work had no vanishing point left.
     *
     * A worn tread has no vegetation in it whatever; feet kill plants outright,
     * and that is the operational definition of a trail rather than a clearing.
     * What is permitted is overhang, because the margin plants do lean in and
     * the tips of their outermost fronds do cross the edge: the distal third of
     * a frond, no more. Solving that for the origin puts it two thirds of a
     * crown radius outside the tread edge.
     *
     * Enforced by shrinking rather than by rejecting, so the margin keeps every
     * plant the density asked for and simply grades them down into the edge —
     * which is also what the photographs show, because the ones that keep
     * getting clipped never get large. Below the point where shrinking would
     * make a token seedling the candidate is dropped.
     */
    const treadHalf = DIMS.trailHalf * trailShape(c.along).width;
    /* 1.16 covers the independent per-axis stretch applied just below. */
    const fit = 1.5 * (c.dist - treadHalf) / (reach[sp] * 1.16);
    if (fit < sizeLo * 0.90) { counts.treadDrop++; return; }
    const s = Math.min(s0, fit);
    if (s < s0 - 1e-6) counts.treadTrim++;
    /* Published so a future change to the trail width or to a builder's reach
     * cannot put crowns back on the path without the number saying so. A
     * negative here is a crown origin inside the tread. */
    const margin = c.dist - treadHalf;
    if (margin < counts.treadMin) counts.treadMin = margin;
    counts.sizeLo = Math.min(counts.sizeLo, s);
    counts.sizeHi = Math.max(counts.sizeHi, s);
    const k = 0.16;
    const sc = new THREE.Vector3(
      s * (1 + c.rng.range(-k, k)),
      s * (1 + c.rng.range(-k * 1.3, k * 1.3)),
      s * (1 + c.rng.range(-k, k)),
    );
    /* Tilted with the floor, but only partly: a plant grows towards the light,
     * not perpendicular to the soil, so a fern on a hummock splits the
     * difference and a litter mat conforms completely. */
    const gn = groundNormal(c.x, c.z);
    _n.set(gn[0], gn[1], gn[2]).lerp(new THREE.Vector3(0, 1, 0), 1 - tilt).normalize();
    const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), _n);
    quat.multiply(new THREE.Quaternion().setFromEuler(
      new THREE.Euler(c.rng.range(-0.10, 0.10), c.rng.range(0, 6.283), c.rng.range(-0.10, 0.10), 'YXZ'),
    ));
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(c.x, groundHeight(c.x, c.z) - SINK, c.z), quat, sc,
    );
    list.push({ m, tone: 0.80 + c.rng.f() * 0.40, open: c.open });
    openSum++;
    counts.openMean += c.open;
    counts[sp]++;
  };

  /* Sword fern. The densest species and the one that owns the trail margin.
   *
   * The accept rates here were multiplied by roughly two after the first
   * capture, and the measurement that forced it is worth recording because the
   * intuition ran the other way. Sword fern cover in a mesic Doug-fir/hemlock
   * stand is measured at under 30%, so 18% acceptance looked defensible on
   * paper — and the frame came back with the forest floor visible as a
   * continuous plane between every plant, all the way to the fog. Areal cover
   * and *screen* cover are not the same quantity: from 1.6 m up at a shallow
   * angle the floor is foreshortened by a factor of five or more, so 30% of
   * the ground is a small fraction of the pixels, and the brief's requirement
   * is about the pixels. What closes the base of the frame is the near band,
   * and that band has to saturate. */
  scatter(0.95, 0x51, (c) => {
    const far = 1 - smoothstep(15, BUILD_RADIUS, c.dist);
    return (0.55 + 1.05 * marginBoost(c.dist)) * (0.68 + 0.32 * far)
      /* Crowded against a bole, which is where the deepest and dampest litter
       * on this floor is and where a fern actually establishes. */
      * (1 + 0.55 * (1 - smoothstep(0, 1.4, c.clear)));
  }, (c) => place('fern', c, 0.40, 2.45, 0.42), stems);

  /* Salal and huckleberry. Thinner in the wettest ground close to the trail
   * and heavier out in the stand, which is the opposite of the fern and is
   * what the references say: sword fern takes the moist sites, salal the
   * slightly drier ones. Having the two anticorrelated is also what keeps the
   * floor from being one texture at one density.
   *
   * This is the species that has to close the *middle* distance. A fern is a
   * rosette with sky through it, and a wall of them still reads as a floor
   * with objects on it; salal is a solid mass of overlapping blades and it is
   * what stops the eye following the ground plane out to the fog. */
  scatter(1.15, 0x7a3, (c) => {
    const far = 1 - smoothstep(21, BUILD_RADIUS, c.dist);
    const off = smoothstep(DIMS.trailEdge + 0.05, DIMS.trailEdge + 0.6, c.dist);
    return 3.40 * off * (0.42 + 0.58 * smoothstep(1.2, 7.0, c.dist)) * far;
  }, (c) => place('bush', c, 0.52, 2.20, 0.30), stems);

  /* The low storey. Culled at well under half the distance of everything else,
   * so there is no point building it out where it will never be drawn. */
  scatter(1.00, 0x2c9, (c) => {
    if (c.dist > 17) return 0;
    return 1.30 * smoothstep(DIMS.trailEdge, DIMS.trailEdge + 0.4, c.dist)
      * (0.5 + 0.5 * marginBoost(c.dist));
  }, (c) => place('low', c, 0.48, 1.85, 0.62), stems);

  /* ── The collars ───────────────────────────────────────────────────────
   *
   * The critic's finding, in full: the trunk/ground intersection is a hard
   * line with no litter drift, no moss collar, no partial burial and no
   * darkening ring. All four are one object here, and they have to be — a
   * moss collar with a clean litter-free floor around it is the same defect
   * with a green edge on it.
   *
   * Built as a ring of overlapping torn-edged patches rather than as an
   * annulus. An annulus has an outline, and a circle drawn round the foot of
   * every trunk in the wood is worse than the hard line it replaced. Each
   * patch is banked up towards the bole, so its inner edge climbs 10-30 cm and
   * disappears inside the flare, and its occlusion runs from very dark at the
   * trunk to open at its outer edge — which is the darkening ring, and it is
   * in occlusion rather than in albedo because that is the only channel that
   * attenuates the dome's specular as well as its diffuse.
   */
  const crng = new Rng(0x0c011a);
  for (const t of trees) {
    if (t.hungUp) continue;
    if (tr.distance(t.x, t.z) > 22) continue;
    const b = matAt(t.x, t.z);
    /* Reach scales with the bole. A 1.2 m redcedar banks a metre of litter
     * against itself; a 15 cm pole banks a handful. */
    const rIn = t.r0 * 1.25;
    const n = Math.max(5, Math.round(2 * Math.PI * rIn / 0.34));
    const a0 = crng.range(0, Math.PI * 2);
    /* Which way the weather comes from, for the moss. Per-tree rather than
     * global: a scene-wide azimuth is a sun, and env.ts forbids one. */
    const damp = crng.range(0, Math.PI * 2);
    for (let i = 0; i < n; i++) {
      const a = a0 + (i / n) * Math.PI * 2 + crng.range(-0.35, 0.35);
      const size = t.r0 * crng.range(1.1, 1.9) + crng.range(0.22, 0.46);
      const r = rIn + size * crng.range(0.18, 0.42);
      const x = t.x + Math.cos(a) * r, z = t.z + Math.sin(a) * r;
      if (Math.abs(x) > DIMS.worldHalf - 1 || z > DIMS.zMax - 1 || z < DIMS.zMin + 1) continue;
      /* Moss on the damp side, needle drift everywhere else. The two overlap
       * across a wide band rather than meeting at a line, because the thing
       * being avoided is any straight edge at all down there. */
      const mossy = Math.cos(a - damp) * 0.5 + 0.5 + crng.range(-0.30, 0.30);
      const cell = mossy > 0.55 ? (crng.chance(0.5) ? CELL.mossA : CELL.mossB) : CELL.litter;
      mat(b, x, z, size, crng.range(0, Math.PI * 2), cell,
          0.80 + crng.f() * 0.40,
          /* At the bole: a plant at the foot of a trunk in a closed stand sees
           * a sliver of sky and nothing else. This is the darkening ring. */
          0.20, 0.66 + crng.f() * 0.20,
          /* The bank, climbing the bole. Held to a fraction of the un-flared
           * radius so its inner edge is inside the trunk however the flare is
           * built — the flare multiplier is >= 1 by construction, so a mat
           * that reaches r0 is covered by a bole that reaches r0 * (1 + flare). */
          Math.min(0.34, t.r0 * 0.55 + 0.06), a + Math.PI);
      counts.collars++;
    }
    /* Mushrooms at the foot, which is where the mycorrhizal fruiting bodies
     * actually are — around the base of a conifer and along its roots, not
     * scattered at random over the duff. */
    if (crng.chance(0.75)) {
      const a = crng.range(0, Math.PI * 2);
      const r = rIn + crng.range(0.15, 0.75);
      shrooms(b, t.x + Math.cos(a) * r, t.z + Math.sin(a) * r, crng.range(0.055, 0.11), crng);
      counts.shrooms++;
    }
  }

  /* Free moss mats out on the duff, in the hollows where the water sits. The
   * brief asks for moss on the rocks as well; the stones already carry it as a
   * per-facet attribute from System 1, so what is missing is the *floor*. */
  scatter(1.15, 0x33a1, (c) => {
    if (c.dist > 18) return 0;
    /* Moss holds the low, shaded, undisturbed ground and loses where the
     * needle drift is deep — keying it off its own field rather than off the
     * plant density is what makes the two compete for the floor the way they
     * actually do. */
    const wet = smoothstep(0.35, 0.75, veg.fbm(c.x * 0.42 + 5, c.z * 0.42 - 3, 3) * 0.5 + 0.5);
    return 1.90 * wet * smoothstep(DIMS.trailEdge + 0.1, DIMS.trailEdge + 0.7, c.dist);
  }, (c) => {
    const b = matAt(c.x, c.z);
    const size = c.rng.range(0.30, 0.78);
    mat(b, c.x, c.z, size, c.rng.range(0, Math.PI * 2),
        c.rng.chance(0.5) ? CELL.mossA : CELL.mossB,
        0.78 + c.rng.f() * 0.42,
        0.60 + 0.24 * c.open, 0.74 + 0.24 * c.open);
    counts.mats++;
    if (c.rng.chance(0.22)) {
      shrooms(b, c.x + c.rng.range(-0.2, 0.2), c.z + c.rng.range(-0.2, 0.2),
              c.rng.range(0.05, 0.10), c.rng);
      counts.shrooms++;
    }
  }, stems);

  for (const [t, b] of matBuilds) {
    if (!b.count) continue;
    t.ground = b.geometry();
    counts.matTris += b.idx.length / 3;
  }

  counts.plantTris = plantTris;
  counts.openMean = openSum ? counts.openMean / openSum : 0;

  return { tiles: [...tiles.values()], variants, counts };
}
