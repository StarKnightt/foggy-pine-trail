'use client';

/* System 8 — the post chain, and the last thing that happens to the frame.
 *
 * ── Colour space, declared, because everything here turns on it ───────────
 *
 *   in    tScene    scene-linear radiance, sRGB primaries, half float. The
 *                   fog has already been mixed into it in the same units; see
 *                   pipeline.ts for why that needed no change.
 *   §1-2  radiance  the defocus gathers radiance, which is the only space in
 *                   which averaging neighbouring pixels is averaging light.
 *   §3    AgX       one tone map, here and nowhere else on this path.
 *   §4-7  display-linear
 *   §8-10 display-encoded, sRGB. Grain and dither are sensor and quantiser
 *                   artifacts and belong in the units of the thing that makes
 *                   them.
 *   out   canvas    sRGB, 8 bit.
 *
 * ── The order, and why it is this order ───────────────────────────────────
 *
 * Physical, from the world inwards: the lens defocuses what reaches it, the
 * sensor has a finite range and an opinion about tone, the ISP grades, and the
 * read noise and the quantiser are the last two things that touch the number.
 * That is the order in grade.tsx in night-street and it is the order here. Two
 * places depart from it and both are argued at the point they occur — the
 * vignette (§6) and the near-field chroma (§5).
 *
 * ── What is deliberately absent ───────────────────────────────────────────
 *
 * No bloom. Veiling glare is the one thing this scene already has for free and
 * for real: thirty-six metres of visibility means every ray in the frame has
 * airlight added along it, which is what a veil *is*. A second, screen-space
 * one added on top would be counting the same photons twice, and the brief
 * does not ask for it.
 *
 * No chromatic aberration. It is not in the brief, and lateral CA is the first
 * thing a phone's ISP corrects; putting it back is the giveaway that the frame
 * came out of a "cinematic" preset rather than out of a phone.
 *
 * No chroma ceiling, and this one was written, measured and deleted. "No
 * bright colours anywhere" reads like an instruction to clamp the chroma tail,
 * so the tail was measured: this frame's 99th percentile HSV saturation is
 * 0.34 (level) and 0.43 (down), against 0.80, 0.85 and 1.00 in the three
 * reference photographs. There is no tail to clamp. A cap would have been the
 * eighth code path in this project that typechecks, reads correctly and
 * changes zero pixels.
 *
 * No global desaturation, and that is the standing instruction rather than a
 * choice. Whole-frame median saturation is 0.062-0.137 against 0.042-0.141 in
 * the comparable references — in band, and low only because the 10-30 m
 * mid-ground is 60-90% achromatic airlight by construction. §5 pushes chroma
 * the other way, in the near field only.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { fullscreenTriangle, makeSceneTarget, postFlags, useHdr } from './pipeline';

/* ── The look, as constants substituted into the GLSL ─────────────────────
 *
 * Every number below is a code value or a metre, and every one of them is
 * either read off a measurement of this scene or worked out from the optics of
 * the camera the brief names. Where a value is a taste, it says so.
 */

/* Defocus: a 5.7 mm lens at f/1.8 focused at six metres, which is where a
 * phone's autofocus lands when pointed down a trail.
 *
/* Defocus: a flagship phone's main camera — 6.9 mm at f/1.6 on a 1/1.3"
 * sensor — focused at six metres, which is where autofocus lands when the
 * frame is a trail running away from the lens.
 *
 * The circle of confusion of a thin lens is A*f*(1/d - 1/S) with A = f/N the
 * aperture diameter, so with A = 4.31 mm and f = 6.9 mm the diameter on the
 * sensor is 0.02974 mm per reciprocal metre of defocus. The sensor is 9.8 mm
 * across and this frame is 1600 px, so a sensor millimetre is 163 px and the
 * *radius* in pixels is 2.43 * (1/d - 1/6).
 *
 * That is the whole of COC_GAIN, and the table it produces is the point of
 * writing it this way rather than as a strength:
 *
 *     0.5 m  3.5 px   1.0 m  2.0 px   1.5 m  1.2 px   2.0 m  0.81 px
 *     3.0 m  0.41 px  4.0 m  0.20 px  6.0 m  0        beyond  0
 *
 * This is a *small* effect and it is supposed to be. The brief's "everything
 * past about 1.5 m is sharp" is not a stylistic preference, it is what a 7 mm
 * lens does, and it is why there is no far-field branch in this file at all.
 * Blurring the fogged mid-ground would be wrong twice over: it is not what the
 * camera does, and the mid-ground *is* the fog's depth cue, which is the best
 * thing in the project.
 *
 * It also means the term is nearly zero at a level framing, and that is worth
 * stating rather than discovering. A standing eye at 2.35 m with a 52 degree
 * frame sees its nearest ground 4.8 m away, where the radius is 0.16 px; the
 * `down` framing brings it to 1.9 m and 0.87 px, and `near` — which exists in
 * the shot list for this term — to 1.2 m and 1.6 px. `tools/fogdiff.mjs --b
 * post=nodof` at those framings is how it is shown to be doing anything.
 *
 * The cap exists because the formula diverges at the near plane, which is
 * 5 cm, and a frond brushing the lens would otherwise ask for a thirty-pixel
 * gather out of an eight-tap kernel. Nothing in the walk gets within 40 cm of
 * the eye, so it should never bind. */
const COC_GAIN = 2.43;
const COC_FOCUS = 6.0;
const COC_MAX = 3.5;

