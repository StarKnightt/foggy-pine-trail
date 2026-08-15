/* What is actually in the air, as numbers.
 *
 * Two populations, and the reason they are one system with one buffer rather
 * than two is that they differ only in their *parameters*. A needle and a
 * pollen grain are both a wrapped descent plus a wander; what separates them
 * is that one descends at a metre a second and wanders in centimetres and the
 * other descends at two centimetres a second and wanders in decimetres. Once
 * that is written down there is one motion model, one draw call and one place
 * to be wrong.
 *
 * ── Fall speeds, and where they come from ─────────────────────────────────
 *
 * Pollen is measured and is not a guess. Pinus taeda pollen has a terminal
 * velocity of 2.1-2.3 cm/s (Williams 2008, Niklas 1984) — unusually slow for a
 * ~50 µm grain because the two air-filled sacci add volume without adding
 * mass. That is the number `DUST` uses and it is most of why this population
 * reads as suspended rather than as falling: at 2.2 cm/s a grain crosses the
 * frame's near field in about a minute, which is slow enough that the eye
 * never sees it as descending at all.
 *
 * Needles are not measured anywhere I could find, so they are derived and the
 * derivation is checkable. A Douglas-fir needle is about 25 mm long, 1.5 mm
 * wide and weighs around 4 mg. Falling broadside, v = sqrt( 2mg / (rho A Cd) )
 * with A = 3.75e-5 m^2, rho = 1.2 and Cd ~ 1.5 for a plate at Re ~ 200 gives
 * 1.08 m/s. That brackets correctly against the one adjacent thing that *is*
 * measured: Pinus radiata samaras, which are a similar mass with a great deal
 * more area, fall at 0.58-1.42 m/s with a mean of 0.8-1.1 (Wyse et al.). A
 * needle should sit at the fast end of that band and it does.
 *
 * Broadleaf litter — vine maple, which is the understorey broadleaf on this
 * coast — is larger, lighter per unit area and falls at roughly half the
 * speed, with the long swooping glide everyone has watched. The brief asks for
 * "needles and leaves", so a small fraction of the falling population is one.
 *
 * ── Why the flutter frequency is not the Strouhal number ──────────────────
 *
 * A thin plate at Re ~ 200 does not fall steadily; it flutters, and the
 * textbook scaling is f = St * v / L with St around 0.2. For a 25 mm needle at
 * 1 m/s that is 8 Hz, and 8 Hz is wrong here for two separate reasons. It is
 * wrong physically — a conifer needle is not a plate, it is a stiff, roughly
 * semicircular rod that autorotates about its long axis and slips sideways in
 * a lazy helix far more often than it flaps — and it is wrong perceptually,
 * because 8 Hz at any visible amplitude reads as a vibrating sprite. The
 * effective Strouhal below is 0.045, which puts a needle at 1.8 Hz and a maple
 * leaf at 0.34 Hz, and those are the rates you can count off reference
 * footage. It is a fitted constant and it is the only one in this file that is
 * not sourced.
 *
 * ── Counts ────────────────────────────────────────────────────────────────
 *
 * The brief's word is "occasionally", and the arithmetic behind the numbers is
 * worth having because "a few hundred particles" sounds like a lot and is not.
 *
 * A needle reads between about two and eleven metres — see FALL_FADE for where
 * the far end came from. That shell, intersected with a 82 x 52 degree frustum
 * (9.3% of the sphere) and cut down for the part of it that is underground or
 * behind a trunk, is around 320 cubic metres. The wrap box is 23 x 23 x 16 m,
 * so 155 needles is 0.013 per cubic metre and puts four in the frustum, of
 * which the differenced count finds two or three legible. Two is the brief's
 * number and the rest are subliminal.
 *
 * The dust box is smaller in every dimension because a grain is only ever seen
 * within about six metres, and at 0.41 per cubic metre it puts of the order of
 * thirty grains inside the visible cone — of which only the ones standing in
 * front of something dark are visible at all, which is roughly a third of the
 * frame. That last clause is the whole reason a number that sounds like a lot
 * does not look like one.
 */

import { Rng } from './noise';

