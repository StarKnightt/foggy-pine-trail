/* The one atlas every living thing on the floor is cut out of.
 *
 * ── Colour space ──────────────────────────────────────────────────────────
 *
 * Same contract as `groundMaterials.ts`: every albedo written here is LINEAR,
 * because `bake.ts` renders into an sRGB8 target and the GPU encodes on write.
 * Read that file's header before touching a number in this one.
 *
 * Measured reference points for this system, all linear:
 *
 *   sword fern frond, wet, deep shade   0.019  0.031  0.017
 *   sword fern frond, crown edge        0.046  0.064  0.031
 *   salal blade, glossy, shade          0.026  0.038  0.023
 *   Oregon grape, bronzed               0.040  0.026  0.019
 *   dead frond, soaked                  0.048  0.037  0.022
 *   floor moss, deep shade              0.026  0.038  0.021
 *   floor moss, cushion crown           0.076  0.096  0.050
 *   needle drift over humus             0.031  0.026  0.018
 *   mushroom cap, buff                  0.078  0.060  0.037
 *
 * The critic's note on chroma is the constraint that set all of these: moss is
 * the only thing in the frame with any saturation at all, which is exactly why
 * a very small amount of it reads so strongly. Living moss in deep shade is
 * about 0.05 linear green, not the 0.3 that the word "green" suggests, and
 * every leaf here is *darker* than the moss rather than brighter. A sword fern
 * is a leathery evergreen under a closed canopy at 6am; it is very nearly
 * black, and the reference photographs agree.
 *
 * ── There is no normal map, and that is deliberate ────────────────────────
 *
 * Every other surface in this project bakes one. This one does not, and the
 * reason is env.ts: there is no directional source, so a normal perturbation
 * produces a shading change only through how much of the *dome* the perturbed
 * normal sees — and the dome is nearly uniform. On bark, where the relief is
 * 5 cm and the surface is a metre across, that is still worth 1.15x of
 * normalScale. On a leaf, where the relief is a 0.4 mm midvein, it is worth
 * nothing measurable, and it would cost a 2048² texture, a bake pass and a
 * fetch per fragment on the surface with the highest overdraw in the frame.
 *
 * What actually shades a leaf here is (a) the geometric normal of the card,
 * which the builders cup and twist, and (b) occlusion. So the venation, the
 * cushion cavities and the gaps between pinnae go into the AO channel of the
 * aux map instead, where they attenuate diffuse and specular together — which
 * is the only channel that does, and the lesson `treeMaterials.ts` paid for.
 *
 * ── One atlas, one material, one draw call family ─────────────────────────
 *
 * Twelve cells in a 4x4 grid. Ferns, shrub leaves, moss cushions, litter
 * drift, mushrooms and stems all come out of the same two textures, so the
 * whole system draws with one material and the per-tile buckets below are the
 * only thing that multiplies calls.
 *
 * Two textures rather than three: albedo with alpha at 2048, and an aux map at
 * 1024 packing r = occlusion, g = roughness, b = translucency. The aux map is
 * bound into both `roughnessMap` and `aoMap`, which is the same trick the ORM
 * sets use — three reads .g from one and .r from the other, so one sampler
 * serves both slots.
 */
import * as THREE from 'three';
import { bakeImage } from '@/world/bake';

/* Cell indices. Row 0 is the bottom of the texture, because `bakeImage` draws
 * a full-screen quad and `PlaneGeometry` puts uv (0,0) at the bottom left. The
 * geometry builders import these, so the two cannot drift. */
export const CELL = {
  fernA: 0,
  fernB: 1,
  fernDead: 2,
  deerFern: 3,
  mahonia: 4,
  salal: 5,
  mossA: 6,
  mossB: 7,
  litter: 8,
  shroom: 9,
  stem: 10,
} as const;

export const ATLAS_GRID = 4;

/** uv origin of a cell, for the geometry builders. */
export function cellUv(id: number): { u0: number; v0: number; span: number } {
  return {
    u0: (id % ATLAS_GRID) / ATLAS_GRID,
    v0: Math.floor(id / ATLAS_GRID) / ATLAS_GRID,
    span: 1 / ATLAS_GRID,
  };
}

/* How much of a cell the artwork is allowed to use.
 *
 * The remaining border has to be genuinely empty, because the albedo carries a
 * mip chain and by mip 4 a 512-texel cell is 32 texels — at which point a
 * frond tip three texels from the cell edge has bled into the neighbouring
 * cell's alpha and a distant fern grows a rectangular halo of whatever is
 * stored next to it. 4% is two texels at mip 3, which is the coarsest level
 * anything in this scene is ever sampled at before the fog has taken it. */
const MARGIN = 0.04;

