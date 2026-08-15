/* The fog. Not a distance fade — weather.
 *
 * This is the hero of the scene and it is built as a global patch of three's
 * own fog chunks rather than as a per-material effect. Every material three
 * ships already includes `fog_pars_vertex`, `fog_vertex`, `fog_pars_fragment`
 * and `fog_fragment`, so replacing the chunk text reaches the ground, the
 * boles, the canopy, the props and anything System 4 adds later with nothing
 * to remember to wire up. The alternative — an `onBeforeCompile` on each — is
 * five call sites that drift apart the first time one of them changes, and
 * this project already has four separate systems whose per-material hooks had
 * to be kept in step by hand.
 *
 * ── What three's chunk gets wrong for this scene ──────────────────────────
 *
 * Four things, and each of them is visible in the delivered frame.
 *
 *   Planar depth. `vFogDepth = -mvPosition.z` is the distance to the camera
 *   *plane*. It agrees with the true path length at the centre of frame and
 *   diverges without limit towards the edges, which on a large ground plane
 *   draws a straight terminator across the tread — a horizontal line the fog
 *   has no business putting there. Replaced with `length(world - camera)`.
 *
 *   Uniform density in altitude. This is the big one. Measured under the
 *   placeholder FogExp2, a perfectly black object at 16 m rendered 91 and at
 *   21 m rendered 134 *at every height in the frame* — a crown 18 m up got
 *   exactly the veil the duff under it got. Real radiation fog forms by the
 *   ground cooling overnight and is stratified: dense in the first few metres,
 *   thinning with altitude. Without that the canopy cannot reach the 30-70
 *   band the trees were authored for, and, far more importantly, the picture
 *   has no *layer* in it. A layer with a top is the entire difference between
 *   weather and a distance fade.
 *
 *   A fog colour that is not the background. Aerial perspective works by an
 *   object's radiance converging on the radiance of the air in front of it,
 *   and that air is eventually indistinguishable from the sky along the same
 *   ray. If the two are different colours then however thick the air gets the
 *   object keeps an outline — a flat card standing in fog rather than a tree
 *   dissolving into it. So the fog evaluates the same elevation profile the
 *   sky dome is built from, and above the horizon the two are the same
 *   function.
 *
 *   A mix in display space. three includes `fog_fragment` *after*
 *   `tonemapping_fragment` and `colorspace_fragment`, so by the time it runs
 *   `gl_FragColor` is an AgX-tone-mapped, sRGB-encoded display value and
 *   mixing a scene radiance into it is a category error. It is not a small
 *   one: a five per cent veil of air at L=0.47 over wet bark at L=0.04 is
 *   worth about eight code values mixed after AgX and about forty mixed
 *   before it. Every silhouette in this frame is a dark object against bright
 *   air, so the wrong space suppresses the fog hardest along exactly the edges
 *   the brief asks it to soften.
 *
 *   That last one is why the mix below lives in `tonemapping_fragment` and not
 *   in `fog_fragment`. It is the one point in the fragment shader where
 *   `gl_FragColor` is still scene radiance. Every ShaderLib entry that
 *   includes `fog_fragment` also includes `tonemapping_fragment`, exactly
 *   once, immediately before `colorspace_fragment` — checked across all ten of
 *   them in three 0.185 — so the reach is identical and the space is right.
 *   `fog_fragment` is left declared and empty rather than deleted, because a
 *   material that replaces it by hand would otherwise silently get two.
 *
 * ── What System 8's render target did and did not change here ─────────────
 *
 * The scene now draws into a half-float linear target, where three forces
 * `NoToneMapping` for every material and makes the output transform the
 * identity. That is the arrangement this chunk was originally written *around*
 * rather than *for*, so it is worth stating what happened to it: nothing. The
 * mix sits outside `#if defined( TONE_MAPPING )`, so the tone map simply
 * compiles out of the scene pass and reappears once at the end of the post
 * chain, and the mix keeps running on exactly the quantity it always ran on.
 * The block was already correct in both worlds; it was checked in three's
 * source before the target was built rather than after.
 *
 * The dither is the part that did not survive the move, and it is at the
 * bottom of this file with its own note.
 */
import * as THREE from 'three';
import {
  FOG_RADIANCE, FOG_HIGH, FOG_LOW, FOG_NADIR, FOG_SCALE_HEIGHT, FOG_FALLOFF,
} from './env';
import { trail } from '@/world/trail';
import { DIMS } from '@/world/dims';

/* ── The elevation profile, once ──────────────────────────────────────────
 *
 * The dome texture, the environment map that lights every surface, and the
 * fog's own airlight all have to be the same function of elevation or distant
 * geometry stops dissolving. `el` is the dome's own parameterisation: -1 at
 * the nadir, 0 at the horizon, +1 at the zenith, linear in polar angle,
 * because that is what `SphereGeometry` puts in `uv.y` and therefore what the
 * dome texture's rows mean. A direction converts as
 * `el = 1 - 2*acos(dir.y)/PI`, which is *not* `dir.y`, and using `dir.y`
 * shifts the profile by up to eleven per cent of the dome's range at
 * mid-elevations.
 */