/* The wrap box, per population, as (half-extent in x and z, y floor, y top).
 *
 * Camera-relative in x and z and world-absolute in y, and the asymmetry is
 * deliberate. Wrapping x and z around the camera is what lets a hundred
 * needles stand in for a forest's worth: the box travels with the walk and a
 * particle that falls out of the back reappears at the front, at a distance
 * where `FADE_FAR` has already taken it to zero alpha so there is nothing to
 * see. Wrapping y the same way would tie every particle's altitude to the
 * camera's, and since the camera rides 1.62 m above a floor with a metre and a
 * half of macro relief in it, walking over a rise would slide the entire
 * population upwards together — which is the one motion in this system that
 * would unmistakably read as a shader.
 *
 * The y bands are absolute and generous enough to cover that relief. Needles
 * recycle at 14 m, which is up in the crowns where they come from; dust sits
 * in a shallower band because it is only ever seen within a few metres and
 * paying for grains twelve metres up is paying for nothing.
 */
export const DUST_BOX = { half: 7.0, lo: -1.5, hi: 6.5 } as const;
export const FALL_BOX = { half: 11.5, lo: -2.0, hi: 14.0 } as const;

/* Where each population is faded out, in metres.
 *
 * These have to be inside the corresponding `half` or the wrap becomes
 * visible: a particle crossing the box edge teleports by the full box width,
 * and the nearest that can happen is exactly `half` metres away. The margin is
 * only 0.9 m either way, which is enough because the fade is a smoothstep that
 * has reached zero at `FAR`, not an asymptote.
 *
 * The far numbers are where the contrast finally goes, and the needle one was
 * set by measurement rather than by guessing. It was 8.6 m on the first build
 * and the differenced count at three stations found one legible needle per
 * frame against a target of two — not because the population was too thin but
 * because the near field is a small volume and the needles that actually read
 * are the ones with the bright trail corridor behind them, which are further
 * out. At 11 m a needle is still six pixels long and, sat against fog at
 * display 190 with the sub-pixel alpha at 0.13, still removes twenty code
 * values. That is a fleck you notice; twenty metres out it would not be.
 *
 * The dust number is angular size rather than contrast: a 2 mm clump at 6.5 m
 * is a seventh of a pixel across and its area compensation has taken it to
 * two per cent alpha.
 */
export const DUST_FADE = { near: 4.5, far: 6.5 } as const;
export const FALL_FADE = { near: 8.5, far: 11.0 } as const;

/* The lens, as the two numbers a circle of confusion needs.
 *
 * These particles are the only geometry in the scene that ever comes within a
 * metre of the camera, and that makes defocus their problem rather than the
 * post-processing stack's. Measured on the first build: a 3 mm clump at 80 cm
 * rendered as a hard four-pixel dot 96 code values above the trunk behind it,
 * which is not what a mote looks like in any handheld footage ever shot. It is
 * a soft grey smudge, because it is a point source a long way inside the near
 * limit of the depth of field.
 *
 * This is deliberately *not* a job for a screen-space depth-of-field pass, and
 * the reason is worth stating so System 8 does not undo it. A DOF pass blurs
 * an image; the correct operation here is to convolve the particle's own
 * footprint with the lens point-spread function *before* it is rasterised,
 * because the particle is sub-pixel and the information a blur would need —
 * that this two-pixel dot is really a 3 mm object at 80 cm — is destroyed the
 * moment it is written to the framebuffer. Doing it here also conserves the
 * particle's total light exactly, which a post blur applied to an already
 * clamped dot cannot.
 *
 * A phone's main camera: 5 mm focal length at f/1.8, so a 2.8 mm entrance
 * pupil, focused about four metres out — which is where a walker's attention
 * is on a trail and about where autofocus lands. At 80 cm that gives a
 * two-and-a-half pixel blur circle at this framing, which takes the same
 * grain from 96 code values to about 30 and spreads it over three times the
 * area.
 *
 * ── Where this term provably does nothing, and why that is right ──────────
 *
 * A differenced pair against `?p=nofocus` at a typical station measures
 * *exactly zero pixels changed*, and that number is worth understanding
 * rather than treating as a dead code path — it very nearly got this deleted.
 *
 * Below one pixel the blur and the thin-feature compensation cancel
 * algebraically. Widening a footprint by the blur circle and then scaling
 * alpha by the area ratio, followed by clamping to the one-pixel floor and
 * scaling alpha by *that* area ratio, is the same product either way: the
 * particle deposits its true area's worth of light into one pixel whichever
 * order it is done in. Which is correct — a sub-pixel dot that is blurred is
 * still a sub-pixel dot, and no light has gone anywhere.
 *
 * So the term acts only on particles already larger than a pixel, which here
 * means grains inside about a metre and a half, and there is frequently not
 * one of those in frame. `?p=big6,nofocus` against `?p=big6` puts every
 * particle over the pixel floor and shows it plainly.
 */