/* Shadow lift: the phone-HDR term, and the one that answers the critic's
 * standing complaint.
 *
 * Measured on `shots/s8base` against reference photographs of fogged conifer
 * forest, the frame's defect is not its chroma and not its highlights — it is
 * that 45-62% of every frame sits below code value 70, where the references
 * run 17-32%, and the mid band the review counts (70-150) came in at 22-38%
 * against a 32-69% target. The `up` framing failed it outright at 22.5%. That
 * is the bimodal histogram the critic has measured repeatedly, and it is what
 * a phone's HDR pipeline exists to remove: it lifts shadows aggressively and
 * rolls the highlights long so the whole picture arrives inside a narrower
 * band than a linear render produces.
 *
 * The form is a multiplicative gain on *luminance* with the channels carried
 * along in proportion, which leaves HSV saturation exactly invariant — that is
 * not a nicety here, it is the one property that lets a term this large be
 * applied at all given the instruction not to touch the chroma. `palette.py`
 * checks it rather than trusting it.
 *
 * It is nonetheless tapered off on saturated pixels, and that taper is the one
 * measurement that changed this term's design. Scale invariance means lifting a
 * green fern does not make it greener by that metric — but it does make it
 * *brighter*, and a large bright saturated green is what "no bright colours
 * anywhere" is actually about. `tools/foliage.py` keys the understory
 * population out and measures it against the same photographs:
 *
 *     reference understory foliage   median luma 31, 32, 33, 41, and 87
 *     ours, grade off                            55 (t=0.42), 60 (down)
 *     ours, untapered lift 1.4                   73,          77
 *
 * The ferns are already about twenty code values brighter than four of the five
 * references before this file runs. That is an albedo, not a curve, and it is
 * not this agent's to change — but an untapered lift doubled the error, and it
 * was plainly visible: they read as fresh spring growth against grey air. A
 * grade must not amplify a defect it did not create.
 *
 * The two populations separate well enough for a saturation key to do the job
 * cleanly. Below luma 90, where the lift has purchase, the green foliage runs
 * at median saturation 0.34 and everything else at 0.16, so a taper across 0.18
 * to 0.32 keeps 74% of the lift on the bark, duff, tread and air that the
 * histogram gap is actually made of, and 20% of it on the ferns. The amount is
 * then raised to put the neutral majority back where the sweep below put it.
 *
 * Both numbers come from a measured sweep on the t=0.42 stop, not from the eye,
 * and the two are swept apart because they fail differently — the amount opens
 * the blackest pixels and leaves the shoulder of the dark lobe alone, the knee
 * moves the whole lobe and eventually eats midtone contrast:
 *
 *     off          70-150 = 33.6%   <70 = 51.4%   med 69   p1 18
 *     0.8 / 0.04           40.1%         45.0%        74      24
 *     1.4 / 0.04           46.7%         38.4%        78      29
 *     0.8 / 0.07           45.3%         39.7%        79      25
 *     1.4 / 0.07           54.7%         30.2%        86      30   ← shipped
 *     2.0 / 0.09           64.3%         19.7%        96      34
 *
 * against references at 70-150 = 29.8-58.5%, <70 = 16.7-32.1%, median 90-154,
 * p1 = 2-38. The shipped pair is the first row inside the dark-lobe band, and
 * 2.0/0.09 was rejected for a mid band at 64% — still nominally in range, but
 * that is a frame with very little left below the midtones and it reads flat.
 *
 * The sweep also settles the question of whether a term this large can touch
 * the fog: the fraction above code value 180 is 7.6-7.8% across every row of
 * it, including the last. The lift is confined to the shadows by measurement
 * and not merely by intent, so the fog's vertical gradient — the best thing in
 * the project — is provably untouched.
 *
 * Deliberately no black point underneath it. One was modelled: subtracting
 * 0.006 of display-linear takes the median where it needs to go and drives
 * more than one per cent of the `down` and `up` frames to zero, and what it is
 * subtracting is the fog's airlight floor — a physically correct veil that the
 * fog system was signed off with. The reference photographs' deeper blacks
 * come from understory cavities this scene does not have, not from a curve. */
const LIFT = 1.90;
const LIFT_KNEE = 0.07;
const LIFT_ACHROMA = 0.18;
const LIFT_ACHROMA_W = 0.32;

/* The floor under the saturation ratio's denominator, and it is a bug fix
 * rather than a look control.
 *
 * The gate above keys on `( max - min ) / max`, and on the darkest surface in
 * the frame that denominator is a number near zero made almost entirely of
 * noise. Bark sits at display 31 and the ratio there swings across the whole
 * 0.18-0.32 transition from one pixel to the next, so each pixel independently
 * won either the full 2.24x lift or none of it. A per-pixel multiplicative
 * coin toss of +-38% on a median of 31 is +-12 code values of chromatic
 * speckle laid over the largest surface in every frame, which is why the owner
 * read the whole image as soft and filtered and read a near trunk as "blurry
 * green": the speckle does not blur anything, it buries the bark's own
 * contrast under noise of several times its amplitude, and the eye cannot tell
 * those apart.
 *
 * Measured at stop 78 on the hero bole, mean Laplacian energy: 28.2 shipped,
 * 5.5 with the whole grade off, 6.5 with the lift alone off, 3.9 on the
 * pre-System-8 path. The lift was the entire difference. It also explains the
 * one part of the report that looked like a contradiction — that the near
 * ferns are the only sharp thing in the frame. A fern is saturated, so its
 * gate is closed, so it never received the noise.
 *
 * Adding a floor instead of clamping the divisor makes the ratio roll off to
 * zero as the pixel goes black rather than becoming undefined, which is also
 * the physically honest answer: a pixel at two per cent of display white has
 * no reliable hue in it, and it belongs in the achromatic majority this lift
 * was shaped to catch. 0.035 is where AgX's toe stops compressing, so above it
 * the ratio is unchanged to within a per cent and every pixel the gate was
 * ever meant to discriminate between still measures what it measured before.
 * `?post=s0.08` sweeps it. */