/** Above the horizon: the lit air, warming slightly towards the thinner deck. */
function skyward(el: number, out: THREE.Color): THREE.Color {
  return out.copy(FOG_RADIANCE).lerp(FOG_HIGH, el * el * (3 - 2 * el));
}

/**
 * The sky dome's own colour at elevation `el`, and the source of truth for it.
 *
 * Below the horizon this is not the air — it is what a surface *sees* looking
 * that way, which is a short path through glowing air onto wet duff, and
 * `FOG_NADIR` is that sum. It is the right thing for the environment map and
 * the wrong thing for the fog, which is why `fogAirAt` exists separately.
 */
export function domeRadianceAt(el: number, out = new THREE.Color()): THREE.Color {
  if (el >= 0) return skyward(el, out);
  return out.copy(FOG_RADIANCE).lerp(FOG_NADIR, Math.min(1, (-el / 0.34) ** 0.75));
}

/**
 * The radiance of the air itself at elevation `el`.
 *
 * Identical to the dome above the horizon — that identity is what makes a
 * fully hazed object vanish instead of leaving a silhouette — and deliberately
 * different below it.
 *
 * The nadir branch of the dome bottoms out at 0.082, and if the fog used it
 * then the air in front of the tread fifteen metres ahead would be mixed
 * towards a colour a third as bright as the horizon. That is nonsense: it is
 * the same air. What the dome is describing down there is ground seen through
 * air, not air. The fog instead falls from the horizon towards `FOG_LOW`,
 * which env.ts defines as the colour of the densest, least-lit part of the
 * layer — a mild darkening on shallow downward sightlines, reaching the full
 * value only straight down where nothing is ever seen through more than two
 * metres of it.
 */
export function fogAirAt(el: number, out = new THREE.Color()): THREE.Color {
  if (el >= 0) return skyward(el, out);
  return out.copy(FOG_RADIANCE).lerp(FOG_LOW, Math.min(1, -el));
}

/* ── Per-term switches ────────────────────────────────────────────────────
 *
 * `?fog=noheight,nosky` — comma separated, development only.
 *
 * This project has shipped four separate code paths that typechecked, read
 * correctly and changed zero pixels: roughness values with no environment map
 * to reflect, a polish term firing on 2.4% of the surface, an unreachable lean
 * cap, and a sky-view term that saturated to a constant. The only defence that
 * has ever worked is a differenced pair — render twice with one term switched
 * and measure the delta. A term that cannot be switched off cannot be proved
 * to be on.
 *
 * Every switch substitutes a *constant* into the same GLSL. It adds no branch,
 * no uniform and no define, so the compiled program is structurally identical
 * either way and a measured difference cannot be an artifact of having
 * compiled a different shader.
 */
function fogFlags(): Set<string> {
  if (process.env.NODE_ENV === 'production') return new Set();
  if (typeof window === 'undefined') return new Set();
  const q = new URLSearchParams(window.location.search).get('fog');
  return new Set(q ? q.split(',').map((s) => s.trim()).filter(Boolean) : []);
}

/* Where aerial perspective is forced to complete.
 *
 * An exponential never reaches one, so without this a distant object keeps a
 * residual of its own albedo and reads as a flat card standing in the fog. The
 * quadratic FogExp2 profile converges fast enough that a *level* ray is
 * already at 0.9998 by 45 m, so this range changes nothing at all in the part
 * of the frame the eye is on. What it is for is the other rays: with height
 * structure in place, a crown twenty metres up at sixty metres out only
 * reaches 0.88 on its own, and there is no honest reading in which the top of
 * a tree at sixty metres in thirty-six-metre visibility still has a silhouette.
 *
 * Keyed on the raw distance, not the height-corrected optical depth. The
 * height term is a statement about how much water is in the way; this is a
 * statement that past a certain range nothing has an outline, and a crown at
 * that range has no more of one than the duff beneath it. */
const CLOSE_NEAR = 45;
const CLOSE_FAR = 105;

/* How much brighter the air gets where it can see more sky, as a fraction.
 *
 * Small on purpose, and the ceiling is set by the sky dome rather than by
 * taste. The dome carries no sky-view modulation — it is one texture — so a
 * ray that saturates through a canopy gap is brighter than the dome behind it
 * by exactly this factor, and that difference is what the effect *is*: the air
 * under a gap glowing. Push it far and the difference stops reading as glowing
 * air and starts reading as a halo drawn around every distant crown.
 *
 * Most of the number is spent for very little, and it is worth saying where it
 * goes so nobody raises it again expecting more. The air near the camera is
 * barely there, so a multiplier on it moves nothing; the air at range has
 * saturated near the top of the tone curve, where a factor of two is worth
 * three or four code values — and is faded out anyway, see the shader. All of
 * the effect is in the middle distance, between about eight and twenty-five
 * metres.
 *
 * 0.42 measures, against `?fog=nosky`, a frame mean of 3.9 counts and a peak
 * of 15 on 71% of the pixels — a wash the eye reads as the trail being open to
 * the sky, with no edge anywhere. At 0.9 the peak was 27 and the frame mean 7.7,
 * which stops being a glow and becomes an exposure change. `?fog=s3.0`
 * overdrives it to see where it lands. */