export const APERTURE = 0.00278;
export const FOCUS = 4.0;

/* The near fades, in metres, per population.
 *
 * These are no longer doing the visibility work — the defocus above is — so
 * they are back to the one thing they are actually needed for, which is
 * bounding the point sprite. A sprite is a square as wide as the particle is
 * long, and the largest leaf here would want a 128-pixel one at a metre. Dust
 * has no such problem and is allowed much closer, which matters because the
 * near field is where it is seen at all.
 */
/* Dust is held back to 70 cm, and this one is a calculated guard rather than
 * an observed defect — stated that way because the two are worth telling
 * apart.
 *
 * The largest grain in the distribution at 32 cm works out at four pixels
 * across geometrically with a blur circle of another four, so an eleven-pixel
 * soft disc at 58% alpha: over a dark trunk that is a hundred code values
 * spread over a couple of hundred pixels, which stops reading as something in
 * the air and starts reading as dirt on the lens. None of the six stations
 * sampled happened to have one — the volume inside 40 cm is four litres — so
 * this is arithmetic, not a measurement. At 70 cm the same grain is a
 * three-pixel disc that still lifts a dark background by about a hundred
 * counts, which is the moment the brief calls catching the light, without the
 * smudge.
 *
 * The thing that *was* measured at 283 pixels and 105 code values turned out
 * to be a broadleaf at a metre and a half, and it is supposed to be there. */
export const DUST_NEAR = { in: 0.70, out: 0.40 } as const;
/* Held out to three metres, and the note above about "a broadleaf at a metre
 * and a half, and it is supposed to be there" is what this overrides.
 *
 * That object was measured here at 283 pixels and 105 code values and accepted
 * as a leaf. Read cold in a still it is not one: the pre-release review found
 * it as "a brown sphere floating unsupported in mid-air, smooth, perfectly
 * circular, soft-edged, with pale fog visible all around and beneath it,
 * attached to nothing", and named it the most embarrassing object in the set.
 * Both readings are correct and the difference between them is motion. A leaf
 * at a metre and a half is unmistakable in a walk because it swoops and rotates
 * and you watch it descend; frozen, it is a disc of uniform colour with no
 * support, no scale cue and no internal detail, because there is none to be had
 * at eleven pixels. The deliverable is hero stills as well as a video, so the
 * still has the casting vote.
 *
 * Three metres puts the largest leaf at 29 pixels rather than 65 and, more to
 * the point, puts enough air in front of it to have started desaturating it. */
export const FALL_NEAR = { in: 3.00, out: 1.50 } as const;

/** Effective Strouhal number for the flutter. Fitted, not sourced; see header. */
export const FLUTTER_ST = 0.045;

/** Lateral flutter excursion, in chord lengths of the falling object. */
export const FLUTTER_CHORDS = 0.5;

/* Albedos, as linear reflectance, and they are the only colour in the system.
 *
 * A needle that has just let go is still green but a needle drifting down in
 * October is nearly always a dead one from the interior of the crown, which is
 * a dull red-brown. Both are dark: conifer foliage runs 0.06-0.10 in luma and
 * dead needle litter 0.10-0.15, so whichever way this goes the particle is a
 * *dark* fleck against bright air. That is the correct reading and it is the
 * opposite of the dust population, which is bright against dark trunks — the
 * two are visible in different parts of the frame and by different mechanisms.
 *
 * Saturation is deliberately low. `probe()` reports frame mean saturation and
 * the brief bans bright colour; at this size a hue is not resolvable anyway
 * and all a saturated albedo would do is put a coloured pixel in an otherwise
 * neutral frame.
 *
 * Both are the *wet* values, and that is a 30% cut off the dry ones rather
 * than a rounding. Water films fill the surface microstructure and kill the
 * diffuse first-surface scatter that dry organic matter gets most of its
 * lightness and most of its saturation from — which is why a soaked log is
 * always darker and greyer than the same log in the sun, and why every other
 * surface in this project is authored damp. It was worth doing here for a
 * specific reason: at the dry values a broadleaf drifting past a trunk at a
 * metre and a half rendered as a flat tan pill, and a flat tan pill is the one
 * thing in this system that reads as a sprite rather than as a leaf. There is
 * no internal detail to be had at eleven pixels, so the only lever is to stop
 * it being the only saturated object in the frame.
 */
