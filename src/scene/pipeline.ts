/* The linear-HDR hand-off, and the one thing System 8 had to get right before
 * anything else.
 *
 * ── Why the scene stops drawing to the canvas ─────────────────────────────
 *
 * Depth of field needs scene depth and WebGL will not let you read the default
 * framebuffer's depth at all, so the choice is a render target or no depth of
 * field. The brief offers the safe order — grain, vignette and grade off a
 * canvas grab first, the target and the defocus second — and the target was
 * taken first anyway, for a reason that is specific to this scene rather than
 * general:
 *
 * `fog.ts` mixes the airlight inside `tonemapping_fragment` because that is
 * the last point at which `gl_FragColor` is still scene radiance *when drawing
 * to the canvas*. A canvas grab would leave that arrangement exactly as it is,
 * which sounds like the conservative choice and is in fact the one that keeps
 * the whole grade downstream of a tone map it cannot undo. The target does the
 * opposite: it puts the grade in radiance next to the fog, where the two are
 * the same kind of number.
 *
 * ── What three does on its own, checked in the source, not hoped for ──────
 *
 *   `WebGLRenderer` forces `toneMapping = NoToneMapping` for any material
 *   drawn into a non-XR render target (three.module.js:18345-18354), and the
 *   target's colour space becomes the working space so `linearToOutputTexel`
 *   is the identity (18336).
 *
 * `fog.ts`'s mix sits *outside* `#if defined( TONE_MAPPING )` and its output
 * is whatever `opaque_fragment` wrote, so the moment the target appears the
 * mix keeps happening in exactly the space it was written for and the tone map
 * simply compiles out of the scene pass and reappears once, at the end of the
 * post chain. That was the whole colour-space question and the answer is that
 * the fog needs no edit.
 *
 * One thing did have to move, and it is the kind of defect that would have
 * been invisible: the fog's dither. It is one code value of noise added in
 * `dithering_fragment`, which runs after `colorspace_fragment` — display space
 * on the canvas path, and *radiance* in a linear target. A 1/255 excursion of
 * radiance on a scene whose airlight is 0.47 is a fortieth of a stop in the
 * fog and, far worse, a factor of several in the darkest bark, because AgX has
 * a long toe and a code value of radiance down there is enormous. So
 * `installFog` takes a flag and the dither is emitted once, at the end of this
 * pass, in the space the quantiser it is dithering for actually works in.
 *
 * ── The escape hatch ──────────────────────────────────────────────────────
 *
 * `?nohdr` renders the old way: scene straight to the canvas, tone-mapped by
 * the renderer, dithered by the fog chunk, no post pass at all. That is not a
 * degraded version of this path, it is byte-for-byte the build every shot in
 * `shots/s8base` was judged through, so it is the floor of every comparison.
 *
 * With `?nograde` — the target, the tone map moved, and every grade term at
 * its identity — the two together bisect the change: `nohdr` against `nograde`
 * is the cost of the restructure alone, and `nograde` against the shipped
 * build is the grade alone. Neither question can be asked with one switch.
 */
import * as THREE from 'three';

/**
 * `?post=nograin,novig` — comma separated, plus the bare aliases, because
 * these get typed by hand more than anything else in the project.
 *
 * Development only, like `?fog=`. Every switch substitutes a constant into the
 * same GLSL rather than adding a branch or a define, so the compiled program is
 * structurally identical either way and a measured difference cannot be an
 * artifact of having compiled a different shader. Seven inert or degenerate
 * code paths have shipped here; a term that cannot be switched off cannot be
 * proved to be on.
 */
export function postFlags(): Set<string> {
  if (process.env.NODE_ENV === 'production') return new Set();
  if (typeof window === 'undefined') return new Set();
  const q = new URLSearchParams(window.location.search);
  const raw = q.get('post');
  const s = new Set(raw ? raw.split(',').map((x) => x.trim()).filter(Boolean) : []);
  for (const k of ['nohdr', 'nograde', 'nograin', 'novig', 'nodof', 'nolift', 'nohue', 'nodither']) {
    if (q.has(k)) s.add(k);
  }
  return s;
}

/**
 * Whether the scene renders into a linear target at all.
 *
 * Read once and never re-read. The pipeline cannot change shape midway — the
 * fog's dither placement is decided at chunk-patch time, before the first
 * material links — so a switch that could flip at runtime would be a lie.
 */
export const useHdr = (): boolean => !postFlags().has('nohdr');

/**
 * The scene target: half-float colour, 4x MSAA, and a depth texture.
 *
 * `samples: 4` is not a new cost. The canvas was already `antialias: true` and
 * `Forest.tsx` turns that off in the same commit, so this is the same
 * multisampling moved — except that it now resolves in *radiance* rather than
 * in display code values. That is a real difference here and in the right
 * direction: every silhouette in this frame is a near-black trunk against
 * bright air, which is the one case where averaging four sRGB-encoded samples
 * and averaging four lights give visibly different answers.
 *
 * The depth texture is the only reason the defocus can exist.
 * `resolveDepthBuffer` is what makes three blit the multisampled depth into
 * it; without it the texture is allocated, bound, sampled and empty, which
 * would read as "the defocus is too subtle to see" rather than as "the depth
 * is zero", and this project has lost a round to exactly that shape of
 * failure.
 */
export function makeSceneTarget(w: number, h: number): THREE.WebGLRenderTarget {
  const depth = new THREE.DepthTexture(w, h);
  depth.type = THREE.UnsignedIntType;
  depth.format = THREE.DepthFormat;
  depth.minFilter = THREE.NearestFilter;
  depth.magFilter = THREE.NearestFilter;

  const rt = new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    colorSpace: THREE.LinearSRGBColorSpace,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: false,
    depthBuffer: true,
    stencilBuffer: false,
    samples: 4,
    depthTexture: depth,
  });
  rt.texture.name = 'sceneHDR';
  rt.resolveDepthBuffer = true;
  return rt;
}

/* One triangle, not two.
 *
 * Two put a seam down the diagonal for anything reading derivatives, and this
 * pass reads `gl_FragCoord` for the grain and takes neighbour taps for the
 * defocus. */
export function fullscreenTriangle(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(
    new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
  return g;
}