const SKY_VIEW_GAIN = 0.42;

/* The dither amplitude, in code values, peak to peak.
 *
 * One LSB. The sky in this scene is a near-uniform bright field spanning about
 * fourteen distinct values across nine hundred rows, which is the worst case
 * there is for Mach banding: the eye's lateral inhibition finds a 1/255 step
 * across forty rows of flat tone and draws a line on it. One LSB of noise
 * before quantisation converts the step into a stochastic boundary and the
 * banding goes.
 *
 * Interleaved gradient noise rather than an ordered Bayer matrix. Bayer is a
 * fixed 4x4 or 8x8 tile, and over a field this large and this flat the tile
 * itself becomes the artifact — a visible cross-hatch that moves with the
 * camera because it is locked to the screen and the content is not. IGN is a
 * single fract of a dot product, has a near-blue-noise spectrum so the error
 * sits at high spatial frequency where the eye is least sensitive, and has no
 * tile to find. */
const DITHER = 1.0;

/* Patchiness, as two amplitudes, because one number cannot buy it.
 *
 * Measured on the delivered frame: ten code values of variation across an
 * entire scanline of clear air, and at 26x boost not one wisp. Real fog varies
 * by tens of per cent over a few metres and that variation is most of why it
 * reads as suspended water rather than as a filter over the lens.
 *
 * The obvious move — multiply the density by a noise field — only works over
 * part of the frame, and it is worth being explicit about why rather than
 * shipping it and wondering. Where the fog has saturated, density is not
 * observable: `1 - exp(-tau^n)` is 0.998 at twenty-five metres and putting
 * twenty per cent more water in the way takes it to 0.9995. Every "clear air"
 * pixel the review sampled is in exactly that regime, so a density term alone
 * would have left the complaint untouched and measured as fixed in the
 * mid-ground.
 *
 * So there are two terms with different reaches:
 *
 *   `DENSITY` scales the optical depth. It does all of its work between about
 *   six and thirty metres, where the fog factor is still on its way up — on a
 *   dark trunk at twenty metres, +-22% of density is +-8 code values. This is
 *   the honest one: it is what a patch of denser air actually does.
 *
 *   `RADIANCE` modulates the airlight itself and does not fade, so it survives
 *   into the saturated far field where the first term cannot reach. It is kept
 *   small and, critically, *zero-mean*: the system rests on saturated air being
 *   equal to the dome behind it, and the previous version of this file records
 *   what a systematic excursion costs — a bright ghost around every distant
 *   trunk and a widened seam along the rim of the ground mesh. A zero-mean
 *   field cannot draw a rim around anything because it is as often negative as
 *   positive; it just mottles. At 0.028 it is +-5 code values at the top of the
 *   tone curve, which is invisible at presentation and unmissable at the 3x
 *   contrast every defect this round was found at.
 */
const PATCH_DENSITY = 0.44;
const PATCH_RADIANCE = 0.028;

/* Chroma restored after AgX's inset. See the block in installFog() for why the
 * base transform cannot be shipped on its own and why this is the place the
 * correction belongs. */
const LOOK_SATURATION = 1.55;

const v3 = (c: THREE.Color) =>
  `vec3(${c.r.toFixed(6)}, ${c.g.toFixed(6)}, ${c.b.toFixed(6)})`;

/**
 * `float fogTrailX( float z )` — the trail centreline's x, as a function of z.
 *
 * Built from `trail()` rather than typed in, because a hand-copied curve that
 * quietly stops matching the path the ground is dug from would put the fog's
 * bright corridor a metre to one side of the trail and there would be nothing
 * in the frame to name as the cause.
 *
 * Hinge functions rather than an array lookup: `a + sum c_i * max(0, u - u_i)`
 * is exactly piecewise linear, unrolls to fourteen multiply-adds with no
 * branch, and needs no dynamically indexed array — which three compiles as
 * GLSL ES 1.00 unless told otherwise, where dynamic indexing in a fragment
 * shader is not guaranteed to be supported at all.
 */
