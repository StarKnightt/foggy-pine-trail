/* The two surfaces the trail props are made of.
 *
 * Same colour-space rules as `groundMaterials.ts` and the same tiling contract
 * — every scale factor is a multiple of 1/8 so the period stays a whole number
 * of lattice cells. Read the header of that file before touching the numbers
 * here; in particular, these albedos are linear, and wet wood at 0.04 is not a
 * typing error.
 *
 * Measured reference points, all linear:
 *
 *   wet exposed root, shaded    0.075  0.056  0.038
 *   same root, boot-polished    0.185  0.148  0.098
 *   rotting stick, bark on      0.062  0.049  0.036
 *   wet basalt                  0.056  0.056  0.053
 *   crustose lichen on rock     0.128  0.132  0.112
 *   sheet moss in deep shade    0.042  0.060  0.038
 *   sheet moss, growing         0.098  0.124  0.074
 *
 * Every one of these roughly doubled when env.ts stopped metering the scene two
 * stops under. They are not a re-grade: the old set was chosen to survive an
 * exposure that was wrong, and against the corrected one it rendered the roots
 * and stones as holes cut in the floor — measurably darker than the duff either
 * side of them, which is the opposite of the reference photographs.
 *
 * The root numbers are the ones worth arguing about, because the instinct is
 * that wet wood is dark and the instinct is wrong for this particular piece of
 * wood. An exposed root on a used trail has had its bark stripped and its
 * surface burnished by boots, and burnished wood is *pale* — a polished crown is
 * the lightest thing on the whole trail surface, lighter than the bare mineral
 * soil. Set it at the 0.026 of bark in shade and every root in the frame renders
 * as a black ribbon lying on a brown floor, which is the shape of a root with
 * none of the substance.
 */
import * as THREE from 'three';
import { bakeSurface, type SurfaceSet } from '@/world/bake';

/* Exposed root and rotting branch.
 *
 * One surface for both, because they are the same thing at different ages and
 * because a second bake buys nothing the per-piece tint below cannot. The uv
 * arrives from `trailProps.ts` in metres divided by the patch, with v running
 * along the piece — so everything longitudinal is a stretch in v and
 * everything that wraps is in u.
 *
 * What has to be legible:
 *
 *   the grain      long, parallel, unbroken. Wood is the most directional
 *                  material in the frame and an isotropic noise on a cylinder
 *                  is instantly a cylinder.
 *   the checking   wood dries and splits *along* the grain, in a few deep
 *                  cracks rather than many shallow ones. Ridged noise
 *                  stretched hard on v.
 *   the sapwood    a root that has lost its bark is pale underneath, in
 *                  patches with torn edges, and that two-tone is most of what
 *                  makes it read as a root rather than as a pipe.
 */