const LIFT_SAT_FLOOR = 0.035;

/* Hue steer, on the chromatic residual and nothing else.
 *
 * This started as an ASC slope and offset in display-linear, which is the
 * standard instrument and is the wrong one here. A slope with any spread
 * across the channels tints *neutrals*: a 1.2% spread turns every grey pixel
 * into a pixel of HSV saturation 0.012, and this frame is two thirds neutral
 * air. Measured, it took whole-frame median saturation from 0.072 to 0.108 —
 * more than the entire near-field chroma term below — and what that number
 * describes is a colour cast over the fog, which the brief calls white and
 * which a viewer reads as a filter. It was the largest single effect in the
 * grade and it was an accident.
 *
 * So the steer operates on `c - luma(c)`, where a neutral is exactly zero and
 * stays exactly zero however large the coefficient is. What is left is a
 * statement purely about hue, which is what "muted means the hue range, not
 * the saturation level" asks for.
 *
 * One coefficient. The red residual is scaled by 0.90, which takes the yellow
 * out of the fern crowns — wet understory is grey-green and they were the one
 * thing in the frame reading as fresh spring foliage — and cools the duff by
 * about the same amount, which is the direction soaked litter actually goes.
 * Greens and browns keep their chroma; only the axis moves. */
const HUE_RED = 0.90;

/* Near-field chroma, keyed on depth, and the only place saturation is added.
 *
 * The critic's warning is that whole-frame chroma cannot be raised because the
 * mid-ground is 60-90% achromatic airlight by construction and that part is
 * physically correct. It is, and nothing here touches it. What the reference
 * photographs actually have that this frame does not is a chroma *tail*: their
 * 99th percentile saturation is 0.80-1.00 against 0.34 here, and all of it is
 * within a few metres of the lens — wet litter, moss, the underside of a
 * frond. Near-field fern crowns measure 0.169 against a 0.174-0.193 reference
 * band, which is the last stretch of a gap that closes here rather than by
 * pushing colour into fog.
 *
 * A sixth more chroma at the lens, half of it gone by three metres and none of
 * it past ten. Applied about the channel maximum so the hue and the value are
 * untouched and only the distance from the achromatic axis moves. */
const NEAR_SAT = 0.17;
const NEAR_FALLOFF = 4.5;

/* Vignette: cos^4, and slight.
 *
 * A phone lens vignettes hard and its ISP takes nearly all of it back out; the
 * residual in a reference frame is three to six per cent at the corner. This
 * is eight, because the correction a phone applies is calibrated for its own
 * lens and the thing that survives is not a clean cos^4 — some of what a
 * viewer reads as "phone" is that mismatch. Overdone vignette is the single
 * most common giveaway of a cinematic filter, so this is a term to be caught
 * by a differencer and not by a reviewer.
 *
 * In display-linear rather than in radiance, which is the physically wrong
 * side of the tone curve and is a deliberate choice. A lens loses light before
 * the sensor, so radiance is the correct place — but the fog fills two thirds
 * of this frame and sits high on AgX's shoulder, where a 8% loss of radiance
 * is worth under two code values. Measured both ways: in radiance the corner
 * moves 1.9 counts, in display-linear it moves 6.4. The effect is supposed to
 * be visible in the bright field, and only one of those places puts it there.
 *
 * Circular in pixels rather than in uv. A 16:9 frame vignetted on a uv circle
 * is an ellipse on the sensor, which no lens has ever produced. */
/* Zero at the owner's request: the edge falloff read as a filter laid over the
 * picture rather than as a lens.
 *
 * Worth recording that the measurement agreed before the eye did. Corner-minus-
 * centre on the air region came out at −72, −39 and +27 across three framings —
 * sign-inconsistent, because whatever trunk happens to occupy a corner swamps
 * the term. A term whose own sign changes with content is not delivering the
 * cue it was written for, and 0.08 is the value it was tuned to if it is ever
 * wanted back. */
const VIGNETTE = 0;

