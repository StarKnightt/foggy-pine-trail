/* The forest floor, as a height function.
 *
 * One function, `groundHeight(x, z)`, and it is the authority. The ground mesh
 * is a sampling of it, the walker's eye rides on it, every tree base and every
 * fern is planted on it, every log lies along it. Nothing is allowed to have
 * its own idea of where the floor is — a tree standing 4 cm proud of the duff
 * with a visible gap under its root flare is the fastest way to lose a frame,
 * and it is exactly what happens when placement uses an approximation of a
 * surface that the mesh renders exactly.
 *
 * ── What is in it ─────────────────────────────────────────────────────────
 *
 * Four terms, largest to smallest:
 *
 *   macro       a broad tilt and roll, 2-3 m over the length of the walk. The
 *               brief asks for gentle undulation; this is it. Its main job is
 *               to stop the trail from being level, because a level trail
 *               gives the frame a horizon and forest trails do not have one.
 *   hummock     1-2 m mounds at ~7 m spacing. Real PNW floor is not smooth: it
 *               is a couple of centuries of fallen trees rotted down into
 *               mounds with hollows between them, and the mound spacing is set
 *               by how big the trees were.
 *   trough      the trail itself, cut in. See below.
 *   duff        centimetre-scale roughness everywhere off the trail. Small
 *               enough that the normal map would normally carry it, but it has
 *               to be in the *geometry* because ferns and litter are planted
 *               on it and a fern standing on a flat plane inside a bumpy
 *               normal map reads as a decal.
 *
 * ── The bench ─────────────────────────────────────────────────────────────
 *
 * A worn trail is a bench and a slightly raised margin: boots compact the
 * tread down flat and push the displaced litter out to the sides, where it
 * piles against the undisturbed duff. Both halves matter. The bench alone
 * reads as a ditch; the berm alone reads as a kerb.
 *
 * The cross-section is the part that is easy to get wrong. It has a *flat*
 * base — you can stand on it with both feet level — and the whole 85 mm of
 * wear happens in a short rise at each edge. A raised cosine across the full
 * width, which is what was here, is flat only at the exact centreline and
 * slopes continuously from there, and from eye height that is indistinguishable
 * from a V: an erosion gully with two walls meeting at a line. The fix is to
 * spend the wear on the bank and leave the base alone apart from 16 mm of dish.
 *
 * ── What grading does and does not mean ───────────────────────────────────
 *
 * Only the *small* terms are suppressed over the tread. Suppressing the metre-
 * scale hummocks as well is the single worst bug this file has had: with `hum`
 * running ±50 cm and its suppression fading out over the 49 cm to the margin,
 * the tread sat as far below the floor as whatever mound it happened to be
 * crossing. `crossSection()` measured -27 to -31 cm at four stations with a
 * 100-146% maximum grade, and +9.7 cm *proud* at a fifth where the trail
 * crossed a hollow instead — a trench in some frames and a raised causeway in
 * others, from a `trailDepth` of 85 mm.
 *
 * Grading means a trail follows a locally averaged line, not that it deletes
 * the terrain's local value. A real single-track rolls straight over a 15 cm
 * mound at 2.4 m spacing, because a 12% grade is nothing to walk. What wear
 * actually removes is everything below about half a metre of wavelength: the
 * sub-metre lumps and the centimetre duff roughness. So the two long hummock
 * bands run through untouched and only the 1.1 m band and the duff are
 * suppressed, which bounds the whole cross-section at the bench depth plus a
 * few centimetres no matter where along the trail it is sampled.
 */
import { Noise2D, clamp, smoothstep } from './noise';
import { trail } from './trail';
import { DIMS } from './dims';

const n = new Noise2D(20260814);

/* The two long hummock bands, as a function of position, because the trail
 * corridor needs them evaluated somewhere other than where it is standing. */