export const WOOD = /* glsl */ `
void surf(vec2 uv, out vec3 albedo, out float height, out float rough, out float ao){
  vec2 p = uv * 8.0;
  vec2 per = vec2(8.0);

  /* Grain. 14:1 anisotropy — the fibres are metres long and a millimetre
   * across, and anything less than about ten to one reads as woodgrain
   * wallpaper rather than as wood. */
  vec2 aniso = vec2(4.0, 0.25);
  float grain = unit(pfbm(p * aniso, per * aniso, 4));
  vec2 fine = vec2(16.0, 0.5);
  float fibre = unit(pfbm(p * fine, per * fine, 3));

  /* Checking. Ridged noise inverted so the creases are the low places, and
   * squared so there are a few deep ones rather than a field of scratches. */
  vec2 ck = vec2(2.0, 0.125);
  float check = pridged(p * ck, per * ck, 3);
  check = pow(clamp(check, 0.0, 1.0), 4.0);

  height = grain * 0.42 + fibre * 0.26 - check * 0.62;

  /* Bark still attached, in patches. Where it has gone the sapwood shows, and
   * the boundary is torn rather than smooth — that is the smoothstep being
   * narrow on a high-octave field. */
  float barkN = unit(pfbm(p * vec2(0.75, 0.375), per * vec2(0.75, 0.375), 4));
  float bark = smoothstep(0.44, 0.56, barkN);

  /* Bark plates and the furrows between them.
   *
   * Douglas fir bark is thick, corky and deeply furrowed into elongated plates,
   * and without the furrows a root reads as pale plastic conduit however good
   * its colour is — the audit's phrase, and it is a texture complaint rather than
   * a colour one. worleyEdge with a low jitter is the right primitive here for
   * exactly the reason it is the wrong one for trail gravel: bark plates really
   * do tile a surface with straight-edged cells, and the furrow really is the
   * cell border. Stretched 6:1 along the grain, which is the way the plates run.
   */
  vec2 pl = vec2(3.0, 0.5);
  vec3 plate = worleyEdge(p * pl, per * pl, 0.42);
  float furrow = 1.0 - smoothstep(0.0, 0.16, plate.y - plate.x);

  /* Both ends brought down. The sapwood at 0.102 was the reason a fallen stick
   * read as a pale grey cylinder: exposed sapwood is only that bright when it is
   * *dry*, and nothing on this floor is dry. A soaked, weathered, part-rotted piece
   * of fir sits nearer 0.06, which is the figure at the top of this file for a
   * rotting stick with its bark on, and the header always said so. */
  vec3 wetWood = vec3(0.0405, 0.0310, 0.0225);
  vec3 sapwood = vec3(0.0620, 0.0480, 0.0320);
  /* Red-brown rather than the neutral grey-brown that was here. Doug fir bark is
   * distinctly warm, and it is one of the few things on this floor allowed any
   * chroma at all. */
  vec3 barkC   = vec3(0.0530, 0.0335, 0.0245);

  vec3 body = mix(sapwood, wetWood, grain);
  albedo = mix(body, barkC * (0.72 + 0.56 * plate.z), bark);
  // The furrows are deep, wet and nearly black, and they are most of the read.
  albedo *= 1.0 - 0.62 * furrow * bark;
  height -= furrow * bark * 0.55;

  // The checks are wet inside and full of dirt.
  albedo = mix(albedo, vec3(0.0300, 0.0232, 0.0168), check * 0.85);

  /* Algae. Anything lying on a coastal forest floor for two winters has a
   * green-black film on its upper surface. Tiny amount of chroma, and it is
   * the only thing keeping the wood from being a grey ramp. */
  float algae = smoothstep(0.52, 0.86, unit(pfbm(p * vec2(1.375, 0.75), per * vec2(1.375, 0.75), 3)));
  albedo = mix(albedo, vec3(0.0380, 0.0490, 0.0300), algae * 0.55);

  rough = 0.86 - grain * 0.08;
  rough = mix(rough, 0.96, bark * 0.7);
  rough = mix(rough, 0.55, check * 0.4);
  rough = mix(rough, 0.90, algae * 0.5);

  /* Floored at 0.38 where it was 0.60, and this is where the props' value problem
   * actually lives.
   *
   * A 10x cut to the wood albedo moved the rendered stick by almost nothing, which
   * looked at first like a dead code path and is not: it is that occlusion, not
   * albedo, is what sets value in a scene lit entirely by indirect light. An AO map
   * scales only the indirect terms, and when every photon is indirect that makes AO
   * the whole exposure control. The ground reaches its measured luma 46 through an
   * AO floor of 0.34 on an albedo of 0.072; the wood sat at luma 65-74 on an albedo
   * of 0.05-0.068 purely because its floor was 0.60. The two have to be set together
   * or the props float off the surface they are lying on however carefully their
   * colours are matched. */
  ao = clamp(0.38 + 0.58 * unit(height), 0.0, 1.0);
  ao *= 1.0 - check * 0.42;
  ao *= 1.0 - furrow * bark * 0.52;
}
`;

/* Stone.
 *
 * Wet basalt with a granite fraction. Very little colour and very little
 * value range — the legibility of a rock in this scene comes from its facets
 * and its occlusion, not from its texture, and a high-contrast rock map fights
 * the flat shading rather than supporting it.
 *
 * The lichen is the exception and is worth the trouble: crustose lichen grows
 * as hard-edged pale discs a few centimetres across, and it is the one thing
 * that says "this rock has been here for thirty years" rather than "this rock
 * was generated".
 */
