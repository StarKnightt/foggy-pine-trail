'use client';

/* Atmospheric particles. One `THREE.Points`, one draw call, both populations.
 *
 * ── Why points and not instanced quads ────────────────────────────────────
 *
 * Because everything in this system is sub-pixel in at least one dimension and
 * that is the whole rendering problem, not a detail of it.
 *
 * A 25 mm needle at four metres is 5.8 pixels long and 0.08 of a pixel wide at
 * this framing. Submitted as a quad, the rasteriser either misses it entirely
 * or catches one sample of it, so the needle strobes on and off between
 * frames — and the thing directly behind it is bright fog, which is the worst
 * possible background for a flickering dark speck. The fix is the standard
 * thin-feature one: never draw the feature narrower than a pixel, and pay for
 * the width you did not draw by scaling alpha instead. That keeps the total
 * light the particle removes from the frame correct at every distance and
 * turns strobing into a smooth fade. It needs a shape evaluated *in pixels* in
 * the fragment shader, which is what a point sprite is.
 *
 * The second reason is the material. `PointsMaterial` goes through three's own
 * `ShaderLib.points`, which includes `fog_pars_vertex`, `fog_vertex`,
 * `fog_pars_fragment` and `tonemapping_fragment` — the four chunks `fog.ts`
 * replaces. So these particles are fogged by literally the same text as the
 * ground and the trees, rather than by a second implementation that agrees
 * with it today. `fog.ts`'s header records that a system whose fog drifted out
 * of step does not fail loudly; it keeps looking plausible and quietly stops
 * dissolving. A particle that ignored distance attenuation would punch a hole
 * in the image, and that has happened in this project once already.
 *
 * The object sits at the world origin with an identity matrix and the shader
 * writes a *world* position into `transformed`. That is what makes the stock
 * `fog_vertex` correct here with no patch at all: it computes
 * `modelMatrix * transformed`, and with an identity model matrix that is the
 * world position the fog wants. `Undergrowth.tsx` had to fix this by hand
 * because `InstancedMesh` applies `instanceMatrix` later; there is no
 * equivalent hazard here, and choosing a mechanism that avoids the fix is
 * better than writing the fix again.
 *
 * ── What makes each population visible ────────────────────────────────────
 *
 * They are visible by opposite mechanisms and in different parts of the frame,
 * which is worth stating because it is the answer to "there is no sun, so what
 * are they catching".
 *
 * A needle is an opaque dielectric with an albedo near 0.11. In a nearly
 * isotropic field its outgoing radiance is albedo times the mean radiance of
 * that field — about a tenth of the air around it. It is a *dark* fleck, and
 * it therefore reads against the fog and disappears against a trunk.
 *
 * A grain of pollen is a white, translucent, multiply-scattering thing with an
 * effective albedo near one, so its radiance comes out just below the
 * radiance of the air it is in — and, critically, it is set to *exactly* the
 * air along its own view ray, evaluated by calling `fogAir()` from `fog.ts`
 * rather than by picking a colour. It is a *bright* speck, and it therefore
 * reads against a trunk and vanishes against the fog. Held below 1.0 it
 * structurally cannot be brighter than saturated air, so it cannot punch the
 * hole the fog's own sky-view term had to be faded out to avoid.
 *
 * Neither population has, or could have, a light of its own. There is nothing
 * here that a `?fog=off` render would leave standing.
 *
 * ── Per-term switches ─────────────────────────────────────────────────────
 *
 * `?p=nodust,noneedles,still,nowander,noflutter,notumble,noatten,nofocus,off`
 * plus `?p=g<k>` for the overall gain and `?p=big<k>` for the physical size,
 * development only. Same discipline as `fog.ts` and `Undergrowth.tsx`: every
 * switch substitutes a *constant* into the same GLSL, so the compiled program
 * is structurally identical either way and a measured difference cannot be an
 * artifact of having compiled a different shader. `nodust` and `noneedles`
 * multiply alpha by zero rather than shortening the buffer, for the same
 * reason — the vertex count and the draw are unchanged.
 *
 * `big` is the one that earns its keep. Every shipped size here is at or below
 * a pixel in one axis, so a differenced pair against `still` proves the motion
 * term compiles but says nothing about whether the *orientation* maths is
 * wired to the right axis. `?p=big12` inflates the particles until the tumble
 * is unmissable, which is the only way to see that a needle turning end-on
 * actually collapses to a dot.
 *
 * ── The clock is not on `useFrame` ────────────────────────────────────────
 *
 * `Undergrowth.tsx` documents what happens when per-frame work lives in
 * `useFrame`: every capture in this project renders from a paused loop, so the
 * callback never runs between moving the camera and drawing, and a differenced
 * pair silently measures two identically-stale frames. So the time uniform is
 * written from `scene.onBeforeRender`, which three calls inside every render
 * however it was triggered.
 *
 * Advancing it from `performance.now()` rather than from a frame delta is the
 * other half of that: headless Chromium synthesises the timestamp it hands
 * `requestAnimationFrame` and reports a flat 60 fps straight through a stall.
 *
 * And because a differenced pair still needs the *same* time on both sides —
 * two `renderOnce()` calls are tens of milliseconds apart and a needle moves
 * three centimetres in that — `scene.userData.particles.pin(t)` freezes the
 * clock at an exact value. Every measurement in `tools/ptc.mjs` pins first.
 */