function hummock(x: number, z: number): number {
  /* Three bands now, and the new one at 19 m is here rather than in `macro`
   * for a specific reason: it is large enough to matter to the tread, and
   * everything in this function is levelled across the corridor by the caller
   * while `macro` is not. Put in `macro` at this amplitude it would have run a
   * 20% cross-slope through a trail that took three revisions to get flat.
   *
   * What it is for is the line the floor draws against the air. Measured with
   * every other object hidden, the terrain's silhouette across the whole frame
   * width occupied nine pixels — a ruled line, sd 2.3 px — and the review
   * called the floor a tabletop. The cause is not that the surface is smooth:
   * a silhouette is an upper envelope taken along the sightline, and an
   * envelope over thirty metres of a 2.4 m field converges on that field's
   * maximum and is flat by construction. Only a wavelength of the same order
   * as the viewing distance survives being enveloped.
   *
   * Ridged rather than fbm for the same reason the other two are: pit and
   * mound topography is what a few centuries of windthrow leaves, and it is
   * mounds with hollows between them rather than a wave. */
  return (n.ridged(x * 0.145, z * 0.145, 3) - 0.55) * 0.62
    + (n.ridged(x * 0.42, z * 0.42, 2) - 0.50) * 0.30
    + (n.ridged(x * 0.052 + 8.3, z * 0.052 + 4.1, 2) - 0.52) * 1.30;
}

/** Ruts. Two of them, from boots keeping to the same two lines for decades. */
function ruts(sideOffset: number, along: number): number {
  // Rut centres at ±13 cm, which is a stride width, and shallow: 18 mm. Any
  // deeper and they read as bike tracks.
  const a = Math.exp(-((sideOffset - 0.13) * (sideOffset - 0.13)) / 0.010);
  const b = Math.exp(-((sideOffset + 0.13) * (sideOffset + 0.13)) / 0.010);
  // They fade in and out along the trail — a rut is a stretch of trail, not a
  // property of the whole thing.
  const live = smoothstep(0.15, 0.55, n.fbm(along * 0.11, 4.3, 2) * 0.5 + 0.5);
  // 11 mm rather than 18: the ruts now sit inside a base that already carries
  // 16 mm of dish, and the pair has to stay inside the 2-4 cm a real bench has.
  return -(a + b) * 0.011 * live;
}

