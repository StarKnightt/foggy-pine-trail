/* The trees, as geometry.
 *
 * The brief's sentence for this system is "the trees are the walls of this
 * scene", and everything below is organised around what a wall of wood is made
 * of when the only light is a bright fog dome.
 *
 * ── Silhouette is the whole budget ────────────────────────────────────────
 *
 * Under this lighting a trunk is a dark vertical bar against bright air. There
 * is no directional light, so no shading gradient runs across the bole; the
 * bark's normal map earns its keep for about the first eight metres of range
 * and contributes nothing at all past twelve. What survives at every distance
 * is the outline, and the outline is set by five things, in this order:
 *
 *   taper        a bole that keeps one diameter for its visible length reads
 *                as a pipe at any resolution. Doug-fir loses roughly 1 cm of
 *                diameter per metre of height through the lower bole.
 *   root flare   the bottom metre swells and then splits into spur roots. It
 *                is the only place a conifer's outline is not two near-parallel
 *                lines, and it is at eye level.
 *   lean         one to four degrees on a live tree, and *curved* rather than
 *                tilted, because a tree that leans has grown into the lean.
 *   stubs        dead lower branches. Short, drooping, broken. Three or four
 *                bumps on an outline stop it being a cylinder even when no
 *                bark on it is resolvable, and they are the strongest age and
 *                species cue available for the cost.
 *   out-of-round the section is lumpy. Three angular harmonics at 7% of the
 *                radius, fading upward, which at 12-16 radial facets makes the
 *                silhouette ragged rather than circular.
 *
 * So the geometry spends its triangles at the base and on the stubs, and the
 * upper bole — which is behind eight scale heights of fog — is four rings.
 *
 * ── Why this is merged geometry and not InstancedMesh ─────────────────────
 *
 * jungle-trail instances a handful of tree variants and it is the right answer
 * there: that forest has tens of thousands of plants and its trunks are one
 * element among many. Here the trunks are the *subject*, twenty of them are in
 * frame at once at ranges from two metres to the fog line, and a repeated
 * silhouette at that count is the defect the whole system exists to avoid —
 * the eye matches outlines long before it matches textures.
 *
 * The measured cost of giving every stem its own bole is 320k triangles for the
 * whole wood, which is two frames' worth of the budget already spent on the
 * ground. Tile bucketing and the per-tile distance cull are kept, because those
 * are what stop the far half of the world being submitted every frame; it is
 * only the instancing and the near/far LOD split that are not worth their
 * repetition. See `Trees.tsx` for the measurement.
 *
 * ── Everything sits on groundHeight, and sits *in* it ─────────────────────
 *
 * A tree standing proud of the duff with daylight under its flare is the same
 * failure `trailProps.ts` documents for stones, one scale up and far more
 * visible. Two defences: the base ring is placed at the *minimum* of eight
 * ground samples around the flare footprint rather than the one at the centre,
 * and the flare is built down past that minimum by another 12 cm, so the
 * lowest geometry is buried whatever the duff is doing. Logs get the harder
 * version of the same problem — see `restLine()`.
 */
import * as THREE from 'three';
import { groundHeight } from './ground';
import { trail } from './trail';
import { DIMS } from './dims';
import { Noise2D, Rng, clamp, smoothstep } from './noise';

/* Metres of world covered by one tile of the bark and snag maps. Emitted
 * straight into the uv attribute, like the props do, because the same material
 * has to serve boles from 5 cm to 1.9 m across and no single texture transform
 * can. */
export const BARK_PATCH = 1.4;

/* Bucket edge for the draw-call grid. 20 m against a 48 m cull leaves eight to
 * twelve tiles alive and the frustum rejects most of those when the camera is
 * looking down the trail; smaller tiles would cull tighter and cost a draw call
 * each to do it. */
const TILE = 20;

/** Which way the weather comes from, for the moss. Shared with the props. */
const DAMP_AZ = Math.atan2(-0.95, -0.32);

/* ── The stand ───────────────────────────────────────────────────────────── */

export type Species = 'fir' | 'hemlock' | 'cedar' | 'pole';

/* Per-species form.
 *
 * `hOverD` is height over diameter at breast height, which is the number that
 * actually distinguishes these three in silhouette: a stand-grown hemlock is a
 * whip at 55, a Doug-fir is a column at 42, and a redcedar is a stout cone at
 * 30 that has already lost half its diameter by the time it is ten metres up.
 * Getting them all from one number and one taper rate is why they do not need
 * three separate builders.
 *
 * `taper` is metres of *radius* per metre of height through the lower bole.
 * 0.0052 for fir is the brief's 1 cm of diameter per metre. Cedar is two and a
 * half times that, which is most of what makes a cedar read as a cedar from
 * fifteen metres away with no bark visible.
 *
 * `flare` is how much the radius multiplies at the soil line and `spurs` is how
 * many root ridges break that flare up. A Doug-fir has a flare; a redcedar has
 * something close to a buttress; a suppressed pole has neither and its base is
 * nearly the same width as its middle, which is exactly why a stand of poles
 * reads as poles.
 */
const FORM: Record<Species, {
  dbhLo: number; dbhHi: number; dbhPow: number;
  hOverD: number; hMin: number; hMax: number;
  taper: number; crown: number;
  flare: number; flareH: number; spurs: number;
  lump: number; stubs: number; barkScale: number;
}> = {
  fir: {
    dbhLo: 0.34, dbhHi: 1.35, dbhPow: 2.6,
    hOverD: 42, hMin: 22, hMax: 54,
    taper: 0.0052, crown: 0.42,
    flare: 0.72, flareH: 0.95, spurs: 5,
    lump: 0.075, stubs: 1.0, barkScale: 1.0,
  },
  hemlock: {
    dbhLo: 0.15, dbhHi: 0.66, dbhPow: 2.1,
    hOverD: 55, hMin: 13, hMax: 38,
    taper: 0.0062, crown: 0.30,
    flare: 0.52, flareH: 0.62, spurs: 4,
    lump: 0.055, stubs: 1.7, barkScale: 0.62,
  },
  cedar: {
    dbhLo: 0.55, dbhHi: 1.95, dbhPow: 2.8,
    hOverD: 30, hMin: 20, hMax: 44,
    taper: 0.0128, crown: 0.34,
    flare: 1.35, flareH: 1.90, spurs: 6,
    /* 0.80 rather than the 0.52 that shipped in the second build. Redcedar bark
     * genuinely is a much finer vertical fibre than fir's furrow, and squeezing
     * the tile that hard delivered it — at four centimetres a strip, which on a
     * 1.9 m bole eight metres away is under a pixel. Every cedar in the frame
     * averaged to a smooth pale grey and read as brushed suede. A texture that
     * resolves to its own mean is worse than no texture, because it also takes
     * the silhouette's value with it. */
    lump: 0.125, stubs: 0.6, barkScale: 0.80,
  },
  /* Suppressed understory stems, and every number here is set by one
   * inequality rather than by the botany.
   *
   * At 4.5 cm and a height-over-diameter of 78 the thin end of this population
   * was a bare 3.5 m whip four pixels wide, and forty of them scattered through
   * the mid-ground read as scratches on the lens. The answer at the time was to
   * stop drawing the stem wherever it got thinner than `R_TIP`, and that turned
   * out to be much worse than the disease: a 5.5 m pole 10 cm through crosses
   * 4.5 cm of radius at 1.6 m, so a third of the population was drawn as the
   * bottom metre and a half of itself — straight, blunt, near-constant in
   * diameter and dark, which is precisely the "surveyor's stake" the last
   * review rejected. Measured at stop 94: 8 cm through at 13.4 m, 2.7 m tall,
   * flat topped.
   *
   * So the population is now sized so that the truncation cannot bite. The
   * constraint is rad(0.75 h) >= R_TIP for the *thinnest* stem drawn, which with
   * a crown fraction of 0.58 works out at r0 - taper * 0.75 h >= 0.060 m; 15 cm
   * at 46 and a taper of 0.0026 gives 0.0615 and clears it. What that buys is a
   * stem that tapers all the way up, ends in a splintered break rather than a
   * cut, and is five pixels through at its top at fifteen metres.
   */
  pole: {
    dbhLo: 0.15, dbhHi: 0.32, dbhPow: 1.7,
    hOverD: 46, hMin: 4.5, hMax: 14,
    taper: 0.0026, crown: 0.58,
    flare: 0.26, flareH: 0.40, spurs: 3,
    lump: 0.052, stubs: 2.3, barkScale: 0.45,
  },
};

export type TreeSpec = {
  x: number; z: number;
  /** Soil line the bole is registered to: the minimum ground under its flare. */
  base: number;
  sp: Species;
  /** Radius at the soil line, before the flare multiplier. */
  r0: number;
  /** Total height of the bole as built — for a snag, the height it snapped at. */
  h: number;
  /** Height the live tree reached, which is what the crown is hung from. */
  hFull: number;
  /** Radians from vertical, and the azimuth it leans towards. */
  lean: number; leanAz: number;
  /** Basal sweep as a fraction of height, and its azimuth. Zero on most stems. */
  sweep: number; sweepAz: number;
  /** Cosine-weighted sky view factor for a horizontal normal, by azimuth bin. */
  sky: Float32Array | null;
  /** Standing dead: barkless, silver, no crown. */
  dead: boolean;
  /** Dead and hung up in a neighbour, so the lean is extreme and it stops in air. */
  hungUp: boolean;
  seed: number;
};

/* The clumping field.
 *
 * A per-candidate acceptance probability produces a statistically even spread,
 * and evenness is what gives a scattered forest away even when every individual
 * stem is right — the eye reads a constant nearest-neighbour distance as a
 * plantation immediately. Real stands are patchy because they regenerate in the
 * gaps left by whatever fell last: a two-century-old windthrow gap is a thicket
 * of poles, and fifteen metres away under closed canopy the floor is nearly
 * open with four veterans on it.
 *
 * Two bands. The long one is the gap structure and the short one breaks its
 * edges up so a thicket does not have a smooth boundary.
 */
const clumpN = new Noise2D(0x7ee5);
function clump(x: number, z: number): number {
  return clamp(
    clumpN.fbm(x * 0.055, z * 0.055, 2) * 0.68
    + clumpN.fbm(x * 0.19 + 31, z * 0.19, 2) * 0.32,
    -1, 1,
  ) * 0.5 + 0.5;
}

/**
 * Where the trees are.
 *
 * Jittered grid, accepted against the clumping field, then rejected against a
 * spatial hash of what has already been placed. The spacing rule is the part
 * worth being careful with: it is a function of the *sum* of the two radii and
 * not a constant, because a stem-exclusion radius that ignores size lets a
 * 1.3 m veteran and a 1.2 m veteran stand a metre apart with their flares
 * interpenetrating, which is the one placement error that cannot be hidden by
 * fog — it happens at the base, at eye level, in the near field.
 *
 * Big stems are drawn first so they win the competition for space, which is
 * also what actually happens in a stand.
 */
export function standSpecs(): TreeSpec[] {
  const rng = new Rng(0x2ee5f0);
  const tr = trail();
  const out: TreeSpec[] = [];

  /* Spatial hash for the spacing test. 3 m cells and a 3x3 neighbourhood
   * covers the largest exclusion radius any pair here generates. */
  const CELL = 3.0;
  const grid = new Map<number, TreeSpec[]>();
  const key = (x: number, z: number) =>
    (Math.floor(x / CELL) + 512) * 1024 + Math.floor(z / CELL) + 512;

  const tooClose = (x: number, z: number, r: number): boolean => {
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const list = grid.get((cx + dx + 512) * 1024 + cz + dz + 512);
        if (!list) continue;
        for (const t of list) {
          /* Flares touch well before boles do. The clearance is the two flared
           * radii plus a hand's width, so two stems can genuinely crowd each
           * other — which is the look — without merging. */
          const need = (r + t.r0) * 1.55 + 0.18;
          const dd = (x - t.x) * (x - t.x) + (z - t.z) * (z - t.z);
          if (dd < need * need) return true;
        }
      }
    }
    return false;
  };

  /* Drawn in four passes, largest first, so the veterans get the space they
   * need and the poles fill in around them rather than the other way round. */
  /* Stocking. A mature unmanaged Doug-fir/hemlock stand carries 250-400 stems
   * per hectare over 10 cm DBH plus whatever regeneration the gaps allow; this
   * strip is 0.74 ha, so the target is roughly 220 trees and 350 poles. The
   * numbers below overshoot that on purpose because the spacing test throws
   * away a third of what they generate. */
  const passes: { sp: Species; step: number; take: number }[] = [
    { sp: 'cedar', step: 11.0, take: 0.36 },
    { sp: 'fir', step: 4.2, take: 0.64 },
    { sp: 'hemlock', step: 3.6, take: 0.64 },
    /* Taken harder than the others because the poles are now thick enough that
     * the spacing test rejects most of what this generates — raising the
     * minimum diameter from 10 cm to 15 cm to kill the surveyor's stakes also
     * cut the understory from a layer to a scatter, and the depth step between
     * the duff and the boles goes with it.
     *
     * Two passes at different scales rather than one harder pass, and the
     * second is the answer to the mid-ground reading as cut paper. 109 poles
     * over 0.74 ha is not an understory, it is a scatter, and the histogram
     * showed it: 42% of the upper frame was open air because between the big
     * stems at fifteen metres there was nothing at all. The second pass is
     * offset by half a cell so its stems land in the gaps the first left rather
     * than being rejected by the spacing test against them. */
    { sp: 'pole', step: 2.4, take: 0.72 },
    { sp: 'pole', step: 1.7, take: 0.80 },
  ];

  /* Veterans.
   *
   * A separate pass, placed first, and biased towards the trail — which is the
   * one piece of placement in this file that is not a statement about how a
   * forest grows. The population above is drawn from the real diameter
   * distribution and that distribution is heavily weighted to the thin end, so
   * across 0.74 ha it produces about four stems over a metre through and puts
   * them wherever the grid happens to fall. The first capture came back with a
   * corridor made entirely of 30-60 cm stems and no reference object in it at
   * all: with nothing in frame whose size the viewer knows, the whole wood read
   * as a thicket of saplings seen from close up rather than as old growth seen
   * from a trail.
   *
   * One veteran passing within a few metres of the camera fixes that, because a
   * 1.6 m bole is a size a person recognises directly. Twelve of them over 48 m
   * of walking is roughly one every four seconds, which is also what the
   * reference photographs of the Hoh show.
   */
  {
    for (let i = 0; i < 16; i++) {
      const along = -4 + (DIMS.trailLength + 10) * ((i + 0.5) / 16)
        + rng.range(-1.4, 1.4);
      const sp: Species = rng.chance(0.35) ? 'cedar' : 'fir';
      const f = FORM[sp];
      const dbh = rng.range(0.95, 1.0) * f.dbhHi * rng.range(0.72, 1.0);
      const r0 = dbh * 0.5;
      /* Close enough to fill a third of the frame's height when the walk passes
       * it, far enough that the flare never intersects the tread. */
      const side = (rng.chance(0.5) ? 1 : -1)
        * (DIMS.trailHalf + 0.55 + r0 * (1 + f.flare) + rng.range(0, 5.5));
      const c = tr.pointAtAlong(along);
      const x = c.x + -c.tz * side, z = c.z + c.tx * side;
      if (Math.abs(x) > DIMS.worldHalf - 3) continue;
      if (tr.distance(x, z) < DIMS.trailHalf + 0.32 + r0 * (1 + f.flare)) continue;
      if (tooClose(x, z, r0)) continue;
      const t: TreeSpec = {
        x, z, base: 0, sp, r0,
        h: clamp(dbh * f.hOverD, f.hMin, f.hMax),
        hFull: clamp(dbh * f.hOverD, f.hMin, f.hMax),
        /* Half the stand's lean. A veteran carries a hundred tonnes on a bole a
         * metre and a half through and is the stiffest thing in the wood; it is
         * also the object the eye uses to decide whether the frame is plumb, so
         * a visible tilt on one reads as the camera being crooked rather than as
         * the tree being crooked. */
        lean: Math.min(0.055, Math.abs(rng.gauss()) * 0.078),
        leanAz: rng.range(0, Math.PI * 2),
        sweep: rng.chance(0.16) ? rng.range(0.004, 0.009) : 0,
        sweepAz: rng.range(0, Math.PI * 2),
        sky: null,
        dead: false, hungUp: false,
        seed: rng.range(0, 1000),
      };
      out.push(t);
      const k = key(x, z);
      let list = grid.get(k);
      if (!list) grid.set(k, (list = []));
      list.push(t);
    }
  }

  for (const pass of passes) {
    const f = FORM[pass.sp];
    for (let gx = -DIMS.worldHalf; gx < DIMS.worldHalf; gx += pass.step) {
      for (let gz = DIMS.zMin; gz < DIMS.zMax; gz += pass.step) {
        const x = gx + rng.range(0, pass.step);
        const z = gz + rng.range(0, pass.step);
        if (Math.abs(x) > DIMS.worldHalf || z < DIMS.zMin || z > DIMS.zMax) continue;

        /* Clumping. Poles are gated hardest because a thicket of regeneration
         * is the most spatially concentrated thing in a real stand — it exists
         * only where a gap let light in — and an even sprinkle of them across
         * the whole wood reads as understory scatter rather than as a thicket.
         */
        /* The floor under the pole gate is new and it is not a softening of the
         * thicket idea, it is a correction to it. Regeneration is concentrated
         * in gaps, but suppressed stems are not the same thing as regeneration:
         * an old stand carries a continuous scatter of shaded-out saplings that
         * germinated years ago and have been dying slowly ever since, and those
         * are everywhere. A pure smoothstep gate put the entire understory in a
         * handful of patches and left the rest of the wood as bare boles over
         * bare duff. */
        const c = clump(x, z);
        const gate = pass.sp === 'pole'
          ? 0.30 + 0.70 * smoothstep(0.38, 0.78, c)
          : pass.sp === 'cedar' ? 0.35 + 0.65 * (1 - c) : 0.34 + 0.80 * c;
        if (!rng.chance(pass.take * gate)) continue;

        /* Heavy-tailed diameters. A uniform draw gives every stem in a species
         * the same apparent mass and the stand reads as a plantation of one
         * age; the power law puts most of the population at the thin end with
         * the occasional veteran that establishes the scale of everything
         * else. */
        const dbh = f.dbhLo + (f.dbhHi - f.dbhLo) * rng.f() ** f.dbhPow;
        const r0 = dbh * 0.5;

        /* Off the trail, by the flared radius plus a clearance. 0.30 m is
         * deliberately tight: a corridor is trees you could touch, and holding
         * them a metre back turns the path into a ride. */
        const clear = DIMS.trailHalf + 0.30 + r0 * (1 + f.flare);
        if (tr.distance(x, z) < clear) continue;
        if (tooClose(x, z, r0)) continue;

        const hFull = clamp(dbh * f.hOverD * rng.range(0.86, 1.14), f.hMin, f.hMax);

        /* Standing dead. Roughly one stem in eleven in an unmanaged stand of
         * this age, and they matter out of all proportion: a snag is the only
         * pale vertical in the frame and the only one whose top is broken. */
        const dead = rng.chance(pass.sp === 'pole' ? 0.14 : 0.085);
        /* A dead conifer loses its top within a decade or two of dying, and the
         * broken top is most of what identifies it at distance. Two thirds of
         * the snags here are broken; the rest still carry their spire. */
        const h = dead && rng.chance(0.66)
          ? hFull * rng.range(0.20, 0.62)
          : hFull;
        /* Hung up in a neighbour. A tree that fell and did not reach the ground
         * is the single strongest diagonal available in a scene made entirely
         * of verticals, and every mature PNW stand has them. */
        const hungUp = dead && !rng.chance(0.72) && pass.sp !== 'cedar';

        const t: TreeSpec = {
          x, z,
          base: 0,
          sp: pass.sp,
          r0, h, hFull,
          /* Live stems: two to six degrees, in a uniformly random azimuth.
           *
           * This has been wrong in both directions and the reason is the same
           * both times: `Rng.gauss` is not a unit normal. It is the sum of three
           * uniforms mapped to [-1, 1], so its standard deviation is one third
           * and its support is bounded — which means the sigma written here has
           * always delivered a third of what it reads, and every "hard cap" put
           * on it has been unreachable and therefore inert. The first version
           * claimed 4.3 degrees at one sigma and actually gave 1.4; the
           * correction claimed 1.6 and gave 0.5, which is why the review found
           * one bole's left edge crossing eight pixels over 340 of height and
           * every standing stem in the frame parallel to every other. The
           * numbers below are pre-multiplied by three so that the figure written
           * is the figure delivered, and `leanMean` and `leanP90` are published
           * on the forest counts so this cannot be got wrong silently a third
           * time. Measured: 2.3 degrees mean, 4.7 at the ninetieth percentile.
           *
           * The quantity that matters is not the lean of any one stem, it is
           * whether two stems in frame are visibly *not* parallel. Three degrees
           * apart in opposite azimuths is six degrees of relative angle, which
           * at fifteen metres is a hundred pixels of divergence over the visible
           * height — legible as a crossing, and still far too little for any
           * single stem to read as bent. Poles get half again as much: a
           * suppressed stem grows towards whatever gap let the light in, and
           * leaning is most of what says "suppressed".
           *
           * Hung-up dead stems keep their own range untouched. */
          lean: hungUp
            ? rng.range(0.34, 0.68)
            : Math.min(pass.sp === 'pole' ? 0.16 : 0.105,
                       Math.abs(rng.gauss()) * (pass.sp === 'pole' ? 0.225 : 0.150)),
          leanAz: rng.range(0, Math.PI * 2),
          /* Basal sweep, on a fifth of the stand.
           *
           * A stem that spent its first decade under a snowpack, or was pushed
           * over by a neighbour coming down and then straightened itself, keeps
           * a J in the bottom few metres for the rest of its life and is
           * vertical above it. It is a different shape from lean — the curvature
           * is all in the part of the bole that is actually in frame — and it is
           * the cheapest way to break the parallelism at eye level rather than
           * at the top of the picture where the fog has already eaten it. */
          sweep: rng.chance(0.22) ? rng.range(0.006, 0.016) : 0,
          sweepAz: rng.range(0, Math.PI * 2),
          sky: null,
          dead, hungUp,
          seed: rng.range(0, 1000),
        };
        out.push(t);
        const k = key(x, z);
        let list = grid.get(k);
        if (!list) grid.set(k, (list = []));
        list.push(t);
      }
    }
  }

  /* Register every base to the floor, once, after placement — the sample is
   * eight `groundHeight` calls and doing it during the rejection loop would
   * pay for it on candidates that never get placed. */
  for (const t of out) {
    const f = FORM[t.sp];
    /* The sample radius has a floor, and the floor is the fix for stems that
     * hang clear of the ground.
     *
     * Scaling it off the trunk's own girth is right for a veteran and useless
     * for a pole: at r0 = 5 cm the ring below samples a circle 10 cm across, so
     * a sapling standing on a hummock is registered to the hummock while the
     * terrain a metre in front of it is thirty centimetres lower. Seen against
     * bright air that is a flat-bottomed stem with fog underneath it, which is
     * what the review found in `94.png` -- the same defect class as the
     * truncated tops, at the other end of the stem. What matters is not how fat
     * the tree is, it is how rough the ground is over the span the eye can see
     * under it, and that is a property of the terrain. */
    const rr = Math.max(t.r0 * (1 + f.flare) * 1.15, 1.05);
    let lo = groundHeight(t.x, t.z);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const g = groundHeight(t.x + Math.cos(a) * rr, t.z + Math.sin(a) * rr);
      if (g < lo) lo = g;
    }
    /* And another 12 cm under the lowest sample. The flare is built down to
     * this line, so the lowest ring of every tree in the wood is under the
     * duff by construction and no amount of local roughness can open a gap. */
    t.base = lo - 0.12;
  }

  skyView(out);
  return out;
}