import { useEffect, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import {
  buildParticles, DUST_BOX, FALL_BOX, DUST_FADE, FALL_FADE, DUST_NEAR, FALL_NEAR,
  FLUTTER_ST, FLUTTER_CHORDS, NEEDLE_ALBEDO, LEAF_ALBEDO, DUST_GAIN, APERTURE, FOCUS,
} from '@/world/particles';
import { FOG_RADIANCE } from './env';
import { domeRadianceAt } from './fog';
import { DIMS } from '@/world/dims';

/* The largest point sprite that will be asked for, in device pixels.
 *
 * A sprite is a square and the shape inside it is a stadium, so the sprite has
 * to be as wide as the particle is long. `FALL_NEAR` is set so that the
 * largest leaf in the population reaches exactly this at the distance it fades
 * out, which makes the clamp unreachable in practice; it exists so that a
 * future change to the size distribution fails by cropping one sprite rather
 * than by asking for a 400-pixel point, which some drivers silently refuse and
 * others clamp without saying so.
 */
const MAX_POINT_PX = 128;

/* The half-width, in pixels, below which a feature is drawn wider and dimmer
 * instead of narrower and stronger.
 *
 * Half a pixel — that is, one pixel across — because that is the width at
 * which a rasterised feature stops being reliably sampled. Above it nothing
 * happens; the compensation is the identity. Below it the alpha carries the
 * missing width, which is what keeps a needle receding into the fog fading
 * smoothly rather than dropping out.
 */
const MIN_HALF_PX = 0.55;

/**
 * The mean radiance of the environment over the whole sphere.
 *
 * This is the correct multiplier for a small diffuse object's own radiance in
 * this scene: with no directional source, a Lambertian surface's outgoing
 * radiance is its albedo times the mean incident radiance, and a particle
 * tumbling through every orientation in a second samples the whole sphere
 * anyway. Integrated off `domeRadianceAt` rather than off `FOG_RADIANCE`
 * because that function is the source of truth the environment map and the sky
 * dome are both built from — a particle lit by a number typed in here would be
 * the one thing in the frame that did not move when the hour did.
 *
 * Comes out around 0.30, against 0.47 at the horizon: the lower hemisphere is
 * air over wet duff and drags the average down by a third.
 */
function meanDomeRadiance(): THREE.Color {
  const c = new THREE.Color();
  const acc = new THREE.Color(0, 0, 0);
  let w = 0;
  const N = 512;
  for (let i = 0; i < N; i++) {
    const theta = ((i + 0.5) / N) * Math.PI;
    const sw = Math.sin(theta);
    domeRadianceAt(1 - (2 * theta) / Math.PI, c);
    acc.r += c.r * sw; acc.g += c.g * sw; acc.b += c.b * sw;
    w += sw;
  }
  return acc.multiplyScalar(1 / w);
}

function ptcFlags(): Set<string> {
  if (process.env.NODE_ENV === 'production') return new Set();
  if (typeof window === 'undefined') return new Set();
  const q = new URLSearchParams(window.location.search).get('p');
  return new Set(q ? q.split(',').map((s) => s.trim()).filter(Boolean) : []);
}

/* Whether `fog.ts` has been switched off entirely.
 *
 * `?fog=off` leaves three's stock chunks in place, and the stock chunks
 * declare neither `vFogWorld` nor `fogAir()`. The dust colour is a call to
 * `fogAir()`, so under that flag this shader would fail to *link* — which
 * `harness.mjs` reports as a hard failure and which would make the one
 * measurement `?fog=off` exists to provide impossible to take. Under the flag
 * the dust falls back to the horizon radiance, which is what the air is along
 * a level ray anyway.
 */
function fogIsOff(): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  if (typeof window === 'undefined') return false;
  const q = new URLSearchParams(window.location.search).get('fog');
  return !!q && q.split(',').map((s) => s.trim()).includes('off');
}