export const NEEDLE_ALBEDO: [number, number, number] = [0.094, 0.079, 0.062];
export const LEAF_ALBEDO: [number, number, number] = [0.118, 0.098, 0.072];

/* How bright a floating grain is relative to the air it is floating in.
 *
 * This single number is the whole visibility model for the dust and it is
 * worth stating as physics rather than as a level.
 *
 * There is no beam in this scene, so a grain cannot be lit differently from
 * the air around it — it is in the same nearly isotropic field. What it can do
 * is *return* a different fraction of it. Pollen and the fine fluff that
 * actually reads at this scale are white, translucent, multiply-scattering
 * things with effective albedos near one, so a grain's radiance comes out just
 * under the radiance of the air. That has exactly the consequence the brief
 * describes and it needs no logic to enforce it: against the fog the grain is
 * within a couple of code values of its background and vanishes; against a
 * trunk at RGB 13 it is a bright speck.
 *
 * Held strictly below 1.0, and that is a correctness constraint rather than a
 * taste one. Above 1.0 a grain would be brighter than saturated air, which is
 * the definition of punching a hole in the fog — the exact defect `fog.ts`
 * records having had to fix once already, where the sky-view term put the air
 * at 197 against a dome of 194 and every distant trunk grew a bright ghost. At
 * 0.90 the term structurally cannot do it.
 */
export const DUST_GAIN = 0.90;

/* Particle counts. See the header for the arithmetic behind the needle
 * number; the dust number is the same argument run at 0.42 grains per cubic
 * metre over a much smaller box, which puts about ten grains inside the four
 * metres where they can be seen at all and rather fewer than that in front of
 * something dark enough to see them against. */
/* Trimmed from 650 when System 8's linear target landed underneath this.
 *
 * The alpha values were first tuned against a build that blended straight to
 * the canvas, which meant a grain's coverage was mixed into an already
 * AgX-tone-mapped, sRGB-encoded background. System 8 renders into a half-float
 * target instead, so the same blend now happens in radiance and *then* goes
 * through the tone curve — and fog.ts's header has the arithmetic for what
 * that is worth: a small veil over a dark subject is a few code values mixed
 * after AgX and several times that mixed before it. Measured, the differenced
 * count of legible grains went from five per frame to thirteen without a line
 * of this system changing. Nothing was wrong; the frame simply started
 * compositing correctly and the population had been sized against the wrong
 * one.
 */
export const N_FALL = 155;
export const N_DUST = 430;

/** What fraction of the falling population is a broadleaf rather than a needle. */
export const LEAF_FRACTION = 0.04;

export type ParticleBuffers = {
  /** Base position: x and z within the box, y the descent phase. */
  position: Float32Array;
  /** (fall m/s, wander radius m, wander rate rad/s, phase 0..1). */
  mot: Float32Array;
  /** (kind: 0 grain / 1 needle / 2 leaf, half-length m, half-width m, tint). */
  shp: Float32Array;
  counts: { dust: number; needle: number; leaf: number; total: number };
};

/**
 * Build the whole population, once, deterministically.
 *
 * Seeded for the same reason the forest is: two captures of two builds have to
 * be two pictures of the same air, or a differenced pair measures the reseed
 * rather than the change.
 */