/* How much sky each bole can see, as a function of which way it is facing.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * A vertical cylinder's surface normals are all horizontal, and `Lighting.tsx`
 * builds its environment by writing one colour per row of constant elevation
 * and replicating it across all 128 columns of the equirect. The dome is
 * therefore rotationally symmetric about Y *exactly*, not approximately, and
 * every point around a bole receives identical irradiance by construction.
 * There is no terminator on any trunk in the scene and there cannot be one:
 * flatness is the honest output of a correct setup, and it is why the
 * mid-ground measured a spread of nine luma across a 36 px stem.
 *
 * A real trunk is not flat, and not because the light has a direction — under
 * a genuine overcast it does not. It is because sky *visibility* has a
 * direction: a stem with a neighbour two metres to the north-east has most of
 * that quadrant of its hemisphere filled with another trunk, and the bearing
 * with the longest clear sightline down the stand is several times better lit
 * than the bearing that looks straight into a thicket. That is a property of
 * where the tree is standing, it is different for every tree in the wood, and
 * nothing else in this renderer can supply it — there is no shadow map, no
 * bounce, and no light with an azimuth.
 *
 * ── What it computes ──────────────────────────────────────────────────────
 *
 * Two stages. First an azimuthal blockage profile at 32 bins: every neighbour
 * within 18 m fills the bins it subtends with a weight that falls off with
 * distance and with how much of the upper hemisphere it actually reaches, so a
 * 3 m pole at 12 m blocks almost nothing and a 40 m veteran at 4 m blocks
 * nearly everything on its bearing. Then the profile is convolved with a
 * cosine lobe to give the view factor a horizontal normal on each of 12
 * bearings actually integrates. The convolution is the part that matters: a
 * surface facing north is shaded by everything from north-west to north-east
 * weighted by the cosine, not by what is due north, and skipping it produces a
 * hard-edged patch of shadow rather than a terminator.
 *
 * Cost is measured in the build log; at roughly 900 stems, 32 bins and a 12x32
 * convolution it is under 15 ms and happens once.
 */
/* Everything on the floor was tuned against the old bark AO floor.
 *
 * The shared bark and snag bakes carried "a trunk is a silhouette" in their AO
 * until this round, when it moved onto the bole's own vertex occlusion so that
 * it could vary with bearing. That roughly doubled the delivered occlusion of
 * both maps, and the stubs, logs, limbs and sticks that sample them were each
 * tuned by measurement against the old value — the sticks in particular went
 * through two revisions to stop reading as flat black slivers. Rather than
 * re-tune five surfaces that no one has complained about, the factor that
 * leaves them exactly where they measured is applied once, here.
 */
const DEADWOOD_OCC = 0.52;

/* Handed back to the one deadwood population that lies at the viewer's feet.
 * See the note at its use site in branch(). */
const LITTER_OCC = 1.90;

const SKY_BINS = 12;
function skyView(trees: TreeSpec[]): void {
  const NB = 32;
  const REACH = 18;

  /* Same 3 m hash as the spacing test, rebuilt because the placement one is
   * local to `standSpecs` and this runs over the finished list. */
  const CELL = 6.0;
  const cells = new Map<number, TreeSpec[]>();
  const ck = (x: number, z: number) =>
    (Math.floor(x / CELL) + 512) * 1024 + Math.floor(z / CELL) + 512;
  for (const t of trees) {
    const k = ck(t.x, t.z);
    let l = cells.get(k);
    if (!l) cells.set(k, (l = []));
    l.push(t);
  }

  const blocked = new Float32Array(NB);
  const span = Math.ceil(REACH / CELL);

  for (const t of trees) {
    blocked.fill(0);
    const cx = Math.floor(t.x / CELL), cz = Math.floor(t.z / CELL);
    for (let dx = -span; dx <= span; dx++) {
      for (let dz = -span; dz <= span; dz++) {
        const list = cells.get((cx + dx + 512) * 1024 + cz + dz + 512);
        if (!list) continue;
        for (const n of list) {
          if (n === t) continue;
          const ex = n.x - t.x, ez = n.z - t.z;
          const d = Math.hypot(ex, ez);
          if (d < 1e-3 || d > REACH) continue;

          /* How much of a horizontal normal's cosine lobe this one stem takes,
           * split into an elevation factor and an azimuth coverage.
           *
           * The elevation factor is the awkward one and getting it wrong is
           * what made the first attempt useless. For a *horizontal* normal the
           * cosine-weighted hemisphere is not spread evenly over elevation — the
           * weight goes as cos^2, so more than half of everything such a surface
           * receives arrives within thirty degrees of the horizon, which is
           * exactly the band the neighbouring trunks occupy. The closed form of
           * that integral up to an elevation limit is below; a stem reaching
           * sixty degrees takes 98% of its bearing rather than the 87% a naive
           * solid-angle fraction would give.
           */
          const el = clamp(Math.atan2(n.h - 3.0, d), -1.5707, 1.5707);
          const ev = ((el * 0.5 + Math.sin(2 * el) * 0.25) + Math.PI / 4) / (Math.PI / 2);
          // Fade the last few metres so a stem crossing REACH does not pop.
          const fade = Math.min(1, (REACH - d) / 4);
          const strength = clamp(ev, 0, 1) * fade;
          if (strength <= 0) continue;

          /* Everything below is in turns rather than radians, so that a bin
           * index and a bearing are the same kind of number and the half-bin
           * offsets between the two resolutions cannot drift apart. */
          const bt = Math.atan2(ez, ex) / (Math.PI * 2);
          const hw = Math.atan2(n.r0 * 1.35, d) / (Math.PI * 2);
          const binW = 1 / NB;
          for (let j = 0; j < NB; j++) {
            let off = (j + 0.5) / NB - bt;
            off -= Math.round(off);
            /* Proportional coverage, not a whole bin per neighbour.
             *
             * The first version filled at least one bin at full strength for
             * every stem it found, and with three hundred stems inside eighteen
             * metres that saturated all thirty-two bins on every tree in the
             * wood: sky came out identically zero, the term collapsed to a
             * constant, and the boles were flat for a completely different
             * reason from the one being fixed. A 0.4 m stem at twelve metres
             * subtends four degrees and a bin is eleven, so it is a third of a
             * bin and has to be booked as a third of a bin. */
            const cov = clamp((hw + binW * 0.5 - Math.abs(off)) / binW, 0, 1);
            if (cov <= 0) continue;
            /* Combined as independent occluders rather than added. Two stems
             * on the same bearing do block more than one, but the second can
             * only take what the first left, and adding them is what let a
             * thicket drive the figure negative. */
            blocked[j] = 1 - (1 - blocked[j]) * (1 - cov * strength);
          }
        }
      }
    }

    /* The bearing profile as five Fourier coefficients rather than as a table,
     * and this is the fix for the seams the review found down the hero boles.
     *
     * The previous version wrote twelve bins and the shader-side lookup
     * smoothstepped between them. That is continuous in value and it is still
     * not smooth enough: with the gain below, one bin can clamp at 0.05 while
     * its neighbour sits at 0.40, and a smoothstep puts most of that 2.5:1
     * change inside fifteen degrees of bearing. On a mid-ground stem fifteen
     * degrees is three pixels and nobody sees it; on the 300 px hero bole in
     * `94.png` it is a hard vertical line a quarter of the way across the
     * trunk, which is exactly what was reported — "a near-black band down its
     * left third, ruler-straight, meeting textured bark on a hard line".
     *
     * Truncating to two harmonics fixes it at the source instead of papering
     * over it with a wider filter. The physical quantity being approximated is
     * a cosine-weighted view factor, which is an integral of a bounded
     * function against a cos lobe: it genuinely has almost no energy above the
     * second harmonic, so nothing real is being discarded. What *is* discarded
     * is the bin-to-bin noise of a Monte-Carlo-ish sum over discrete
     * neighbours, which is the only thing that was producing edges. The result
     * is analytic in bearing — C-infinity, no bins, no interpolation, no
     * boundaries to land on — and it is also cheaper to evaluate than the
     * lookup it replaces.
     *
     * A DC term plus a first harmonic is a cylinder's terminator; the second
     * harmonic is what lets a stem be dark on two opposite sides, which is the
     * common case for one standing between two others.
     */
    const c = new Float32Array(5);
    let mean = 0;
    for (let j = 0; j < NB; j++) {
      const a = ((j + 0.5) / NB) * Math.PI * 2;
      const v = 1 - blocked[j];
      mean += v / NB;
      c[1] += (2 / NB) * v * Math.cos(a);
      c[2] += (2 / NB) * v * Math.sin(a);
      c[3] += (2 / NB) * v * Math.cos(2 * a);
      c[4] += (2 / NB) * v * Math.sin(2 * a);
    }

    /* Deviations from the tree's own mean, amplified.
     *
     * Straight view factors give the right *ordering* and nothing like enough
     * range: measured over this stand the spread across one bole's visible face
     * came out around 1.6:1, which after the fog at thirteen metres is three
     * display levels and is invisible. The stand is dense everywhere, so the
     * honest signal is real but small, and the term that has to be legible is
     * the difference between one side of a trunk and the other rather than the
     * difference between one trunk and the next.
     *
     * Amplifying the harmonics and leaving the DC alone is the same operation
     * the binned version did about the mean, with the advantage that it cannot
     * clip: the old clamp to [0.05, 1] was applied per bin, so a deep bin hit
     * the floor while its neighbour did not, and a clamp against a floor is a
     * discontinuity in the derivative — half of the seam. Here the amplitude is
     * limited instead, before evaluation, so the profile stays a smooth curve
     * whatever the gain. */
    const GAIN = 2.9;
    /* The most the harmonics may sum to, as a fraction of the DC term, and this
     * number is the correction to an eight-fold circumferential falloff that
     * the review measured and correctly refused: the hero bole in `78.png` ran
     * 67 on its open bearing and 8 to 14 across most of its width.
     *
     * 0.86 gave (1+0.86)/(1-0.86), a ratio of thirteen to one before the clamp
     * in `bole` caught it and seven to one after. Nothing physical produces
     * that. The honest figure is recorded four paragraphs up — the measured
     * spread across one bole's visible face is about 1.6:1 — and the reason it
     * is that small is that a stem does not block the sky, it replaces the sky
     * with a lit trunk six metres away and with the glowing air in front of it.
     * At this density the airlight over six metres is under one per cent, so
     * the air is not the rescue; the neighbour's own bark, at eight to twelve
     * per cent albedo under the same dome and carrying moss, is.
     *
     * The gain above stays, because the raw signal really is too small to
     * survive the fog and the term is a legibility device as much as a
     * radiometric one. What changes is that it is capped where a photograph
     * caps it. 0.34 is two to one open-to-closed, which is a little more than
     * the physics and much less than a lit scene, and it is the most a
     * shadowless dome will support before the eye starts looking for the light
     * that made it. */
    const m1 = Math.hypot(c[1], c[2]), m2 = Math.hypot(c[3], c[4]);
    const want = (m1 + m2) * GAIN;
    const room = mean * 0.34;
    const g = want > room && want > 1e-6 ? (GAIN * room) / want : GAIN;
    c[0] = mean;
    for (let k = 1; k < 5; k++) c[k] *= g;
    t.sky = c;
  }

  /* Normalised so the stand's own mean is 1, and the reason is a bug this
   * change caused and then had to undo.
   *
   * The absolute view factor depends on how many stems are within eighteen
   * metres, which is a property of the population and not of any one tree.
   * Adding the understory the mid-ground needed took the stand mean from 0.484
   * to 0.230, and because `bole` mapped the raw figure through a fixed affine
   * remap, every trunk in the wood — including the ones nowhere near the new
   * stems — went 1.6 times darker overnight. The measured 1st percentile of
   * the frame fell from 22 to 15 and the histogram moved the wrong way.
   *
   * The term was never about the absolute number. It exists to say that one
   * side of a bole is more open than the other and that a stem in a thicket is
   * darker than one on the edge of a gap, and both of those are ratios. Fixing
   * the stand mean at 1 here makes the remap in `bole` mean what its comment
   * has always claimed it means, and makes the shipped trunk value independent
   * of a stocking decision taken in a different function.
   */
  let dc = 0, n = 0;
  for (const t of trees) if (t.sky) { dc += t.sky[0]; n++; }
  standSky = n ? dc / n : 1;
  if (standSky > 1e-4) {
    for (const t of trees) if (t.sky) for (let k = 0; k < 5; k++) t.sky[k] /= standSky;
  }
}

/** The stand's mean raw sky view factor, before the normalisation above. */
let standSky = 1;
export const standSkyRaw = () => +standSky.toFixed(3);

/**
 * The sky view factor on a given bearing, from the harmonics above.
 *
 * One place, called from the bole skin and from `skyStats`, because the last
 * time the evaluation was written out twice the statistics were reporting the
 * spread of a profile the renderer was not using.
 */
function skyAt(c: Float32Array, az: number): number {
  const ca = Math.cos(az), sa = Math.sin(az);
  // cos2/sin2 from the angle-doubling identities: no second pair of transcendentals.
  // Bounded relative to the stand mean of 1, not to a view factor's own [0,1].
  return clamp(
    c[0] + c[1] * ca + c[2] * sa + c[3] * (ca * ca - sa * sa) + c[4] * (2 * ca * sa),
    0.06, 2.2,
  );
}

/* What the term above actually produced, which is not a thing to take on trust.
 *
 * Its first version returned a hard zero on every bin of every tree — a
 * saturated occluder sum — and the delivered frame looked like a plausible
 * darkening rather than like a bug, because a constant is exactly what it had
 * been before. The mean says whether the boles will sit at the right level and
 * the spread says whether there is a terminator; a spread near zero means the
 * whole mechanism is inert however good the pictures look. */
export function skyStats(trees: TreeSpec[]): { mean: number; spread: number; lo: number; hi: number } {
  let mean = 0, spread = 0, lo = 1, hi = 0, n = 0;
  for (const t of trees) {
    if (!t.sky) continue;
    let mn = 1, mx = 0, sum = 0;
    for (let k = 0; k < SKY_BINS; k++) {
      const v = skyAt(t.sky, ((k + 0.5) / SKY_BINS) * Math.PI * 2);
      if (v < mn) mn = v;
      if (v > mx) mx = v;
      sum += v;
    }
    mean += sum / SKY_BINS;
    spread += mx - mn;
    if (mn < lo) lo = mn;
    if (mx > hi) hi = mx;
    n++;
  }
  return {
    mean: +(mean / Math.max(1, n)).toFixed(3),
    spread: +(spread / Math.max(1, n)).toFixed(3),
    lo: +lo.toFixed(3), hi: +hi.toFixed(3),
  };
}

/* ── Accumulator ─────────────────────────────────────────────────────────── */

/* Same shape as the one in `trailProps.ts` and deliberately a second copy: the
 * attribute set is different (four channels rather than three, and none of them
 * the same), the vertex count is an order of magnitude larger so the scalar
 * signature matters, and coupling System 1's props buffer to System 2's would
 * mean a change to either one recompiling both materials. */