export function groundHeight(x: number, z: number): number {
  const t = trail().at(x, z);
  const shape = trailShape(t.t * DIMS.trailLength);
  const half = DIMS.trailHalf * shape.width;
  const flat = DIMS.trailFlat * shape.width;
  /* Everything that removes ground has to scale together.
   *
   * Measured: with only `trailDepth` scaled by the incision, 2% of the length came
   * out flush and the depth still ran 2.7-9.1 cm — because most of the cut was never
   * in `trailDepth`. It is in the duff mat being stripped and the hummock field being
   * flattened across the corridor, and those two are the mechanism by which a trail
   * sits below the floor. Scaling the nominal depth alone modulates the smallest of
   * the three terms and leaves the trench where it was, which is the third time this
   * file has been caught by the same thing. */
  const cut = clamp(shape.incision, 0, 1);

  /* Macro relief. Two octaves at a long wavelength: enough to tilt the floor
   * and give the far trunks different base heights, not enough to become
   * hills, which this is not. */
  const macro = n.fbm(x * 0.021, z * 0.021, 2) * 1.35;

  /* Hummocks. Ridged rather than plain fbm because the real thing is a field
   * of *mounds* with hollows between them, not a smooth wave — the mounds are
   * rotted-down root plates and they have flattish tops and steeper sides.
   *
   * Three bands, not one. A single 7 m term is the spacing of the big rotted
   * root plates and it is real, but on its own it is invisible: 7 m is longer
   * than the fog lets you see clearly, so it renders as a slow tilt and the
   * floor still runs out to a flat prairie horizon. The relief a standing
   * viewer actually reads is the 2.4 m band — individual mounds and the pits
   * beside them from windthrow — and the 1.1 m band that breaks their flanks
   * up. Amplitudes are deliberately large for their wavelength; PNW floor is
   * lumpy to the point of being awkward to walk on off-trail.
   */
  let hum = hummock(x, z);

  /* Flattened *across* the trail, not along it.
   *
   * A trail is a routed line. It climbs and drops with the ground lengthwise,
   * but its cross-section does not inherit whatever the hummock field happens to
   * be doing sideways, because a trail that did would be a drainage channel
   * wherever the field dipped — and that is measurably what it was. With the
   * field running through untouched, `crossSection()` found four of six stations
   * with shoulders 5-12 cm above the tread from the 2.4 m band alone, on top of
   * a 4.5 cm cut. A shallow bench sitting in a 2.4 m gully still reads as a
   * trench, which is why zeroing the suppression did not fix the complaint.
   *
   * Sampling the field at the nearest centreline point makes the tread level
   * across its width by construction, and blending back to the true field over
   * the following metre spends the difference as a 10-15% side slope rather than
   * a wall. Costs one extra pair of ridged samples, inside the corridor only.
   */
  if (t.dist < 1.45) {
    const cx = x + t.tz * t.side, cz = z - t.tx * t.side;
    hum += (hummock(cx, cz) - hum) * (1 - smoothstep(half, 1.45, t.dist)) * cut;
  }

  /* Split out because this is the shortest band the tread is allowed to flatten:
   * 1.1 m lumps are what boots actually grind off, and at 7.5 cm amplitude the
   * bank it leaves at the tread edge is a 15% grade rather than a wall.
   *
   * Both this and `duff` are folded to be non-negative, which matters more than
   * it looks. As signed displacements they lowered the tread where they happened
   * to be positive and *raised* it where they were negative, so the trail read
   * as cut in some frames and as a proud pale causeway in others. A litter mat
   * has a thickness, not a sign: scraping it off can only ever go down. */
  const humFine = (n.fbm(x * 0.88, z * 0.88, 2) * 0.5 + 0.5) * 0.075;

  /* Duff. Centimetre roughness, everywhere except the tread — read as the depth
   * of loose mat over the mineral soil, 0 to 6 cm. */
  const duff = (n.fbm(x * 1.35, z * 1.35, 3) * 0.5 + 0.5) * 0.045
    + (n.fbm(x * 3.9, z * 3.9, 2) * 0.5 + 0.5) * 0.016;

  /* How much of the surrounding ground the tread has smoothed away. 1 on the
   * centreline, 0 by the time the margin ends. */
  const tread = 1 - smoothstep(0, half * 1.15, t.dist);
  /* The berm: displaced litter piled just outside the tread. Peaks right at the
   * top of the bank and dies within 20 cm. The previous 0.10 in the exponent
   * was a 32 cm sigma, which spread 26 mm of berm over most of a metre either
   * side and was most of why the disturbed ground measured nearly three metres
   * across. */
  const bermAt = half + 0.05;
  /* Asymmetric, because the two edges of a trail are not built the same way.
   * On the uphill side the duff is cohesive and root-bound and stands as a small
   * overhanging lip 2-6 cm proud of the mineral tread, with a shadow line under
   * it; on the downhill side the saved duff is pulled out over the fillslope and
   * feathers away. Rendering both edges identically is one of the things that
   * makes a trail read as an extruded profile rather than as a cut. Which side
   * is which swaps every few metres so it is not a property of the whole trail.
   */
  const lean = smoothstep(-0.35, 0.35, n.fbm(t.t * 9.1, 61.7, 2));
  const lean2 = t.side > 0 ? lean : 1 - lean;
  const berm = Math.exp(-((t.dist - bermAt) * (t.dist - bermAt)) / 0.009)
    * (0.014 + 0.034 * lean2) * cut;

  /* The fine band fades out over a metre rather than over the 43 cm the material
   * blend uses, so the ground it leaves proud arrives as a slope the eye reads
   * as terrain instead of as a step at the litter line. */
  const graded = 1 - smoothstep(0, half + 0.62, t.dist);

  let h = macro
    + hum
    + humFine * (1 - graded * 0.40 * cut)
    + duff * (1 - tread * 0.80 * cut);

  /* The bench. Full depth across the level base, then the bank climbs it out
   * over `trailBank` with a raised cosine so there is no crease at either end
   * of the climb. */
  if (t.dist < half) {
    const s = Math.max(0, (t.dist - flat) / DIMS.trailBank);
    h -= DIMS.trailDepth * cut * (0.5 + 0.5 * Math.cos(s * Math.PI));
    if (t.dist < flat) {
      const u = t.dist / flat;
      h -= DIMS.trailDish * (0.35 + 0.65 * cut) * (1 - u * u);
    }
  }
  h += berm;

  if (t.dist < half * 1.6) {
    h += ruts(t.side, t.t * DIMS.trailLength) * (1 - smoothstep(half, half * 1.6, t.dist));
  }

  /* The swell of earth a surface root raises, and the hollow washed out around
   * it. Not the root: that is a tube mesh — see `roots()` in `trailProps.ts` —
   * because the thing that makes an exposed root read is its *undercut*, and a
   * heightfield cannot express an overhang at any resolution.
   *
   * What the heightfield does carry is the pair of terms either side of the
   * tube. `lip` is the ground rising to meet it, which is what keeps the tube
   * from looking laid on top of the trail like a length of rope. `moat` is the
   * 2 cm the soil has dropped for a hand's width around it, and it is the term
   * that was missing: a root sitting in undisturbed ground reads as a decal no
   * matter how well its own shading is done, because the eye is looking for the
   * erosion that says the root has been there longer than the soil has.
   *
   * Same generator as the tubes, so the two cannot drift apart.
   */
  const along = t.t * DIMS.trailLength;
  if (t.dist < 1.5) {
    const fade = 1 - smoothstep(0.7, 1.5, t.dist);
    for (const r of rootsNear(along)) {
      const dd = (along - r.at) + t.side * r.skew;
      /* Swell half-width, floored at 22 cm rather than scaled purely off the
       * radius. This is a sampling constraint, not an aesthetic one: the ground
       * mesh steps 22 cm along z and the swell runs across the trail, so a ridge
       * with the 16 cm sigma this used to have fell between rows and simply was
       * not built. The tube then stood on earth that existed only in the height
       * function, and the result was a row of croquet hoops arching over the
       * trail with daylight under them — the most conspicuous artefact in the
       * set, and entirely a mesh resolution problem rather than a root problem.
       * A real root also piles soil more broadly than its own diameter. */
      const w = Math.max(0.22, r.thick * 3.0);
      const prof = Math.exp(-(dd * dd) / (2 * w * w));
      const lip = prof * r.thick * 0.62;
      const moat = (Math.exp(-(dd * dd) / (12 * w * w)) - prof) * Math.min(0.030, r.thick * 0.7);
      h += (lip - moat) * fade;
    }
    for (const r of longRootsNear(along)) {
      const u = (along - r.at) / r.len;
      if (u < -0.1 || u > 1.1) continue;
      const dd = t.side - (r.side + Math.sin(u * 4.1 + r.at) * r.wander);
      /* These run along the trail, so the columns rather than the rows resolve
       * their swell, and the columns are 6 cm. The floor is still worth having so
       * the two root families pile soil the same way. */
      const w = Math.max(0.14, r.thick * 3.0);
      const prof = Math.exp(-(dd * dd) / (2 * w * w));
      const moat = (Math.exp(-(dd * dd) / (12 * w * w)) - prof) * Math.min(0.030, r.thick * 0.8);
      // Dies at both ends, where the root dives back under the bank.
      const ends = smoothstep(-0.1, 0.14, u) * (1 - smoothstep(0.86, 1.1, u));
      h += (prof * r.thick * 0.62 - moat) * ends * fade;
    }
  }

  /* Soil piled against the stones.
   *
   * A stone that has sat in a forest floor for a century is not resting on it:
   * litter and washed fines bank up against its uphill and lee faces, so the
   * ground rises into the stone and there is no line of daylight under its rim.
   * Without this every rock inside four metres read as a faceted tent set down on
   * the duff, which no amount of shading on the stone itself can fix, because the
   * defect is in the ground rather than in the rock.
   *
   * The half-width is floored at 30 cm, which is the point of the whole term
   * being written this way. The root swell used a sigma scaled off the radius, it
   * came out at 16 cm against a 22 cm mesh row spacing, and it therefore fell
   * between rows and was never built — the tubes ended up standing on earth that
   * existed only in this function. Same trap, one system later, so the floor is
   * set above the row spacing rather than derived from the object.
   */
  const alongS = t.t * DIMS.trailLength;
  if (t.dist < 5.6) {
    for (const s of bigStonesNear(alongS)) {
      const dx = alongS - s.at, dy = t.side - s.side;
      const w = Math.max(0.30, s.size * 1.9);
      const d2 = (dx * dx + dy * dy) / (w * w);
      if (d2 > 6) continue;
      /* A mound that peaks at the stone and dies within a couple of radii, minus
       * a shallow scour ring outside it where runoff has taken the fines away.
       * The pair is what makes it read as deposition rather than as a bump. */
      const mound = Math.exp(-d2 * 0.5);
      const scour = Math.exp(-d2 * 0.16) - mound;
      h += mound * s.size * 0.30 - scour * Math.min(0.022, s.size * 0.16);
    }
  }

  return h;
}