const HELP = /* glsl */ `
uniform float uChannel;
const float GRID = ${ATLAS_GRID.toFixed(1)};
const float MARG = ${MARGIN.toFixed(3)};

float h11(float x){ return fract(sin(x * 91.3458) * 47453.5453); }

/* Antialiased "inside", in cell units. Everything here is a distance in the
 * same units as q, so one constant width serves every cell. */
float edge(float d){ return 1.0 - smoothstep(0.0, 0.0045, d); }

/* ── The pinnate frond ────────────────────────────────────────────────────
 *
 * Sword fern is the species this whole system is built around and the frond is
 * the one shape that has to be right, so it is generated rather than drawn.
 *
 * Measured from the references: fronds 50-180 cm long with 60-100 pinnae, the
 * petiole an eighth to a quarter of the total length, the largest pinnae
 * 3-15 cm, and — the identifying feature — a forward-pointing thumb (the
 * auricle) at the base of every pinna.
 *
 * The construction is a lattice in the rachis frame rather than a loop over
 * leaflets, which is what keeps it to one branch per texel however many pinnae
 * there are. For a point at outward distance 'a' along a pinna and 'b' metres
 * up the rachis, the pinna that owns it is the one whose base is at
 * b - rake*a: shifting first and taking the modulo second gives a field of
 * pinnae that rake towards the tip and overlap their neighbours, with no gaps
 * and no per-leaflet iteration.
 *
 * The rake is large and it has to be. A real pinna leaves the rachis at about
 * 60 degrees, so over its 10 cm of reach it advances nearly 6 cm along a rachis
 * whose pinna pitch is 2.3 cm — every pinna overlaps the two or three above it,
 * which is precisely why a sword fern frond reads as a solid blade with a
 * toothed edge rather than as a comb.
 *
 * Returns, through its out parameters:
 *   cov    coverage, antialiased
 *   out    distance along the pinna, 0 at the rachis and 1 at its tip
 *   vein   1 on a midvein, falling off across the leaflet
 *   pid    per-pinna hash, so no two are the same tone
 *   rach   1 on the rachis and petiole
 */
void frond(vec2 q, float seed,
           float W, float nPin, float auric, float teeth, float blunt,
           float petF, float torn,
           out float cov, out float outw, out float vein, out float pid, out float rach)
{
  cov = 0.0; outw = 0.0; vein = 0.0; pid = 0.0; rach = 0.0;

  float v = (q.y - MARG) / (1.0 - 2.0 * MARG);
  float x = q.x - 0.5;
  if (v < 0.0 || v > 1.0) return;

  /* The rachis, and the petiole under it. A frond with no spine has a visible
   * empty line down its middle wherever the pinnae rake apart, and the petiole
   * is also the only part of a senesced frond that is still rigid. */
  float rw = mix(0.0135, 0.0030, sqrt(v)) * (0.45 + 0.55 * W / 0.46);
  rach = edge(abs(x) - rw) * step(v, 0.995);

  float s = (v - petF) / (1.0 - petF);
  if (s < 0.0) { cov = rach; outw = 0.0; return; }

  /* Blade envelope. Widest at about a third of the way up and tapering to a
   * long point, which is the outline the word "sword" is describing. A single
   * sine lobe puts the widest point at the middle and leaves a blunt tip; the
   * two-sided power does not. */
  float env = W * 2.06 * pow(s, 0.35) * pow(max(0.0, 1.0 - s), 0.90);
  env = max(env, rw);

  float ax = abs(x);
  float a = ax / max(env, 1e-4);

  /* Pinna pitch, and the alternation. Pinnae are not opposite: one side is
   * offset half a pitch from the other, and a frond built with paired pinnae
   * reads as a fish skeleton. */
  float p = (1.0 - petF) / nPin;
  float sideSign = x < 0.0 ? -1.0 : 1.0;
  float bAxis = (v - petF) - (sideSign < 0.0 ? 0.5 * p : 0.0);

  /* Rake, in pitches per unit of outward reach. Grows towards the frond tip:
   * basal pinnae stand nearly square to the rachis and apical ones sweep
   * forward almost parallel to it, and that progression is most of what makes
   * a frond read as having grown from one end. */
  float rake = (1.6 + 1.9 * s) * p;
  float bShift = bAxis - rake * a;
  float n = floor(bShift / p);
  float b = (bShift - (n + 0.5) * p) / p;

  pid = h11(n * 3.77 + sideSign * 17.3 + seed);
  float pid2 = h11(n * 8.13 - sideSign * 5.9 + seed * 2.1);

  /* Each pinna is a little shorter or longer than its neighbours, and roughly
   * one in thirty is missing — grazed off, or never developed. An intact rank
   * of identical teeth is the "comb" read. */
  float len = 0.84 + 0.30 * pid;
  if (pid2 > 0.985 - torn) len = 0.0;

  /* The leaflet outline in its own frame: half-width across the pinna as a
   * function of distance out along it. "blunt" interpolates from the narrowly
   * acuminate pinna of a sword fern to the broad blunt oblong of a deer fern. */
  float an = a / max(len, 1e-4);
  float hb = 0.50 * pow(max(0.0, 1.0 - pow(an, mix(1.7, 2.8, blunt))),
                        mix(0.58, 0.42, blunt));

  /* Spinulose teeth along the margin. Sword fern's specific epithet means
   * "armed with teeth" and at 2 mm a texel they are just resolvable, which is
   * worth having: a smooth-edged pinna is the difference between this and a
   * generic fern. */
  hb *= 1.0 + teeth * sin(an * 33.0 + pid * 6.2831);

  /* The auricle. A thumb-sized lobe on the tip side of every pinna base, and
   * the single most reliable field mark separating sword fern from everything
   * else that grows beside this trail. Asymmetric by construction — adding it
   * to both sides gives a bulge, which is a different plant. */
  float hbP = hb + auric * exp(-pow((an - 0.15) / 0.11, 2.0));
  float lim = b > 0.0 ? hbP : hb;

  float inPinna = edge(an - 1.0) * edge(abs(b) - lim) * step(0.001, len);
  cov = max(rach, inPinna);
  outw = clamp(an, 0.0, 1.0);
  /* Midvein down each pinna, plus the shoulder where it meets the rachis. Goes
   * into occlusion rather than into a normal map — see the header. */
  vein = inPinna * (1.0 - smoothstep(0.0, 0.16, abs(b)));
}

/* ── A simple blade ───────────────────────────────────────────────────────
 *
 * Salal, and by rescaling, huckleberry. Thick, leathery, ovate, finely
 * serrate, with a strongly impressed net of veins — the venation is the whole
 * reason a salal leaf is recognisable, because the blade itself is a plain
 * oval and the veins are pressed deep enough to catch light along their edges.
 */
void blade(vec2 q, float seed, float W, float tipK,
           out float cov, out float rad, out float vein, out float mid)
{
  cov = 0.0; rad = 0.0; vein = 0.0; mid = 0.0;
  float v = (q.y - MARG) / (1.0 - 2.0 * MARG);
  float x = q.x - 0.5;
  if (v < 0.0 || v > 1.0) return;

  /* Ovate: broadest below the middle, drawn to a short point. The base is
   * rounded rather than tapered, which is what makes it a leaf on a short
   * petiole rather than a lance. */
  float env = W * 2.24 * pow(max(0.0, v), 0.42) * pow(max(0.0, 1.0 - v), tipK);
  /* Serrations. Salal's margin is finely and bluntly toothed, about one tooth
   * a centimetre, and it is a low-amplitude modulation rather than a spike. */
  env *= 1.0 + 0.035 * sin(v * 78.0 + seed * 6.2831);

  float ax = abs(x);
  cov = edge(ax - env);
  rad = clamp(ax / max(env, 1e-4), 0.0, 1.0);
  mid = cov * (1.0 - smoothstep(0.0, 0.035, ax));

  /* Secondary veins, arching from the midrib towards the tip and running out
   * to the margin. Six or seven pairs, and they curve — a straight herringbone
   * is a fig leaf, not a salal one. */
  float arc = v - 0.30 * rad * rad - 0.08 * rad;
  float sec = abs(fract(arc * 7.0 + 0.5) - 0.5) * 2.0;
  vein = cov * (1.0 - smoothstep(0.0, 0.30, sec)) * smoothstep(0.04, 0.22, rad)
              * (1.0 - smoothstep(0.86, 1.0, rad));
  vein = max(vein, mid);
}

/* ── A cushion of moss ────────────────────────────────────────────────────
 *
 * Alpha-cut with a genuinely torn edge, because this is the thing that has to
 * cover the trunk-to-ground line and a mat with a smooth outline reads as a
 * disc of green laid on the floor. The tear is two octaves so it has both a
 * lobe size and a ragged sub-lobe.
 *
 * The cushion structure itself is the same observation groundMaterials.ts
 * records: a moss carpet is a pile of discrete domes, near black in the gaps
 * between them and pale on the crowns, and that four-to-one value range across
 * a few centimetres is most of what identifies it.
 */
void cushion(vec2 q, float seed, float reach,
             out float cov, out float dome, out float fuzz, out float rim)
{
  vec2 c = q - 0.5;
  float r = length(c);
  float th = atan(c.y, c.x);
  /* Two incommensurate angular rates. A single one gives a starfish; this
   * gives a patch with bays and peninsulas in it. */
  float wob = 0.17 * sin(th * 3.0 + seed * 6.28)
            + 0.11 * sin(th * 5.0 - seed * 4.1)
            + 0.08 * sin(th * 9.0 + seed * 11.7);
  /* The high-order term carries most of the read and it is worth more than the
   * lobes are. A mat with only low-order wobble on it is a rounded blob at any
   * size, and magnified against the duff that is exactly what the first cut
   * looked like: a disc of pale green laid on the floor. What a real colony
   * has at its margin is individual shoots and runners a centimetre long. */
  float shred = 0.085 * pnoise(vec2(cos(th), sin(th)) * 11.0 + seed * 13.0, vec2(4096.0))
              + 0.045 * pnoise(vec2(cos(th), sin(th)) * 27.0 - seed * 5.0, vec2(4096.0));
  cov = edge(r - reach * (1.0 + wob + shred));

  vec2 p = q * 8.0;
  /* 12 cycles across the cell, not 5.5. A mat is placed at anything from 34 cm
   * to 80 cm across, so the coarser field put 7-15 cm cushions on it — three
   * times life size, and at that scale the structure stops reading as a pile of
   * domes and starts reading as a stain with soft blotches in it. */
  dome = unit(pfbm(p * 12.0 + seed * 7.0, vec2(4096.0), 3));
  fuzz = unit(pfbm(p * 26.0 + seed * 3.0, vec2(4096.0), 3));
  rim = cov * smoothstep(0.72, 1.0, r / max(reach, 1e-4));
}
`;