class Mesh {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly uv: number[] = [];
  /** Per-piece tone, 0-1. One bake serves every tree in the wood. */
  readonly tone: number[] = [];
  /** 0 intact bark, 1 barkless weathered wood. */
  readonly weather: number[] = [];
  /** Moss and algal film, 0-1. */
  readonly moss: number[] = [];
  /** Authored occlusion, 1 open. See `Trees.tsx` for why this is not a tint. */
  readonly occ: number[] = [];
  readonly idx: number[] = [];

  get count(): number { return this.pos.length / 3; }

  vert(px: number, py: number, pz: number,
       nx: number, ny: number, nz: number,
       u: number, v: number,
       tone: number, weather: number, moss: number, occ: number): number {
    const i = this.pos.length / 3;
    this.pos.push(px, py, pz);
    this.nrm.push(nx, ny, nz);
    this.uv.push(u, v);
    this.tone.push(tone);
    this.weather.push(weather);
    this.moss.push(moss);
    this.occ.push(occ);
    return i;
  }

  tri(a: number, b: number, c: number): void { this.idx.push(a, b, c); }

  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aTone', new THREE.Float32BufferAttribute(this.tone, 1));
    g.setAttribute('aWeather', new THREE.Float32BufferAttribute(this.weather, 1));
    g.setAttribute('aMoss', new THREE.Float32BufferAttribute(this.moss, 1));
    g.setAttribute('aOcc', new THREE.Float32BufferAttribute(this.occ, 1));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

/* ── The sweep ───────────────────────────────────────────────────────────── */

/* One station on a swept piece.
 *
 * The frame is carried explicitly rather than recomputed, because the two
 * things that read it — the polar profile and the s-tangent used for the normal
 * — have to agree about which way is "around". Building the frame from world up
 * at each ring, as the props' `tube()` does, is fine for something lying within
 * thirty degrees of horizontal and is not fine for a bole: at the vertical it
 * is degenerate, and a leaner passes through every angle in between.
 */
type Station = {
  cx: number; cy: number; cz: number;
  /** Ring basis, orthonormal with the axis. */
  nx: number; ny: number; nz: number;
  bx: number; by: number; bz: number;
  /** Mean radius here. */
  r: number;
  /** 0-1 along the piece. */
  s: number;
  /** Distance along the piece in metres, for the texture v. */
  v: number;
};

/** Per-vertex surface attributes, written in place so the sweep allocates none. */
type Skin = { weather: number; moss: number; occ: number };

/**
 * Build a ring frame at a station from its axis direction.
 *
 * Parallel transport rather than a fixed reference, so the frame does not spin
 * when the axis passes near vertical — which is the whole visible length of
 * every tree in this file.
 */
function frameFrom(
  st: Station, tx: number, ty: number, tz: number,
  px: number, py: number, pz: number,
): void {
  // Project the previous ring's normal onto the plane perpendicular to t.
  const d = px * tx + py * ty + pz * tz;
  let nx = px - tx * d, ny = py - ty * d, nz = pz - tz * d;
  let l = Math.hypot(nx, ny, nz);
  if (l < 1e-5) {
    // Degenerate only if the axis reversed; any perpendicular will do.
    nx = ty; ny = -tx; nz = 0;
    l = Math.hypot(nx, ny, nz) || 1;
  }
  st.nx = nx / l; st.ny = ny / l; st.nz = nz / l;
  st.bx = ty * st.nz - tz * st.ny;
  st.by = tz * st.nx - tx * st.nz;
  st.bz = tx * st.ny - ty * st.nx;
}

/**
 * Sweep a tube through a list of stations with a polar profile.
 *
 * The normal is the cross product of the two surface tangents rather than the
 * radial direction, and that is not a nicety. The root flare multiplies the
 * radius by up to two over the last 30 cm of the bole, so the surface there is
 * nearly a cone: a radial normal would shade the flare as though it were still
 * a vertical cylinder, which under a fog dome — where the only shape
 * information in the frame is how much sky a surface can see — deletes the
 * flare from the picture entirely while leaving it in the silhouette. The same
 * argument covers the spur lobes in the angular direction.
 */
function sweep(
  m: Mesh, st: Station[], sides: number, uSpan: number, tone: number,
  profile: (a: number, s: number) => number,
  /* `wx`/`wz` are the world-space horizontal components of the vertex normal.
   * Passed rather than derived from `a` because the ring frame is parallel
   * transported along the piece and its zero bearing drifts with any lean — on
   * a stem tipped over 30 degrees the two disagree by most of a bin, which puts
   * a bole's lit side on the wrong bearing exactly where the geometry is most
   * conspicuous. */
  skin: (a: number, s: number, y: number, upness: number, out: Skin,
         wx: number, wz: number) => void,
  capEnd: boolean,
  /* Spiral grain, in whole texture tiles per turn round the piece.
   *
   * Conifer wood is very often spiral-grained and a weathered snag shows it
   * plainly, because the checks open along the fibres — a barkless stem with
   * dead-vertical cracks is the one thing that reads as a lathe-turned dowel
   * rather than as a tree. It cannot be baked in: a rotation or a shear inside
   * the bake breaks the lattice wrap, and the map then seams horizontally every
   * 1.4 m up every trunk in the wood. Twisting the *uv* does it exactly, and it
   * is free, provided the twist is a whole number of tiles per turn so that the
   * duplicated seam column still lands on the same texel.
   */
  vTwist = 0,
  /** Passed through to `splinterCap`; see the note on `minRise` there. */
  capRise = 0,
): void {
  const rings: number[] = [];
  const out: Skin = { weather: 0, moss: 0, occ: 1 };
  const E = 0.035;

  for (let i = 0; i < st.length; i++) {
    const f = st[i];
    const prev = st[Math.max(0, i - 1)];
    const next = st[Math.min(st.length - 1, i + 1)];
    rings.push(m.count);

    for (let j = 0; j <= sides; j++) {
      const a = (j / sides) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      const erx = f.nx * ca + f.bx * sa;
      const ery = f.ny * ca + f.by * sa;
      const erz = f.nz * ca + f.bz * sa;
      const etx = -f.nx * sa + f.bx * ca;
      const ety = -f.ny * sa + f.by * ca;
      const etz = -f.nz * sa + f.bz * ca;

      const pr = profile(a, f.s);
      const dpa = (profile(a + E, f.s) - profile(a - E, f.s)) / (2 * E);
      const R = f.r * pr;

      const px = f.cx + erx * R, py = f.cy + ery * R, pz = f.cz + erz * R;

      // Tangent around the ring.
      const Rda = f.r * dpa;
      const tax = erx * Rda + etx * R;
      const tay = ery * Rda + ety * R;
      const taz = erz * Rda + etz * R;

      /* Tangent along the piece. The profile is evaluated once at this angle
       * rather than at the neighbouring rings' angles: the frame rotates by
       * well under a degree between stations, so the same `a` is the same
       * place on the section, and the third profile call per vertex costs more
       * than the approximation does. */
      const rPrev = prev.r * profile(a, prev.s);
      const rNext = next.r * profile(a, next.s);
      const tsx = (next.cx - prev.cx) * 0.5 + erx * (rNext - rPrev) * 0.5;
      const tsy = (next.cy - prev.cy) * 0.5 + ery * (rNext - rPrev) * 0.5;
      const tsz = (next.cz - prev.cz) * 0.5 + erz * (rNext - rPrev) * 0.5;

      let nx = tay * tsz - taz * tsy;
      let ny = taz * tsx - tax * tsz;
      let nz = tax * tsy - tay * tsx;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      // The cross product's sign depends on the winding; force it outward.
      if (nx * erx + ny * ery + nz * erz < 0) { nx = -nx; ny = -ny; nz = -nz; }

      skin(a, f.s, py, clamp(ny, 0, 1), out, nx, nz);
      m.vert(px, py, pz, nx, ny, nz,
             (j / sides) * uSpan, f.v / BARK_PATCH + (j / sides) * vTwist,
             tone, out.weather, out.moss, out.occ);
    }
  }

  /* The ring order here is the whole of the "I can see inside the trees" fault,
   * and it was inverted for the entire life of this file.
   *
   * `quad(a,b,c,d)` emits a,b,c and a,c,d, so the traversal order is the
   * winding. Going up the piece first — (i,j), (i+1,j), (i+1,j+1), (i,j+1) —
   * winds every lateral quad the opposite way from its own vertex normal,
   * which the loop above explicitly forces outward. The wood material is
   * FrontSide, so the near wall of every bole, snag, leaner, log, limb and
   * stick in the wood was culled and what the camera saw was the *inside of
   * the far wall*, one diameter too far away and carrying an outward normal
   * that made it look like perfectly ordinary bark.
   *
   * That is why it survived so long. The silhouette of an inside-out tube is
   * the silhouette of the tube, the shading under a rotationally symmetric fog
   * dome is close enough either way, and the bark texture is the same texture.
   * What gives it away is depth: everything that should have been hidden by
   * the near wall — branch stubs, the moss on the camera side, the far half of
   * anything passing behind — draws in front of the "trunk surface", and the
   * concave interior curvature reads as a folded card rather than as a bole.
   * Measured by auditing the geometric normal of each triangle against its own
   * vertex normal: 2630-2659 of every 3000 triangles sampled disagreed, across
   * all thirty-one tree tiles. The ~12% that agreed are the splinter caps and
   * the root plates, which are wound in their own code and are correct.
   *
   * jungle-trail's `addTube` had exactly this bug for four passes and its file
   * header documents both the symptom and the audit that caught it; this is its
   * descendant and it inherited the fault without the fix. Re-run the audit
   * after any change in here. */
  const row = sides + 1;
  for (let i = 0; i < st.length - 1; i++) {
    const a = rings[i], b = rings[i + 1];
    for (let j = 0; j < sides; j++) {
      m.quad(a + j, a + j + 1, b + j + 1, b + j);
    }
  }

  if (capEnd) splinterCap(m, st[st.length - 1], sides, tone, profile, capRise);
}

/**
 * A snapped end.
 *
 * Wood does not break square across the grain — the fibres run lengthwise, so a
 * break is long and ragged and half the section is still standing when the
 * other half has gone. A flat disc at full radius is what made System 1's
 * sticks read as vacuum hose, and on a snag top it would be worse, because a
 * broken snag top is one of the few pieces of tree geometry a viewer has a
 * strong prior about.
 *
 * The rim is jittered in both radius and axial position from a hash of the ring
 * angle, so the break is stable across builds, and the apex is pushed well past
 * it — which turns the cap into a jagged crown rather than a lid.
 */
function splinterCap(
  m: Mesh, f: Station, sides: number, tone: number,
  profile: (a: number, s: number) => number,
  /* A floor on the splinter length, in metres, for the cases where scaling it
   * off the radius is not enough.
   *
   * A break is a *fracture*, and a fracture in a conifer stem runs along the
   * grain for a length set by the wood, not by how thick the stem happened to
   * be — a snapped top of any diameter leaves spikes a third of a metre to well
   * over a metre long. Scaled off the radius alone, a 6 cm pole got a 5 cm
   * average rise, which nineteen metres away is two pixels: the review found
   * "at least three pale stems ending in a horizontal cut", and they are ending
   * in a splinter crown too small to resolve. Left at zero for stub ends and
   * log ends, where the radius is the right scale and the object is close. */
  minRise = 0,
): void {
  const tx = f.bz * f.ny - f.by * f.nz;
  const ty = f.bx * f.nz - f.bz * f.nx;
  const tz = f.by * f.nx - f.bx * f.ny;

  /* One side of the break long and the other short.
   *
   * A symmetric crown of splinters is a crown, and at any distance where the
   * individual spikes stop resolving it averages back to the flat lid it was
   * meant to replace. What survives the averaging is the *asymmetry*: a real
   * snap tears out a long tongue on one side and leaves a short step on the
   * other, so the silhouette at range is a diagonal rather than a horizontal
   * however few pixels it is drawn in. Phase from the station's own position so
   * two stems in the same frame do not break the same way. */
  const ph = hash1(f.cx * 3.1 + f.cz * 7.7 + f.cy) * Math.PI * 2;
  const spike = Math.max(f.r * 2.1, minRise);

  /* The apex carries the spike too, and this is the rest of the flat-top bug.
   *
   * It used to sit at half a radius above the last ring whatever `minRise`
   * said, so on a 6 cm snag asking for a 45 cm break the centre of the cap rose
   * 3 cm and only the rim moved: measured on one stem the whole crown stood
   * 12 cm proud of its last ring, which at eight metres is nine pixels of
   * ragged edge on a lid and at twenty is two. The break read as a horizontal
   * cut in every capture and three revisions of `minRise` could not fix it,
   * because the term was being applied to a fifth of the cap's geometry.
   *
   * The rim floor moves with it for the same reason. A splinter crown whose
   * short side is 5% of the long one averages, at any distance where the spikes
   * stop resolving, back to a flat rim; a third is enough that the mean of the
   * silhouette is a break rather than a cut. */
  const rApex = Math.max(f.r * 0.5, minRise * 0.62);
  const apex = m.vert(
    f.cx + tx * rApex, f.cy + ty * rApex, f.cz + tz * rApex,
    tx, ty, tz, 0.5, f.v / BARK_PATCH,
    /* A fresh break shows heartwood, which is the palest wood on the tree and
     * the reason a broken top reads as broken rather than as cut. */
    tone, 1, 0, 0.72,
  );
  const first = m.count;
  for (let j = 0; j <= sides; j++) {
    const a = (j / sides) * Math.PI * 2;
    const ca = Math.cos(a), sa = Math.sin(a);
    const erx = f.nx * ca + f.bx * sa;
    const ery = f.ny * ca + f.by * sa;
    const erz = f.nz * ca + f.bz * sa;
    const jag = hash1(a * 7.31 + f.cy * 3.7 + f.cx);
    const R = f.r * profile(a, f.s) * (0.55 + 0.62 * jag);
    const lobe = 0.5 + 0.5 * Math.cos(a - ph);
    const rise = spike * (0.30 + 0.70 * lobe * lobe * (0.30 + 0.70 * jag));
    m.vert(
      f.cx + erx * R + tx * rise, f.cy + ery * R + ty * rise, f.cz + erz * R + tz * rise,
      tx, ty, tz, 0.5 + ca * 0.5, f.v / BARK_PATCH + 0.5 * sa,
      tone, 1, 0, 0.72,
    );
  }
  for (let j = 0; j < sides; j++) m.tri(apex, first + j, first + j + 1);
}

function hash1(x: number): number {
  const h = Math.sin(x * 127.1 + 43.7) * 43758.5453;
  return h - Math.floor(h);
}

/* ── The bole ────────────────────────────────────────────────────────────── */

/**
 * One standing stem, from the soil line to its top.
 *
 * Ring heights are geometric rather than uniform, and the ratio is the one
 * number in this function that changes the picture: the flare and the spur
 * roots live in the bottom 1.3 m of a 35 m bole, so a uniform twenty rings puts
 * one sample inside the entire feature and the flare then exists in the profile
 * function and not in the geometry. Sixteen centimetres at the base growing by
 * 42% a step gives eight rings in the first three metres — which is the part of
 * the tree anyone on this trail can actually look at — for fifteen rings
 * overall.
 */
function bole(m: Mesh, t: TreeSpec, rng: Rng): number {
  const f = FORM[t.sp];

  /* Radius as a function of height above the soil line.
   *
   * Two regimes joined. Through the lower bole it is the species' linear taper,
   * which is what the forestry figure describes and what the eye measures
   * against the trunk beside it; above the base of the live crown it falls away
   * fast, because that is where the stem is still putting on leader growth. The
   * crossover is `crown`, as a fraction of full height.
   */
  const rad = (y: number): number => {
    const s = y / t.hFull;
    let r = Math.max(t.r0 * 0.10, t.r0 - f.taper * y);
    r *= 1 - 0.70 * smoothstep(f.crown, 1.0, s);
    /* The flare. Squared falloff rather than linear: a linear one leaves a
     * visible kink running horizontally round the trunk where it reaches zero,
     * and a horizontal line on a bole is the one thing that says "two
     * primitives joined here". */
    const fl = Math.max(0, 1 - y / f.flareH);
    return r * (1 + f.flare * fl * fl * (0.6 + 0.4 * fl));
  };

  /* Where the stem stops being an object and starts being a hairline.
   *
   * Every conifer tapers to a needle point and on a 45 m fir that point is out
   * of frame, so it cost nothing until the understory poles arrived: a 5 m
   * sapling is 3 cm through at its top, which nineteen metres away is two
   * pixels of near-black against near-white fog. Nine of them in a frame read
   * as hairs on the negative, and the capture was rejected for exactly that.
   *
   * Truncating at a 4.5 cm radius and breaking the stem there rather than
   * thinning the taper, because a suppressed sapling standing in deep shade
   * under a closed canopy has usually lost its leader — a dead broken top is
   * both what the reference photographs show and the only ending that does not
   * need a whip. On anything with a real crown the threshold is met tens of
   * metres up and the shape is unchanged.
   *
   * The floor under it is the part that was missing and the part that turned
   * the fix into the next defect. Left unbounded this will happily return the
   * bottom 1.6 m of a 5.5 m stem, and a stem drawn at 29% of its height has no
   * taper left in it, no crown thinning, and a break at the widest part of the
   * bole — a fence post. The pole form above is sized so that this bound is
   * never the binding constraint; it is here so that no future change to a
   * diameter distribution can quietly reintroduce the stakes.
   */
  const R_TIP = 0.045;
  let hDraw = t.h;
  for (let y = t.h; y > 0.5; y -= 0.05) {
    if (rad(y) >= R_TIP) { hDraw = y; break; }
    hDraw = y;
  }
  hDraw = Math.max(hDraw, t.h * 0.72);
  const broken = hDraw < t.h - 0.06;

  const ys: number[] = [];
  {
    let y = 0, step = 0.10;
    while (y < hDraw - 1e-6) {
      ys.push(y);
      step = Math.min(step * 1.34, Math.max(1.2, hDraw / 7));
      y += step;
    }
    ys.push(hDraw);
  }

  /* The spur roots.
   *
   * These are what stop the flare being a smooth cone. Each is a gaussian lobe
   * in azimuth whose amplitude dies out over its own height, so the bole
   * *becomes* the spur rather than having one attached: there is no seam,
   * because there is only one surface. A Doug-fir has four to six of them and
   * they are the reason the base of the tree has a plan outline like a starfish
   * rather than a circle.
   */
  const spurs: { a: number; h: number; w: number; amp: number }[] = [];
  for (let i = 0; i < f.spurs; i++) {
    spurs.push({
      a: (i / f.spurs) * Math.PI * 2 + rng.range(-0.5, 0.5),
      h: f.flareH * rng.range(0.55, 1.25),
      /* Wide lobes. At the 0.28-0.52 radians this started on, each spur was a
       * gaussian a sixth of the circumference across at full flare amplitude,
       * which builds a thin radial fin rather than a swelling — the first
       * capture had every trunk standing on something like a webbed foot. A real
       * root spur is a broad shoulder of the bole that happens to be higher on
       * one bearing than another. */
      w: rng.range(0.45, 0.85),
      amp: f.flare * rng.range(0.45, 0.95),
    });
  }

  /* Out-of-round. Three harmonics whose phase drifts with height, which is what
   * makes the lumps run up the bole as a slow spiral rather than as parallel
   * flutes — a straight flute at 16 facets reads as a machined column. */
  const f1 = 3 + ((rng.f() * 3) | 0);
  const f2 = f1 + 3 + ((rng.f() * 3) | 0);
  const f3 = f2 + 5 + ((rng.f() * 5) | 0);
  const p1 = rng.range(0, 6.283), p2 = rng.range(0, 6.283), p3 = rng.range(0, 6.283);
  const drift = rng.range(-1.4, 1.4);

  const profile = (a: number, s: number): number => {
    const y = s * t.h;
    let e = 1 + f.lump * (
      0.54 * Math.cos(f1 * a + p1 + s * drift)
      + 0.30 * Math.cos(f2 * a + p2 - s * drift * 0.7)
      + 0.16 * Math.cos(f3 * a + p3 + s * drift * 2.1)
    ) * (0.35 + 0.65 * (1 - Math.min(1, y / Math.max(4, t.h * 0.4))));
    if (y < f.flareH * 1.3) {
      for (const sp of spurs) {
        let d = a - sp.a;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        const fade = Math.max(0, 1 - y / sp.h);
        e += sp.amp * Math.exp(-(d * d) / (sp.w * sp.w)) * fade * fade;
      }
    }
    return e;
  };

  /* The centreline.
   *
   * A lean is a curve, not a tilt. A tree that leans has grown into the lean
   * over a century and its lower bole is close to vertical while its top is
   * well off plumb, so the offset goes as height to the 1.4 rather than
   * linearly. Two slow harmonics on top of that give the bole the wander a real
   * one has — a metre of lateral drift over thirty, which is invisible as a
   * shape and is the difference between a stem and a mast in silhouette.
   */
  const lx = Math.cos(t.leanAz) * Math.sin(t.lean);
  const lz = Math.sin(t.leanAz) * Math.sin(t.lean);
  /* Under one full cycle over the height, at a third of the original amplitude.
   *
   * The comment below describes "a metre of lateral drift over thirty" and the
   * first numbers delivered something else entirely: up to 4.4 complete cycles
   * at an amplitude of 2.2% of the height, which on a 40 m stem is four wiggles
   * of plus or minus 0.9 m. That is not drift, it is a sine wave, and it is what
   * made the stand read as noodles — the S-curve was legible on nearly every
   * bole in the frame at once, which no real stand has.
   *
   * The correction went too far the other way at 0.2-0.6% and under half a
   * cycle, which is a lateral drift of eight centimetres over a forty metre
   * stem: a ruled line. The number that decides this is not the amplitude, it is
   * the *cycle count* — below one cycle the eye cannot close the shape into a
   * wave and reads any amplitude you like as the stem not being quite straight,
   * and above one it reads the smallest amplitude as a wiggle. So the frequency
   * stays capped under one and the amplitude goes back up to where it does
   * something: 0.6-1.4% is half a metre over thirty, which is what a real bole
   * wanders and is legible against the stem beside it.
   */
  const wf1 = rng.range(0.30, 0.62), wf2 = rng.range(0.55, 0.95);
  const wp1 = rng.range(0, 6.283), wp2 = rng.range(0, 6.283);
  const wamp = t.h * rng.range(0.006, 0.014);
  /* Basal sweep. Squared falloff over the bottom fifth, so the curvature is
   * concentrated in the first few metres and the stem is straight above it —
   * a J and not a bow. Zero on four stems in five. */
  const swAmp = t.sweep * t.h;
  const swx = Math.cos(t.sweepAz) * swAmp, swz = Math.sin(t.sweepAz) * swAmp;
  const swH = Math.max(2.2, t.h * 0.18);
  const centre = (y: number): [number, number, number] => {
    const u = y / t.h;
    const bend = Math.pow(u, 1.4) * t.h;
    const g = Math.max(0, 1 - y / swH);
    const sw = g * g;
    const wx = Math.sin(u * wf1 * 6.283 + wp1) * wamp;
    const wz = Math.cos(u * wf2 * 6.283 + wp2) * wamp;
    return [
      t.x + lx * bend + wx + swx * sw,
      t.base + y * Math.cos(t.lean),
      t.z + lz * bend + wz + swz * sw,
    ];
  };

  /* Facet count from the circumference, not from the species. One facet every
   * 13 cm of bark: below that the flat facets and their value steps are the
   * "segmented cylinder" read that the props' roots were taken to 14 sides to
   * fix, and above it the extra triangles buy nothing a normal map is not
   * already carrying. */
  const rRef = t.r0 * (1 + f.flare * 0.4);
  const sides = clamp(Math.round((2 * Math.PI * rRef) / 0.13), 7, 18);
  /* An integral number of texture tiles round the bole. u wraps, so a
   * fractional span puts a hard seam down the full length of every trunk in the
   * wood — and since the wrap is the same place on every one of them, that seam
   * is a straight vertical line repeated forty times across the frame. Stretching
   * the map to fit is free by comparison; bark on a flared bole is stretched
   * anyway. */
  /* `barkScale` is the one species cue in the *material*, and it is a real one:
   * Doug-fir carries broad corky ridges at a 7-10 cm pitch, hemlock is finer
   * and scalier at about half that, and redcedar is not furrowed at all — it is
   * a curtain of narrow vertical fibre strips. Squeezing the same bake round the
   * bole harder is a surprisingly good stand-in for the third of those, because
   * what distinguishes cedar bark at any distance the fog allows is the *pitch*
   * of the vertical lines and not what happens between them. */
  const uSpan = Math.max(1, Math.round((2 * Math.PI * rRef) / (BARK_PATCH * f.barkScale)));

  const st: Station[] = [];
  let prevN: [number, number, number] = [1, 0, 0];
  let arc = 0;
  for (let i = 0; i < ys.length; i++) {
    const y = ys[i];
    const [cx, cy, cz] = centre(y);
    const yb = ys[Math.max(0, i - 1)], yf = ys[Math.min(ys.length - 1, i + 1)];
    const [ax, ay, az] = centre(yb);
    const [bx2, by2, bz2] = centre(yf);
    let tx = bx2 - ax, ty = by2 - ay, tz = bz2 - az;
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl; ty /= tl; tz /= tl;
    if (i > 0) {
      const p = st[i - 1];
      arc += Math.hypot(cx - p.cx, cy - p.cy, cz - p.cz);
    }
    const s: Station = {
      cx, cy, cz,
      nx: 0, ny: 0, nz: 0, bx: 0, by: 0, bz: 0,
      r: rad(y), s: y / t.h, v: arc,
    };
    frameFrom(s, tx, ty, tz, prevN[0], prevN[1], prevN[2]);
    prevN = [s.nx, s.ny, s.nz];
    st.push(s);
  }

  /* Bark, moss and the contact darkening.
   *
   * `weather` is what selects between the bark set and the barkless silver-grey
   * set in the material. A live tree is 0 everywhere. A snag is not 1
   * everywhere: bark comes off a dead conifer in long vertical straps over a
   * decade or two, so a snag that has been dead five years is mostly bark with
   * bare strips and one that has been dead thirty is bare with a few straps
   * still hanging. That two-tone striping is the most recognisable thing about
   * a snag and it costs one noise lookup.
   */
  const strapPh = rng.range(0, 6.283);
  const strapF = rng.range(1.4, 3.2);
  const shed = t.dead ? rng.range(0.25, 0.95) : 0;
  const mossTop = t.base + rng.range(1.8, 5.0) * (t.sp === 'pole' ? 0.45 : 1);
  const mossPh = rng.range(0, 6.283);
  /* A per-tree *coverage* rather than a per-tree strength, and the distinction
   * is the whole reason trunk moss took four captures to appear.
   *
   * Scaling the whole mask by a 0.62-1.0 factor produced an attribute whose mean
   * over the wood was 0.099 with 8% of vertices above a half — so the material
   * was mixing 20% moss into 80% bark nearly everywhere it fired. Substituting a
   * bright magenta for the moss map showed the mask itself was large and
   * correctly placed: broad vertical bands up the weather side of every bole.
   * The map was fine and the *blend weight* was the bug, and it is invisible in
   * a render because a 20% mix of two dark surfaces is one dark surface.
   *
   * Moss is a colony. A trunk either has a patch of it or it does not, and what
   * varies between trees is how much of the circumference is taken, not how
   * strongly it is taken. So the per-tree number is now a threshold. */
  /* Both raised hard, because the shipped pair put moss on 88% of the stems in
   * the wood and took most of the circumference of each one.
   *
   * The owner walking the build at full screen reported a near trunk as a
   * smooth green cylinder with the furrows buried. Most of that turned out to
   * be a post-processing noise artefact rather than this file -- see the note
   * on LIFT_SAT_FLOOR in post.tsx -- but not all of it, and the underlying
   * numbers were wrong on their own terms. Moss on a bole is a colony that has
   * found one damp face of one tree; a stand where seven trees in eight are
   * mossed over half their circumference is a stand under a waterfall.
   *
   * Set by sweeping against the fraction of bole vertices carrying more than
   * half moss, because the mean of the attribute is a useless target -- it is
   * diluted by thirty-five metres of bare bole above the band and reads 0.002
   * for a stand with visible cushions on it. 0.46/0.74 with the height falloff
   * below took that fraction to 0.0008 and put no moss on any bole in any of
   * the eight framings, which is a different wrong answer.
   *
   * Re-set a second time after the winding fix in `sweep`, and the reason is
   * worth recording because it invalidated a whole round of tuning. While the
   * lateral surface was inside-out the camera was seeing the *far* wall of
   * every bole, which is the lee side -- so every moss measurement taken from
   * a render, including the ones that produced the numbers above, was of the
   * dry face. With the near wall drawing, the damp face is the one in frame
   * and the same coefficients cover the whole visible bole in a solid green
   * collar: exactly the defect the owner reported, arrived at from the other
   * direction. Judge trunk moss only on the weather side from now on. */
  const mossGate = rng.range(0.52, 0.78);
  const mossy = t.sp === 'pole' ? rng.chance(0.34) : rng.chance(0.62);

  let bareEdge = 0;
  const skin = (a: number, s: number, y: number, upness: number, out: Skin,
                wx: number, wz: number): void => {
    bareEdge = 0;
    if (shed > 0) {
      /* Straps run up the bole, so the field is mostly a function of angle with
       * a slow drift in height. Thresholded rather than faded: a strap of bark
       * has a torn edge, and a smooth crossfade between bark and bare wood
       * reads as a stain.
       *
       * Three harmonics summed, not two multiplied, and the shed fraction is a
       * threshold on the sum rather than a bias subtracted from it. The product
       * form has its mass piled up near a half, so subtracting 0.55 of it from a
       * shed of 0.9 and multiplying by three saturated over about nine tenths of
       * the bole: what was meant to be a few hanging straps came out as one bare
       * face the full height of the tree, and at 2x it was the largest and
       * flattest object in the crop. Thresholding a spread field gives the bare
       * fraction the caller actually asked for. */
      const f3 = 0.5
        + 0.30 * Math.sin(a * strapF + strapPh + s * 4.1)
        + 0.24 * Math.sin(a * (strapF * 1.7 + 1) - strapPh * 0.6 + s * 1.7)
        + 0.16 * Math.sin(a * (strapF * 2.9 + 2) + s * 7.3 + strapPh * 2.2);
      const th = 0.22 + 0.58 * (1 - shed);
      out.weather = clamp(smoothstep(th - 0.05, th + 0.05, f3), 0, 1);
      /* Doug-fir bark is 10-15 cm thick, so where a strap has come away the
       * exposed sapwood is at the bottom of a step that deep and the bark edge
       * overhangs it. Without the step the two surfaces are coplanar and the
       * boundary is a printed line — which is what made the bare face read as a
       * decal rather than as wood under missing bark. */
      bareEdge = smoothstep(th - 0.16, th - 0.02, f3) * (1 - smoothstep(th + 0.02, th + 0.18, f3));
    } else {
      out.weather = 0;
    }

    /* Moss and the algal film.
     *
     * Not a coat. A trunk evenly furred to three metres reads as a green column
     * and buries the bark, which is the whole reason the bark exists — the same
     * failure jungle-trail's tree builder records. Real trunk moss is heaviest
     * on the weather side, stops at a ragged line, and leaves plenty of bare
     * bark between patches. Two angular harmonics thresholded against a height
     * band gives that, and the damp-side bias is what stops every trunk in the
     * frame being mossed identically all the way round.
     */
    /* Full strength through the bottom two thirds of the band and then a fast
     * ramp out, rather than a smoothstep across the whole of it.
     *
     * The gradual version is what kept `aMoss` at a mean of 0.085 after the gate
     * was already corrected: even where the patch field fired completely, the
     * height ramp was multiplying it by a half, so almost nothing on any bole
     * ever reached full moss and the material never got past a faint tint. Moss
     * climbing a trunk does not fade out with height — it stops, at a line, and
     * the line is ragged. */
    /* A real falloff, replacing "full strength through the bottom two thirds and
     * then a fast ramp out".
     *
     * The note above is right that moss climbing a trunk stops at a ragged line
     * rather than fading, and wrong about where the raggedness comes from. The
     * line is ragged because the *patch* field is ragged, and thresholding a
     * graded height band against a ragged patch field produces exactly the
     * ragged line it wants -- while also getting the thing the flat band cannot
     * have at any threshold, which is more moss low down than high up. Every
     * photograph of a mossed bole shows that gradient: the cushion is deepest
     * in the first metre where splash keeps it wet and the litter banks against
     * it, and it thins upward. The flat band gave a uniform collar with a hard
     * top edge, which is a sock.
     *
     * The multiplier below also loses its 0.45 floor. With the floor, the field
     * never fell to zero anywhere on the bole, so the only thing deciding
     * whether the crown of a forty-metre tree was mossy was the patch field --
     * and a threshold on a field with no height information in it is a stripe
     * running the full height of the trunk, which is what 78.png showed. */
    const hUp = (y - t.base) / Math.max(0.6, mossTop - t.base);
    const band = clamp(1.30 - 1.55 * hUp, 0, 1);
    let d = a - DAMP_AZ;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    /* Widened from 0.68 + 0.32 cos(d), which never let the dry side of a bole
     * fall below two thirds of the damp side and so was not really a bias at
     * all. A trunk in this forest is mossed on the side the weather comes from
     * and close to clean on the lee, and that asymmetry is most of what stops a
     * mossed stand reading as painted. */
    const side = 0.40 + 0.60 * Math.cos(d);
    const patch = 0.5 + 0.32 * Math.sin(a * 2.1 + mossPh)
      + 0.22 * Math.sin(a * 5.3 - mossPh * 1.7 + s * 21)
      + 0.16 * Math.sin(s * 47 + mossPh);
    /* Crisp, and thresholded below the field's own mean.
     *
     * Measured over the whole wood, the first two builds put `aMoss` at a mean
     * of 0.051 with 3.5% of vertices above a half — which is not a moss patch,
     * it is a five percent green wash, and it rendered as literally nothing:
     * three captures went by with an explicit trunk-moss term in the geometry
     * and not one green pixel on a bole. The gate was set at 0.50 against a
     * product whose mean is 0.34, so it fired in the tail. Moss is a colony: it
     * either holds a piece of bark or it does not, and the edge is one you could
     * cut round. Same correction the ground's moss needed, arrived at the same
     * way — by looking at the distribution rather than at the picture. */
    /* And it fills the flutes. Water runs down the grooves between the spur
     * roots and stands in the crotch at the bottom of each one, so that is where
     * the moss on a real bole is thickest and where it reaches highest — which
     * is also the one place the flare's own shape needs help being read. */
    const groove = clamp((1 - profile(a, s)) * 3.2, 0, 1);
    /* The flute term biases the field the threshold is applied to; it does not
     * get added on top of the result.
     *
     * Added, it was the one part of the mask that had never been through the
     * gate, so it arrived as a smooth function of a smooth function — and a 3x
     * crop of a redcedar found what that looks like: a soft-edged pale plume
     * airbrushed a full four metres up the middle of the bole, following the
     * deepest flute, with no cushion structure anywhere in it. It was also the
     * single lightest thing on a trunk in a build whose whole purpose was to
     * stop trunks being light. Biasing instead keeps the behaviour that was
     * wanted — moss reaches highest where water runs — while every edge in the
     * mask stays an edge you could cut round. */
    out.moss = mossy
      ? smoothstep(mossGate, mossGate + 0.06,
                   (patch * side + groove * 0.42) * band)
      : 0;

    /* Contact. The metre of bole nearest the litter sees almost no sky: the
     * floor takes the whole lower hemisphere, the spur crotches take most of
     * what is left, and there is a drift of needles banked against it. A bole
     * evenly lit right down to the soil line is the clearest possible sign that
     * a tree has been placed on the terrain rather than grown out of it, and
     * with no shadow map in this scene occlusion is the only channel that can
     * say so.
     *
     * Multiplied by the flute term, so the grooves between the spur roots are
     * darker than the ridges — which is the only reason the flare has any
     * internal shape at all under a uniform dome.
     */
    const h = y - t.base;
    const contact = 0.34 + 0.66 * smoothstep(0, 1.35, h);
    const flute = clamp(1 - 1.5 * Math.max(0, 1 - profile(a, s)), 0.55, 1);
    /* Upward-facing bark holds water and litter and sees the sky; the undersides
     * of the spur lobes see the ground. A small term and it is what gives a
     * flared base its top-lighting without a light. */
    /* Canopy closure, and it is the term that decides whether the frame reads
     * as Douglas-fir or as birch.
     *
     * A bole standing in a closed stand does not see a hemisphere. It sees the
     * forty or fifty other stems around it, a roof twenty metres up, and a floor
     * — measured sky view factor on the lower bole in a stand of this density is
     * somewhere near a half. Nothing else in this renderer can say so: there is
     * no shadow map, the environment is a uniform dome, and the neighbouring
     * trunks that do the occluding are not consulted by anything.
     *
     * Without it the near boles measured 72, 92 and 105 against a duff of 51 —
     * lighter than the ground in every case, which is the whole of why the stand
     * read as aspen. It belongs here rather than in the bark map's AO floor
     * because it is a property of the object and the maps are shared with every
     * log and stick on the floor, which are *not* in a closed stand and which
     * went black when the correction was tried there. */
    /* And it varies with which way the surface is facing, which is the whole of
     * what makes a bole read as round.
     *
     * The constant 0.60 that used to sit here was the right idea applied to the
     * wrong axis. It darkened every trunk in the wood by the same factor on
     * every bearing, which fixed "the stand reads as birch" and left "the stand
     * reads as flats painted on glass": measured across a 152 px mid-ground bole
     * the luma ran 100, 102, 91, 101, 91, 93, 87, 95, 95, 92, 111 — a spread of
     * fifteen, most of it noise, with no terminator anywhere in it.
     *
     * `t.sky` is the cosine-weighted view factor by bearing computed from the
     * actual neighbours; see `skyView`. The remap below is chosen so the *mean*
     * of the term over a typical stem stays near the 0.60 it replaces — the
     * trunks must not get lighter overall, that was the previous defect — while
     * the spread between the open side and the crowded side is about 2:1.
     * Under this fog a mid-ground bole contributes only ten to twenty luma over
     * a black object at the same depth, so a ratio is the only thing that
     * survives; an additive term disappears into the eighth bit. */
    let closure = 0.62;
    if (t.sky) {
      /* Set against the measured distribution rather than by eye. `skyAt` is
       * normalised to a stand mean of 1 and now spans roughly 0.66 to 1.34
       * around a bole, so 0.58 puts the mean closure at 0.58 and the two ends
       * at 0.38 and 0.78 — two to one across the bole, with the floor below
       * catching only the handful of stems standing inside a thicket.
       *
       * The floor was 0.13 and that was the defect: multiplied by a bark map
       * whose fissures sit at 0.40 it delivered a total attenuation of 0.05 and
       * a near-black ruler-straight band down a third of every near trunk. A
       * shadowless dome cannot produce a twentieth of its own irradiance
       * anywhere on a convex object. The ceiling on the mean is the duff:
       * measured by surface
       * contribution over fog, the floor beside the trail returns 42 and a bole
       * at the same sort of range returns 26, and a trunk that goes past the
       * ground it stands out of is the failure this whole term was added to
       * cure. Published as `skyMean` and `skySpread` on the forest counts so
       * that a change to the stand density cannot silently move either. */
      closure = clamp(0.58 * skyAt(t.sky, Math.atan2(wz, wx)), 0.30, 0.95);
    }
    out.occ = contact * flute * (0.86 + 0.14 * upness) * (1 - 0.42 * bareEdge) * closure;
  };

  /* Only on stems thick enough that one tile per turn is a shallow angle. A
   * 12 cm pole has a 38 cm circumference, so a single tile of twist on it is 75
   * degrees off vertical — grain running round the stem rather than up it. */
  const twist = 2 * Math.PI * rRef > BARK_PATCH * 2.2
    ? (rng.chance(0.55) ? (rng.chance(0.5) ? 1 : -1) : 0) : 0;
  /* 45 cm of splinter on a snapped stem, and more on a big one. Sized so the
   * break is at least three or four pixels of diagonal at the twenty metres
   * where these stems live, which is the range at which the flat cut was being
   * reported. A tree that ran out of taper rather than snapping — `broken` from
   * the `R_TIP` rule — gets the same treatment, because that is the same event:
   * a suppressed sapling that lost its leader. */
  /* Capped unconditionally, and this is the rest of the flat-top defect.
   *
   * `capEnd` used to be `dead || hungUp || broken`, so a live stem that reached
   * its natural top with radius still above R_TIP got no cap at all and the
   * sweep simply stopped — an open tube with a horizontal rim. On a 40 m fir
   * that rim is out of frame and it cost nothing for three revisions. On the
   * understory poles, which top out between 4.5 and 14 m and sit right in the
   * middle distance, it is a stem ending in a flat cut with nothing above it,
   * which is exactly what the review kept finding and what the R_TIP work
   * failed to fix because R_TIP was never the mechanism. */
  /* A live stem gets a rise too, and this is the last of the flat tops.
   *
   * `capRise` of zero leaves `splinterCap` scaling the break off the tip
   * radius, and on a stem still 7 cm through at its top that is a 2 cm crown on
   * a 14 cm disc — a lid with a texture on it, which is indistinguishable from
   * a flat cut at any range the eye can see it. The natural ending is a leader
   * drawn to a point, so the rise here scales with the tip diameter rather than
   * taking the fixed 45 cm a break gets.
   *
   * It also has a floor now, and dropping the "scales away to nothing on a
   * whip" clause is the point of the change. Scaling away to nothing is exactly
   * what leaves a flat cut: a whip 4 cm through got an 8 cm rise, which at the
   * ten to fifteen metres these stems live at is a dozen pixels of taper on top
   * of a stem fourteen pixels wide, and a dozen pixels of taper is a horizontal
   * line. The review has now found flat-topped poles in three consecutive
   * rounds and each fix has addressed a different mechanism — the missing cap,
   * then the R_TIP truncation, now the cap being too short to see. 45 cm is
   * seventy pixels at that range, which cannot be mistaken for a cut. */
  const snapped = t.dead || t.hungUp || broken;
  sweep(m, st, sides, uSpan, hash1(t.seed), profile, skin, true, twist,
        snapped ? Math.max(0.65, rad(hDraw) * 4.5)
                : clamp(rad(hDraw) * 12, 0.45, 1.40));

  /* Dead lower branch stubs.
   *
   * The single highest-value feature in this file per triangle. In a stand-grown
   * conifer the live crown starts fifteen to twenty-five metres up — out of
   * frame — and what is in frame is fifty years of shed lower limbs, each
   * leaving a short drooping snag with a swollen collar. They are a species cue,
   * an age cue and a stand-density cue at once, and because they break the
   * outline they keep working at every distance the fog allows.
   *
   * They start at 2 m rather than at the ground: the lowest stubs rot away
   * first, so the bottom of a mature bole is clean and the stub density
   * *increases* with height until the live crown. Getting that gradient the
   * wrong way round is what makes a procedural conifer look like a bottle brush.
   */
  let stubs = 0;
  /* Above `hDraw` there is no stem, so anything hung there is hung on nothing.
   * The `to` below used to be taken off `t.h`, and on a stem the R_TIP rule had
   * truncated that put stubs in clear air over the break. */
  const top = Math.min(hDraw, t.h * (t.dead ? 0.95 : f.crown * 1.15));
  if (t.sp !== 'pole' || t.h > 6) {
    const from = Math.min(2.0, t.h * 0.28);
    const pitch = 0.95 / f.stubs;
    for (let y = from; y < top; y += pitch * rng.range(0.6, 1.7)) {
      const dens = smoothstep(from, from + (top - from) * 0.7, y);
      if (!rng.chance(0.20 + 0.38 * dens)) continue;
      const n = rng.chance(0.16) ? 2 : 1;
      for (let k = 0; k < n; k++) {
        stub(m, t, y, rng.range(0, 6.283), rad(y), centre, rng, hash1(t.seed));
        stubs++;
      }
    }
  }

  /* The long dead limbs, which are a different population from the stubs above
   * and not a longer draw from the same one.
   *
   * Where they sit is the whole point: from four metres up to the base of the
   * live crown, which is the shell the histogram says is empty. Below four they
   * have rotted off, above the crown base they are alive and belong to
   * `crown()`. Density rises with height for the same reason the stubs' does —
   * the bole sheds from the bottom — and the length rises with it too, because
   * a limb nearer the live crown died more recently and has had less time to
   * break back.
   *
   * The count is set by what the mid-ground needs rather than by a survey: on a
   * 40 m fir this is fourteen to twenty limbs over twelve metres of bole, which
   * is a limb every 70 cm. That is the right order for a stand-grown conifer
   * that puts out a whorl a year and keeps the dead ones for a decade.
   */
  let limbs = 0;
  {
    const from = Math.max(3.2, t.h * 0.10);
    const to = Math.min(hDraw * 0.98, t.h * (t.dead ? 0.98 : f.crown * 1.25));
    /* Long limbs on a snag are the exception, not the rule: a stem that has
     * been dead long enough to lose its bark has lost most of its branches
     * too, and the ones it keeps are the stoutest. */
    const pitch = (t.dead ? 0.90 : 0.44) * rng.range(0.85, 1.15);
    for (let y = from; y < to; y += pitch * rng.range(0.62, 1.55)) {
      const u = (y - from) / Math.max(0.5, to - from);
      if (!rng.chance(0.40 + 0.50 * u)) continue;
      const rB = rad(y);
      /* Longer towards the crown, and mostly short.
       *
       * The first pass at this put the mean around two metres and the frame
       * came back with every trunk wearing a set of long straight quills. A
       * shed lower limb has been snapping back towards the bole for years, so
       * the distribution is heavily weighted to the short end with a thin tail
       * of survivors — which is also what stops them reading as a regular
       * feature. The cap is the stand's own spacing: much over two and a half
       * metres and limbs on neighbouring stems would be growing through each
       * other. */
      const L = clamp(rB * rng.range(3.6, 11.0) * (0.55 + 0.75 * u) * rng.f() ** 0.55,
                      0.35, 2.5);
      deadLimb(m, y, rng.range(0, 6.283), rB, L, centre, rng, hash1(t.seed + 13), t.dead);
      limbs++;
    }
  }
  return stubs + limbs;
}

/**
 * One dead branch stub.
 *
 * Three things make this read as a wound rather than as a peg, and jungle-trail
 * paid for all three before this file existed: the collar (a shed limb leaves a
 * swollen ring of healing tissue at the bole, so the base is half again as wide
 * as the stub), the droop (a dead branch has sagged well below the angle it grew
 * at, and a stub sticking out horizontally reads as alive), and the break (bare
 * pale heartwood at the end, not bark).
 */
function stub(
  m: Mesh, t: TreeSpec, y: number, az: number, rBole: number,
  centre: (y: number) => [number, number, number], rng: Rng, tone: number,
): void {
  const [cx, cy, cz] = centre(y);
  /* Short, and this number was wrong by a factor of four on the first build.
   * Scaled off the bole radius it came out at 0.5-1.7 m on a mature fir, and a
   * 1.7 m spike sticking horizontally out of a trunk is not a branch stub — the
   * frame came back with every tree wearing a set of antennae. A dead lower
   * branch on a stand-grown conifer snaps within a couple of years of dying and
   * what is left is 5-40 cm. The absolute cap is what enforces that on the
   * veterans, where the radius-scaled figure runs away. */
  const L = clamp(rBole * rng.range(0.7, 2.0), 0.08, 0.38);
  /* It droops, but the sag is bounded well under one length.
   *
   * At 0.55-1.5 the tip fell up to 1.5 times the reach, which over three
   * segments of a u-squared curve is not a sagging limb, it is a hook: the 2x
   * crop came back with a set of black claws round every trunk, and read as
   * ironwork. A dead limb that has *snapped* — which is the only kind still on
   * a bole at this height — is 15-40 cm of stiff wood and the sag over that
   * span is a few degrees off the angle it grew at, not ninety. */
  const droop = rng.range(0.22, 0.70);
  /* Capped in absolute metres, not scaled off the bole.
   *
   * A dead lower branch on a Doug-fir is 3-8 cm through however big the tree
   * is — limb diameter is set by how much crown the branch carried before it
   * was shaded out, and a suppressed lower limb never carried much. Taking a
   * fraction of the bole gave a 1.4 m veteran 16 cm stubs, and with the collar
   * swell on top of that they came out 32 cm across and 42 cm long: the third
   * capture had mushrooms growing out of the trunks, and because the tube is so
   * short relative to its width what the frame actually showed was the *end
   * cap* — a flat five-sided plate stuck on the bark. */
  const r0 = clamp(rBole * 0.11, 0.012, 0.048);
  const dx = Math.cos(az), dz = Math.sin(az);

  const segs = 3;
  const st: Station[] = [];
  let prevN: [number, number, number] = [0, 1, 0];
  for (let i = 0; i <= segs; i++) {
    const u = i / segs;
    const reach = rBole * 0.55 + L * u;
    const drop = -droop * L * u * u;
    const px = cx + dx * reach, py = cy + drop, pz = cz + dz * reach;
    // Axis direction, including the droop, so the tube actually bends.
    const du = 1 / segs;
    const r2 = rBole * 0.55 + L * Math.min(1, u + du);
    const d2 = -droop * L * Math.min(1, u + du) ** 2;
    const r1 = rBole * 0.55 + L * Math.max(0, u - du);
    const d1 = -droop * L * Math.max(0, u - du) ** 2;
    let tx = dx * (r2 - r1), ty = d2 - d1, tz = dz * (r2 - r1);
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl; ty /= tl; tz /= tl;
    /* The collar. Widest at the bole and gone within a third of the stub, then
     * a slow taper to the break. */
    const collar = 1 + 0.62 * Math.max(0, 1 - u * 3.2) ** 1.6;
    const s: Station = {
      cx: px, cy: py, cz: pz,
      nx: 0, ny: 0, nz: 0, bx: 0, by: 0, bz: 0,
      r: r0 * collar * (1 - 0.42 * u),
      s: u, v: u * L,
    };
    frameFrom(s, tx, ty, tz, prevN[0], prevN[1], prevN[2]);
    prevN = [s.nx, s.ny, s.nz];
    st.push(s);
  }

  /* Held well under full even on a snag. Silvered stubs at full strength put a
   * ring of pale spikes round every dead trunk in the frame, which read as bone
   * rather than as wood — a stub that has been dead long enough to lose its bark
   * has also been dead long enough to go the same grey-black as everything else
   * lying on this floor. Only the break itself is bright. */
  /* Weathered over nearly the whole length even on a live tree, and the reason
   * is a mapping constraint rather than a botanical one.
   *
   * `sweep` wraps `uSpan` whole bark tiles round the member, and uSpan cannot go
   * below one because a fractional wrap puts a hard seam down the piece. A stub
   * is 6-10 cm round, so one 1.4 m tile round it is a 4.6x circumferential
   * magnification: the piece gets painted with the *inside of a single fissure*,
   * stretched, and that is why the first captures had black worms hanging off
   * every trunk and not why the geometry was wrong. The snag set is grain rather
   * than plates — 3 mm features, which survive the same stretch as fine lines
   * running the length of the stub, which is what a broken limb looks like
   * anyway. Value is then taken back down through occlusion below, because a
   * stub at full snag brightness is bone. */
  const shed = t.dead ? 0.92 : rng.range(0.62, 0.94);
  const skin = (_a: number, s: number, _y: number, up: number, out: Skin): void => {
    /* Bark survives on the collar and is gone towards the break, which is the
     * gradient a real stub has: the sheltered part under the branch collar is
     * the last bark on a dead limb to come off. */
    out.weather = clamp(shed * smoothstep(0.06, 0.42, s), 0, 1);
    out.moss = 0.30 * (1 - s) * up;
    /* The crotch above the stub is one of the deepest occlusions on a trunk —
     * a wedge of bark facing a wedge of branch — and it is what tells the eye
     * the stub is attached rather than intersecting. */
    out.occ = (0.40 + 0.60 * smoothstep(0.0, 0.45, s)) * (0.80 + 0.20 * up) * 0.80 * DEADWOOD_OCC;
  };

  sweep(m, st, 6, 1, tone, () => 1, skin, true);
}

/**
 * One long dead limb, and the twigs still on it.
 *
 * This is the answer to the mid-ground reading as a woodcut, and the diagnosis
 * is worth writing down because it is a population problem that looks like a
 * shading problem. Measured over the upper 60% of four stops, 31-48% of pixels
 * sat above luma 180 — pure air — and only 19-35% in the 70-150 mid-band. The
 * critic's reference photographs invert that: 7-13% air, 32-69% mid. Nothing in
 * this scene occupied the shell between ten and thirty metres above knee height
 * except bare stems, so every pixel was either wood or sky and the mid-ground
 * came out as cut paper.
 *
 * What fills that shell in a real closed stand is not more trees. It is the
 * fifty years of dead branches each tree is still carrying: a stand-grown
 * conifer sheds its lower crown from below, and the limbs die and hang on for
 * years before they snap. They are thin — 2 to 5 cm — and that thinness is the
 * whole value of them here. A 3 cm limb at twenty metres is a pixel and a half
 * wide, so it does not draw a dark bar; it *partly covers* pixels, and a
 * partly-covered pixel is exactly a mid-band pixel. Sub-pixel clutter is the
 * cheapest way there is to move a bimodal histogram into its middle, and it is
 * also what the reference photographs are full of.
 *
 * The short `stub` above stays for the bole's own silhouette, where a 30 cm nub
 * at four metres is the right object. These are its longer relatives further up.
 */
function deadLimb(
  m: Mesh, y: number, az: number, rBole: number, L: number,
  centre: (y: number) => [number, number, number], rng: Rng, tone: number,
  dead: boolean,
): void {
  const [cx, cy, cz] = centre(y);
  const dx = Math.cos(az), dz = Math.sin(az);

  /* Limb diameter is set by the crown the branch used to carry, not by the
   * tree — the same argument as the crown armature, and the same numbers.
   * Bounded at both ends: below 12 mm it is a hair on the negative at any
   * range, and above 5 cm it stops being a shed lower limb. */
  const r0 = clamp(L * rng.range(0.014, 0.026), 0.012, 0.050);

  /* Three regimes of sag, and the third is the one the review asked for by
   * name. A limb that is still attached and stiff droops a third of its reach;
   * one that has been dead a decade droops most of it; and one in ten has
   * snapped at the collar and is *hanging* — caught by its own twigs on the
   * limb below, pointing almost straight down. Hanging deadwood is listed in
   * the brief and it is the single most conifer-specific thing in this band. */
  const hang = rng.chance(0.11);
  const droop = hang ? rng.range(1.5, 2.6) : rng.range(0.30, 0.95);
  const bendPow = hang ? 1.25 : 1.9;

  const reachAt = (u: number) => rBole * 0.55 + L * u;
  const dropAt = (u: number) => -droop * L * Math.pow(u, bendPow);

  const segs = 4;
  const st: Station[] = [];
  let prevN: [number, number, number] = [0, 1, 0];
  for (let i = 0; i <= segs; i++) {
    const u = i / segs, du = 1 / segs;
    const uA = Math.max(0, u - du), uB = Math.min(1, u + du);
    let tx = dx * (reachAt(uB) - reachAt(uA));
    let ty = dropAt(uB) - dropAt(uA);
    let tz = dz * (reachAt(uB) - reachAt(uA));
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl; ty /= tl; tz /= tl;
    const collar = 1 + 0.70 * Math.max(0, 1 - u * 4.5) ** 1.5;
    const s: Station = {
      cx: cx + dx * reachAt(u), cy: cy + dropAt(u), cz: cz + dz * reachAt(u),
      nx: 0, ny: 0, nz: 0, bx: 0, by: 0, bz: 0,
      r: r0 * collar * (1 - 0.62 * u),
      s: u, v: u * L,
    };
    frameFrom(s, tx, ty, tz, prevN[0], prevN[1], prevN[2]);
    prevN = [s.nx, s.ny, s.nz];
    st.push(s);
  }

  const shed = dead ? 0.95 : rng.range(0.70, 0.98);
  const skin = (_a: number, s: number, _y: number, up: number, out: Skin): void => {
    out.weather = clamp(shed * smoothstep(0.04, 0.36, s), 0, 1);
    out.moss = 0;
    /* Darker than the air behind them at the same depth — that is the whole
     * requirement — and no darker than that.
     *
     * The first version ran 0.18 to 0.45 after the deadwood factor and the
     * histogram said what that costs: the limbs took pixels out of the >180
     * pile and put them straight into the near-black one, so the count above
     * 180 fell seven points and the 70-150 mid-band fell five. A limb is
     * weathered grey wood under a bright dome and it is genuinely lighter than
     * the bark it hangs off; drawing it near-black converts a bimodal histogram
     * into a more strongly bimodal histogram, which is the defect. */
    out.occ = (0.52 + 0.40 * smoothstep(0.0, 0.40, s)) * (0.84 + 0.16 * up) * DEADWOOD_OCC;
  };
  sweep(m, st, 3, 1, tone, () => 1, skin, true);

  /* Secondary twigs, which are most of what actually covers pixels.
   *
   * A bare limb is one line; a limb with four twigs on it is five, for a fifth
   * of the triangles each, and they are what turns a set of spokes into
   * something that reads as twiggy. Two stations and three sides is the
   * cheapest tube that still tapers, and at these diameters nothing else
   * resolves anyway. */
  const nT = 3 + ((rng.f() * 4) | 0);
  for (let k = 0; k < nT; k++) {
    /* Spread along the limb by index rather than drawn independently. Four
     * independent draws on [0.3, 0.92] clump about half the time, and a limb
     * with all its twigs in one place is a limb with a tuft on it rather than a
     * twiggy limb — which is most of why the first pass still read as a quill. */
    const u = 0.22 + 0.72 * ((k + rng.range(0.1, 0.9)) / nT);
    const [bxp, byp, bzp] = [cx + dx * reachAt(u), cy + dropAt(u), cz + dz * reachAt(u)];
    const side = rng.chance(0.5) ? 1 : -1;
    // Off the limb's own bearing, and further down: twigs on a dead branch have
    // sagged past it.
    const ta = az + side * rng.range(0.45, 1.7);
    const tl2 = L * rng.range(0.24, 0.58);
    const tdx = Math.cos(ta), tdz = Math.sin(ta);
    const fall = rng.range(0.5, 1.4);
    const tr0 = r0 * (1 - 0.62 * u) * rng.range(0.35, 0.62);

    const ts: Station[] = [];
    let pN: [number, number, number] = [0, 1, 0];
    for (let i = 0; i <= 2; i++) {
      const v = i / 2;
      const vA = Math.max(0, v - 0.5), vB = Math.min(1, v + 0.5);
      let ax = tdx * tl2 * (vB - vA);
      let ay = -fall * tl2 * (vB * vB - vA * vA);
      let az2 = tdz * tl2 * (vB - vA);
      const al = Math.hypot(ax, ay, az2) || 1;
      ax /= al; ay /= al; az2 /= al;
      const s: Station = {
        cx: bxp + tdx * tl2 * v, cy: byp - fall * tl2 * v * v, cz: bzp + tdz * tl2 * v,
        nx: 0, ny: 0, nz: 0, bx: 0, by: 0, bz: 0,
        r: tr0 * (1 - 0.72 * v), s: v, v: v * tl2,
      };
      frameFrom(s, ax, ay, az2, pN[0], pN[1], pN[2]);
      pN = [s.nx, s.ny, s.nz];
      ts.push(s);
    }
    sweep(m, ts, 3, 1, tone, () => 1, skin, true);
  }
}

/* ── Fallen wood ─────────────────────────────────────────────────────────── */

export type LogSpec = {
  x: number; z: number;
  az: number;
  len: number;
  /** Radius at the butt and at the top. */
  rA: number; rB: number;
  /** 0 fresh windthrow with bark and branches, 1 a nurse log collapsing into
   * the duff. Drives sink depth, moss, weathering and branch survival. */
  decay: number;
  /** Has an upturned root plate at the butt. */
  wad: boolean;
  /** Metres the butt stands off the floor, held up by that plate. */
  lift: number;
  seed: number;
};

/**
 * Where a fallen piece's axis has to be so that it rests on the floor.
 *
 * This is the part of a log that a heightfield cannot help with and that no
 * amount of per-node ground sampling gets right either. A log is *rigid*: it
 * lies on the two or three high points under it and bridges the hollows
 * between them, with daylight under the middle. Following the ground at every
 * node — which is what the props' sticks do, correctly, at 40 cm — gives a
 * twelve-metre log that undulates like a snake, and that is a worse error than
 * floating, because it says the object has no stiffness.
 *
 * So: sample the floor along the axis, fit a least-squares line to it, then
 * slide that line vertically until the *minimum* clearance over the samples is
 * the target. A fresh log therefore touches at its high points and has real
 * gaps under it; a decayed one is pushed down into the duff until most of its
 * length is buried, which is what a nurse log is.
 */
function restLine(
  x: number, z: number, az: number, len: number,
  rAt: (u: number) => number, sink: number,
  /* Anything the builder is going to add to the axis *after* this returns —
   * the prop on the root plate, in practice. It has to be known here or the
   * clearance test is run against a shape that is not the one drawn: the log
   * was rested on the duff first and then the whole butt half was raised by up
   * to 2.9 m, which left several pieces with no point of contact at all. That
   * is the free-floating segment with a flat cut at each end in `03.png`. */
  offset: (u: number) => number = () => 0,
): { y0: number; slope: number; ground: number[] } {
  const dx = Math.cos(az), dz = Math.sin(az);
  const N = 12;
  const g: number[] = [];
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i <= N; i++) {
    const u = i / N;
    const d = (u - 0.5) * len;
    const h = groundHeight(x + dx * d, z + dz * d);
    g.push(h);
    sx += u; sy += h; sxx += u * u; sxy += u * h;
  }
  const n = N + 1;
  const den = n * sxx - sx * sx;
  const slope = Math.abs(den) < 1e-9 ? 0 : (n * sxy - sx * sy) / den;
  const inter = (sy - slope * sx) / n;