const f = (x: number) => x.toFixed(6);
const v3 = (c: THREE.Color) => `vec3(${f(c.r)}, ${f(c.g)}, ${f(c.b)})`;

export function Particles() {
  const scene = useThree((s) => s.scene);
  const gl = useThree((s) => s.gl);

  const built = useMemo(() => {
    const F = ptcFlags();
    if (F.has('off')) return null;

    const buf = buildParticles();

    const num = (prefix: string, dflt: number) => {
      const hit = [...F].find((x) => new RegExp(`^${prefix}[\\d.]+$`).test(x));
      return hit ? Number(hit.slice(prefix.length)) : dflt;
    };

    const TIME_K = F.has('still') ? 0 : 1;
    const WANDER_K = F.has('nowander') ? 0 : 1;
    const FLUTTER_K = F.has('noflutter') ? 0 : 1;
    const TUMBLE_K = F.has('notumble') ? 0 : 1;
    const ATTEN_K = F.has('noatten') ? 0 : 1;
    /* `?p=ap40` opens the aperture forty stops' worth.
     *
     * The defocus is the one term here that a differenced pair cannot settle
     * on its own, because below one pixel it cancels against the thin-feature
     * compensation exactly — see APERTURE in world/particles.ts — so it only
     * acts on grains inside about a metre and a half, and whether there is one
     * of those in frame at a given station is luck. Overdriving it until every
     * particle in the frame is a soft disc, looking at where the change lands,
     * and setting it back is how fog.ts chose its sky-view gain and is the
     * only method that has ever worked on a term this small. */
    const FOCUS_K = F.has('nofocus') ? 0 : num('ap', 1);
    const DUST_ON = F.has('nodust') ? 0 : 1;
    const FALL_ON = F.has('noneedles') ? 0 : 1;
    const GAIN = num('g', 1);
    const SIZE_K = num('big', 1);
    const FOG_OFF = fogIsOff();

    const mean = meanDomeRadiance();
    const needleRad = new THREE.Color(
      NEEDLE_ALBEDO[0] * mean.r, NEEDLE_ALBEDO[1] * mean.g, NEEDLE_ALBEDO[2] * mean.b,
    );
    const leafRad = new THREE.Color(
      LEAF_ALBEDO[0] * mean.r, LEAF_ALBEDO[1] * mean.g, LEAF_ALBEDO[2] * mean.b,
    );

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(buf.position, 3));
    geometry.setAttribute('aMot', new THREE.BufferAttribute(buf.mot, 4));
    geometry.setAttribute('aShp', new THREE.BufferAttribute(buf.shp, 4));

    const material = new THREE.PointsMaterial({
      /* Blended, not alpha-tested. Coverage *is* the signal here — a needle
       * whose width has been rounded up to a pixel is carrying its real width
       * in alpha, and a test would throw exactly that away. */
      transparent: true,
      /* No depth write. A sprite writes its centre's depth across its whole
       * square, so a needle in front of a trunk would stamp a needle-length
       * square of near depth into the buffer and cut a hole in anything drawn
       * after it. Depth *test* stays on, so trunks still occlude particles. */
      depthWrite: false,
      /* three's own attenuation is `scale / -mvPosition.z` with `scale` set to
       * half the drawing buffer height, which quietly assumes a 90-degree
       * vertical field of view. This scene is at 52. The size is computed from
       * `projectionMatrix[1][1]` below instead, so the stock path is compiled
       * out rather than left to disagree. */
      sizeAttenuation: false,
    });

    material.onBeforeCompile = (shader) => {
      material.userData.shader = shader;
      shader.uniforms.uTime = { value: 0 };
      shader.uniforms.uViewH = { value: 900 };

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', /* glsl */`#include <common>
attribute vec4 aMot;
attribute vec4 aShp;
uniform float uTime;
uniform float uViewH;
varying vec4 vPtcGeom;
varying vec3 vPtcRad;
varying vec2 vPtcAK;
varying float vPtcPx;`)

        /* The motion, in world space, in the vertex shader.
         *
         * On the CPU this would be 510 matrix writes and an attribute upload
         * every frame, which is the cost the budget cannot take; here it is
         * about sixty ALU on 510 vertices and does not appear in a frame time
         * at all. `transformed` ends up holding a world position, which is
         * what makes the stock `project_vertex` and `fog_vertex` correct — see
         * the header. */
        .replace('#include <begin_vertex>', /* glsl */`
float ptcKind = aShp.x;
float ptcOri = step( 0.5, ptcKind );
float ptcPh = aMot.w * 6.2831853;
float ptcT = uTime * ${f(TIME_K)};

vec3 ptcBox = mix(
  vec3( ${f(DUST_BOX.half)}, ${f(DUST_BOX.lo)}, ${f(DUST_BOX.hi)} ),
  vec3( ${f(FALL_BOX.half)}, ${f(FALL_BOX.lo)}, ${f(FALL_BOX.hi)} ), ptcOri );

/* Descent, wrapped into an absolute world band. A modulo rather than a
 * respawn, because a respawn needs per-particle state and therefore either a
 * CPU pass or a feedback buffer, and this needs neither. */
float ptcY = ptcBox.z
  - mod( ( ptcBox.z - position.y ) + aMot.x * ptcT, ptcBox.z - ptcBox.y );

/* The wander. The two components run at rates whose ratio is irrational, so
 * the path never closes and no two particles are ever briefly in step — a
 * closed circle is the single most recognisable "this is a shader" signature
 * there is. */
float ptcA = ptcT * aMot.z + ptcPh;
vec2 ptcOff = aMot.y * ${f(WANDER_K)}
  * vec2( sin( ptcA ), cos( ptcA * 0.8713 + ptcPh * 1.7 ) );

/* The flutter, and its frequency comes out of the object rather than out of a
 * table: f = St * v / L, so a fast small needle buzzes and a slow broad leaf
 * swoops, from one constant. See FLUTTER_ST in world/particles.ts for why the
 * Strouhal number used here is a quarter of the textbook one. */
float ptcFw = 6.2831853 * ${f(FLUTTER_ST)} * aMot.x / max( 2.0 * aShp.y, 1e-4 );
float ptcF = ptcT * ptcFw + ptcPh * 3.1;
float ptcRock = sin( ptcF );
ptcOff += ptcOri * ${f(FLUTTER_CHORDS * 2 * FLUTTER_K)} * aShp.y
  * vec2( ptcRock, sin( ptcF * 1.131 + 2.1 ) );

vec3 transformed = vec3( position.x + ptcOff.x, ptcY, position.z + ptcOff.y );

/* Wrapped around the camera in x and z only; world-absolute in y. The
 * asymmetry is argued in world/particles.ts. */
transformed.xz = cameraPosition.xz
  + mod( transformed.xz - cameraPosition.xz + ptcBox.x, 2.0 * ptcBox.x ) - ptcBox.x;

/* Orientation as two orthogonal axes rather than one.
 *
 * One axis is enough for a needle, which is a rod: project it, and the
 * foreshortening falls out as the projected length. It is not enough for a
 * leaf, which is a plate — a plate turning edge-on keeps its length and loses
 * its *width*, and that flash from blade to sliver and back is most of what
 * identifies a falling leaf at all. Carrying a second axis costs one cross
 * product and covers both, so there is no separate leaf path.
 *
 * The rock and the sideways slip share one phase, which is the physics: a
 * fluttering object slips in the direction it is tilted. Driving them from
 * independent phases would read as two unrelated animations on one sprite. */
float ptcYaw = ptcT * aMot.z * 0.7 + ptcPh * 2.3;
float ptcPit = 1.15 * ${f(TUMBLE_K)} * ptcRock;
vec3 ptcU = vec3( cos( ptcPit ) * cos( ptcYaw ), sin( ptcPit ), cos( ptcPit ) * sin( ptcYaw ) );
/* The pitch is capped at 66 degrees, so ptcU is never within 24 degrees of
 * vertical and this cross product cannot degenerate. */
vec3 ptcE1 = normalize( cross( ptcU, vec3( 0.0, 1.0, 0.0 ) ) );
float ptcRoll = ptcF * 0.83 + ptcPh * 5.0;
vec3 ptcW = ptcE1 * cos( ptcRoll ) + cross( ptcU, ptcE1 ) * sin( ptcRoll );`)

        .replace('gl_PointSize = size;', /* glsl */`
/* Metres to device pixels at this depth. The projection term is the part
 * three's own attenuation leaves out. */
float ptcPxM = projectionMatrix[1][1] * 0.5 * uViewH / max( -mvPosition.z, 0.05 );

/* Both axes projected onto the screen. Subtracting the component along the
 * view ray is the whole of the perspective foreshortening for an object this
 * small; what is left is, to first order, the screen-space image of the axis.
 * A needle pointing at the camera collapses to a dot here, which is correct
 * and is the reason a tumbling needle appears to flash. */
vec3 ptcRay = normalize( mvPosition.xyz );
vec3 ptcUv = ( viewMatrix * vec4( ptcU, 0.0 ) ).xyz;
vec3 ptcWv = ( viewMatrix * vec4( ptcW, 0.0 ) ).xyz;
vec2 ptcPu = ( ptcUv - ptcRay * dot( ptcUv, ptcRay ) ).xy;
vec2 ptcPw = ( ptcWv - ptcRay * dot( ptcWv, ptcRay ) ).xy;
float ptcPuL = length( ptcPu );
vec2 ptcDir = ptcPuL > 1e-5 ? ptcPu / ptcPuL : vec2( 1.0, 0.0 );

/* A grain is a sphere and has no orientation to project; mixing to 1.0 keeps
 * it circular instead of letting it pulse in size as a meaningless axis
 * rotates. */
float ptcA2 = aShp.y * ${f(SIZE_K)} * mix( 1.0, ptcPuL, ptcOri ) * ptcPxM;
float ptcB2 = aShp.z * ${f(SIZE_K)}
  * mix( 1.0, abs( dot( ptcPw, vec2( -ptcDir.y, ptcDir.x ) ) ), ptcOri ) * ptcPxM;

/* The lens, convolved into the footprint before it is rasterised rather than
 * blurred out of the framebuffer afterwards. See APERTURE in
 * world/particles.ts for why that distinction is the whole point.
 *
 * Added in quadrature, which is the right composition for a footprint and a
 * point-spread function that are both roughly Gaussian, and the alpha carries
 * the area ratio so the particle's total light is unchanged by being
 * defocused. Far from the focal plane in the *other* direction this is
 * essentially zero — at five metres the blur circle is a tenth of a pixel —
 * so this term is only ever spending its cost where it does something. */
float ptcCoC = ${f(APERTURE * 0.5 * FOCUS_K)}
  * abs( ${f(1 / FOCUS)} - 1.0 / max( -mvPosition.z, 0.05 ) )
  * projectionMatrix[1][1] * 0.5 * uViewH;
float ptcA0 = ptcA2, ptcB0 = ptcB2;
ptcA2 = sqrt( ptcA2 * ptcA2 + ptcCoC * ptcCoC );
ptcB2 = sqrt( ptcB2 * ptcB2 + ptcCoC * ptcCoC );
float ptcBlur = ( ptcA0 * ptcB0 ) / max( ptcA2 * ptcB2, 1e-6 );

/* Thin-feature compensation, applied on each axis independently.
 *
 * For a needle only the width is ever below the floor, so the alpha scales
 * linearly with the width that was not drawn. For a grain both axes are, so it
 * scales with the area — which is right, and is why this is two statements
 * rather than one on the larger axis. Switched off by ?p=noatten, which makes
 * every distant particle far too strong and is obvious in a differenced pair. */
float ptcAtt = ptcBlur
             * mix( 1.0, min( 1.0, ptcA2 / ${f(MIN_HALF_PX)} ), ${f(ATTEN_K)} )
             * mix( 1.0, min( 1.0, ptcB2 / ${f(MIN_HALF_PX)} ), ${f(ATTEN_K)} );
ptcA2 = max( ptcA2, ${f(MIN_HALF_PX)} );
ptcB2 = max( ptcB2, ${f(MIN_HALF_PX)} );

float ptcD = length( transformed - cameraPosition );
vec4 ptcFade = mix(
  vec4( ${f(DUST_FADE.near)}, ${f(DUST_FADE.far)}, ${f(DUST_NEAR.out)}, ${f(DUST_NEAR.in)} ),
  vec4( ${f(FALL_FADE.near)}, ${f(FALL_FADE.far)}, ${f(FALL_NEAR.out)}, ${f(FALL_NEAR.in)} ),
  ptcOri );
ptcAtt *= 1.0 - smoothstep( ptcFade.x, ptcFade.y, ptcD );
ptcAtt *= smoothstep( ptcFade.z, ptcFade.w, ptcD );

/* A needle vanishing into the litter instead of through the floor.
 *
 * The floor is taken as one eye height below the camera rather than from the
 * heightfield. groundHeight() is a dozen noise octaves and is not something
 * to evaluate per vertex per frame, and it does not need to be: the ground
 * this matters for is the ground the walker is standing on, the relief is
 * gentle over the couple of metres where a needle is still legible, and the
 * consequence of being 10 cm out is that a needle disappears 10 cm early into
 * duff and moss that is 15 cm deep anyway. */
float ptcFloor = cameraPosition.y - ${f(DIMS.eyeHeight)};
ptcAtt *= mix( 1.0, smoothstep( ptcFloor - 0.05, ptcFloor + 0.45, transformed.y ), ptcOri );

ptcAtt *= mix( ${f(DUST_ON)}, ${f(FALL_ON)}, ptcOri ) * ${f(GAIN)};

vPtcPx = clamp( 2.0 * ( ptcA2 + ptcB2 ) + 2.0, 2.0, ${f(MAX_POINT_PX)} );
gl_PointSize = vPtcPx;
vPtcGeom = vec4( ptcA2, ptcB2, ptcDir );
vPtcAK = vec2( ptcAtt, ptcOri );
/* Solid particles carry their radiance from here; grains carry only their
 * per-particle tint and pick up the air's colour in the fragment shader, where
 * the view direction is known per pixel. */
vPtcRad = mix( vec3( aShp.w ),
  mix( ${v3(needleRad)}, ${v3(leafRad)}, clamp( ptcKind - 1.0, 0.0, 1.0 ) ) * aShp.w,
  ptcOri );`);

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', /* glsl */`#include <common>
varying vec4 vPtcGeom;
varying vec3 vPtcRad;
varying vec2 vPtcAK;
varying float vPtcPx;`)

        /* The sprite's shape, in pixels, replacing the texture lookup this
         * chunk would otherwise do. A stadium — a segment with a rounded
         * half-width — covers both populations: at half-length equal to
         * half-width it is a disc, which is a grain, and as the two separate
         * it is a rod. */
        .replace('#include <map_particle_fragment>', /* glsl */`
{
  /* gl_PointCoord runs top-down and the projected axis in vPtcGeom.zw is
   * y-up, so one of the two has to be flipped or every needle leans the wrong
   * way — which is invisible on a symmetric distribution and would never have
   * been caught by looking at the frame. */
  vec2 ptcP = ( gl_PointCoord - 0.5 ) * vec2( vPtcPx, -vPtcPx );
  float ptcSeg = max( vPtcGeom.x - vPtcGeom.y, 0.0 );
  vec2 ptcQ = ptcP - vPtcGeom.zw * clamp( dot( ptcP, vPtcGeom.zw ), -ptcSeg, ptcSeg );
  /* One pixel of edge softness. This is the antialiasing for the whole system:
   * the canvas has no MSAA once System 8 takes over, and a point sprite is not
   * covered by a post-process resolve either way. */
  float ptcCov = smoothstep( vPtcGeom.y + 0.5, vPtcGeom.y - 0.5, length( ptcQ ) );
  if ( ptcCov * vPtcAK.x < 0.0025 ) discard;

  /* The air along this pixel's own ray, from fog.ts, which is the source of
   * truth the sky dome and the environment map are also built from. A grain
   * set to a fraction of it is invisible against the fog by construction
   * rather than by tuning.
   *
   * Guarded twice, and both guards were earned rather than added for safety.
   *
   * The #ifdef is because this material links once before Lighting's effect
   * has put a fog on the scene, so three compiles one program with USE_FOG
   * undefined and another with it defined, and only the second is ever drawn
   * with. Unguarded, the first fails to link — which harness.mjs correctly
   * treats as a hard failure of the run even though the pixels are fine, and
   * which on a slower boot could be the program that draws.
   *
   * The build-time branch is for ?fog=off, which leaves three's *stock* chunks
   * in place: USE_FOG is still defined, but stock chunks declare neither
   * vFogWorld nor fogAir. Losing the one measurement that switch exists to
   * provide, to a link error, would be a poor trade. */
  vec3 ptcAir = ${v3(FOG_RADIANCE)};
  ${FOG_OFF ? '' : `#ifdef USE_FOG
    ptcAir = fogAir( normalize( vFogWorld - cameraPosition ) );
  #endif`}

  diffuseColor.a = ptcCov * vPtcAK.x;
  diffuseColor.rgb = mix( ptcAir * ${f(DUST_GAIN)} * vPtcRad, vPtcRad, vPtcAK.y );
}`);
    };

    /* Three keys its program cache on this string. Without it a switch flipped
     * across a hot reload silently reuses the previous shader, which reads
     * exactly like a term that does nothing. */
    material.customProgramCacheKey = () =>
      `particles-1-${TIME_K}${WANDER_K}${FLUTTER_K}${TUMBLE_K}${ATTEN_K}${FOCUS_K}` +
      `-${DUST_ON}${FALL_ON}-${GAIN}-${SIZE_K}-${FOG_OFF ? 1 : 0}`;

    const points = new THREE.Points(geometry, material);
    /* The positions in the buffer are pre-animation and pre-wrap, so any
     * bounding volume computed from them describes somewhere the particles are
     * not. There is one draw call to save and it is 510 vertices. */
    points.frustumCulled = false;
    points.matrixAutoUpdate = false;
    points.updateMatrix();

    return {
      points, material, geometry, counts: buf.counts,
      flags: {
        TIME_K, WANDER_K, FLUTTER_K, TUMBLE_K, ATTEN_K, FOCUS_K,
        DUST_ON, FALL_ON, GAIN, SIZE_K,
      },
      dispose() { geometry.dispose(); material.dispose(); },
    };
  }, []);

  useEffect(() => built?.dispose, [built]);

  /* The clock, the viewport height, and the debug surface. See the header for
   * why none of this is in `useFrame`. */
  useEffect(() => {
    if (!built) return;
    const state = { t: 0, last: 0, pin: null as number | null };
    const size = new THREE.Vector2();

    const prev = scene.onBeforeRender;
    scene.onBeforeRender = function (this: THREE.Scene, ...a: unknown[]) {
      (prev as unknown as (...x: unknown[]) => void).apply(this, a);
      const shader = built.material.userData.shader as
        { uniforms: Record<string, { value: number }> } | undefined;
      if (!shader) return;
      const now = performance.now() / 1000;
      const dt = state.last ? Math.min(now - state.last, 0.1) : 0;
      state.last = now;
      state.t = state.pin !== null ? state.pin : state.t + dt;
      shader.uniforms.uTime.value = state.t;
      /* Device pixels, not CSS pixels, because that is what gl_PointSize is
       * in. The dev harness runs at dpr 1 and the browser at up to 1.5, and a
       * particle system that was half the size on a retina display would be a
       * defect nobody measuring at dpr 1 could ever see. */
      shader.uniforms.uViewH.value = gl.getDrawingBufferSize(size).y;
    };

    if (process.env.NODE_ENV === 'development') {
      scene.userData.particles = {
        ...built.counts,
        flags: built.flags,
        get time() { return state.t; },
        /** Freeze the clock at an exact value. Pass null to let it run. */
        pin(t: number | null) { state.pin = t; },
        /** Toggle the draw without a reload, for a differenced pair. */
        setVisible(on: boolean) { built.points.visible = !!on; },
      };
    }

    return () => {
      scene.onBeforeRender = prev;
      delete scene.userData.particles;
    };
  }, [scene, gl, built]);

  if (!built) return null;
  return <primitive object={built.points} />;
}