function trailXGLSL(): string {
  const t = trail();
  const probe = new THREE.Vector3();
  /* Nearest polyline sample to a target z. The curve is monotone in z over the
   * whole run, so this is well defined. */
  const xAt = (z: number) => {
    let best = Infinity, bx = 0;
    for (let i = 0; i <= 400; i++) {
      t.curve.getPoint(i / 400, probe);
      const d = Math.abs(probe.z - z);
      if (d < best) { best = d; bx = probe.x; }
    }
    return bx;
  };

  const STEP = 6;
  const knots: { u: number; x: number }[] = [];
  for (let z = DIMS.zMax; z >= DIMS.zMin - STEP; z -= STEP) knots.push({ u: -z, x: xAt(z) });

  const terms: string[] = [];
  let prevSlope = 0;
  for (let i = 0; i < knots.length - 1; i++) {
    const slope = (knots[i + 1].x - knots[i].x) / (knots[i + 1].u - knots[i].u);
    const c = slope - prevSlope;
    prevSlope = slope;
    terms.push(`${c.toFixed(6)} * max( 0.0, u - ${knots[i].u.toFixed(3)} )`);
  }

  return /* glsl */ `
float fogTrailX( float z ) {
  float u = -z;
  return ${knots[0].x.toFixed(6)}
${terms.map((s) => '    + ' + s).join('\n')};
}
`;
}

/**
 * `float fogSkyView( vec3 p )` — how much of the sky the air at `p` can see.
 *
 * There is no sun in this scene, so there is no classic shaft: a god ray here
 * is not a beam, it is the air under a gap being lit by more sky than the air
 * beside it and therefore in-scattering more. Two things open the canopy, and
 * both are read off the world rather than painted:
 *
 *   the trail, which is the one continuous gap in the stand — this is also
 *   requirement 6, "the trail ahead should glow slightly brighter", and it
 *   falls straight out rather than needing a term of its own;
 *
 *   scattered holes in the canopy elsewhere, from a value noise coarse enough
 *   that one is a few metres across and thresholded hard enough that they are
 *   occasional. The brief is explicit that they should be rare: half a dozen
 *   at similar weights reads as staging rather than as weather.
 *
 * Deliberately *not* keyed on altitude. Air higher up does see more sky, but
 * the height profile has already thinned the fog up there and adding a second
 * altitude term would double-count it — and worse, it would brighten the air
 * along every upward ray, including the ones that end on the dome, which would
 * put a bright rim around every distant crown instead of dissolving it.
 */
function skyViewGLSL(): string {
  return /* glsl */ `
float fogHash( vec2 p ) {
  vec3 q = fract( vec3( p.xyx ) * 0.1031 );
  q += dot( q, q.yzx + 33.33 );
  return fract( ( q.x + q.y ) * q.z );
}

float fogNoise( vec2 p ) {
  vec2 i = floor( p ), f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( fogHash( i ), fogHash( i + vec2( 1.0, 0.0 ) ), f.x ),
              mix( fogHash( i + vec2( 0.0, 1.0 ) ), fogHash( i + vec2( 1.0, 1.0 ) ), f.x ),
              f.y );
}

/* Value noise on a lattice in three dimensions, for the patchiness.
 *
 * Three dimensions rather than two because the layer has vertical structure
 * already and a field constant in altitude would put a column of the same
 * excursion from the duff to the canopy, which is a curtain rather than a
 * patch. Value rather than gradient noise because this is being sampled twice
 * per fragment on a term worth five code values, and nothing here resolves the
 * difference; the smoothstep on the cell fraction is what keeps the lattice
 * from showing.
 */
float fogNoise3( vec3 p ) {
  vec3 i = floor( p ), f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  vec2 o = vec2( 0.0, 1.0 );
  // The z planes are decorrelated by an offset into the same 2D hash rather
  // than by a third hash, which costs nothing and has no visible structure at
  // this amplitude.
  float z0 = i.z * 37.13, z1 = z0 + 37.13;
  float a = mix( mix( fogHash( i.xy + o.xx + z0 ), fogHash( i.xy + o.yx + z0 ), f.x ),
                 mix( fogHash( i.xy + o.xy + z0 ), fogHash( i.xy + o.yy + z0 ), f.x ), f.y );
  float b = mix( mix( fogHash( i.xy + o.xx + z1 ), fogHash( i.xy + o.yx + z1 ), f.x ),
                 mix( fogHash( i.xy + o.xy + z1 ), fogHash( i.xy + o.yy + z1 ), f.x ), f.y );
  return mix( a, b, f.z );
}

/** Zero-mean, roughly -0.5 to 0.5. Two octaves at 9 m and 3.4 m. */
float fogPatch( vec3 p ) {
  return ( fogNoise3( p * 0.111 ) - 0.5 ) * 1.30
       + ( fogNoise3( p * 0.294 + 23.7 ) - 0.5 ) * 0.52;
}

float fogSkyView( vec3 p ) {
  float lat = abs( p.x - fogTrailX( p.z ) );
  // The tread is 0.86 m across but the gap in the canopy over it is not; the
  // stand thins for a couple of metres either side because nothing germinates
  // in a boot track. 4.5 m is where the crowns close over again.
  float corridor = 1.0 - smoothstep( 0.9, 4.5, lat );
  // ~11 m across, which is a windthrow gap rather than a missing branch.
  float gap = fogNoise( p.xz * 0.09 );
  gap = smoothstep( 0.74, 0.96, gap );
  return clamp( max( corridor, gap ), 0.0, 1.0 );
}
`;
}