  /* The clearance the line has to hold over the worst sample. A fresh log rests
   * with its underside on the duff, so the axis is one radius up; a class-5
   * nurse log has settled until its axis is at the soil line and the litter has
   * come up over its flanks. */
  let worst = Infinity;
  for (let i = 0; i <= N; i++) {
    const u = i / N;
    const want = rAt(u) * (1 - 1.75 * sink);
    const have = inter + slope * u + offset(u) - g[i];
    worst = Math.min(worst, have - want);
  }
  return { y0: inter - worst, slope, ground: g };
}

/**
 * One fallen log.
 *
 * The decay class does nearly all of the work here and it is worth spelling out
 * what each end of it looks like, because "fallen log" covers two completely
 * different objects. A class-1 windthrow is a round, hard, bark-covered stem
 * lying clear of the ground on its own branches with an upturned root plate at
 * the butt. A class-5 nurse log is a soft mound of red-brown punk with no
 * circular section left, half swallowed by the duff, carrying a metre of moss —
 * and it is the most characteristic single object on a Pacific Northwest forest
 * floor. The same builder produces both because everything between them is on
 * one axis.
 */
function fallen(m: Mesh, spec: LogSpec, rng: Rng): number {
  const dx = Math.cos(spec.az), dz = Math.sin(spec.az);
  const tone = hash1(spec.seed);

  /* Taper along the piece, plus the swell at the butt where the root collar is.
   * A log with parallel sides is the same failure as a bole with parallel sides
   * and it is more visible here, because a log is seen from the side across its
   * whole length rather than disappearing into fog. */
  const rAt = (u: number): number => {
    const r = spec.rA + (spec.rB - spec.rA) * u;
    const butt = 1 + 0.45 * Math.max(0, 1 - u * 7) ** 1.5;
    return r * butt;
  };

  /* The butt held up on its own root plate, as a function of position along the
   * piece. Declared before the rest line rather than inside `pt` so the two
   * agree about the shape being placed; see the `offset` argument on
   * `restLine`. Dying over the first third rather than over the whole length,
   * because a windthrow pivots over the ground close behind its plate and lies
   * flat from there on — spreading it over the full length turns every propped
   * log into a ramp, and a floor of ramps is no better than a floor of dowels. */
  const liftAt = (u: number) => spec.lift * Math.max(0, 1 - u / 0.34) ** 1.4;
  const rest = restLine(spec.x, spec.z, spec.az, spec.len, rAt, spec.decay, liftAt);

  /* Sag. A decayed log has lost its stiffness and has broken its own back over
   * the high points it rests on — a class-4 log is visibly swaybacked and that
   * curve is a strong decay cue. A fresh one is straight. */
  const sag = spec.decay * spec.decay * Math.min(0.22, spec.len * 0.022);
  const bowPh = rng.range(0, 6.283);
  const bow = spec.len * rng.range(0.006, 0.020);

  const segs = Math.max(6, Math.round(spec.len / 0.42));
  const st: Station[] = [];
  let prevN: [number, number, number] = [0, 1, 0];
  const pt = (u: number): [number, number, number] => {
    const d = (u - 0.5) * spec.len;
    const drop = -sag * Math.sin(u * Math.PI) * 4 * u * (1 - u);
    const lat = Math.sin(u * 3.1 + bowPh) * bow;
    return [
      spec.x + dx * d - dz * lat,
      rest.y0 + rest.slope * u + drop + liftAt(u),
      spec.z + dz * d + dx * lat,
    ];
  };
  let arc = 0;
  for (let i = 0; i <= segs; i++) {
    const u = i / segs;
    const [cx, cy, cz] = pt(u);
    const du = 0.5 / segs;
    const [ax, ay, az2] = pt(Math.max(0, u - du));
    const [bx, by, bz] = pt(Math.min(1, u + du));
    let tx = bx - ax, ty = by - ay, tz = bz - az2;
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl; ty /= tl; tz /= tl;
    if (i > 0) arc += Math.hypot(cx - st[i - 1].cx, cy - st[i - 1].cy, cz - st[i - 1].cz);
    const s: Station = {
      cx, cy, cz, nx: 0, ny: 0, nz: 0, bx: 0, by: 0, bz: 0,
      r: rAt(u), s: u, v: arc,
    };
    frameFrom(s, tx, ty, tz, prevN[0], prevN[1], prevN[2]);
    prevN = [s.nx, s.ny, s.nz];
    st.push(s);
  }

  /* Section. A fresh log is round; a rotten one has slumped, so it is wider than
   * it is tall and its top has caved. Two harmonics on top of that, with the
   * slump keyed off the ring angle relative to *world up* rather than to the
   * frame, because gravity does not care which way the frame happened to
   * initialise. */
  const f1 = 3 + ((rng.f() * 3) | 0), f2 = f1 + 4;
  const p1 = rng.range(0, 6.283), p2 = rng.range(0, 6.283);
  const lump = 0.05 + 0.09 * spec.decay;
  /* Which ring angle points at the sky. The ring frame is parallel-transported
   * from an arbitrary start, so `a = 0` is not up and gravity has to be told
   * where up is; the frame barely rolls along a straight piece, so one phase
   * taken from the first station is accurate to a few degrees over the whole
   * length. */
  const slumpPh = Math.atan2(st[0].by, st[0].ny);
  const profile = (a: number, s: number): number => {
    let e = 1 + lump * (0.6 * Math.cos(f1 * a + p1 + s * 5) + 0.4 * Math.cos(f2 * a + p2 - s * 3));
    /* Slump. A sound log is round; a rotted one has lost its cell structure and
     * spread under its own weight, so it is wider than it is tall and its crown
     * has caved. That flattened section is a stronger decay cue than any colour,
     * because it changes the object's outline against the floor. */
    const c = Math.cos(a - slumpPh);
    e -= spec.decay * 0.22 * c * Math.abs(c);
    return Math.max(0.35, e);
  };

  const sides = clamp(Math.round((2 * Math.PI * spec.rA) / 0.10), 7, 14);
  const uSpan = Math.max(1, Math.round((2 * Math.PI * spec.rA) / BARK_PATCH));

  /* Where the bark has gone. Sloughs first on the upper surface, where the sun
   * and the rain get at it, and survives longest on the underside — which is
   * why a half-rotted log photographs with a bare grey crown and a dark barked
   * flank, and is a detail that reads instantly as decay when it is present and
   * as plastic when it is not. */
  const mossPh = rng.range(0, 6.283);

  const skin = (a: number, s: number, y: number, up: number, out: Skin): void => {
    const bare = clamp(spec.decay * 1.5 - 0.15 + up * 0.55, 0, 1);
    const tear = 0.5 + 0.5 * Math.sin(a * 3.3 + mossPh + s * 9.1)
      * Math.cos(s * 17 - mossPh);
    out.weather = clamp((bare - tear * 0.45) * 2.4, 0, 1);

    /* Moss. Grows on the top and the shaded flank of anything lying on this
     * floor, and on a class-4 or 5 log it is the *dominant* surface — a nurse
     * log is a green mound with wood visible only at the ends and along the
     * underside. It also has an edge: moss stops where the log's flank turns
     * under, because below that line it is in the litter. */
    const cushion = 0.5 + 0.30 * Math.sin(a * 2.7 - mossPh * 1.3 + s * 6.1)
      + 0.20 * Math.sin(s * 23 + mossPh);
    out.moss = clamp(
      smoothstep(0.22, 0.52, up) * smoothstep(0.30, 0.48, cushion)
      * (0.30 + 1.25 * spec.decay), 0, 1);

    /* Contact. Two terms and both are necessary. The underside of the log is in
     * the deepest shade in the frame — a horizontal cylinder over a floor sees
     * almost no sky from below — and separately there is a hard dark line where
     * the flank meets the litter, which is the only thing that stops a log
     * reading as laid on top of a photograph of a floor. */
    const gi = clamp(Math.round(s * (rest.ground.length - 1)), 0, rest.ground.length - 1);
    const above = y - rest.ground[gi];
    const crease = clamp(1 - above / Math.max(0.05, rAt(s) * 1.6), 0, 1);
    /* Linear in upness for the same reason the sticks are: a squared term puts
     * the whole flank of a cylinder at one value and the object stops reading
     * as round. The floor does the darkening; the exponent only decides whether
     * there is a gradient left to read. */
    out.occ = (0.32 + 0.68 * up) * (1 - 0.55 * crease ** 1.5) * DEADWOOD_OCC;
  };

  sweep(m, st, sides, uSpan, tone, profile, skin, true);
  /* The butt end. `sweep` only caps the far end, and a log with an open tube for
   * a butt shows the inside of itself from any angle below the axis. */
  splinterCap(m, { ...st[0],
    nx: -st[0].nx, ny: -st[0].ny, nz: -st[0].nz }, sides, tone, profile);

  let pieces = 1;

  /* Branches. A fresh windthrow still has its limbs and they hold it clear of
   * the ground, which is where the gaps under it come from; by class 3 they
   * have snapped off to stubs. Skipping them is what makes a CG log read as a
   * length of dowel. */
  if (spec.decay < 0.55) {
    const n = Math.round((1 - spec.decay * 1.6) * spec.len * 0.9);
    for (let i = 0; i < n; i++) {
      const u = rng.range(0.12, 0.95);
      const [bx, by, bz] = pt(u);
      const br = rAt(u);
      const a = rng.range(0, 6.283);
      // Around the log's own axis, so the limbs radiate from it rather than
      // all standing up.
      const ex = -dz * Math.cos(a), ey = Math.sin(a), ez = dx * Math.cos(a);
      logLimb(m, bx, by, bz, ex, ey, ez, br * rng.range(0.22, 0.45),
              br * rng.range(2.5, 9.0), tone, spec.decay, rng);
      pieces++;
    }
  }

  /* The root plate.
   *
   * A wind-thrown conifer does not break at the base, it tips: the shallow root
   * mat levers out of the ground and stands on edge as a two- to four-metre disc
   * of soil, stone and torn root, with a water-filled pit where it came from.
   * There is nothing else in this forest with that outline, and one of them in
   * frame does more for "this is an old-growth floor" than another ten logs.
   */
  if (spec.wad) {
    rootPlate(m, st[0], spec, tone, rng);
    pieces++;
  }

  return pieces;
}