/**
 * The trail's cross-section, for measuring rather than eyeballing.
 *
 * The profile is the one thing in this file that cannot be judged from a
 * render. A trench and a bench look similar in a foreshortened frame — the
 * difference is a number in centimetres — and the two revisions of this
 * function that shipped a trench both did so because the depth was checked by
 * looking at a picture. What that missed, twice, is that most of the depth was
 * never in `trailDepth` at all: it came from the hummock suppression removing a
 * half-metre mound from under the tread while leaving it either side, so the
 * cut was as deep as whatever relief the trail happened to be crossing and
 * changed along its length. That is invisible in a screenshot and obvious in
 * one column of numbers.
 *
 * Heights come back in metres, absolute; the caller normalises against
 * whichever sample it wants to call the undisturbed floor.
 */
export function crossSection(along: number, half = 2.0, step = 0.02): number[] {
  const c = trail().pointAtAlong(along);
  const nx = -c.tz, nz = c.tx;
  const out: number[] = [];
  for (let i = 0; i * step <= 2 * half + 1e-9; i++) {
    const s = -half + i * step;
    out.push(groundHeight(c.x + nx * s, c.z + nz * s));
  }
  return out;
}

export type RootSpec = {
  /** Arc position along the trail, metres from the start. */
  at: number;
  /** How much the crossing is skewed off perpendicular. */
  skew: number;
  /** Radius, metres. */
  thick: number;
  /** How far either side of the centreline it stays above ground. */
  reach: number;
  /** Side offset where a daughter root forks off, or 0 for none. */
  fork: number;
};