/**
 * The GLSL twin of `fogAirAt`, and the one piece of this file that can drift.
 *
 * It has to be a twin: the dome texture is built on the CPU and the fog is
 * evaluated per fragment, and there is no way to call one from the other. The
 * failure mode if they diverge is not an error — the fog keeps working, keeps
 * being layered, keeps looking plausible, and distant geometry simply stops
 * disappearing, because the two colours are no longer the same colour.
 *
 * `tools/fog.mjs` is the check, and it is a measurement rather than an
 * assertion: it renders every material black and reports the luma the air
 * converges to against the luma of the dome behind it. Those two numbers
 * agreeing is the invariant. If this function is edited without editing
 * `fogAirAt`, that gap opens and the tool prints it.
 */
function fogAirGLSL(): string {
  return /* glsl */ `
vec3 fogAir( vec3 dir ) {
  // The dome's parameterisation: linear in polar angle, because that is what
  // SphereGeometry writes into uv.y and therefore what the texture rows mean.
  float el = 1.0 - 0.6366197724 * acos( clamp( dir.y, -1.0, 1.0 ) );
  if ( el >= 0.0 ) {
    return mix( ${v3(FOG_RADIANCE)}, ${v3(FOG_HIGH)}, el * el * ( 3.0 - 2.0 * el ) );
  }
  return mix( ${v3(FOG_RADIANCE)}, ${v3(FOG_LOW)}, min( 1.0, -el ) );
}
`;
}

/**
 * @param hdr whether the scene draws into a linear target rather than the
 * canvas. It changes exactly one thing in this file — where the dither is
 * emitted — and the reasoning is at the bottom, next to the chunk it drops.
 * The mix itself needs no edit, which was not obvious and is argued in
 * pipeline.ts.
 */