/** A limb still attached to a fallen log. */
function logLimb(
  m: Mesh, x: number, y: number, z: number,
  ex: number, ey: number, ez: number,
  r: number, L: number, tone: number, decay: number, rng: Rng,
): void {
  const el = Math.hypot(ex, ey, ez) || 1;
  ex /= el; ey /= el; ez /= el;
  const segs = 3;
  const st: Station[] = [];
  let prevN: [number, number, number] = [0, 1, 0];
  const bendX = rng.range(-0.3, 0.3), bendZ = rng.range(-0.3, 0.3);
  for (let i = 0; i <= segs; i++) {
    const u = i / segs;
    const px = x + ex * L * u + bendX * L * u * u;
    const py = y + ey * L * u;
    const pz = z + ez * L * u + bendZ * L * u * u;
    const g = groundHeight(px, pz);
    const s: Station = {
      cx: px, cy: Math.max(py, g - r * 0.4), cz: pz,
      nx: 0, ny: 0, nz: 0, bx: 0, by: 0, bz: 0,
      r: r * (1 - 0.55 * u), s: u, v: u * L,
    };
    frameFrom(s, ex, ey, ez, prevN[0], prevN[1], prevN[2]);
    prevN = [s.nx, s.ny, s.nz];
    st.push(s);
  }
  const skin = (_a: number, s: number, _y: number, up: number, out: Skin): void => {
    out.weather = clamp(decay * 1.8 + s * 0.4, 0, 1);
    out.moss = 0.22 * up * decay;
    out.occ = (0.44 + 0.56 * up * (0.4 + 0.6 * s)) * DEADWOOD_OCC;
  };
  sweep(m, st, 5, 1, tone, () => 1, skin, true);
}