/**
 * How wide and how deeply cut the trail is at a given point down its length.
 *
 * The measured cross-section is in band at every station and the objection this
 * answers is one no cross-section measurement can catch: the trench was perfectly
 * continuous and perfectly *invariant*. Two dark parallel wall-bands ran from the
 * camera to the vanishing point in every single frame, never widening, never
 * narrowing, never coming flush with the floor, never braiding out around an
 * obstacle. That regularity is what reads as a drainage channel — not the depth,
 * which is why fixing the depth did not fix the complaint. Nothing in a forest is
 * extruded along 48 m without varying.
 *
 * In the reference photographs a single-track is largely *flush* with the forest
 * floor, with a ragged wandering edge, and is only properly incised where it
 * crosses a sidehill or a wet spot. So `incision` is allowed all the way down to
 * 0.06 — genuinely flush, no cut at all — over stretches several metres long, and
 * the two fields are deliberately given different wavelengths so a wide stretch is
 * not reliably a deep one.
 *
 * Shared with the mesh's tread weight, because the pale mineral material is what
 * the eye takes as the width of the trail. A geometry that narrows under a material
 * that does not is worse than neither varying.
 */
export function trailShape(along: number): { width: number; incision: number } {
  /* Two octaves so a stretch has both a length and a ragged sub-length. The long
   * one is 11 m, which is past what the fog resolves, and that is the point: the
   * variation has to survive being seen from one end. */
  const w = n.fbm(along * 0.09, 3.7, 2) * 0.62 + n.fbm(along * 0.31, 51.3, 2) * 0.38;
  const d = n.fbm(along * 0.135 + 17, 88.1, 2) * 0.66 + n.fbm(along * 0.42 + 5, 12.9, 2) * 0.34;
  return {
    width: 0.72 + 0.62 * clamp(w * 0.5 + 0.5, 0, 1),
    /* Cubed, which is what puts real flush stretches in rather than a trail that
     * merely breathes. A linear map spends most of its length near the mean and the
     * result still reads as one continuous channel of slightly varying depth; the
     * cube makes shallow the common case and a properly cut bench the exception,
     * which is the distribution the photographs show. */
    incision: 0.06 + 0.99 * clamp(d * 0.5 + 0.5, 0, 1) ** 3,
  };
}

/** A stone big enough for the ground to be piled against it. */
export type StoneSpec = {
  /** Arc position along the trail, metres from the start. */
  at: number;
  /** Signed offset from the centreline. */
  side: number;
  /** Long-axis radius, metres. */
  size: number;
  /** Fraction of its own height that sits below the soil line. */
  buried: number;
  /** How mossy, 0-1. */
  moss: number;
  /** World position. Only filled in by `allBigStones`, because resolving it costs
   * a curve evaluation and `groundHeight` works in trail coordinates anyway. */
  wx?: number;
  wz?: number;
};