export function installFog(hdr = false) {
  const S = THREE.ShaderChunk as unknown as Record<string, unknown>;
  if (S.__fogInstalled) return;
  S.__fogInstalled = true;

  const F = fogFlags();

  /* The floor of every comparison: three's own chunks, untouched. Not a
   * separate implementation of "no fog" — literally the stock text, so
   * `?fog=off` is a measurement against the build this system replaced rather
   * than against a second guess at what it did. */
  if (F.has('off')) return;

  /* Scale height as its reciprocal. Zero drives the integral down the
   * `abs(kdy) < 1e-3` branch, which returns exactly 1.0 — uniform density in
   * altitude, which is the placeholder FogExp2 this replaced. */
  const K_HEIGHT = F.has('noheight') ? 0 : 1 / FOG_SCALE_HEIGHT;
  /* Pushed past anything in the world, so the smoothstep is identically zero
   * over the whole scene and the closeout contributes nothing. */
  const C0 = F.has('noclose') ? 1e6 : CLOSE_NEAR;
  const C1 = F.has('noclose') ? 2e6 : CLOSE_FAR;
  /* `?fog=s0.4` sweeps the sky-view gain. Its shipped value is small enough
   * that a picture is a poor instrument for choosing it — the way to see where
   * a term acts is to overdrive it until it is obvious, look at *where* the
   * change lands, and then set it back. */
  const sFlag = [...F].find((f) => /^s[\d.]+$/.test(f));
  const SKY_GAIN = F.has('nosky') ? 0 : sFlag ? Number(sFlag.slice(1)) : SKY_VIEW_GAIN;
  const DITH = F.has('nodither') ? 0 : DITHER;
  /* Both patch amplitudes on one switch, because they are one effect. Measured
   * separately during development with `?fog=p...`-style edits; shipped as a
   * pair so `?fog=nopatch` answers "is the fog patchy" rather than "is one of
   * the two halves of the patchiness doing anything". */
  const P_D = F.has('nopatch') ? 0 : PATCH_DENSITY;
  const P_R = F.has('nopatch') ? 0 : PATCH_RADIANCE;

  /* `?fog=p2.6` sweeps the falloff exponent. The density has to move with it
   * or the sweep is a sweep of the visibility as well and says nothing: the
   * whole point of the parameterisation is that 36 m is fixed and only the
   * distribution of the loss changes. `scene.fog.density` is set from env.ts
   * and is not touched here, so the override rescales it in the shader. */
  const pFlag = [...F].find((f) => /^p[\d.]+$/.test(f));
  const N = pFlag ? Number(pFlag.slice(1)) : FOG_FALLOFF;
  const K_SCALE = Math.log(50) ** (1 / N) / Math.log(50) ** (1 / FOG_FALLOFF);

  /* ── The AgX look ────────────────────────────────────────────────────────
   *
   * three ships AgX bare: inset matrix, log encode, contrast sigmoid, outset
   * matrix, and nothing else. That is the *base* transform, and it is not what
   * anybody looks at. Blender, whose implementation three's is a port of, never
   * shows it without a "look" on top, and the looks exist for one reason: the
   * inset matrix deliberately walks the primaries in towards the achromatic
   * axis so that bright saturated colour has somewhere to roll off to, and
   * nothing in the base transform ever walks them back out. Everything comes
   * out of it desaturated by construction.
   *
   * On a scene that is one enormous neutral field with a little green and brown
   * in the near corner, that costs the entire chroma budget. Measured across
   * the set, median HLS saturation was 0.032 to 0.058 with three to ten per
   * cent of pixels above 0.15, against reference photographs of the same forest
   * at 0.174 to 0.193 and sixty per cent. There is nothing left for System 8's
   * muted grade to mute.
   *
   * The restore goes exactly where Blender puts it — on the log-encoded value
   * after the contrast sigmoid and before the outset matrix — because that is
   * the space the outset matrix was fitted to invert from, and a saturation
   * applied after it in display-linear blows the highlights out of gamut
   * instead. 1.42 is between Blender's Golden (1.3) and Punchy (1.4/1.5) and
   * was set by measuring the near ferns and the duff up to the reference band
   * without moving the air, which is achromatic and therefore untouched by a
   * pure saturation.
   *
   * `?fog=nosat` returns the bare transform.
   */
  const SAT = F.has('nosat') ? 1 : LOOK_SATURATION;
  const pars = THREE.ShaderChunk.tonemapping_pars_fragment;
  const anchor = 'color = agxDefaultContrastApprox( color );';
  if (!pars.includes(anchor)) {
    /* Silently doing nothing here would be indistinguishable from the term
     * being tuned to unity, which is precisely the failure mode this project
     * keeps finding. */
    console.error('fog.ts: AgX chunk did not match; chroma restore not installed');
  }
  THREE.ShaderChunk.tonemapping_pars_fragment = pars.replace(anchor, `${anchor}
	{
		float agxL = dot( color, vec3( 0.2126, 0.7152, 0.0722 ) );
		color = clamp( agxL + ${SAT.toFixed(3)} * ( color - agxL ), 0.0, 1.0 );
	}`);

  THREE.ShaderChunk.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vFogWorld;
#endif
`;

  /* vFogDepth is kept and assigned even though nothing reads it. Removing a
   * varying three's own chunk declares is the kind of change that links fine
   * everywhere and then fails on the one material somewhere else in the
   * project that replaced `<fog_vertex>` by hand and assigns it — which three
   * reports lazily on first draw, as a black surface and a console line rather
   * than as a build error. */
  THREE.ShaderChunk.fog_vertex = /* glsl */ `
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  vFogWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
#endif
`;

  THREE.ShaderChunk.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  varying vec3 vFogWorld;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
${fogAirGLSL()}
${trailXGLSL()}
${skyViewGLSL()}
#endif
`;

  /* The mix, in scene radiance, immediately before the tone curve.
   *
   * COLOUR SPACE, stated where the pass is:
   *   in    gl_FragColor  scene-linear radiance, sRGB primaries. `opaque_fragment`
   *                       has just written outgoingLight and nothing has
   *                       touched it since.
   *   local fogLin        the same.
   *   out   gl_FragColor  the same, and then the stock tone map runs on it.
   *
   * Nothing display-encoded crosses this block in either direction, which is
   * the whole reason the mix moved here from `fog_fragment`.
   */
  THREE.ShaderChunk.tonemapping_fragment = /* glsl */ `
#ifdef USE_FOG

  /* Path length along the ray, not depth along the view axis.
   *
   * three's chunk measures -mvPosition.z, the distance to the camera *plane*.
   * The two agree at the centre of frame and diverge without limit towards the
   * edges, and the geometry that lives out there is the ground — a mesh 88 m
   * across seen from 1.6 m up, so a point on it far out to the side but only
   * ten metres up the trail was being given the fog of something ten metres
   * away while actually being thirty away. It kept its own albedo, and where it
   * ran out you saw it run out. Radial distance is also simply the right
   * quantity: extinction depends on how far the light travelled, not on its
   * component along one axis. */
  vec3 fogRay = vFogWorld - cameraPosition;
  float fogDist = length( fogRay );
  vec3 fogDir = fogRay / max( fogDist, 1e-4 );

  /* Height structure, which is the term that makes this weather.
   *
   * The closed-form integral of an exponential-in-altitude density along the
   * ray, divided through by the density at the camera so that a level ray
   * comes out at exactly 1.0. That normalisation is not cosmetic: without it
   * every fog value in the project shifts the moment the term is switched on,
   * and the ground has already been signed off against the level-ray numbers.
   * Referred to the camera this is a pure redistribution — the tread is
   * untouched and the canopy is what moves.
   *
   * FOG_SCALE_HEIGHT is 9 m, from env.ts, where it is set from the brief's
   * "thicker near the ground, slightly thinner above head height": a sightline
   * five metres above the eye then carries 77% of the optical depth of a level
   * one, and a crown sixteen metres up carries 47%. Measured, that takes a
   * black object at crown height from 120 down into the 40s, which is the band
   * the trees were authored against.
   *
   * Downward rays get a factor above 1.0, correctly — the air below the eye is
   * denser. It is bounded in practice because the ground is never more than
   * about two metres below the camera within the visible range.
   *
   * NOT capped, and the negative result is worth the paragraph because the
   * obvious next move is to add one. Real radiation fog is held down by a
   * temperature inversion and has a top a metre or two thick, and the way to
   * put that here would be a piecewise density — exponential below the
   * inversion, collapsing above it — integrated in two parts with the ray
   * split at the crossing altitude. Worked through before writing it: for a
   * crown twenty metres up at thirty-five metres out, the capped integral
   * comes to 0.394 against the uncapped 0.426, seven per cent, well under a
   * code value. The reason is that the exponential's own integral already
   * converges — a ray straight up accumulates at most FOG_SCALE_HEIGHT metres
   * of optical path however far it goes, which at this density is a fog factor
   * of 0.03 — so there is almost nothing above the inversion for a cap to
   * remove. A cap would buy two branches and a discontinuity risk for nothing
   * measurable. Do not add it; the layer's top comes from the exponential. */
  float fogKdy = ${K_HEIGHT.toFixed(8)} * fogRay.y;
  float fogHeight = ( abs( fogKdy ) < 1e-3 ) ? 1.0 : ( 1.0 - exp( - fogKdy ) ) / fogKdy;
  float fogOptical = fogDist * fogHeight;

  /* Patchiness in the density, sampled at two points along the near half of
   * the ray. See PATCH_DENSITY in fog.ts for why there are two terms and what
   * each of them reaches.
   *
   * Two samples rather than one because a single sample is a *point* value
   * standing in for a line integral, and with a nine-metre field that means
   * two adjacent rays that happen to straddle a cell boundary get different
   * whole-ray densities — which draws the cell boundary across the frame as a
   * soft edge. Averaging two points a third of the ray apart smears each
   * boundary over the range between them and there is no edge left to find.
   * Capped at thirty metres because past that the factor is multiplying a
   * saturated exponential and cannot be seen. */
  float fogSpan = min( fogDist, 30.0 );
  float fogP = 0.5 * ( fogPatch( cameraPosition + fogDir * ( fogSpan * 0.30 ) )
                     + fogPatch( cameraPosition + fogDir * ( fogSpan * 0.72 ) ) );
  /* Gated off the near field, and this is a correction rather than a taste.
   *
   * Sampling at fractions of the ray means a fragment at two metres samples the
   * field at 0.6 m and 1.4 m from the eye — which is the same place for every
   * near fragment in the frame, so the whole near field shares one value of
   * fogP and the patchiness stops being patchiness and becomes a global
   * exposure that drifts as the walker moves. It measured as one: near fern
   * crowns at stop 60 read 25.9 against 29.9 with ?fog=nopatch, and at stop 42
   * the whole-frame mean moved ten code values the other way. Four to ten
   * levels of camera-position-dependent brightness on everything inside five
   * metres is not a defect a still picture shows, which is why it survived a
   * round.
   *
   * There is nothing to lose by removing it. The optical depth at two metres is
   * a few per cent, so modulating it by forty per cent is a statement about
   * almost nothing — while the shell the term was written for, between ten and
   * thirty metres, is entirely above the gate and measures unchanged. */
  fogOptical *= 1.0 + ${P_D.toFixed(4)} * fogP * smoothstep( 1.5, 9.0, fogDist );

  /* exp(-(k*d)^n), n = FOG_FALLOFF. Not three's FogExp2, which is this with
   * n fixed at 2; env.ts has the measurement that moved it and the physics
   * that allows it. The uniform is still three's own fogDensity, so the
   * visibility stays a single number in one file. */
  #ifdef FOG_EXP2
    float fogTau = max( fogDensity * ${K_SCALE.toFixed(8)} * fogOptical, 1e-5 );
    float fogFactor = 1.0 - exp( - pow( fogTau, ${N.toFixed(4)} ) );
  #else
    float fogFactor = smoothstep( fogNear, fogFar, fogOptical );
  #endif

  // Aerial perspective has to actually complete; see CLOSE_NEAR in fog.ts.
  fogFactor = mix( fogFactor, 1.0,
    pow( smoothstep( ${C0.toFixed(1)}, ${C1.toFixed(1)}, fogDist ), 1.6 ) );
  fogFactor = clamp( fogFactor, 0.0, 1.0 );

  /* The air in front of this fragment, lit by the sky it is looking into, and
   * equal to the dome along the same ray so that a fully hazed object
   * disappears rather than leaving an outline. */
  vec3 fogLin = fogAir( fogDir );

  /* In-scattering keyed to how much sky the air can see.
   *
   * Sampled at the midpoint of the near half of the ray rather than at the
   * fragment. The in-scattered radiance is an integral along the whole path
   * weighted by transmittance, so it is dominated by the near end; taking it
   * at the fragment would key a saturated ray's colour to a point it
   * contributes almost nothing from, and the trail's own glow would then
   * follow whatever the ray happened to land on twenty-five metres away
   * instead of following the trail.
   *
   * The 14 m cap is the transmittance falling off: past about two thirds of
   * the visibility there is no weight left to sample. */
  vec3 fogMid = cameraPosition + fogDir * min( fogDist * 0.5, 14.0 );

  /* Faded out as the fog completes, and that is a correctness fix rather than
   * a taper.
   *
   * Without it the term breaks the one invariant the whole system rests on:
   * that saturated air equals the dome behind it. Measured at 49 m the air was
   * landing at 197 against a dome of 194, so instead of dissolving, a distant
   * trunk left a *bright* ghost of itself — the same artifact as a mismatched
   * fog colour with the sign flipped, and it also widened the seam along the
   * rim of the ground mesh, which is the one place saturated air and the dome
   * meet along a straight line.
   *
   * The fade is also the honest statement. Sky view is a local property of the
   * air; a ray long enough to saturate has averaged it over its whole length
   * and there is nothing left of the local excursion — which is exactly what
   * the dome, a single average, represents. So the term is largest where the
   * ray is long enough to carry weight and short enough not to have averaged
   * out. The product peaks at half fog, around fifteen metres here. */
  fogLin *= 1.0 + ${SKY_GAIN.toFixed(6)} * fogSkyView( fogMid ) * ( 1.0 - fogFactor );

  /* And the half of the patchiness that survives saturation. Not faded with
   * the fog factor, unlike the sky-view term above, because a zero-mean field
   * cannot bias the air away from the dome and therefore cannot produce the
   * artifact the fade exists to prevent. The same sample is reused rather than
   * drawn again: the same patch of air should be both denser and — since it is the
   * same water — differently lit, and two independent fields would read as two
   * unrelated effects laid over each other. */
  fogLin *= 1.0 + ${P_R.toFixed(5)} * fogP;

  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogLin, fogFactor );

#endif

#if defined( TONE_MAPPING )

  gl_FragColor.rgb = toneMapping( gl_FragColor.rgb );

#endif
`;

  /* Left declared and empty. Deleting the include is not an option — it is in
   * three's own ShaderLib sources — and leaving the stock text in would apply
   * the fog a second time, in the wrong space, on top of the right one. */
  THREE.ShaderChunk.fog_fragment = '';

  /* Dither, and it is the last thing that happens to the pixel — on the canvas
   * path only.
   *
   * Placed in `dithering_fragment` because that chunk runs after
   * `colorspace_fragment`, so the noise is added in the same space and the same
   * units as the quantiser that is about to round it. Adding it any earlier —
   * in radiance, before AgX — would be shaped by the tone curve on the way
   * through and would come out at a different amplitude in the highlights than
   * in the shadows, which for a frame that is almost entirely highlights means
   * almost no dither where all the banding is.
   *
   * Which is exactly what a linear render target would do to it. In a target
   * `colorspace_fragment` is the identity, so this chunk would be adding a
   * code value of *radiance*: a fortieth of a stop in the fog, and a factor of
   * several in the darkest bark, because AgX's toe is long and 1/255 of
   * radiance down there is an enormous number. So on the HDR path this is left
   * as three's stock chunk — which is inert, since nothing in this scene sets
   * the DITHERING define — and `post.tsx` emits the same noise at the same
   * amplitude at the end of its chain, where the quantiser it is for actually
   * rounds. There is exactly one dither in the frame on either path;
   * `?post=nodither` is how that is checked.
   *
   * Unconditional rather than behind the DITHERING define, because the worst
   * banding in the frame is on the sky dome and a `meshBasicMaterial` has no
   * reason to have opted in. `points`, `sprite` and `linedashed` do not include
   * this chunk at all; nothing in this scene uses them.
   *
   * The three channels are offset from one another so the noise is chromatic
   * rather than a luma grain, which at one LSB is invisible as colour and
   * decorrelates the three quantisers instead of moving them together. */
  if (hdr) return;

  THREE.ShaderChunk.dithering_fragment = /* glsl */ `
  {
    // Interleaved gradient noise. Jorge Jimenez's constants; a near-blue-noise
    // spectrum from one dot product and one fract, and no tile to find.
    float fogIgn = fract( 52.9829189 * fract(
      dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
    vec3 fogTri = vec3( fogIgn, fract( fogIgn + 0.3333 ), fract( fogIgn + 0.6667 ) );
    gl_FragColor.rgb += ( fogTri - 0.5 ) * ( ${DITH.toFixed(4)} / 255.0 );
  }
`;
}