export const STONE = /* glsl */ `
void surf(vec2 uv, out vec3 albedo, out float height, out float rough, out float ao){
  vec2 p = uv * 8.0;
  vec2 per = vec2(8.0);

  float mottle = unit(pfbm(p * 1.375, per * 1.375, 4));
  float speck  = unit(pfbm(p * 9.0, per * 9.0, 3));
  // Vesicles. Basalt is full of little gas bubbles and they are the only
  // relief on an unbroken face.
  vec2 ves = pworley(p * 14.0, per * 14.0);
  float pit = 1.0 - smoothstep(0.0, 0.22, ves.x);

  height = mottle * 0.30 + speck * 0.22 - pit * 0.55;

  /* Neutral-to-warm, not blue.
   *
   * The previous pair were cool — blue up in every channel relationship — and
   * on a floor where nothing else has a cool cast that made every stone in the
   * frame read as imported gravel. Trail stones are the parent material the soil
   * was made from and they are stained by a century of sitting in it, so their
   * hue has to sit beside the soil's rather than against it. */
  /* Warmer still, and with a wider value spread between the two. A near-neutral
   * pair 1.8x apart gave a field of identical mid-grey rocks that read as
   * faceted tents rather than as stones, because the only thing distinguishing
   * one from another was its silhouette. Real trail clasts vary in tone as much
   * as they vary in size — some are near-black wet andesite and some are pale
   * lahar rubble — and that population variance is what stops them looking
   * stamped from one mould. */
  /* The pale end pulled down by a third. It was set against a tread of luminance
   * 0.14-0.21 and the tread is now 0.072, so a 0.121 clast went from lighter-than-
   * soil to nearly twice the soil — bright confetti on dark ground, which is a
   * worse read than a uniformly pale floor because the eye forgives a wrong overall
   * level and does not forgive a wrong relationship. The population spread that
   * stops them looking stamped from one mould is preserved; it is the ceiling that
   * moves. */
  vec3 basalt  = vec3(0.0290, 0.0272, 0.0243);
  vec3 granite = vec3(0.0790, 0.0745, 0.0650);
  albedo = mix(basalt, granite, smoothstep(0.30, 0.78, mottle));
  // Feldspar grains. Barely brighter, and only visible because everything
  // around them is not.
  albedo = mix(albedo, albedo * 1.35, smoothstep(0.74, 0.92, speck) * 0.6);
  albedo = mix(albedo, albedo * 0.62, pit * 0.7);

  /* Lichen. Discs with hard rims, sparse, and pale for this scene — a lichen
   * crust is one of the few things out here that is genuinely light. */
  vec2 lc = pworley(p * 3.0, per * 3.0);
  float lid = pworleyId(p * 3.0, per * 3.0);
  float disc = step(0.70, lid) * (1.0 - smoothstep(0.20, 0.32, lc.x));
  float lichenFuzz = unit(pfbm(p * 22.0, per * 22.0, 2));
  vec3 lichenC = mix(vec3(0.0745, 0.0780, 0.0655), vec3(0.0920, 0.0940, 0.0800), lichenFuzz);
  albedo = mix(albedo, lichenC, disc * 0.88);
  height += disc * 0.16;

  /* Wet rock is smooth and picks up a broad sheen off the sky, which on a
   * facetted surface is what separates one facet from the next when there is
   * no directional light to do it. Lichen is dry and dead matte, and the
   * contrast between the two is most of the surface interest. */
  /* 0.56 rather than 0.40. Wet rock is smooth, but with an environment in the
   * scene 0.40 puts a legible reflection of the sky dome on every facet and the
   * stones came back looking chromed — the specular was carrying more of their
   * value than the albedo was. */
  /* Mottled rather than a uniform floor. 0.40 everywhere put a legible sky
   * reflection on every facet and the stones came back chromed; 0.56 everywhere
   * removed the sheen entirely and they came back chalky, which is the state the
   * audit found — no specular on any stone in eight frames. Wet rock is neither:
   * water beads and drains unevenly on a rough clast, so the crown of a boulder
   * carries genuinely low-roughness patches with matte ground between them, and
   * that patchiness is what reads as wet. */
  float film = smoothstep(0.42, 0.78, unit(pfbm(p * 2.75 + 33.0, per * 2.75, 3)));
  rough = 0.74 - 0.10 * mottle;
  rough = mix(rough, 0.26, film * 0.80);
  rough = mix(rough, 0.96, disc);
  rough = mix(rough, 0.82, pit * 0.5);

  ao = clamp(0.40 + 0.56 * unit(height), 0.0, 1.0);
  ao *= 1.0 - pit * 0.45;
}
`;