const CELLS = /* glsl */ `
/* Frond colour, shared by the three ferns and the dead one.
 *
 * The ramp runs from the shaded underside of the crown to a pinna tip out at
 * the edge of the rosette, and both ends are dark.
 *
 * ── The blue-green correction ─────────────────────────────────────────────
 *
 * These were authored at G/R 1.6 and G/B 1.9, described as "a very desaturated
 * yellow-green". Once the exposure was fixed and the crowns came up out of the
 * black, that hue rendered as pale mint — the colour of new spring growth in
 * sun, and the first thing a viewer walking the scene objected to.
 *
 * G/B 1.9 is the error and it is a specific one. Chlorophyll absorbs in the red
 * *and* in the blue, with a trough in each: a green leaf's spectral reflectance
 * runs about 5% red, 15% green, 5% blue, so blue and red come out within a few
 * per cent of one another and the leaf is neutral-green, not yellow-green.
 * Setting B to two thirds of R subtracts blue from a surface that reflects as
 * much blue as red, which is the definition of making it yellower. Yellow-green
 * at high value is mint.
 *
 * What makes a shaded wet frond read *cool* is not the albedo, it is the
 * illuminant: the dome is (0.470, 0.508, 0.545) and the near air is bluer still,
 * so a leaf with B equal to R renders cool without being authored cool. And wet
 * is darker, not lighter — a water film fills the surface microstructure, kills
 * the diffuse first-surface scatter and sends that energy into a specular lobe
 * instead, so the diffuse comes down while the sheen comes up. Both moves are
 * below: R down, B up to meet it, G up a little to hold the value the review
 * asked for, and the roughness down to pay for it in gloss.
 */
vec3 frondColour(float outw, float pid, float age, float dead){
  vec3 shade = vec3(0.0163, 0.0316, 0.0180);
  vec3 lit   = vec3(0.0332, 0.0662, 0.0362);
  /* Older fronds in a crown are yellower and duller, not browner: a sword fern
   * frond lives several years and greys through the middle of its life before
   * it dies back from the tip. This is the one place the yellow belongs. */
  vec3 old   = vec3(0.0355, 0.0520, 0.0245);
  vec3 c = mix(shade, lit, clamp(0.30 + 0.62 * pid + 0.24 * outw, 0.0, 1.0));
  c = mix(c, old, age);
  /* Dead tissue: soaked, mid brown, and the *only* warm note in the
   * undergrowth. A crown always carries a skirt of these and they are what
   * stops the mass being one colour. */
  vec3 rot = mix(vec3(0.0330, 0.0245, 0.0150), vec3(0.0575, 0.0440, 0.0255), pid);
  return mix(c, rot, dead);
}

void cellShade(float id, vec2 q, out vec3 alb, out float alpha,
               out float ao, out float rough, out float trans)
{
  alb = vec3(0.0); alpha = 0.0; ao = 1.0; rough = 0.9; trans = 0.0;

  /* ── Sword fern, two green cuts and one dead one ──────────────────────
   *
   * Three cells rather than one because a rosette is fifteen fronds seen at
   * once at two metres, and the eye matches two identical outlines in that
   * situation immediately. The dead cut also has to exist separately: every
   * real crown wears a collapsed skirt of last year's brown fronds lying flat
   * on the litter, and without it a fern is a shop plant. */
  if (id < 2.5) {
    float dead = id > 1.5 ? 1.0 : 0.0;
    float seed = id * 21.7 + 3.3;
    float cov, outw, vein, pid, rach;
    /* Cut two: fewer, longer pinnae and a heavier tear rate, which reads as an
     * older frond from a shadier crown. */
    float second = (id > 0.5 && id < 1.5) ? 1.0 : 0.0;
    frond(q, seed,
          0.455 - 0.035 * second,        // blade half-width in cell units
          mix(34.0, 27.0, second + dead * 0.5),
          0.115,                         // the auricle
          0.085,                         // spinulose teeth
          0.0,                           // acuminate, not blunt
          0.155,                         // petiole, an eighth of the frond
          0.010 + 0.030 * second + 0.055 * dead,
          cov, outw, vein, pid, rach);
    if (cov <= 0.001) return;
    alpha = cov;
    float age = dead > 0.5 ? 0.0 : (0.18 + 0.55 * second) * pid;
    alb = frondColour(outw, pid, age, dead);
    /* The rachis is paler and much less green than the blade — it is straw
     * with brown scales on it, and on a dead frond it is the last thing left. */
    alb = mix(alb, mix(vec3(0.0420, 0.0330, 0.0205), vec3(0.0680, 0.0555, 0.0330), pid),
              rach * (0.55 + 0.35 * dead));
    /* Tips die back first, on live fronds as well as dead ones. */
    alb = mix(alb, alb * vec3(1.35, 0.92, 0.72), smoothstep(0.72, 1.0, outw) * 0.35);

    /* Occlusion, and this is where the frond's value actually comes from.
     *
     * Three terms: the slot between two pinnae, which is a light trap two
     * leaflets deep; the midvein channel; and the shading of the inner third
     * of the blade, which is looking at the rest of its own frond. */
    ao = 0.52 + 0.40 * outw;
    ao *= 1.0 - 0.42 * vein;
    ao = mix(ao, ao * 0.80, 1.0 - smoothstep(0.0, 0.35, outw));
    /* Leathery and wet. An evergreen frond has a real cuticle, so it holds a
     * broad low sheen off the dome — which is nearly the only thing that says
     * these are wet rather than merely dark. */
    rough = mix(0.40, 0.66, pid);
    rough = mix(rough, 0.90, rach);
    rough = mix(rough, 0.94, dead);
    /* Thin tissue passes light. A sword fern pinna is leathery and passes
     * little, and a dead one passes almost none. */
    trans = (0.34 + 0.30 * outw) * (1.0 - 0.75 * dead) * (1.0 - rach);
    return;
  }

  /* ── Deer fern ─────────────────────────────────────────────────────────
   *
   * The other fern on this trail, and it is here for silhouette contrast
   * rather than for botany: its pinnae are broad, blunt and joined along the
   * rachis, so at four metres it is a solid narrow strap where the sword fern
   * is a toothed one. Two ferns with the same outline is one fern. */
  if (id < 3.5) {
    float cov, outw, vein, pid, rach;
    frond(q, 47.1,
          0.235,        // much narrower
          40.0,
          0.0,          // no auricle
          0.02,
          1.0,          // blunt oblong pinnae
          0.085,        // and a short petiole — deer fern tapers to its base
          0.012,
          cov, outw, vein, pid, rach);
    if (cov <= 0.001) return;
    alpha = cov;
    alb = frondColour(outw, pid, 0.10 * pid, 0.0) * 1.06;
    alb = mix(alb, vec3(0.0430, 0.0385, 0.0255), rach * 0.5);
    ao = 0.50 + 0.42 * outw;
    ao *= 1.0 - 0.38 * vein;
    rough = mix(0.50, 0.74, pid);
    trans = 0.46 + 0.28 * outw;
    return;
  }

  /* ── Oregon grape ──────────────────────────────────────────────────────
   *
   * Mahonia nervosa: an upright pinnate leaf of nine to fifteen holly-like
   * leaflets, thick and glossy, with a few of them turned bronze-red. It is
   * built from the same generator with the pitch opened right out, so the
   * leaflets are separate objects with sky between them rather than a
   * continuous blade — which is the difference between this and a fern seen at
   * three metres. */
  if (id < 4.5) {
    float cov, outw, vein, pid, rach;
    frond(q, 88.9,
          0.400,
          6.5,          // six leaflets a side, widely spaced
          0.0,
          0.30,         // deep spine teeth, the holly margin
          0.65,
          0.190,
          0.008,
          cov, outw, vein, pid, rach);
    if (cov <= 0.001) return;
    alpha = cov;
    /* Dark, and only just green. Mahonia in shade is nearly black-green with a
     * hard cuticle, and it is the darkest foliage on this floor. */
    vec3 leaf = mix(vec3(0.0125, 0.0250, 0.0150), vec3(0.0250, 0.0480, 0.0270), pid);
    /* One leaflet in five has gone bronze. It is a tiny area of the frame and
     * it is the only red in the scene, so it stays well under the moss in
     * chroma — this is a hue that has to be found rather than noticed. */
    float bronze = smoothstep(0.80, 0.94, pid);
    leaf = mix(leaf, vec3(0.0400, 0.0262, 0.0192), bronze * 0.85);
    alb = leaf;
    alb = mix(alb, vec3(0.0330, 0.0270, 0.0180), rach * 0.7);
    ao = 0.56 + 0.36 * outw;
    ao *= 1.0 - 0.34 * vein;
    /* The glossiest thing in the undergrowth. */
    rough = mix(0.34, 0.52, pid);
    rough = mix(rough, 0.92, rach);
    trans = 0.14;
    return;
  }

  /* ── Salal ─────────────────────────────────────────────────────────────── */
  if (id < 5.5) {
    float cov, rad, vein, mid;
    blade(q, 5.31, 0.310, 0.30, cov, rad, vein, mid);
    if (cov <= 0.001) return;
    alpha = cov;
    vec2 p = q * 8.0;
    float mottle = unit(pfbm(p * 3.2 + 19.0, vec2(4096.0), 3));
    vec3 c = mix(vec3(0.0170, 0.0318, 0.0196), vec3(0.0318, 0.0542, 0.0332), mottle);
    /* Blotches. Salal in a wet forest is always spotted with leaf fungus, in
     * hard-edged patches a few millimetres across, and it is the one thing that
     * stops a field of identical ovals reading as printed. */
    float spotN = unit(pfbm(p * 11.0 + 61.0, vec2(4096.0), 2));
    float spot = smoothstep(0.70, 0.80, spotN);
    c = mix(c, vec3(0.0390, 0.0300, 0.0190), spot * 0.55);
    /* Veins are paler than the blade and stand slightly proud of it; between
     * them the lamina is quilted down into the shade. */
    alb = mix(c, c * 1.34, vein * 0.9);
    /* Everything below the mix is the "green balls sitting on the ground"
     * report, and the first two attempts at it were both wrong in ways worth
     * recording because the second one was wrong silently.
     *
     * The object is a salal leaf -- proved by tinting this cell magenta and
     * finding every disc in the frame turn with it, after ?ug=nomats had
     * ruled out the moss cushions, whose cushion() dome shading was the
     * obvious suspect. The reading was not a shading gradient either: the
     * radial luma profile across one of the offending leaves at 3.2 m measures
     * 84 82 83 81 83 from centre to rim, a ratio of 1.01. It is already flat.
     *
     * It reads as a ball because it is *featureless*. A uniform green oval with
     * no internal structure has nothing in it that says which way the surface
     * faces, and the eye's prior for a smooth uniform blob is a sphere. The
     * venation this cell already computes was not surviving to the screen: at
     * three metres the leaf is thirty pixels across and a 1.34x vein tint on a
     * mottled ground is under a code value once the fog has veiled it.
     *
     * So the structure goes in hard and it goes in the albedo. A midrib is the
     * whole of the cue -- it is a single line with a direction, and a sphere
     * cannot have one. The margin darkening does the other half: a defined edge
     * contradicts a terminator, and salal really does carry a darker, often
     * slightly bronzed rim. Note the occlusion channel below was tried first
     * and moved exactly zero pixels on the leaf it was aimed at, so this cell's
     * occlusion output is reaching nothing the near-field render can see. */
    alb = mix(alb, alb * 1.62, mid);
    alb = mix(alb, alb * vec3(0.72, 0.60, 0.62), smoothstep(0.86, 1.0, rad));
    ao = 0.80 + 0.12 * (1.0 - rad);
    ao *= 1.0 - 0.42 * (1.0 - vein) * smoothstep(0.05, 0.5, rad);
    ao *= 1.0 - 0.30 * mid;
    /* Thick cuticle. Salal is the shiniest leaf out here and under a bright
     * dome that sheen is a broad soft highlight across the whole blade — which
     * is the single most useful "everything is soaking wet" cue the undergrowth
     * has, because it comes from the environment rather than from a paint. */
    /* Raised from 0.30-0.46. At the old gloss the dome highlight was a single
     * broad soft blob centred on the blade, which is the second sphere cue on
     * top of the radial occlusion above; widening the lobe spreads it to the
     * margins where a flat wet leaf actually carries it. */
    rough = mix(0.34, 0.52, mottle);
    rough = mix(rough, 0.74, spot);
    trans = 0.22 * (1.0 - 0.5 * spot);
    return;
  }

  /* ── Moss cushions ─────────────────────────────────────────────────────
   *
   * Two cuts, used both as the collar banked against a trunk and as free mats
   * on the duff. This is the cell that closes the critic's hardest complaint —
   * the trunk/ground intersection being a hard line with no moss collar and no
   * partial burial — so its edge quality matters more than its interior. */
  if (id < 7.5) {
    float second = id > 6.5 ? 1.0 : 0.0;
    float cov, dome, fuzz, rim;
    cushion(q, 3.1 + second * 9.4, 0.40 + 0.055 * second, cov, dome, fuzz, rim);
    if (cov <= 0.001) return;
    alpha = cov;
    /* Cool grey-green, low chroma, and mottled hard between the two stops.
     * groundMaterials.ts has the argument for the hue; this is the same
     * organism a few centimetres off the floor, so it is a shade lighter than
     * the floor mat and no more. */
    float tone = clamp(contrast(dome, 2.0) * 0.78 + fuzz * 0.32 - 0.06, 0.0, 1.0);
    alb = mix(vec3(0.0235, 0.0350, 0.0192), vec3(0.0630, 0.0800, 0.0425), tone);
    /* Dead brown at the base of the cushions, which is what stops it being
     * green felt — a moss mat is only alive in its top centimetre. */
    alb = mix(alb, vec3(0.0430, 0.0330, 0.0215), (1.0 - dome) * 0.34);
    /* Needles caught in the pile. Every moss mat under a conifer is half
     * litter, and the mat at the foot of a trunk is more than half. */
    float caught = smoothstep(0.76, 0.90, unit(pfbm(q * vec2(38.0, 9.0) + 71.0, vec2(4096.0), 2)));
    alb = mix(alb, vec3(0.0345, 0.0280, 0.0185), caught * 0.55);

    /* The strongest occlusion in the system. A cushion carpet is a light trap
     * and the gaps between the domes go nearly black; with no directional
     * light in the scene this map is the only place that can come from. */
    /* Floored at 0.46, not 0.30, and this is a correction rather than a taste
     * change. A cushion carpet is a light trap and the gaps between the domes
     * really do go nearly black — but this map's occlusion is multiplied by the
     * geometry's own, which for a mat lying in a closed stand is already down
     * around 0.5, and the two compounded put the whole mat at an eighth of the
     * dome. Magnified, the moss collars rendered as hard-edged black polygons
     * lying on a pale floor: correctly shaped, correctly placed, and reading as
     * holes cut in the ground rather than as the one chromatic thing in the
     * frame. Surface cavities belong in this map; "this mat is in a closed
     * stand" belongs on the geometry, and it was being paid for twice. */
    /* Wide again — 0.34 to 0.96 — after the first correction overshot.
     *
     * Raising the floor to 0.46 fixed the black-polygon read and replaced it
     * with a worse one: with the range compressed to two thirds of a stop, the
     * cushion structure stopped being visible at all and a metre of mat came
     * back as a flat pale green patch, which is the algae-crust failure
     * that groundMaterials.ts names. The value that identifies moss is the
     * near-four-to-one range across a few centimetres, so the range has to stay
     * and the *product* with the geometry's own occlusion is what had to come
     * down — which it did, on the geometry side, where the statement "this mat
     * is lying in a closed stand" belongs. */
    ao = clamp(0.34 + 0.62 * contrast(dome, 2.2), 0.0, 1.0);
    ao *= 1.0 - 0.14 * (1.0 - fuzz);
    /* The torn rim is thin, so it is lit from both sides and is the *least*
     * occluded part of the mat. That gradient is what makes the edge read as a
     * fringe of shoots rather than as a cut. */
    ao = mix(ao, min(1.0, ao + 0.30), rim);
    rough = 0.96 - 0.05 * fuzz;
    trans = 0.30 * rim;
    return;
  }

  /* ── Needle drift ──────────────────────────────────────────────────────
   *
   * The apron of litter banked against everything that stands in a forest
   * floor. It is the second half of the trunk-base fix: moss takes the damp
   * side and the drift takes the rest, and between them there is no straight
   * line anywhere along the join.
   *
   * Needles rather than noise, for the reason groundMaterials.ts spends a
   * page on — but only one population and no per-cell direction, because a
   * drift *is* combed. Litter that has been pushed into a bank by rain running
   * off a bole lies along the contour, and here that alignment is the point
   * rather than the artefact. */
  if (id < 8.5) {
    float cov, dome, fuzz, rim;
    cushion(q, 17.7, 0.415, cov, dome, fuzz, rim);
    if (cov <= 0.001) return;
    alpha = cov;
    vec2 p = q * 8.0;
    float streak = unit(pfbm(p * vec2(2.4, 26.0) + 5.0, vec2(4096.0), 3));
    float streak2 = unit(pfbm(p * vec2(3.7, 41.0) + 33.0, vec2(4096.0), 2));
    float mat = clamp(streak * 0.66 + streak2 * 0.44 - 0.06, 0.0, 1.0);
    /* Doug-fir and hemlock litter: a dull olive-brown fresh, near black old,
     * and most of a real drift is at the old end. */
    alb = mix(vec3(0.0205, 0.0175, 0.0130), vec3(0.0640, 0.0520, 0.0320), pow(mat, 1.5));
    /* Bark flakes and cone scales caught in it, which are the warmest and
     * chunkiest things down here. */
    float flakeId = pworleyId(p * 5.0 + 29.0, vec2(4096.0));
    vec2 flakeD = pworley(p * 5.0 + 29.0, vec2(4096.0));
    float flake = step(0.86, flakeId) * (1.0 - smoothstep(0.14, 0.21, flakeD.x));
    alb = mix(alb, vec3(0.0560, 0.0345, 0.0240), flake * 0.85);
    ao = clamp(0.44 + 0.50 * mat, 0.0, 1.0);
    ao *= 1.0 - 0.24 * flake;
    rough = 0.92 - 0.06 * mat;
    trans = 0.0;
    return;
  }

  /* ── Mushrooms ─────────────────────────────────────────────────────────
   *
   * A whole troop in one cell, drawn from the side, because a mushroom is
   * three centimetres across and putting real geometry on it would cost more
   * than the entire fern population. Two crossed cards per cluster is four
   * triangles and at this size the parallax error is under a pixel.
   *
   * They are the palest objects in the frame by a wide margin, and that is
   * correct and is why they are worth having at all: everything else on this
   * floor is between 0.02 and 0.08 linear, and a buff cap at 0.08 with a
   * near-white stipe under it is the only small bright thing the eye can find.
   */
  if (id < 9.5) {
    float best = 0.0, bid = 0.0, bcap = 0.0, bgill = 0.0, bstem = 0.0;
    for (int i = 0; i < 6; i++) {
      float fi = float(i);
      float hx = h11(fi * 7.31 + 1.7);
      float hh = h11(fi * 3.19 + 5.3);
      float hr = h11(fi * 11.7 + 2.9);
      float cx = 0.16 + 0.68 * hx;
      /* Caps between a third and a full centimetre-scale button, sized against
       * a cell that maps to 9 cm of world: 1.5 to 4 cm across, which is the
       * range a Mycena or a small Hypholoma actually occupies. */
      float cr = 0.055 + 0.075 * hr;
      float ht = 0.20 + 0.42 * hh;
      float lean = (hx - 0.5) * 0.16;
      float dx = q.x - cx - lean * q.y / max(ht, 1e-3);
      /* Stipe: thin, slightly swollen at the base where it enters the litter. */
      float sr = cr * (0.15 + 0.10 * hh) * (1.0 + 0.9 * exp(-q.y / 0.06));
      float stem = edge(abs(dx) - sr) * step(0.02, q.y) * step(q.y, ht);
      /* Cap: a shallow dome sitting on the top of the stipe, with the rim
       * turned down. A flat disc reads as a nail head. */
      float ch = cr * (0.42 + 0.34 * hr);
      float dy = q.y - ht;
      float capW = cr * sqrt(max(0.0, 1.0 - pow(max(0.0, dy) / max(ch, 1e-4), 2.0)));
      float cap = edge(abs(dx) - capW) * step(0.0, dy) * step(dy, ch);
      /* The gill line under the rim, which is the darkest and most
       * identifying millimetre of a mushroom. */
      float gill = edge(abs(dx) - cr * 0.92) * step(-0.012, dy) * step(dy, 0.0);
      float m = max(max(stem, cap), gill);
      if (m > best) {
        best = m; bid = h11(fi * 13.1);
        bcap = cap; bgill = gill; bstem = stem;
      }
    }
    if (best <= 0.001) return;
    alpha = best;
    /* Buff to pale ochre, darker at the disc than the margin, which is how
     * nearly every small brown mushroom is coloured. */
    vec3 capC = mix(vec3(0.0620, 0.0470, 0.0285), vec3(0.0935, 0.0745, 0.0470), bid);
    vec3 stemC = mix(vec3(0.0740, 0.0690, 0.0555), vec3(0.1080, 0.1010, 0.0840), bid);
    alb = mix(stemC, capC, bcap);
    alb = mix(alb, vec3(0.0300, 0.0250, 0.0185), bgill);
    /* Fungal flesh is genuinely translucent at this thickness and it is the
     * one place a strong transmission term is physically right. */
    trans = 0.85 * bstem + 0.45 * bcap;
    ao = 1.0 - 0.55 * bgill - 0.20 * bstem;
    rough = mix(0.80, 0.62, bcap);
    return;
  }

  /* ── Stem ──────────────────────────────────────────────────────────────
   *
   * Salal's arching canes, which are red-brown and quite visible through the
   * leaves — a shrub drawn as floating foliage with no wood in it is the
   * commonest way undergrowth reads as a texture rather than as a plant. */
  if (id < 10.5) {
    float v = (q.y - MARG) / (1.0 - 2.0 * MARG);
    if (v < 0.0 || v > 1.0) return;
    float hw = mix(0.160, 0.075, v);
    float x = q.x - 0.5;
    alpha = edge(abs(x) - hw);
    if (alpha <= 0.001) return;
    float across = clamp(abs(x) / hw, 0.0, 1.0);
    float grain = unit(pfbm(q * vec2(3.0, 30.0), vec2(4096.0), 3));
    /* Muted from R/B 2.3 to 1.6. Salal canes are genuinely red, but this
     * albedo goes through the atlas GAIN and then through the look's saturation
     * restore, and what came out of the far end was a vivid orange rod -- the
     * only saturated warm object in a frame of green and grey, and read by the
     * review as plastic. Under a fog dome at two metres a wet cane is a dull
     * maroon-brown; the red is a cue you notice, not a colour you name. */
    alb = mix(vec3(0.0335, 0.0248, 0.0208), vec3(0.0228, 0.0182, 0.0160), grain);
    /* Lenticels, and a green flush on this year's growth at the tip. */
    alb = mix(alb, vec3(0.0330, 0.0400, 0.0245), smoothstep(0.72, 1.0, v) * 0.55);
    /* A cylinder drawn as a card only reads as round if the occlusion says so;
     * this is the whole of its cross-section. */
    ao = 0.42 + 0.52 * sqrt(max(0.0, 1.0 - across * across));
    rough = 0.62 + 0.24 * grain;
    trans = 0.0;
    return;
  }
}
`;