/**
 * The upturned root plate of a wind-thrown tree.
 *
 * A disc standing on edge, perpendicular to the fallen stem, with the outline
 * torn rather than circular and a fringe of snapped roots round its rim. It is
 * built as two offset sheets rather than as a solid, because the thing has a
 * thickness of thirty centimetres against a diameter of three metres and
 * nothing in this scene will ever see its edge close enough for the join to
 * matter.
 */
function rootPlate(m: Mesh, butt: Station, spec: LogSpec, tone: number, rng: Rng): void {
  const R = spec.rA * rng.range(3.2, 5.5);
  const thick = spec.rA * 0.55;
  // Face normal is the log's own axis, pointing back out of the butt.
  const ax = -(butt.bz * butt.ny - butt.by * butt.nz);
  const ay = -(butt.bx * butt.nz - butt.bz * butt.nx);
  const az = -(butt.by * butt.nx - butt.bx * butt.ny);
  const al = Math.hypot(ax, ay, az) || 1;
  const fx = ax / al, fy = ay / al, fz = az / al;
  // In-plane basis.
  const ux = butt.nx, uy = butt.ny, uz = butt.nz;
  const vx = butt.bx, vy = butt.by, vz = butt.bz;

  const cx = butt.cx + fx * spec.rA * 0.5;
  const cy = butt.cy + fy * spec.rA * 0.5;
  const cz = butt.cz + fz * spec.rA * 0.5;
  const g = groundHeight(cx, cz);
  /* Pushed down until the bottom of the plate is under the floor. The pit it
   * came out of is the heightfield's business and the heightfield does not know
   * about this object, so the only defence against a visible gap is to bury the
   * rim. */
  const lift = Math.max(0, cy - R * 0.55 - (g - 0.25));

  const RINGS = 4, SIDES = 14;
  const ph = rng.range(0, 6.283);
  const rim = (a: number): number =>
    R * (0.62 + 0.38 * (0.5 + 0.5 * Math.sin(a * 3 + ph))
         * (0.6 + 0.4 * Math.sin(a * 7 - ph * 2.1)));

  for (const sgn of [1, -1]) {
    const base = m.count;
    for (let i = 0; i <= RINGS; i++) {
      const t = i / RINGS;
      for (let j = 0; j <= SIDES; j++) {
        const a = (j / SIDES) * Math.PI * 2;
        const rr = rim(a) * t;
        const ca = Math.cos(a), sa = Math.sin(a);
        // Domed: the plate is a dish, not a plane, because it peeled off a
        // curved root mat.
        const bulge = thick * (1 - t * t) * sgn;
        const px = cx + (ux * ca + vx * sa) * rr + fx * bulge;
        const py = cy - lift + (uy * ca + vy * sa) * rr + fy * bulge;
        const pz = cz + (uz * ca + vz * sa) * rr + fz * bulge;
        /* The soil face is nearly matte black wet earth and the underside is
         * torn root; both read as "not wood", which is the point of the object.
         * The occlusion is what carries that, since the material has no soil
         * set in it. */
        m.vert(px, py, pz, fx * sgn, fy * sgn, fz * sgn,
               (0.5 + ca * t * 0.5) * 2, (0.5 + sa * t * 0.5) * 2,
               tone, 0.35, 0.22 * (1 - t),
               (0.24 + 0.34 * t) * (sgn > 0 ? 1 : 0.72));
      }
    }
    const row = SIDES + 1;
    for (let i = 0; i < RINGS; i++) {
      for (let j = 0; j < SIDES; j++) {
        const a = base + i * row + j;
        if (sgn > 0) m.quad(a, a + 1, a + row + 1, a + row);
        else m.quad(a, a + row, a + row + 1, a + 1);
      }
    }
  }

  /* Snapped roots round the rim. Six to ten short tapered spikes radiating out
   * of the plate's edge, which is what turns a disc into a root plate — the
   * ragged fringe is the whole silhouette. */
  const n = 6 + ((rng.f() * 5) | 0);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const rr = rim(a) * rng.range(0.80, 1.0);
    const ca = Math.cos(a), sa = Math.sin(a);
    const ex = ux * ca + vx * sa, ey = uy * ca + vy * sa, ez = uz * ca + vz * sa;
    logLimb(m,
      cx + ex * rr * 0.85, cy - lift + ey * rr * 0.85, cz + ez * rr * 0.85,
      ex + fx * rng.range(-0.5, 0.5), ey * 0.7 + rng.range(-0.2, 0.2), ez + fz * rng.range(-0.5, 0.5),
      spec.rA * rng.range(0.12, 0.26), R * rng.range(0.18, 0.42), tone, 0.9, rng);
  }
}