/* Moss, for the damp faces of the stones.
 *
 * Baked as its own set rather than tinted in, because moss and rock differ in
 * every channel: moss is the only chromatic thing in the frame, its normal is
 * a fine fuzz rather than facets, and it is the roughest surface here while
 * the wet rock under it is one of the smoothest. Mixing two full sets by a
 * vertex attribute is the same trick the ground uses and it costs one extra
 * sampler on a surface that covers a few percent of the frame.
 */
export const MOSS = /* glsl */ `
void surf(vec2 uv, out vec3 albedo, out float height, out float rough, out float ao){
  vec2 p = uv * 8.0;
  vec2 per = vec2(8.0);

  /* Shoots. Sheet moss is a carpet of upright stems a few millimetres apart,
   * and the eye reads it as a *velvet* — very high frequency, very low
   * contrast, with the depth coming from occlusion rather than from value. */
  float fuzz  = unit(pfbm(p * 30.0, per * 30.0, 3));
  float clump = unit(pfbm(p * 5.0, per * 5.0, 4));
  float sheet = unit(pfbm(p * 1.75, per * 1.75, 3));

  height = fuzz * 0.44 + clump * 0.40 + sheet * 0.16;

  vec3 shade = vec3(0.0420, 0.0600, 0.0380);
  vec3 lit   = vec3(0.0980, 0.1240, 0.0740);
  albedo = mix(shade, lit, clamp(clump * 0.55 + fuzz * 0.45, 0.0, 1.0));
  // Dead brown at the base of the clumps, which is what stops it reading as
  // green felt.
  albedo = mix(albedo, vec3(0.0520, 0.0400, 0.0260), (1.0 - clump) * 0.45);

  rough = 0.97 - fuzz * 0.04;
  /* Deep. A moss carpet is a light trap and this is the strongest occlusion
   * anywhere in the scene — but 0.30 was set against an exposure two stops down
   * and now crushes half of every mossed face to the same value. */
  ao = clamp(0.36 + 0.62 * clamp(height * 1.3, 0.0, 1.0), 0.0, 1.0);
}
`;

export type PropTextures = {
  wood: SurfaceSet;
  stone: SurfaceSet;
  moss: SurfaceSet;
  dispose(): void;
};

/**
 * Bake all three.
 *
 * Smaller than the ground's 1024 and it is not a compromise: the ground is
 * five hundred square metres of continuous surface and these are props a few
 * centimetres across seen from a metre and a half, so 512 over a 0.42 m patch
 * is 0.8 mm a texel — four times the ground's density.
 */
export function bakeProps(renderer: THREE.WebGLRenderer): PropTextures {
  const wood = bakeSurface(renderer, WOOD, {
    size: 512, patch: 0.42, bump: 0.006, anisotropy: 16,
  });
  const stone = bakeSurface(renderer, STONE, {
    size: 512, patch: 0.55, bump: 0.010, anisotropy: 16,
  });
  const moss = bakeSurface(renderer, MOSS, {
    size: 512, patch: 0.30, bump: 0.008, anisotropy: 16,
  });
  return {
    wood, stone, moss,
    dispose() { wood.dispose(); stone.dispose(); moss.dispose(); },
  };
}