/* The stones the heightfield knows about.
 *
 * Only the ones over 9 cm. Below that the collar is thinner than the ground mesh
 * can resolve and the stone reads as bedded anyway because its own contact crease
 * carries it; above it, a stone sitting on an unmodified floor is the defect the
 * audit named — a faceted tent resting on the duff with no soil against it.
 *
 * Same generator as the geometry, for the same reason the roots share one: two
 * generators put the collar in one place and the stone in another, and a few
 * centimetres of disagreement is small enough to pass review and large enough to
 * look wrong. This one is a cell walk rather than the sequential `Rng` the props
 * used, because the heightfield has to be able to answer for an arbitrary
 * position without replaying the whole scatter.
 */
export function bigStonesNear(along: number, span = 2.4): StoneSpec[] {
  const out: StoneSpec[] = [];
  /* Two per cell, at two different lateral distributions, so one walk covers both
   * the stones in the tread and the ones out in the duff. */
  const c0 = Math.floor((along - span) / 1.1), c1 = Math.floor((along + span) / 1.1);
  for (let cell = c0; cell <= c1; cell++) {
    for (let k = 0; k < 2; k++) {
      const s0 = cell * 3.0 + k * 71.3;
      if (n.n(s0 * 3.1 + 9.31, 41.7) <= (k === 0 ? -0.06 : 0.18)) continue;
      const u = n.n(s0 * 1.7 + 5.17, 13.9) * 0.5 + 0.5;
      /* Power law weighted to the small end, matching the props' own
       * distribution: many small, few large. 9-40 cm. */
      const size = 0.045 + 0.155 * u ** 2.1;
      const onTrail = k === 0;
      const side = onTrail
        ? n.n(s0 * 2.3 + 6.53, 7.7) * DIMS.trailHalf * 0.9
        : Math.sign(n.n(s0 * 1.3 + 2.11, 30.3) || 1)
          * (DIMS.trailHalf + 0.10 + Math.abs(n.n(s0 * 0.9 + 8.09, 5.5)) * 6.2);
      out.push({
        at: cell * 1.1 + 0.55 + n.n(s0 * 2.9 + 4.61, 17.3) * 0.5,
        side,
        size,
        buried: 0.60 + (n.n(s0 * 3.7 + 7.41, 9.2) * 0.5 + 0.5) * 0.26,
        moss: onTrail ? 0 : 0.45 + (n.n(s0 * 1.1 + 1.93, 26.6) * 0.5 + 0.5) * 0.55,
      });
    }
  }
  return out;
}

/** Every stone the heightfield has piled soil against, for the geometry pass. */
export function allBigStones(): StoneSpec[] {
  const out: StoneSpec[] = [];
  const tr = trail();
  for (let a = -2; a < DIMS.trailLength + 3; a += 4) {
    for (const s of bigStonesNear(a + 2, 2)) {
      if (s.at < a || s.at >= a + 4) continue;
      const c = tr.pointAtAlong(s.at);
      out.push({ ...s, wx: c.x + -c.tz * s.side, wz: c.z + c.tx * s.side });
    }
  }
  return out;
}

/** A root running with the trail rather than across it. */
export type LongRootSpec = {
  /** Arc position of the upstream end, metres from the start. */
  at: number;
  /** How far it runs before diving back under. */
  len: number;
  /** Signed offset from the centreline it follows. */
  side: number;
  /** How much that offset weaves. */
  wander: number;
  /** Radius, metres. */
  thick: number;
};

/* Where the surface roots are.
 *
 * Shared between the heightfield above and the tube geometry, which is the
 * whole point: two generators would put the swell in one place and the root in
 * another, and the gap would be a few centimetres — small enough to survive
 * review and large enough to look wrong.
 *
 * Roughly every 2.3 m with heavy jitter, and only about two thirds of the
 * slots are taken, so they cluster and gap the way real ones do rather than
 * arriving like sleepers on a railway.
 */