/* ── Deadwood on the floor ───────────────────────────────────────────────── */

/**
 * Branches and sticks.
 *
 * This replaces `sticks()` in `trailProps.ts`, which System 1 withdrew: its
 * placement distribution was sound and its surface was not, and the surface
 * failure was diagnosed there as a value problem that could not be fixed by
 * adjusting colour. The fix is in three places and none of them is the albedo.
 *
 *   The contact term goes through *occlusion* rather than through a diffuse
 *   tint. A dielectric under a bright fog dome returns about 4% of the sky
 *   whatever its albedo is, so a piece whose only darkening is a diffuse
 *   multiplier has a floor it cannot get below — which is exactly the "value
 *   would not move" the audit recorded. See `Trees.tsx`.
 *
 *   The whole underside is occluded, not just the contact line. A stick lying in
 *   a needle mat is in a shallow trench of its own making and sees sky over
 *   maybe a third of the hemisphere.
 *
 *   It forks. A fallen branch is a branch: it has at least one side limb, and a
 *   single tapered tube with no junction anywhere along it is the shape of a
 *   hose whatever is painted on it.
 *
 * The distribution is inherited: clumped, most of it off the tread, a few
 * pieces across it because nobody clears a path in a wood.
 */
function stickField(pick: (x: number, z: number) => Mesh, rng: Rng): number {
  const tr = trail();
  let drawn = 0;

  /* Roughly six hundred pieces over the 48 m of trail and 11 m either side of
   * it, which is about 0.7 per square metre. That sounds like a lot and it is
   * under what a Pacific Northwest floor carries — coarse woody debris runs
   * 200-400 m³ per hectare in an unmanaged stand of this age and every square
   * metre of it has something on it. The first build's spacing gave 98 pieces
   * over the same ground and the near floor came back visibly *cleaner* than
   * the ground texture underneath it, which is the wrong way round: the litter
   * bake already has twigs in it, and geometry that is sparser than the texture
   * it sits on reads as a scattering of accidents. */
  for (let along = -1; along < DIMS.trailLength + 2; along += rng.range(0.10, 0.30)) {
    const n = rng.chance(0.45) ? 2 : 1;
    for (let k = 0; k < n; k++) {
      const onTrail = rng.chance(0.07);
      const side = onTrail
        ? rng.range(-DIMS.trailHalf, DIMS.trailHalf)
        : Math.sign(rng.gauss() || 1) * (DIMS.trailHalf + 0.20 + 11 * rng.f() ** 1.5);

      const c = tr.pointAtAlong(along);
      const cx = c.x + -c.tz * side, cz = c.z + c.tx * side;
      if (Math.abs(cx) > DIMS.worldHalf - 2 || cz > DIMS.zMax - 2 || cz < DIMS.zMin + 2) continue;
      const m = pick(cx, cz);

      const len = onTrail ? rng.range(0.18, 0.55) : rng.range(0.35, 3.0);
      /* 16 mm floor, and it is a rendering constraint rather than a botanical
       * one: a 6 mm twig four metres out is a fifth of a pixel and resolves to a
       * chain of isolated dark pixels, which reads as dirt on the lens. The
       * first build's 12 mm was still under that threshold at the distance most
       * of these are seen from, and the near floor came back with a scattering
       * of thin dark slivers rather than with visible deadwood. Anything finer
       * belongs in the litter texture, where the ground already has it. */
      /* 24 mm floor, up from 16.
       *
       * The 16 mm piece was chosen against the pixel size at four metres and it
       * clears that easily; what it does not clear is the *bark tile*. `sweep`
       * cannot wrap less than one whole texture tile round a member, so a 32 mm
       * stick gets 1.4 m of bark squeezed round a 10 cm circumference — a
       * fourteen-fold circumferential magnification, which paints the whole
       * piece with the inside of one fissure. That is what made the thin end of
       * this population read as black wire in the floor captures while the
       * thicker pieces beside them read as wood, and it is the same mechanism
       * that had the branch stubs hanging off the trunks as claws. */
      const rA = clamp(len * rng.range(0.035, 0.070), 0.024, 0.11);
      const decay = rng.f() ** 0.8;
      branch(m, cx, cz, rng.range(0, 6.283), len, rA, decay, onTrail, rng, 0);
      drawn++;
    }
  }
  return drawn;
}

/** One fallen branch, laid on the floor, optionally forking. */
function branch(
  m: Mesh, cx: number, cz: number, az: number, len: number, rA: number,
  decay: number, onTrail: boolean, rng: Rng, depth: number,
): void {
  const tone = rng.f();
  const dx = Math.cos(az), dz = Math.sin(az);
  const rB = rA * rng.range(0.20, 0.50);
  const rAt = (u: number) => rA + (rB - rA) * u;

  /* Same rest-line fit as the logs. A 2 m branch across a floor with 4 cm of
   * duff roughness touches at two points and bridges between them, and it is
   * the daylight in the bridge that says the object is rigid. */
  const rest = restLine(cx, cz, az, len, rAt, 0.30 + decay * 0.45);

  const segs = Math.max(4, Math.round(len / 0.16));
  const st: Station[] = [];
  let prevN: [number, number, number] = [0, 1, 0];
  const kink = rng.range(0.4, 1.5), kph = rng.range(0, 6.283);
  const pt = (u: number): [number, number, number] => {
    const d = (u - 0.5) * len;
    const lat = Math.sin(u * kink * 6.283 + kph) * len * 0.035;
    return [cx + dx * d - dz * lat, rest.y0 + rest.slope * u, cz + dz * d + dx * lat];
  };
  let arc = 0;
  for (let i = 0; i <= segs; i++) {
    const u = i / segs;
    const [px, py, pz] = pt(u);
    const du = 0.5 / segs;
    const [ax, ay, az2] = pt(Math.max(0, u - du));
    const [bx, by, bz] = pt(Math.min(1, u + du));
    let tx = bx - ax, ty = by - ay, tz = bz - az2;
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl; ty /= tl; tz /= tl;
    if (i > 0) arc += Math.hypot(px - st[i - 1].cx, py - st[i - 1].cy, pz - st[i - 1].cz);
    /* Knuckles where side branches left, at two incommensurate periods. A single
     * sine is a regular bulge and reads as a moulding. */
    const lump = 1 + 0.19 * Math.sin(u * 9.3 + kph * 2.1) + 0.12 * Math.sin(u * 21.7 + kph);
    const s: Station = {
      cx: px, cy: py, cz: pz, nx: 0, ny: 0, nz: 0, bx: 0, by: 0, bz: 0,
      r: rAt(u) * lump, s: u, v: arc,
    };
    frameFrom(s, tx, ty, tz, prevN[0], prevN[1], prevN[2]);
    prevN = [s.nx, s.ny, s.nz];
    st.push(s);
  }

  const mossPh = rng.range(0, 6.283);
  const skin = (a: number, s: number, y: number, up: number, out: Skin): void => {
    /* Biased hard towards the barkless set for the same mapping reason as the
     * stubs: the snag bake is 3 mm grain, which survives being stretched round
     * a thin member as lines running along it, and the bark bake is 8 cm plates,
     * which does not. It is also true of the objects — a branch on a wet coastal
     * floor loses its bark within a couple of years and almost everything lying
     * out there has been down longer than that. */
    out.weather = clamp(0.52 + decay * 0.85 - 0.10 + up * 0.22
      + 0.22 * Math.sin(a * 2.7 + mossPh + s * 8), 0, 1);
    out.moss = clamp(smoothstep(0.35, 0.75, up) * decay
      * (0.4 + 0.6 * (0.5 + 0.5 * Math.sin(s * 11 + mossPh))) * (onTrail ? 0.1 : 1), 0, 1);
    const gi = clamp(Math.round(s * (rest.ground.length - 1)), 0, rest.ground.length - 1);
    const above = y - rest.ground[gi];
    const crease = clamp(1 - above / Math.max(0.02, rAt(s) * 1.8), 0, 1);
    /* A gradient round the piece, not a step.
     *
     * The first build squared the upness here, on the reasoning that a stick in
     * a needle mat sees sky over only about a third of the hemisphere from its
     * flanks. It does — and squaring it puts the *whole* flank at the floor
     * value, so the piece has one tone across everything except a thin strip
     * along its crown. Rendered at 2 m that is a flat black sliver lying on the
     * duff, which is a worse failure than the pale one it was fixing, and for
     * the same reason: a cylinder is legible because its value runs smoothly
     * from its lit side to its dark one, and any term that collapses that run
     * deletes the cylinder. Linear, with the floor doing the darkening. */
    /* LITTER_OCC, and it is here rather than folded into DEADWOOD_OCC because
     * this is the only deadwood population that lies at the viewer's feet.
     *
     * DEADWOOD_OCC is 0.52 and it exists to cancel the bark map's AO floor
     * going from 0.14 to 0.40, so that the four wood populations kept the
     * values they had been tuned to. That is the right instinct for the stubs
     * and limbs twenty metres up, whose values the review has verified. It was
     * the wrong instinct here, because the value these had been tuned to was
     * already wrong: a stick on the duff was rendering at 15 to 25 against duff
     * at 52 to 57, and both the review and a viewer walking the scene called
     * them black tubes. Preserving a defect is what a compensation constant
     * does if nobody checks what it is preserving.
     *
     * Wet deadwood lying in a needle mat photographs at or a little under the
     * duff around it — it is the same material at the same albedo seeing the
     * same sky, and the only reason it is darker at all is that a cylinder
     * lying in litter loses the lower half of its hemisphere. That is a factor
     * of two, not of three. The floor is up and the contact crease is softened
     * to match; the gain restores what the compensation removed. */
    out.occ = clamp((0.60 + 0.40 * up) * (1 - 0.34 * crease ** 1.4)
                    * DEADWOOD_OCC * LITTER_OCC, 0, 1);
  };

  const sides = clamp(Math.round((2 * Math.PI * rA) / 0.032), 6, 11);
  sweep(m, st, sides, 1, tone, () => 1, skin, true);
  splinterCap(m, { ...st[0], nx: -st[0].nx, ny: -st[0].ny, nz: -st[0].nz },
              sides, tone, () => 1);

  /* The fork. One side limb, leaving somewhere in the middle third at 25 to 60
   * degrees, at a bit under half the parent's diameter — which is what a branch
   * junction actually looks like and what a tube has none of. */
  if (depth === 0 && len > 0.5 && rng.chance(0.62)) {
    const u = rng.range(0.25, 0.72);
    const [fx, , fz] = pt(u);
    branch(m, fx, fz, az + (rng.chance(0.5) ? 1 : -1) * rng.range(0.45, 1.05),
           len * rng.range(0.30, 0.62), rAt(u) * rng.range(0.42, 0.68),
           decay, onTrail, rng, 1);
  }
}

/* ── The canopy ──────────────────────────────────────────────────────────── */

/**
 * The roof: branch armatures in whorls, with the needle mass hung on them.
 *
 * There is no live foliage at eye level in a closed stand and this system does
 * not build any. But the frame that looks up has to have something in it, and
 * the absence of a roof is visible even in the level frames: with nothing
 * overhead the fog dome runs to the zenith and the top of the picture is a
 * clean bright gradient, which is a photograph taken in a field.
 *
 * This was two independent populations until the last review and the review was
 * right about what that costs. The sprays were scattered round the bole axis on
 * their own and the frame that looks up showed a set of dark slabs floating in
 * the air with no visible means of support, because in a real canopy the first
 * thing the eye finds is not the needle mass at all — it is the armature. Bare
 * limbs radiating from each stem in rough annual whorls, tapered, sagging, and
 * crossing everything behind them, with the foliage carried out near their ends.
 * So the branch is now built first and the spray is hung on it, which fixes the
 * support, the tiering and the radial distribution in one change: a spray can
 * only be somewhere a branch reaches.
 *
 * Costs are set by what survives twenty-five metres of this fog. The limbs are
 * three-sided and three-stationed and never resolve as more than a dark line;
 * the sheets are a 4x4 patch, which is the coarsest grid that still takes a
 * visible sag and a crumple. Together they are about 800 triangles a stem over
 * the four hundred stems tall enough to have a crown at all.
 */