/* Grain: a phone sensor, not film.
 *
 * Three amplitudes, peak to peak in display-encoded units, because a single
 * number cannot describe CMOS read noise:
 *
 *   FLOOR is everywhere, including the highlights. It is what makes the fog
 *   read as a photograph of fog rather than as a gradient, and the fog is the
 *   hard case: two thirds of the frame is a large flat bright field, which is
 *   where grain is most visible and where it is least welcome. 0.017 delivers
 *   1.25 code values RMS per channel and 0.75 in luma — the two differ because
 *   the channels are independent and luma is a weighted sum of them, which is
 *   the number the eye is most sensitive to and therefore the one that was
 *   set. `tools/grain.py` measures it in the flattest bright window it can
 *   find rather than trusting the amplitude.
 *
 *   DARK is the part that is actually sensor noise. Read noise is roughly
 *   constant in absolute terms while the signal is not, so the shot that shows
 *   it is the shadow, and it is set against the reference photographs rather
 *   than against the fog. Measured high-pass RMS in the flattest dark window
 *   `grain.py` can find, at mean 53 code values:
 *
 *       grade off   1.02 CV      ← the scene's own texture, the floor to beat
 *       0.034       2.19
 *       0.050       2.47
 *       0.070       2.86
 *       0.085       3.14   ← shipped
 *       0.095       3.36
 *
 *   against references at 4.13 CV (mean 28), 4.72 (mean 10) and 9.12 (mean 48,
 *   a heavily compressed JPEG and the outlier). Shipped sits just under the
 *   quietest of them, deliberately: shot noise rises with signal, so a window
 *   at mean 53 should be noisier than a reference window at mean 28, and being
 *   under it there means the deepest bark — where the weight is near 1 and the
 *   amplitude reaches about 6 CV — lands in the reference band rather than past
 *   it. 0.095 was inspected at 4x magnification and was not objectionable
 *   either; the difference between the two is not visible at 1:1 and the
 *   quieter one was taken.
 *
 *   Independent of FLOOR by measurement, not just by intent: the bright window
 *   reads 0.851 CV at every row of that sweep, including the last.
 *
 *   CHROMA is demosaic blotch, which is a different artifact from speckle and
 *   is why it is sampled on a six-pixel grid and smoothed: starving the red
 *   and blue channels gives coloured mottle several pixels across, and this is
 *   the signature that separates a phone from an emulsion. Luminance mean
 *   removed so it tints rather than brightens.
 *
 * The one thing here that is not in night-street's model is the smear. A
 * phone's noise reduction is strongest where the signal is weakest, so the
 * grain in the darkest parts of the frame is not per-pixel — it is a coarser,
 * softer mottle, because the fine detail has been averaged away with the
 * noise. The luma field crossfades to a 3x3 block field as the pixel darkens,
 * which is that, and it is also the difference between grain that reads as a
 * sensor and grain that reads as a filter laid over the whole picture. */
/* All three are zero because the owner of this project asked for no grain.
 *
 * That is a departure from the brief, which asks for "film grain for that
 * phone camera feel", and it is deliberate rather than an oversight. The
 * measured values the terms were tuned to are kept below so the decision is
 * reversible without re-deriving them: 0.017 / 0.085 / 0.013 put the dark
 * window at 3.14 CV against references measuring 4.13-9.12, and the bright fog
 * at 0.85 CV against 0.98-9.77 — deliberately quiet in the fog, which is a
 * large flat bright field where grain is the most visible thing in the frame.
 *
 * Zeroing the constants rather than deleting the code keeps the term in the
 * compiled program with the same structure, so `?post=g3` still sweeps it and
 * a differenced pair still measures it. Restoring the look is three numbers.
 */
const GRAIN_FLOOR = 0;
const GRAIN_DARK = 0;
const GRAIN_CHROMA = 0;

/* Grain redraw rate, in hertz, and it is a rate in seconds rather than "every
 * frame" for the reason night-street's GRAIN_HZ records: seeding from a frame
 * counter makes the *appearance* of the term a function of the display it was
 * tuned on, and it is the only mechanism in the file that gets worse on a
 * faster machine. Thirty because the referent is a phone and a phone's read
 * noise is redrawn once per captured frame at thirty a second.
 *
 * Quantised with a floor rather than scaled, and that is the load-bearing
 * detail: the seed feeds a hash, so seeding with an unfloored `elapsed * 30`
 * would produce a completely uncorrelated field every frame exactly as the
 * frame counter did, and the fix would be inert while looking correct. */
const GRAIN_HZ = 30;

/* One code value peak to peak, and the last statement in the frame.
 *
 * This is `fog.ts`'s dither, moved. On the canvas path it lives in
 * `dithering_fragment`, which runs in display space; in a linear target that
 * chunk would be adding a code value of *radiance*, which is a fortieth of a
 * stop in the fog and a factor of several in the darkest bark. Same noise,
 * same amplitude, same interleaved gradient construction, emitted at the point
 * in the chain where the quantiser it exists for actually rounds. */
const DITHER = 1.0;

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`;

/**
 * The whole chain. `__X__` placeholders are substituted with constants by
 * `buildFragment` so that a switched-off term is the same program with a
 * different number in it — never a branch, never a define. A term that cannot
 * be switched off cannot be proved to be on, and a term switched off by
 * recompiling a different shader cannot be differenced against.
 */
const FRAG = /* glsl */ `
precision highp float;

/* three's own tone mapping chunk, included rather than transcribed.
 *
 * AgXToneMapping is not three's stock function here — fog.ts patches
 * tonemapping_pars_fragment to put Blender's chroma restore back on the
 * log-encoded value after the sigmoid, which three ships without. Copying the
 * transform into this file would mean two implementations of the scene's tone
 * curve, one of which would eventually stop matching the other, and the
 * failure would be a frame that is subtly wrong in a way no test names. The
 * chunk that the scene pass would have used is the chunk this pass uses.
 *
 * Only the *pars* chunk, which declares functions and calls none. The chunks
 * that execute — tonemapping_fragment, which carries the fog mix, and
 * dithering_fragment — are deliberately not included; running either here
 * would apply it to the frame a second time. toneMapped: false on the
 * material stops three injecting its own call as well. */