export const PLANT_ATLAS = HELP + CELLS + /* glsl */ `
/* Exposure correction, applied once at the funnel rather than at the fifty
 * places above that write an albedo or an occlusion.
 *
 * Every cell in this atlas was authored dark, and the reasoning is sound in
 * isolation and wrong in aggregate. env.ts states the conversion exactly: a
 * surface of albedo 0.08 under this dome lands at RGB 77 and one of 0.12 at
 * RGB 94. The green channel here was authored between 0.030 and 0.064, so a
 * fully unoccluded frond could not reach 60 no matter what else was right —
 * and then the *geometry* multiplied its own occlusion attribute on top of the
 * map's, and the crowns measured 25.9 against reference photographs of fogged
 * understory at 71, 87, 90 and 97.
 *
 * Two separate corrections, because they fix two separate errors:
 *
 * GAIN is the albedo. Sword fern in the green band reflects ten to fifteen per
 * cent, not four; the authored numbers were reading as reflectance in the *red*
 * band, where a leaf really is that dark, and applying that to all three
 * channels darkens and desaturates together. 2.55 puts the lit frond at 0.116
 * green, which is what env.ts costs out at RGB 90.
 *
 * LIFT compresses the map's occlusion towards one. Not to remove it — a light
 * trap between two pinnae is real and it is most of what says the crown has
 * depth — but because the same physical shadowing is now also carried by the
 * vertex attribute in Undergrowth.tsx, and the two multiplied to 0.30. At
 * 0.38 the map still spans 0.53 to 1.0 across a frond, which is a stop and a
 * half of internal modelling, and the product with the compressed attribute
 * lands near 0.7.
 */
const float GAIN = 2.55;
const float LIFT = 0.38;

vec4 shade(vec2 uv){
  vec2 g = uv * GRID;
  vec2 c = floor(g);
  float id = c.y * GRID + c.x;
  vec2 q = fract(g);
  vec3 alb; float alpha, ao, rough, trans;
  cellShade(id, q, alb, alpha, ao, rough, trans);
  if (uChannel < 0.5) return vec4(max(alb, 0.0) * GAIN, alpha);
  ao = mix(clamp(ao, 0.0, 1.0), 1.0, LIFT);
  return vec4(ao, clamp(rough, 0.02, 1.0), clamp(trans, 0.0, 1.0), alpha);
}
`;