export function buildParticles(seed = 20260815): ParticleBuffers {
  const n = N_DUST + N_FALL;
  const position = new Float32Array(n * 3);
  const mot = new Float32Array(n * 4);
  const shp = new Float32Array(n * 4);
  const rng = new Rng(seed);

  let leaf = 0;

  for (let i = 0; i < n; i++) {
    const isFall = i >= N_DUST;
    const box = isFall ? FALL_BOX : DUST_BOX;

    position[i * 3] = rng.range(-box.half, box.half);
    position[i * 3 + 1] = rng.range(box.lo, box.hi);
    position[i * 3 + 2] = rng.range(-box.half, box.half);

    let fall: number, radius: number, rate: number;
    let kind: number, halfLen: number, halfWid: number, tint: number;

    if (!isFall) {
      /* 2.1-2.3 cm/s measured, widened slightly downwards because the real
       * population in forest air is not all pollen — it is pollen, spore
       * clusters, bark dust and fragments of spider silk, and the lighter of
       * those hang. */
      fall = rng.range(0.016, 0.024);
      /* A wander of tens of centimetres over tens of seconds. The product
       * radius * rate is the lateral speed and it lands at 2-6 cm/s, which is
       * the same order as the settling rate — that equality is what makes the
       * population read as *air* being still rather than as particles being
       * slow, because there is no preferred direction in it at all. */
      radius = rng.range(0.10, 0.45);
      rate = rng.range(0.05, 0.25);
      kind = 0;
      /* 0.4-2.6 mm. Physically-sized pollen at 50 µm is a fiftieth of a pixel
       * at two metres and returns 1/2500 of a pixel's worth of light: it is
       * not visible, and any system that claims to show individual dust motes
       * in flat light is showing something larger. What is genuinely visible
       * at arm's length in forest air is the coarse end — clumped pollen,
       * seed fluff, fragments of lichen and silk — so that is what this is.
       *
       * Cubed rather than uniform, because a uniform draw over that range is
       * not what airborne debris looks like and the difference is measurable
       * rather than aesthetic. Every real aerosol population is heavily
       * weighted to the small end; a uniform draw put a third of the grains
       * above 2 mm, and a 2 mm grain at two and a half metres is a full pixel
       * across at full alpha — a hard white dot. The differenced count found
       * five of those per frame, which is five too many. Cubed puts the median
       * at 0.8 mm and leaves about one in ten above 2 mm, so the conspicuous
       * ones stay conspicuous and stop being the majority. */
      halfLen = 0.00025 + 0.0011 * rng.f() ** 3;
      halfWid = halfLen;
      tint = rng.range(0.80, 1.06);
    } else if (rng.f() < LEAF_FRACTION) {
      leaf++;
      fall = rng.range(0.34, 0.58);
      /* Leaves swoop. A 6 cm blade glides half a metre off its drop line and
       * back again, which is the motion everybody recognises and the single
       * strongest cue in the system that the air is being modelled rather than
       * the particle. */
      radius = rng.range(0.16, 0.34);
      rate = rng.range(0.55, 1.15);
      /* Three values rather than a flag, because the shader needs two
       * independent things out of it and a single step() gives both without a
       * branch: `step(0.5, kind)` is "is this thing oriented", and `kind - 1`
       * clamped is how far towards the broadleaf albedo to go. */
      kind = 2;
      halfLen = rng.range(0.021, 0.036);
      /* Broad. The projection below collapses this to a sliver when the blade
       * turns edge-on, which is where the flashing comes from. */
      halfWid = halfLen * rng.range(0.55, 0.78);
      tint = rng.range(0.72, 1.20);
    } else {
      fall = rng.range(0.72, 1.28);
      /* The lazy helix a needle slips down in, 4-12 cm across with a period of
       * two to three seconds. This is the slow component; the flutter derived
       * from FLUTTER_ST rides on top of it. */
      radius = rng.range(0.04, 0.12);
      rate = rng.range(1.8, 3.4);
      kind = 1;
      halfLen = rng.range(0.009, 0.019);
      halfWid = halfLen * rng.range(0.05, 0.085);
      tint = rng.range(0.70, 1.25);
    }

    mot[i * 4] = fall;
    mot[i * 4 + 1] = radius;
    mot[i * 4 + 2] = rate;
    mot[i * 4 + 3] = rng.f();

    shp[i * 4] = kind;
    shp[i * 4 + 1] = halfLen;
    shp[i * 4 + 2] = halfWid;
    shp[i * 4 + 3] = tint;
  }

  return {
    position, mot, shp,
    counts: { dust: N_DUST, needle: N_FALL - leaf, leaf, total: n },
  };
}