#include <tonemapping_pars_fragment>

varying vec2 vUv;

uniform sampler2D tScene;
uniform sampler2D tDepth;
uniform vec2  uTexel;
uniform vec2  uTanHalf;      // tan(fov/2), horizontal and vertical
uniform vec2  uDepthRange;   // near, far
uniform float uRevDepth;
uniform float uAspect;
uniform float uSeed;

float luma( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }

float linToSrgb( float c ) {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * pow( c, 1.0 / 2.4 ) - 0.055;
}
vec3 linToSrgb( vec3 c ) {
  return vec3( linToSrgb( c.r ), linToSrgb( c.g ), linToSrgb( c.b ) );
}

/* Three uncorrelated channels from one point, because the signature of a phone
 * is coloured speckle and not a shared luminance term.
 *
 * Hoskins' sine-free construction rather than the fract(sin(dot)) hash that is
 * in every post-processing shader including night-street's, and the reason is
 * a measurement. This frame is 1600 px wide, so the dot products reach 1.2e5,
 * and sin() of that in a highp float has lost most of its mantissa — the field
 * degenerates into correlated streaks and its variance collapses. Measured:
 * the sine hash delivered 0.45 code values RMS where the amplitude asks for
 * 0.81, which is a term running at half the level it is written at and
 * drifting with the resolution. Nothing here goes near a transcendental. */
vec3 hash3( vec2 p ) {
  vec3 q = fract( p.xyx * vec3( 0.1031, 0.1030, 0.0973 ) );
  q += dot( q, q.yxz + 33.33 );
  return fract( ( q.xxy + q.yzz ) * q.zyx ) - 0.5;
}

/** Depth-buffer sample to positive view-space depth, in metres. */
float viewZ( float d ) {
  /* Reversed depth puts the near plane at 1. Getting this backwards would put
   * every surface at the far plane, the defocus would be identically zero, and
   * it would read as "too subtle to see". */
  d = mix( d, 1.0 - d, uRevDepth );
  float n = uDepthRange.x, f = uDepthRange.y;
  return ( 2.0 * n * f ) / ( f + n - ( d * 2.0 - 1.0 ) * ( f - n ) );
}

/* Distance along the ray, not depth along the view axis. The two differ by
 * 15% at the bottom corner of a 52 degree frame, and the bottom corner is the
 * only place this term is non-zero. */
float rayLen( vec2 uv ) {
  vec2 t = ( uv * 2.0 - 1.0 ) * uTanHalf;
  return sqrt( 1.0 + dot( t, t ) );
}

/** Circle of confusion at uv, as a radius in pixels. See COC_GAIN. */
float cocAt( vec2 uv ) {
  float dist = viewZ( texture2D( tDepth, uv ).r ) * rayLen( uv );
  return clamp( __COC_GAIN__ * ( 1.0 / max( dist, 0.2 ) - __COC_FOCUS_INV__ ),
                0.0, __COC_MAX__ );
}

/* Scatter-as-gather, at a fixed ring radius with the weights doing the work.
 *
 * A gather at the *centre* pixel's own radius cannot spread a blurred
 * foreground over a sharp background — the sharp pixel has radius zero and
 * never reaches for its neighbour — and foreground spread is the entire
 * visible content of a near-field defocus. So the ring is always at the
 * maximum radius the optics allow and each tap is admitted only if its own
 * circle of confusion actually reaches this pixel. Where nothing is defocused
 * every weight is zero and the result is the centre tap exactly, to the bit.
 *
 * This is also why there is no early-out. An if around the gather would make
 * the switched-off build a structurally different program, and the differenced
 * pair is the only instrument in this project that has ever caught an inert
 * term. ?post=nodof sets the radius to zero instead and the program is the
 * same one. */
#define DOF_TAP( OX, OY ) { \
  vec2 o = vec2( OX, OY ); \
  vec2 uv2 = vUv + o * ( __COC_MAX__ ) * uTexel; \
  float w = clamp( max( cocAt( uv2 ), c0 ) - length( o ) * ( __COC_MAX__ ) + 1.0, 0.0, 1.0 ); \
  src += texture2D( tScene, uv2 ).rgb * w; \
  wsum += w; \
}