export type PlantTextures = {
  /** Linear albedo in an sRGB8 target, alpha = coverage. */
  map: THREE.Texture;
  /** r = occlusion, g = roughness, b = translucency. */
  auxMap: THREE.Texture;
  dispose(): void;
};

/**
 * Bake the atlas.
 *
 * The albedo is 2048 and the aux is 1024, which is not a compromise. The
 * albedo's alpha is *thresholded*, so its resolution sets the quality of every
 * silhouette in the near field — and silhouette is the only thing fog leaves
 * intact. The aux is only ever sampled and averaged, so half the resolution
 * costs nothing visible and saves three quarters of its memory.
 *
 * At 2048 over a 4x4 grid a cell is 512 texels. A sword fern frond maps its
 * long axis across one cell, so a 1.1 m frond is 2.1 mm a texel and a 2.3 cm
 * pinna pitch is eleven texels — enough for the pinnae to survive two mip
 * levels, which is the point at which the fog has taken the plant anyway.
 */
export function bakePlants(renderer: THREE.WebGLRenderer): PlantTextures {
  const map = bakeImage(renderer, PLANT_ATLAS, {
    size: 2048, srgb: true, anisotropy: 8, uniforms: { uChannel: { value: 0 } },
  });
  const auxMap = bakeImage(renderer, PLANT_ATLAS, {
    size: 1024, srgb: false, anisotropy: 4, uniforms: { uChannel: { value: 1 } },
  });
  return {
    map,
    auxMap,
    dispose() { map.dispose(); auxMap.dispose(); },
  };
}