export function rootsNear(along: number, span = 3): RootSpec[] {
  const out: RootSpec[] = [];
  /* 3.6 m cells with half the slots empty, so roughly one crossing every 7 m.
   * At 1.9 m with two thirds taken they arrived at a steady beat that read as
   * sleepers on a railway — visible in a single frame, because a frame at eye
   * height shows eight of them at once and the regularity of the *spacing* is a
   * stronger cue than the shape of any one of them. */
  const c0 = Math.floor((along - span) / 3.6), c1 = Math.floor((along + span) / 3.6);
  for (let cell = c0; cell <= c1; cell++) {
    if (n.n(cell * 5.7, 19.3) <= 0.02) continue;
    /* Radius on a power law, not a uniform range. Real surface roots on a trail
     * run 2-20 cm across and the distribution is heavily weighted to the thin
     * end — a 20 cm buttress root is an event, and the previous uniform
     * 42-70 mm gave every root on the trail the same apparent mass, which is
     * most of why they read as a repeated decal rather than as roots. */
    const u = n.n(cell * 3.6, 2.4) * 0.5 + 0.5;
    /* 22 mm floor and a gentler exponent than the first attempt at this, which
     * used 14 mm and 2.6 and put most of the population under 3 cm across. At
     * that diameter a root standing 0.52 of its radius proud of a soil surface
     * that has itself been dished 2 cm around it does not read as a root: it
     * reads as a cable lying in a groove, which is what the frame came back
     * with. 4-18 cm across, weighted low. */
    const thick = 0.022 + 0.078 * u ** 1.9;
    out.push({
      at: cell * 3.6 + 1.8 + n.n(cell * 7.13, 11.7) * 1.7,
      /* Wide, because a set of roots all crossing within 30 degrees of
       * perpendicular is a pattern the eye finds in about a second. Real surface
       * roots cross at anything from square-on to nearly parallel. */
      skew: n.n(cell * 3.31, 5.2) * 1.25,
      thick,
      /* Reach scales with thickness: a thin root surfaces for a few tens of
       * centimetres and dives, a thick one crosses the whole tread and keeps
       * going. Both used to reach 1.1-1.8 m regardless, which made even the
       * thinnest of them imply a two-metre object. */
      reach: 0.34 + 12.0 * thick + 0.30 * (n.n(cell * 2.7, 8.1) * 0.5 + 0.5),
      // Only the thicker third fork; a 2 cm root has nothing to fork into.
      fork: thick > 0.036 && n.n(cell * 4.4, 31.2) > 0.05
        ? n.n(cell * 6.1, 27.5) * 0.30 : 0,
    });
  }
  return out;
}

/* Roots that run *with* the trail.
 *
 * Reference photographs of a rooty trail have as many of these as they have
 * crossings — a root that surfaces where the tread has cut into a root plate
 * follows the line of least soil, and that is often along the trail rather than
 * across it. Sparser than the crossings, one every 6 m or so, and they sit
 * towards the tread edges where the bank has been cut rather than up the middle.
 */
export function longRootsNear(along: number, span = 3): LongRootSpec[] {
  const out: LongRootSpec[] = [];
  const c0 = Math.floor((along - span - 4) / 6.1), c1 = Math.floor((along + span) / 6.1);
  for (let cell = c0; cell <= c1; cell++) {
    if (n.n(cell * 9.2, 41.7) <= 0.05) continue;
    const u = n.n(cell * 2.15, 13.9) * 0.5 + 0.5;
    out.push({
      at: cell * 6.1 + n.n(cell * 3.7, 22.1) * 2.4,
      len: 1.4 + 2.6 * u,
      side: (n.n(cell * 5.05, 7.7) > 0 ? 1 : -1) * (0.10 + 0.26 * (n.n(cell * 1.3, 44.2) * 0.5 + 0.5)),
      wander: 0.03 + 0.06 * u,
      thick: 0.020 + 0.052 * u ** 1.8,
    });
  }
  return out;
}

/** Every root over the whole trail, for building the tube geometry once. */
export function allRoots(): RootSpec[] {
  return rootsNear(DIMS.trailLength * 0.5, DIMS.trailLength * 0.5 + 4);
}

/** Every lengthwise root, likewise. */
export function allLongRoots(): LongRootSpec[] {
  return longRootsNear(DIMS.trailLength * 0.5, DIMS.trailLength * 0.5 + 8);
}

/**
 * Surface normal, by central difference of the height function.
 *
 * 6 cm apart: fine enough to pick up a root and coarse enough not to pick up
 * the duff term, which is the correct split. The duff belongs to the normal
 * map, and a fern that tilts with every centimetre-scale bump looks drunk.
 */
export function groundNormal(x: number, z: number, e = 0.06): [number, number, number] {
  const hL = groundHeight(x - e, z), hR = groundHeight(x + e, z);
  const hD = groundHeight(x, z - e), hU = groundHeight(x, z + e);
  const nx = hL - hR, nz = hD - hU, ny = 2 * e;
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}