function crown(m: Mesh, wood: Mesh, t: TreeSpec, rng: Rng): number {
  const f = FORM[t.sp];
  const top = t.hFull;
  /* Twelve metres is a hard floor on a canopy tree, whatever the species' crown
   * fraction says.
   *
   * A hemlock crown starts at 0.30 of its height and a suppressed one is twenty
   * metres tall, so the fraction alone put sprays at six metres — inside the
   * frame, seen edge-on, and reading as flat dark shards hanging in the air at
   * head height. Under a stand this dense there is no live foliage below about
   * fifteen metres on a stem that reached the roof.
   *
   * A pole is the other case and it was being handled by refusing to draw one
   * at all, which is where two separate defects came from. A suppressed sapling
   * *does* carry a thin crown — that is how it is still alive — and without one
   * every pole in the wood was a bare whip ending in a lid, which is the
   * flat-topped stem the review keeps finding, and the ten-to-thirty-metre
   * airspace had nothing in it but those whips, which is the bimodal histogram.
   * Four metres is the floor here: high enough to stay clear of the walker's
   * head and of the fern layer, low enough that the shell actually fills. */
  const sub = t.sp === 'pole';
  const from = sub ? Math.max(4.0, top * 0.55) : Math.max(12, top * f.crown * 1.1);
  if (from >= top - 1.2) return 0;

  const lx = Math.cos(t.leanAz) * Math.sin(t.lean);
  const lz = Math.sin(t.leanAz) * Math.sin(t.lean);
  const limbTone = hash1(t.seed + 71);

  /* Whorls rather than a uniform scatter. A conifer puts out one ring of
   * branches a year, so limbs arrive in groups at a common height with a clear
   * gap above and below, and that vertical rhythm is most of what identifies a
   * conifer crown seen from underneath. */
  /* Whorl count. A Douglas-fir sets one whorl a year and a twenty-metre live
   * crown is therefore twenty-odd of them, not six; six put a ring of branches
   * every three metres and the gaps between the rings were sky. Ten is the most
   * the triangle budget carries — the armature is swept tube geometry and it
   * costs more than the cards it holds — and it halves the vertical gap. */
  const tiers = sub ? 3 + ((rng.f() * 3) | 0) : 8 + ((rng.f() * 4) | 0);
  let n = 0;

  for (let w = 0; w < tiers; w++) {
    const u = (w + rng.range(0.15, 0.85)) / tiers;
    const y = from + (top - from) * u;
    const bend = Math.pow(y / t.h, 1.4) * t.h;
    const bx = t.x + lx * bend, bz = t.z + lz * bend;
    const rBole = Math.max(0.04, t.r0 * (1 - 0.66 * (y / t.hFull)));
    const a0 = rng.range(0, 6.283);
    const per = sub ? 2 + ((rng.f() * 2) | 0) : 4 + ((rng.f() * 2) | 0);

    for (let i = 0; i < per; i++) {
      const az = a0 + (i / per) * 6.283 + rng.range(-0.42, 0.42);
      /* Long at the base of the crown and short at the top: that is the cone,
       * and the cone is what stops the roof reading as a flat ceiling. */
      const L = (1.3 + 3.1 * (1 - u) ** 0.85) * (0.55 + t.r0 * 1.1) * rng.range(0.72, 1.22)
        /* A suppressed stem's branches are short as well as few — a two-metre
         * limb on a 10 cm pole is a windmill, and the shell wants many small
         * faint things rather than a few large ones. */
        * (sub ? 0.42 : 1);
      limb(bx, t.base + y, bz, rBole * 0.6, az,
           L, rng.range(0.34, 1.05), 0, w * 7 + i);
    }
  }
  return n;

  /* One limb of the armature, and — one level down — the secondary branches
   * that carry the foliage.
   *
   * Written as a recursion because the review's objection was structural: "a TV
   * aerial with pom-poms", straight untapered spokes leaving the bole at one
   * angle with the needle mass stuck on the end. Three of those four are cured
   * by drawing the same limb again at 40% scale off the middle of the first,
   * and hanging the fronds on *that*. A real conifer branch forks twice before
   * it reaches foliage, and the foliage is on the outer half of the
   * second-order shoots, which is why a crown from below reads as depth rather
   * than as a row of paddles.
   *
   * `depth` is capped at one for cost, not for realism: this runs on four
   * hundred stems and the third order would triple the count of the cheapest
   * and least visible members in the scene.
   */
  function limb(
    ox: number, oy: number, oz: number, inset: number,
    az: number, L: number, droop: number, depth: number, seed: number,
  ): void {
    /* A branch is a twentieth of its length through at the bole and half that
     * at the tip. The first pass scaled this off the stem radius as well and
     * gave a veteran 36 cm limbs — at twenty metres those came back as pale
     * straight planks radiating out of the trunk, which read as scaffolding.
     * Limb diameter is set by the crown the branch carries, not by the tree. */
      const r0 = clamp(L * rng.range(0.013, 0.024), 0.014, 0.055);
      const dx = Math.cos(az), dz = Math.sin(az);
      const reachAt = (v: number) => inset + L * v;
      /* A catenary, not a parabola with a small coefficient. A limb leaves the
       * bole close to horizontal and is falling steeply by its own tip, and the
       * exponent is what carries that: at v-squared the whole limb curves
       * evenly and reads as a bent rod, which is the "no catenary sag" in the
       * review. */
      const dropAt = (v: number) => -droop * L * Math.pow(v, 2.4);

      const segs = 4;
      const st: Station[] = [];
      let prevN: [number, number, number] = [0, 1, 0];
      for (let k = 0; k <= segs; k++) {
        const v = k / segs;
        const dv = 1 / segs;
        const rA = reachAt(Math.max(0, v - dv)), rB = reachAt(Math.min(1, v + dv));
        const dA = dropAt(Math.max(0, v - dv)), dB = dropAt(Math.min(1, v + dv));
        let tx = dx * (rB - rA), ty = dB - dA, tz = dz * (rB - rA);
        const tl = Math.hypot(tx, ty, tz) || 1;
        tx /= tl; ty /= tl; tz /= tl;
        const s: Station = {
          cx: ox + dx * reachAt(v), cy: oy + dropAt(v), cz: oz + dz * reachAt(v),
          nx: 0, ny: 0, nz: 0, bx: 0, by: 0, bz: 0,
          /* The collar at the bole, then a hard taper. A limb that keeps its
           * girth to the tip is a dowel and reads as one even in silhouette. */
          r: r0 * (1 + 0.55 * Math.max(0, 1 - v * 3.4)) * (1 - 0.68 * v),
          s: v, v: v * L,
        };
        frameFrom(s, tx, ty, tz, prevN[0], prevN[1], prevN[2]);
        prevN = [s.nx, s.ny, s.nz];
        st.push(s);
      }

      const limbSkin = (_a: number, _s: number, _y: number, _up: number, out: Skin): void => {
        out.weather = 0.55;
        out.moss = 0;
        /* Flat and very dark. A limb twenty-five metres up under a closed roof
         * is lit from nowhere: what is above it is the foliage it is carrying
         * and what is below it is a black forest. Anything that reads as
         * surface on one of these is wrong. A subcanopy limb is in open air at
         * a range where the fog cannot rescue it; see the frond note below. */
        out.occ = sub ? 0.30 : 0.13;
      };
      sweep(wood, st, 3, 1, limbTone, () => 1, limbSkin, true);

      /* Fork before foliage. Two or three secondaries off the outer two thirds,
       * at 30 to 65 degrees and a third to a half the parent's length, each
       * drooping harder than the limb that carries it. */
      if (depth === 0) {
        const nS = 3 + ((rng.f() * 2) | 0);
        for (let k = 0; k < nS; k++) {
          const v = 0.24 + 0.68 * ((k + rng.range(0.2, 0.8)) / nS);
          limb(ox + dx * reachAt(v), oy + dropAt(v), oz + dz * reachAt(v), 0,
               az + (rng.chance(0.5) ? 1 : -1) * rng.range(0.52, 1.15),
               L * rng.range(0.30, 0.52), droop * rng.range(1.1, 1.8), 1, seed + k * 3);
        }
        /* The primary carries foliage too, along its own outer half. Without
         * this the only needle mass in the crown hangs off the secondaries and
         * the interior of the crown is empty — which is visible from directly
         * underneath as sky between every unit, and is half of why the roof
         * read as a scatter of separable objects rather than as a cloud. */
        sprays(0.40, 0.96, 3 + ((rng.f() * 2) | 0), 0.70);
        return;
      }
      sprays(0.26, 0.98, 5 + ((rng.f() * 3) | 0), 1);
      return;

      /* The needle mass, as drooping fronds hung along the outer half of the
       * limb — not as a disc stamped on the end of it.
       *
       * The disc is the defect the last review named twice, once for its shape
       * and once for what it does at a glancing angle. A Douglas-fir seen from
       * below is not a rosette: it is a *linear* thing, a rachis with a fine
       * needle fringe either side of it, hanging downward, and a crown is
       * dozens of those overlapping. Stamped radially round a point they read
       * as hydrangea heads, which is exactly what came back, and worse, they
       * read as broadleaf — a rosette of rounded lobes is the silhouette of a
       * flowering shrub and there is no arrangement of alpha that will rescue
       * it.
       *
       * The second failure is geometric and it is the "cling film". One flat
       * sheet two metres across, seen within a few degrees of its own plane,
       * is a long straight-edged ribbon of solid alpha — the brightest, most
       * artificial object in the frame, and there were three of them in
       * `60.png`. No amount of crumple fixes it, because a crumpled plane is
       * still a plane and its edge-on projection is still a line.
       *
       * A frond is a narrow strip, so its own edge-on projection is thin
       * enough not to register, and it is built as a *crossed pair* — two
       * strips sharing an axis seventy degrees apart — so whatever the viewing
       * angle, one of the two presents area and the pair never disappears.
       * Same triangle count as the disc it replaces.
       */
    function sprays(vLo: number, vHi: number, nF: number, scale: number): void {
      for (let fi = 0; fi < nF; fi++) {
        /* Spread along the limb by index. */
        const sv = vLo + (vHi - vLo) * ((fi + rng.range(0.15, 0.85)) / nF);
        const ax = ox + dx * reachAt(sv);
        const ay = oy + dropAt(sv);
        const az2 = oz + dz * reachAt(sv);

        /* Card size, and this is the correction the whole round turns on.
         *
         * It used to be L * 0.52-0.95 off a secondary that was itself up to
         * 2.2 m, which put cards at 0.2 to 2.1 metres — and since the map drew
         * exactly one frond per card, the smallest foliage object in the wood
         * was over a metre long. Seen from underneath against clean bright air
         * every one of them was individually resolvable, which is the "discrete
         * black clumps hanging in mid-air" a viewer walking the scene reported
         * and the "blade about a sixth of a nearby trunk's apparent width" the
         * review measured. They are the same fault counted twice.
         *
         * The card is now a branchlet system carrying fourteen shoots (see
         * CANOPY in treeMaterials.ts), so the resolvable unit is a shoot and
         * the card can be the size a real branchlet is: clamped to 0.35-1.0 m,
         * which puts a shoot at eight to twelve centimetres. The area lost per
         * card is bought back by count — nF is up from 2-3 to 4-6 on the
         * secondaries, the primaries now carry cards of their own, and there is
         * one more secondary per limb.
         *
         * The comment this replaces argued the opposite, that area is quadratic
         * in the card dimensions so growing cards is cheaper than adding them.
         * That is arithmetically true and it is the wrong trade, because a
         * canopy is not an area target: it is a target for *how large the
         * smallest visible thing is*, and area bought by growing the card moves
         * that number the wrong way. */
        const fl = clamp(L * rng.range(0.42, 0.78) * scale, 0.35, 1.00);
        const fw = fl * rng.range(0.34, 0.50);
        /* Away from the bole and to one side of the limb, so the cards fan
         * rather than lining up along it. */
        const fa = az + rng.range(-0.95, 0.95);
        const fdx = Math.cos(fa), fdz = Math.sin(fa);
        /* Hanging. A frond carries its own weight on a stalk a few millimetres
         * through, so it leaves the branch near horizontal and is pointing well
         * below it within half a metre — the catenary is the shape, and it is
         * what the silhouette is read from at this distance. */
        /* How far the card falls over its own length. It was up to 1.5, which
         * on a card that is now under a metre strung the sprays out vertically
         * into separate hanging threads — good silhouette, terrible coverage,
         * and it read as hanging moss rather than as needle mass. Held back to
         * a real branchlet's droop, the cards stay near the plane of the branch
         * that carries them and overlap each other laterally, which is what
         * makes a crown opaque from underneath without adding a single card. */
        const fall = rng.range(0.28, 0.78);
        const roll = rng.range(0, 6.283);

        const SEG = 3;
        for (let plane = 0; plane < 2; plane++) {
          const base = m.count;
          // Two strips 70 degrees apart about the frond's own axis.
          const pa = roll + plane * 1.22;
          for (let k = 0; k <= SEG; k++) {
            const v = k / SEG;
            const px = ax + fdx * fl * v;
            const py = ay - fall * fl * v * v;
            const pz = az2 + fdz * fl * v;
            /* Widest a third of the way out and drawn to a point. A strip of
             * constant width is a ribbon; the taper is a third of what makes
             * this read as foliage rather than as tape. */
            const wv = fw * smoothstep(0, 0.22, v) * (1 - 0.82 * smoothstep(0.40, 1, v));
            /* The cross direction, tilted out of horizontal by the roll so the
             * two planes of the pair are genuinely different surfaces. */
            const cxr = -fdz * Math.cos(pa), czr = fdx * Math.cos(pa);
            const cyr = Math.sin(pa);
            for (let e = -1; e <= 1; e += 2) {
              m.vert(px + cxr * wv * e, py + cyr * wv * e, pz + czr * wv * e,
                     0, 1, 0, v, e > 0 ? 1 : 0,
                     hash1(t.seed + seed + fi), 0, 0,
                     /* A canopy from below is a silhouette, and this is the
                      * term that decides whether it is one.
                      *
                      * Measured in the up framing: a black object at eighteen
                      * metres renders 118 under this fog and the sky renders
                      * 194, so the whole range available to the roof is 76
                      * display levels. The sprays were landing at 145 — a third
                      * of the way up that range, which put two of the three the
                      * review sampled level with open sky. They were not too
                      * bright in albedo; that was already down at 0.013. They
                      * were too *open*: a needle mass two metres deep lit only
                      * from above sees almost none of the dome from underneath.
                      * Unchanged from the sheet this replaces, because the
                      * review has since verified the roof at 27% of `up.png`
                      * below luma 70 and the shape is the only thing in
                      * question.
                      *
                      * The subcanopy is the one case that has to differ. A
                      * sapling crown is a single layer of shoots with open air
                      * on every side of it, not the underside of a two-metre
                      * mass, and it stands at five to twenty metres where the
                      * fog has not yet done the work — at canopy values it
                      * would read as a black cutout at head height, which is
                      * the reason poles were given no foliage at all until
                      * now. */
                     /* Lifted from 0.05 + 0.20 v. The previous round closed
                      * the roof too far: `up.png` went from 13.5% of pixels
                      * above luma 180 to 1.7% against a 4-7% target, a median
                      * of 48 against 75-90, and 73.5% of the frame below 70.
                      * A canopy is a near-silhouette, not a blackout, and the
                      * frame has to keep some air in it or the fog above the
                      * crowns has nothing to be read against. */
                     (sub ? 0.22 + 0.32 * v : 0.13 + 0.26 * v));
            }
          }
          for (let k = 0; k < SEG; k++) {
            const a = base + k * 2;
            m.quad(a, a + 1, a + 3, a + 2);
          }
        }
        n++;
      }
    }
  }
}

/* ── Assembly ────────────────────────────────────────────────────────────── */

export type ForestTile = {
  cx: number; cz: number;
  wood: THREE.BufferGeometry | null;
  canopy: THREE.BufferGeometry | null;
};

export type Forest = {
  tiles: ForestTile[];
  counts: {
    trees: number; snags: number; leaners: number; poles: number;
    stubs: number; logs: number; wads: number; sticks: number;
    woodTris: number; canopyTris: number;
    /** Sky view: the stand's raw mean, and the normalised mean and per-bole
     * spread the shader actually sees. `skyMean` near 1 is the normalisation
     * working; `skySpread` near 0 means there is no terminator on any trunk. */
    skyRaw: number; skyMean: number; skySpread: number;
    /** Live-stem lean in degrees: mean and 90th percentile, and % with basal sweep. */
    leanMean: number; leanP90: number; sweepPct: number;
  };
};

/** Where the fallen wood is. Scattered from the trail, like everything else. */
function logSpecs(rng: Rng): LogSpec[] {
  const tr = trail();
  const out: LogSpec[] = [];

  /* Thirty-four attempts, down from ninety-six.
   *
   * Coarse woody debris in an unmanaged stand of this age runs 200-400 cubic
   * metres a hectare, and the mistake in the first build was to read that as a
   * piece count. It is a *volume*, and it is carried by a small number of very
   * large pieces: one 20 m bole 90 cm through is 12 cubic metres and is worth
   * sixty of the 3 m limbs that were being drawn instead. Ninety-six pieces all
   * within a factor of two of each other in girth gave a floor of scattered
   * dowels — evenly spread, all lying flat, none of them an event. Fewer and
   * wilder is both more accurate and a better picture.
   */
  for (let i = 0; i < 34; i++) {
    const along = rng.range(-6, DIMS.trailLength + 8);
    /* Weighted towards the trail. A uniform draw over the strip puts four fifths
     * of the logs beyond ten metres, where the fog has them at a tenth contrast
     * and the whole class contributes nothing — and the first two captures came
     * back with a floor that had visibly *less* coarse woody debris on it near
     * the camera than far from it, which is the opposite of how a scatter should
     * look. This is a sampling bias and not a claim about where logs fall. */
    const side = Math.sign(rng.gauss() || 1) * (1.1 + 20.9 * rng.f() ** 1.9);
    const c = tr.pointAtAlong(along);
    const x = c.x + -c.tz * side, z = c.z + c.tx * side;
    if (Math.abs(x) > DIMS.worldHalf - 6 || z > DIMS.zMax - 6 || z < DIMS.zMin + 6) continue;

    /* Length and diameter are correlated, because a log is a tree: a 14 m piece
     * came off a stem that was 60 cm through where it broke. Drawing them
     * independently gives a floor covered in objects with no consistent
     * relationship between their length and their girth, which reads as debris
     * rather than as trees that fell. */
    /* Two populations rather than one distribution, because a forest floor has
     * two kinds of thing on it and a single draw cannot produce both. A limb is
     * a few metres of 10-20 cm wood shed from a crown; a bole is most of a tree.
     * Drawing one length and scaling the radius off it put everything on the
     * same line and the whole class arrived within a factor of two of the same
     * girth — which is the "near-identical diameter" the floor read as. The
     * split is deliberately uneven: limbs outnumber boles three to two, and the
     * boles are what the eye actually registers. */
    const bole = rng.chance(0.40);
    const len = bole ? 7.0 + 14.0 * rng.f() ** 1.5 : 1.4 + 4.2 * rng.f() ** 1.6;
    /* Girth checked against the standing population, which it was not before.
     *
     * The old coefficients gave a 21 m piece a butt radius of 0.95 m — a stem
     * 1.9 m through, wider than the largest fir this file will grow and half as
     * wide again as its own length allows. One of them landed 24 m up the trail
     * at eye height and the last review reported it as "a flat trapezoid
     * plateau sitting proud of the general line", which is what a two-metre
     * cylinder looks like at that range through fog. The mistake was reading
     * the note that a big log is "90 cm through" as a radius. Halved, so a 21 m
     * piece is now 1.1 m at the butt and a 10 m one is 0.5 m, both of which are
     * stems the stand actually contains. */
    const rA = bole
      ? (0.10 + 0.0155 * len) * rng.range(0.80, 1.30)
      : (0.030 + 0.016 * len) * rng.range(0.70, 1.30);
    /* Decay weighted to the old end. Wood on a wet coastal floor takes two to
     * four centuries to disappear and only a few years to lose its bark, so at
     * any moment most of what is lying there is well rotted and the fresh
     * windthrows are the minority. */
    const decay = clamp(rng.f() ** 0.62, 0, 1);

    const az = rng.range(0, Math.PI * 2);
    /* Nothing lying across the tread. A log across a used path gets cut out or
     * walked round until the path moves, so a trail with one across it is a
     * trail nobody uses — and this one is worn to mineral soil. */
    const dx = Math.cos(az), dz = Math.sin(az);
    let blocked = false;
    for (let k = 0; k <= 8; k++) {
      const d = (k / 8 - 0.5) * len;
      if (tr.distance(x + dx * d, z + dz * d) < DIMS.trailHalf + 0.55 + rA) {
        blocked = true; break;
      }
    }
    if (blocked) continue;

    // Only the big fresh ones still have their plate; on an old log it has
    // rotted back into the mound.
    /* A nurse log's plate has rotted back into the mound, so only the big fresh
     * pieces keep one. Raised from 0.55 because with the piece count down to
     * the thirties and the bole/limb split on top of it, a 55% roll on the
     * qualifying subset was delivering zero or one plate in the whole wood, and
     * an upturned root plate is one of the two or three most characteristic
     * objects on this floor. */
    const wad = decay < 0.68 && len > 6 && rng.chance(0.80);
    out.push({
      x, z, az, len, rA, rB: rA * rng.range(0.42, 0.80),
      decay, wad,
      /* Scaled off the butt radius, because the plate is the root system and a
       * bigger stem tears out a bigger disc. Two and a half radii puts a 40 cm
       * log's butt a metre up, which is about what the photographs show. */
      lift: wad ? rA * rng.range(1.6, 3.0) : 0,
      seed: rng.range(0, 1000),
    });
  }
  return out;
}

/**
 * Build the wood.
 *
 * One `Mesh` per tile per family, so the whole forest arrives as a handful of
 * static buffers with nothing to update per frame and a bounding sphere small
 * enough for the frustum to reject.
 */
export function buildForest(): Forest {
  /* One stream, consumed in a fixed order. Two builds of the same code are the
   * same wood, which is the only thing this has to guarantee — but it does mean
   * that changing the number of logs reshuffles the sticks. */
  const rng = new Rng(0x0f0125);

  const tiles = new Map<number, { cx: number; cz: number; wood: Mesh; canopy: Mesh }>();
  const tileAt = (x: number, z: number) => {
    const ti = Math.floor(x / TILE), tj = Math.floor(z / TILE);
    const k = (ti + 64) * 256 + tj + 64;
    let t = tiles.get(k);
    if (!t) {
      tiles.set(k, t = {
        cx: (ti + 0.5) * TILE, cz: (tj + 0.5) * TILE,
        wood: new Mesh(), canopy: new Mesh(),
      });
    }
    return t;
  };

  const specs = standSpecs();
  const counts = {
    trees: 0, snags: 0, leaners: 0, poles: 0,
    stubs: 0, logs: 0, wads: 0, sticks: 0, woodTris: 0, canopyTris: 0,
    ...(() => {
      const s = skyStats(specs);
      /* Reported rather than reasoned about. The lean is a capped half-normal
       * and its mean is not the sigma; this has now been misjudged from the
       * formula in both directions across two reviews, once as too much and
       * once as far too little. */
      const L = specs.filter((t) => !t.hungUp).map((t) => (t.lean * 180) / Math.PI).sort((a, b) => a - b);
      return {
        skyRaw: standSkyRaw(), skyMean: s.mean, skySpread: s.spread,
        leanMean: +(L.reduce((a, b) => a + b, 0) / Math.max(1, L.length)).toFixed(2),
        leanP90: +(L[Math.floor(L.length * 0.9)] ?? 0).toFixed(2),
        sweepPct: +((100 * specs.filter((t) => t.sweep > 0).length) / Math.max(1, specs.length)).toFixed(1),
      };
    })(),
  };

  for (const t of specs) {
    const tile = tileAt(t.x, t.z);
    counts.stubs += bole(tile.wood, t, rng);
    if (t.sp === 'pole') counts.poles++; else counts.trees++;
    if (t.dead) counts.snags++;
    if (t.hungUp) counts.leaners++;
    /* Every live stem carries foliage, including the poles, which used to be
     * excluded on the grounds that a crown at six metres is inside the frame.
     * That was true and the conclusion was wrong: what does not belong in the
     * near field is a *dark* cutout, and the fix for that is the value the
     * subcanopy is drawn at, not its absence. Excluding it cost the frame its
     * whole ten-to-thirty-metre shell and left eleven hundred bare whips
     * ending in lids. Six metres is the floor because below it a stem has not
     * cleared the fern layer and its crown would be buried anyway. */
    if (!t.dead && (t.hFull > 14 || (t.sp === 'pole' && t.hFull > 6)))
      crown(tile.canopy, tile.wood, t, rng);
  }

  for (const spec of logSpecs(rng)) {
    fallen(tileAt(spec.x, spec.z).wood, spec, rng);
    counts.logs++;
    if (spec.wad) counts.wads++;
  }

  counts.sticks = stickField((x, z) => tileAt(x, z).wood, rng);

  const out: ForestTile[] = [];
  for (const t of tiles.values()) {
    counts.woodTris += t.wood.idx.length / 3;
    counts.canopyTris += t.canopy.idx.length / 3;
    out.push({
      cx: t.cx, cz: t.cz,
      wood: t.wood.count ? t.wood.build() : null,
      canopy: t.canopy.count ? t.canopy.build() : null,
    });
  }

  return { tiles: out, counts };
}