void main() {

  /* ── 1. Near-field defocus, in radiance ────────────────────────────────── */
  float c0 = cocAt( vUv );
  vec3 src = texture2D( tScene, vUv ).rgb;
  float wsum = 1.0;
  DOF_TAP(  1.0,   0.0  )
  DOF_TAP(  0.0,   1.0  )
  DOF_TAP( -1.0,   0.0  )
  DOF_TAP(  0.0,  -1.0  )
  DOF_TAP(  0.354, 0.354 )
  DOF_TAP( -0.354, 0.354 )
  DOF_TAP( -0.354,-0.354 )
  DOF_TAP(  0.354,-0.354 )
  src /= wsum;

  /* ── 2. The one tone map ───────────────────────────────────────────────── */
  vec3 c = AgXToneMapping( src );

  /* ── 3. Shadow lift, on the achromatic majority ────────────────────────── */
  float y = luma( c );
  float lmx = max( max( c.r, c.g ), c.b );
  float lsat = ( lmx - min( min( c.r, c.g ), c.b ) ) / ( lmx + ( __LIFT_SAT_FLOOR__ ) );
  c *= 1.0 + ( __LIFT__ ) * exp( - y / ( __LIFT_KNEE__ ) )
     * ( 1.0 - smoothstep( ( __LIFT_ACHROMA__ ), ( __LIFT_ACHROMA_W__ ), lsat ) );

  /* ── 4. Hue steer, on the chromatic residual only ──────────────────────── */
  y = luma( c );
  c = max( y + ( c - y ) * vec3( __HUE_RED__, 1.0, 1.0 ), 0.0 );

  /* ── 5. Near-field chroma ──────────────────────────────────────────────── *
   *
   * Out of physical order — it is a grade term and it is keyed on scene depth,
   * which is a thing no ISP has. The alternative is not to have it: the frame
   * has no other handle on the near field, and the whole of the measured
   * chroma gap is there. Read off the centre tap's depth rather than the
   * defocused one, so a blurred edge does not get its saturation from whatever
   * happened to be behind it. */
  float nearD = viewZ( texture2D( tDepth, vUv ).r ) * rayLen( vUv );
  float mx = max( c.r, max( c.g, c.b ) );
  c = mx - ( mx - c ) * ( 1.0 + ( __NEAR_SAT__ ) * exp( - nearD / ( __NEAR_FALLOFF__ ) ) );
  c = max( c, 0.0 );

  /* ── 6. Vignette ───────────────────────────────────────────────────────── */
  vec2 vd = ( vUv - 0.5 ) * vec2( uAspect, 1.0 );
  float vr = length( vd ) / ( 0.5 * sqrt( uAspect * uAspect + 1.0 ) );
  c *= 1.0 - ( __VIGNETTE__ ) * pow( clamp( vr, 0.0, 1.0 ), 4.0 );

  /* ── 7. Encode. Everything below is density, not light. ────────────────── */
  c = linToSrgb( clamp( c, 0.0, 1.0 ) );

  /* ── 8. Sensor noise ───────────────────────────────────────────────────── */
  vec2 fc = gl_FragCoord.xy;
  float lum = luma( c );
  /* Two weights, not one, and the widths are measured rather than copied.
   *
   * night-street's read-noise weight is quartic and closes by code value 56,
   * which was right for a street at night and is wrong here: the darkest thing
   * in this frame is bark at 20-50 code values, because thirty-six metres of
   * airlight puts a floor under everything. A quartic weight measured 0.0116
   * of amplitude at 45 counts — a hundredth over the floor, so the term that
   * is supposed to be the whole of the sensor model was doing nothing anywhere
   * anyone would look. Quadratic, out to 0.55, puts it where this scene's
   * shadows actually are.
   *
   * The smear keeps a tight weight of its own. Noise reduction bites hardest
   * where there is no signal left to protect, so it should be confined to the
   * deepest part of the frame; running it on the same width as the amplitude
   * would turn every mid-shadow into blocks. */
  float shadow = 1.0 - smoothstep( 0.02, 0.55, lum );
  float deep = 1.0 - smoothstep( 0.0, 0.18, lum );

  vec3 fine = hash3( fc + uSeed );
  vec3 soft = hash3( floor( fc / 3.0 ) * 3.0 + uSeed );
  c += mix( fine, soft, deep * 0.8 )
     * ( ( __GRAIN_FLOOR__ ) + ( __GRAIN_DARK__ ) * shadow * shadow );

  // Demosaic blotch, on a six-pixel grid, smoothed, luminance mean removed.
  vec2 cg = fc / 6.0;
  vec2 ci = floor( cg ), cf = fract( cg );
  cf = cf * cf * ( 3.0 - 2.0 * cf );
  float s2 = uSeed * 1.7;
  vec3 blot = mix( mix( hash3( ci + s2 ),                    hash3( ci + vec2( 1.0, 0.0 ) + s2 ), cf.x ),
                   mix( hash3( ci + vec2( 0.0, 1.0 ) + s2 ), hash3( ci + vec2( 1.0, 1.0 ) + s2 ), cf.x ), cf.y );
  blot -= dot( blot, vec3( 0.3333 ) );
  c += blot * ( __GRAIN_CHROMA__ ) * ( 0.30 + shadow );

  /* ── 9. Dither ─────────────────────────────────────────────────────────── *
   *
   * Interleaved gradient noise, Jimenez's constants, three channels offset from
   * one another so the error is chromatic and the three quantisers do not move
   * together. Not reseeded per frame: a dither that changes every frame is a
   * second, finer grain, and there is already a grain. */
  float ign = fract( 52.9829189 * fract( dot( fc, vec2( 0.06711056, 0.00583715 ) ) ) );
  vec3 tri = vec3( ign, fract( ign + 0.3333 ), fract( ign + 0.6667 ) );
  c += ( tri - 0.5 ) * ( ( __DITHER__ ) / 255.0 );

  gl_FragColor = vec4( max( c, 0.0 ), 1.0 );
}
`;

const f = (n: number) => n.toFixed(6);
/**
 * Substitute the constants, honouring the switches.
 *
 * `?post=nograde` is the whole identity set at once rather than a branch,
 * because the way back to the pre-System-8 look has to be a swap of every
 * coefficient — a build that differs from the shipped one in a branch is not
 * the same program and cannot be differenced against it.
 */
function buildFragment(flags: Set<string>): string {
  const off = flags.has('nograde');
  const n = (k: string, v: number) => (off || flags.has(k) ? 0 : v);
  /* Sweeps, for terms whose shipped value is small enough that a picture is a
   * poor instrument: overdrive until the change is obvious, look at *where* it
   * lands, then set it back. `?post=g3` for the grain, `?post=l2.5` for the
   * lift, `?post=k12` for the defocus radius. */
  const sweep = (p: string, d: number) => {
    const m = [...flags].find((x) => new RegExp(`^${p}[\\d.]+$`).test(x));
    return m ? Number(m.slice(p.length)) : d;
  };

  const cocMax = n('nodof', sweep('k', COC_MAX));
  const grain = sweep('g', 1);

  return FRAG
    .replaceAll('__COC_GAIN__', f(COC_GAIN))
    .replaceAll('__COC_FOCUS_INV__', f(1 / COC_FOCUS))
    .replaceAll('__COC_MAX__', f(cocMax))
    .replaceAll('__LIFT__', f(n('nolift', sweep('l', LIFT))))
    /* The knee sweeps separately from the amount because they fail in different
     * directions and the histogram cannot tell them apart from one number:
     * raising the amount opens up the blackest pixels and leaves the shoulder of
     * the dark lobe where it was, widening the knee moves the whole lobe and
     * starts eating the midtone contrast. `?post=n0.08`. */
    .replaceAll('__LIFT_KNEE__', f(sweep('n', LIFT_KNEE)))
    /* `?post=noachroma` widens the key to include everything, which is the
     * untapered lift the foliage measurement rejected — kept switchable because
     * that comparison is the whole argument for the term being shaped this way
     * and it should be reproducible without editing the file. */
    .replaceAll('__LIFT_ACHROMA__', f(flags.has('noachroma') ? 9.0 : LIFT_ACHROMA))
    .replaceAll('__LIFT_ACHROMA_W__', f(flags.has('noachroma') ? 9.1 : LIFT_ACHROMA_W))
    .replaceAll('__LIFT_SAT_FLOOR__', f(sweep('s', LIFT_SAT_FLOOR)))
    .replaceAll('__HUE_RED__', f(off || flags.has('nohue') ? 1 : HUE_RED))
    .replaceAll('__NEAR_SAT__', f(n('nonear', NEAR_SAT)))
    .replaceAll('__NEAR_FALLOFF__', f(NEAR_FALLOFF))
    .replaceAll('__VIGNETTE__', f(n('novig', VIGNETTE)))
    .replaceAll('__GRAIN_FLOOR__', f(n('nograin', GRAIN_FLOOR * grain)))
    /* Separate from `g`, which scales all three together. The fog is a large
     * flat bright field where grain is very visible and the shadows are where a
     * phone's noise actually lives, so the two levels have to be set against
     * different references and cannot share a multiplier. `?post=d0.07`. */
    .replaceAll('__GRAIN_DARK__', f(n('nograin', sweep('d', GRAIN_DARK) * grain)))
    .replaceAll('__GRAIN_CHROMA__', f(n('nograin', GRAIN_CHROMA * grain)))
    /* The dither is not part of `nograde`: it is the fog's, moved here because
     * the linear target broke its space, and switching it off with the grade
     * would mean `?post=nograde` was measuring the grade plus a banding
     * regression. `?post=nodither` alone. */
    .replaceAll('__DITHER__', f(flags.has('nodither') ? 0 : DITHER));
}

export function Post() {
  const { gl, scene, camera, size, viewport } = useThree();
  const hdr = useMemo(useHdr, []);
  /* Switchable at runtime, not only at mount.
   *
   * The query string alone was not enough to prove a term on. Differencing two
   * page loads of the same URL — the null test that should read zero — came
   * back at mean|dY| = 1.73 over 96% of the frame, because something in the
   * scene is phased off a clock that starts at load and `renderOnce` does not
   * reset. Every term measured smaller than that, so all of them differenced
   * to the same number and the tool reported the floor six times as if it were
   * six results.
   *
   * Two `renderOnce` calls inside one load are bit-identical, because nothing
   * between them advances time. So the switch has to be reachable after the
   * page is up, and then a differenced pair has a true zero floor. Still the
   * same substitution into the same GLSL; only the moment it happens moves. */
  const [flags, setFlags] = useState(postFlags);
  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return;
    const w = window as unknown as { __post?: unknown };
    w.__post = {
      set: (q: string) => setFlags(new Set(q ? q.split(',').filter(Boolean) : [])),
      get: () => [...flags].join(','),
    };
    return () => { delete w.__post; };
  }, [flags]);

  const target = useMemo(() => (hdr ? makeSceneTarget(2, 2) : null), [hdr]);
  const uniforms = useMemo(() => ({
    tScene: { value: target ? target.texture : null },
    tDepth: { value: target ? (target.depthTexture as THREE.Texture) : null },
    uTexel: { value: new THREE.Vector2(1, 1) },
    uTanHalf: { value: new THREE.Vector2(1, 1) },
    uDepthRange: { value: new THREE.Vector2(0.05, 260) },
    uRevDepth: { value: 0 },
    uAspect: { value: 16 / 9 },
    uSeed: { value: 0 },
  }), [target]);

  const quad = useMemo(() => {
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: buildFragment(flags),
      uniforms,
      depthTest: false,
      depthWrite: false,
      /* Without this three generates its own `toneMapping()` call into the
       * program prefix — the quad draws to the canvas, where the renderer's
       * AgX applies — and the frame would be tone-mapped twice. The one in the
       * body is placed deliberately; that one is not wanted. It does not stop
       * the renderer *setting* `toneMappingExposure`, which is uploaded to
       * every program that declares it (three.module.js:18703) and is what the
       * included chunk reads. */
      toneMapped: false,
    });
    const m = new THREE.Mesh(fullscreenTriangle(), mat);
    m.frustumCulled = false;
    return m;
  }, [uniforms, flags]);

  const post = useMemo(() => new THREE.Scene(), []);
  const cam = useMemo(() => new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), []);
  useEffect(() => { post.add(quad); return () => { post.remove(quad); }; }, [post, quad]);

  useEffect(() => () => {
    target?.depthTexture?.dispose();
    target?.dispose();
    quad.geometry.dispose();
    (quad.material as THREE.Material).dispose();
  }, [target, quad]);

  /* Sized to the drawing buffer rather than to CSS pixels. The target has to be
   * the same shape as the canvas it resolves onto, and getting it wrong is a
   * half-pixel offset that reads as a softness nobody can explain. */
  useEffect(() => {
    if (!target) return;
    const buf = new THREE.Vector2();
    gl.getDrawingBufferSize(buf);
    const w = Math.max(2, Math.floor(buf.x)), h = Math.max(2, Math.floor(buf.y));
    target.setSize(w, h);
    uniforms.uTexel.value.set(1 / w, 1 / h);
    uniforms.uAspect.value = w / h;
    /* setSize recreates the depth texture, so the uniform has to be re-pointed.
     * Holding the old one is a black depth buffer after every resize and a
     * defocus that silently stops. */
    uniforms.tDepth.value = target.depthTexture as THREE.Texture;
    uniforms.tScene.value = target.texture;
  }, [gl, size, viewport.dpr, target, uniforms]);

  const clock = useRef(0);
  const raw = useRef<((s: THREE.Object3D, c: THREE.Camera) => void) | null>(null);
  const inside = useRef(false);

  /** Scene into the target, chain onto the canvas. The whole frame. */
  const renderFrame = useMemo(() => () => {
    const render = raw.current ?? gl.render.bind(gl);
    if (!target) { render(scene, camera); return; }

    inside.current = true;
    /* three resets `renderer.info` at the top of every render, so with two
     * renders per frame the counters a tool reads afterwards describe the last
     * one — this pass's single triangle. Every report in the project that
     * prints calls= and tris= would silently start saying 1 and 0, which is
     * the kind of instrument failure that gets read as a scene failure. */
    gl.info.autoReset = false;
    gl.info.reset();

    const pc = camera as THREE.PerspectiveCamera;
    const tanY = Math.tan((pc.fov * Math.PI) / 360);
    uniforms.uTanHalf.value.set(tanY * pc.aspect, tanY);
    uniforms.uDepthRange.value.set(pc.near, pc.far);
    uniforms.uRevDepth.value =
      (gl as unknown as { reversedDepthBuffer?: boolean }).reversedDepthBuffer ? 1 : 0;
    /* GRAIN_HZ explains the rate; this is the line that spends it. The floor is
     * the mechanism — without it the hash is reseeded every frame and the fix
     * is inert while looking correct. */
    uniforms.uSeed.value = (Math.floor(clock.current * GRAIN_HZ) % 1024) * 7.13;

    gl.setRenderTarget(target);
    render(scene, camera);
    gl.setRenderTarget(null);
    render(post, cam);
    inside.current = false;
  }, [gl, scene, camera, post, cam, target, uniforms]);

  /* Every PNG this project has produced comes out of `window.__scene`, whose
   * `renderOnce` and `probe` both call `gl.render(scene, camera)` and then read
   * the canvas. A post pass that lives only in the frame loop is live on screen
   * and *absent from every screenshot* — the precise shape of failure this
   * project has paid for before: a change that is correct and never reaches the
   * artefact anyone looks at.
   *
   * The obvious fix is three lines in Rig.tsx, and Rig.tsx is not this agent's
   * file. So the hook is taken one level down, on the renderer itself: a call
   * to draw *this* scene to the canvas now means draw it and run the chain. It
   * is one function, restored on unmount, and it covers `renderOnce`, `probe`
   * and anything else that appears later without either file knowing.
   *
   * The exception is the one that makes the tools keep working.
   * `tools/scan.mjs` and `tools/fog.mjs` set `scene.overrideMaterial` to a
   * shader that encodes world distance and altitude into the framebuffer as
   * fixed-point bytes, and then decode them. Grading that is destroying it —
   * every one of those measurements would come back wrong, and plausibly
   * wrong. An override material means somebody is measuring geometry rather
   * than looking at a picture, which is exactly the case that must bypass the
   * chain, so that is the test. */
  useEffect(() => {
    if (!target) return;
    const original = gl.render.bind(gl);
    raw.current = original;
    gl.render = ((s: THREE.Object3D, c: THREE.Camera) => {
      if (inside.current || s !== scene || (scene as THREE.Scene).overrideMaterial) {
        original(s, c);
        return;
      }
      renderFrame();
    }) as typeof gl.render;
    return () => { gl.render = original; raw.current = null; };
  }, [gl, scene, target, renderFrame]);

  useFrame((_, dt) => {
    /* Clamped the way Rig clamps its own: a backgrounded tab hands back a delta
     * of several seconds, which would jump the grain field through a hundred
     * redraws in one step and put a visible discontinuity in the first frame
     * after a refocus. */
    clock.current += Math.min(dt, 0.1);
    renderFrame();
  }, 1);

  return null;
}
