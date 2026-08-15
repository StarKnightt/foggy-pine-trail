/* The two surfaces the forest floor is made of, and the shader that blends
 * them.
 *
 * ── Colour space ──────────────────────────────────────────────────────────
 *
 * Every albedo written by a `surf` in this file is LINEAR radiance-reflectance,
 * because `bake.ts` renders into an sRGB8 target and the GPU encodes on write.
 * That is worth stating loudly, because the numbers look absurd otherwise: wet
 * conifer duff at 6am has a linear albedo around 0.03-0.07, which is a *sRGB*
 * value of about 60-90 out of 255. Typing 0.25 because it "looks brown" is how
 * a wet forest floor ends up looking like a dry sandpit, and it is the single
 * most common way a procedural scene loses its realism before a single light
 * has been placed.
 *
 * Measured reference points, all linear:
 *
 *   wet dark humus        0.022  0.018  0.015
 *   damp compacted dirt   0.080  0.066  0.048
 *   dried crust on tread  0.174  0.149  0.115
 *   weathered grey stone  0.101  0.097  0.086
 *   fresh-fallen needle   0.105  0.067  0.033
 *   old grey needle mat   0.062  0.057  0.048
 *   wet moss, shaded      0.048  0.064  0.045
 *   wet moss, growing     0.106  0.122  0.081
 *
 * This file used to cap everything at 0.13 and it was wrong to. The cap was a
 * compensation for env.ts metering the scene two stops darker than a camera
 * meters fog, and with that corrected the numbers here can be what the surfaces
 * actually are — which for exposed mineral soil and growing moss is 0.10-0.18.
 * What has not changed is that the frame must stay *muted*: it reads bright
 * because a hundred metres of illuminated air is in front of it, not because
 * anything in it is bright, and no albedo here has more chroma than a hue that
 * survives being told apart from grey.
 *
 * ── Everything is damp ────────────────────────────────────────────────────
 *
 * The brief asks for moisture and it is not a colour note, it is a roughness
 * note. Water fills the microscopic pits in a surface, which does two things a
 * grade cannot fake: it drops the roughness so the surface picks up a broad
 * sheen from the sky, and it darkens the albedo, because light that used to
 * scatter straight back out now bounces around inside the water film first.
 * Both are applied here from the same wetness mask so they cannot disagree,
 * and the mask is driven by the height field — water pools in the low places.
 */
import * as THREE from 'three';
import { bakeSurface, type SurfaceSet } from '@/world/bake';

/* Shared helpers, prepended to both bodies.
 *
 * `needle` is the important one and it is the reason this file is not just two
 * fbm calls. A conifer floor is not a noise field, it is a *mat of sticks* —
 * tens of thousands of 3-8 cm needles lying at every angle, overlapping in a
 * felted layer several centimetres deep. The eye reads that as high-frequency
 * detail with visible individual elements, and no amount of isotropic fbm
 * produces it.
 *
 * ── Why the lattice is square and the needle is rotated, not the reverse ──
 *
 * The obvious construction, and the one that shipped and failed, is to stretch
 * the Worley lattice on one axis so the cells become slivers, then rotate the
 * whole lattice and stack four of them at unrelated angles. It is cheap and it
 * looks right in isolation. What it produces on a floor is burlap.
 *
 * Two reasons, both structural rather than a matter of tuning. Every needle in
 * a layer points the same way, so a layer is a set of parallel stripes; four
 * layers at four angles is four sets of parallel stripes overlaid, and four
 * directions of stripe intersecting is the definition of a woven fabric. And
 * the needles in a layer sit on a stretched grid, so they line up end to end
 * along their own direction at exactly the cell pitch, which is the second
 * lattice the eye picks out. At the presented exposure none of this was
 * visible; two and a half stops up it was a regular diamond mesh over the
 * entire forest floor, with every streak the same length.
 *
 * So the lattice here is square and unrotated, cell pitch is roughly needle
 * length, and each cell picks its own direction from a hash. There is then no
 * shared direction to comb and no shared axis to line up along. It costs a 5x5
 * neighbourhood instead of 3x3, because a needle at a random angle can reach
 * further from its own cell than an axis-aligned one, and the previous 3x3
 * search was truncating needle ends — which is where the uniform streak length
 * partly came from as well.
 *
 * Coverage per layer is only about 6%, so a mat wants ten layers rather than
 * four. That is 250 cell evaluations per texel, which is a lot for a shader and
 * nothing for a one-off bake: it costs single-digit milliseconds behind the
 * load veil and buys the one thing that separates a litter texture from a
 * fabric swatch.
 *
 * ── Every lattice period here is a whole number ───────────────────────────
 *
 * `glsl.ts` states the tiling contract — scale p, scale the period by the same
 * factor — and satisfying it is necessary but not sufficient. The period that
 * comes out has to be a whole number of lattice cells, because the wrap is
 * `mod(cell, period)` and a period of 5.6 wraps cell 5 onto cell 5.6, which is
 * not a cell. The tile then has a hard discontinuity down two of its edges, and
 * since the ground derives its uv from world position the discontinuity repeats
 * across the entire floor — long straight lines, in a scene that contains no
 * other straight lines at all.
 *
 * The needle layers take their period directly as a cell count, so it is
 * integral by construction. The fbm and Worley scales are all multiples of
 * 0.125 against the base period of 8 for the same reason; some of them look
 * like odd numbers to have chosen (3.125, 2.625, 1.375) and they are the
 * nearest legal value to the one that was wanted.
 */
const HELP = /* glsl */ `
mat2 rot(float a){ float s = sin(a), c = cos(a); return mat2(c, -s, s, c); }

/* One population of lying needles.
 *
 *   cells     lattice pitch as a count across the tile, so it is integral
 *   wid       needle half-width in cell units
 *   presence  fraction of cells holding a needle; below 1 this is what makes
 *             the mat clump, since the caller varies it spatially
 *
 * Returns:
 *   x  coverage, 1 on the spine of a needle falling to 0 at its edge
 *   y  a per-needle hash, so each one gets its own tone and age
 *   z  position along the needle, -1 to 1, for tip darkening
 */
vec3 needle(vec2 p, float cells, float wid, float seed, float presence){
  vec2 g = p * (cells / 8.0);
  vec2 gp = vec2(cells);
  vec2 i = floor(g), f = fract(g);

  float best = 9.0; vec2 bc = vec2(0.0); float bal = 0.0;
  for (int y = -2; y <= 2; y++){
    for (int x = -2; x <= 2; x++){
      vec2 o = vec2(float(x), float(y));
      vec2 c = mod(i + o, gp) + seed;
      if (hash21(c + 3.17) > presence) continue;
      vec2 d = o + hash22(c) - f;
      /* Per-cell direction. This one line is the whole difference between a
       * needle mat and a woven texture. */
      float a = hash21(c + 7.71) * 6.2831853;
      vec2 u = vec2(cos(a), sin(a));
      float t = dot(d, u);
      float s = d.x * u.y - d.y * u.x;
      // Half-length varies 0.42 to 1.04 cells, so no two needles match.
      float L = 0.42 + 0.62 * hash21(c + 11.37);
      /* Bow. A fallen conifer needle is not a dead straight line: it develops a
       * longitudinal curl as it dries, and hemlock curves more than fir. A field
       * of perfectly straight segments is one of the things that made the mat
       * read as machine-made — the eye picks up on the absence of curvature well
       * before it picks up on any individual needle. Parabolic, centred so the
       * midpoint stays on the axis and both ends swing the same way. */
      float bow = (hash21(c + 13.91) - 0.5) * 0.30;
      s += bow * ((t / L) * (t / L) - 0.33) * L;
      float m = length(vec2(t / L, s / wid));
      if (m < best){ best = m; bc = c; bal = clamp(t / L, -1.0, 1.0); }
    }
  }
  float cov = 1.0 - smoothstep(0.52, 1.0, best);
  return vec3(cov, hash21(bc + 2.93), bal);
}

void needleTake(vec3 n, inout float cov, inout float id, inout float h, inout float along){
  h += n.x * 0.16;
  if (n.x > cov){ cov = n.x; id = n.y; along = n.z; }
}

/* The mat.
 *
 * Ten layers, the nearer needle winning, height accumulating — which is what
 * gives the felted layer its thickness rather than each needle sitting in its
 * own dimple. The five distinct cell counts are the needle size spread: at the
 * litter patch they run 4.6 cm to 11 cm, which is western hemlock through
 * Douglas fir and is what a mixed stand drops.
 *
 * The base cell count must be divisible by 8 so that every multiplier below
 * stays integral. widK converts a needle width in metres to cell units and
 * therefore depends on the caller's patch size, which is why it is a parameter.
 *
 * Unrolled rather than looped over a const array, because three compiles
 * ShaderMaterial as GLSL ES 1.00 unless told otherwise and array constructors
 * are a 3.00 feature. The failure mode is a link error at first draw, on a
 * material that looks fine in the source. */
/* One population of individually-placed stones.
 *
 * The lattice is used for *nothing but spacing*. The previous aggregate took
 * each stone's body from the distance to its Voronoi cell border, and that makes
 * occupancy, size and shape all consequences of one structure: every stone fills
 * its cell, so it has the cell's corners and its neighbours are hard against it
 * with matching edges. It rendered as smashed crockery, and a single clast split
 * into four pieces along shared straight edges is a signature nothing geological
 * produces. Nothing here reads the cell border. Radius, aspect, rotation and
 * outline wobble are four independent hashes, so a stone's shape says nothing
 * about where it happens to sit.
 *
 * Outline is an ellipse with two low-order lobes on it. Low order on purpose:
 * three and five cycles round the perimeter give a clast that is lumpy but has
 * no straight run and no corner anywhere, which is what water-worn glacial till
 * looks like. Anything above about seven cycles starts to read as fracture.
 *
 * Returns:
 *   x  distance normalised by that stone's own radius: 0 at the centre, 1 at
 *      the rim, and usable past 1 for the collar and the crease
 *   y  per-stone hash
 *   z  radius in cell units, so the caller can grade proudness by size
 */
vec3 stones(vec2 p, float cells, float seed, float occupancy,
            float rMin, float rMax, float rPow){
  vec2 g = p * (cells / 8.0);
  vec2 gp = vec2(cells);
  vec2 i = floor(g), f = fract(g);

  float best = 9.0, bid = 0.0, br = 1.0;
  for (int y = -1; y <= 1; y++){
    for (int x = -1; x <= 1; x++){
      vec2 o = vec2(float(x), float(y));
      vec2 c = mod(i + o, gp) + seed;
      if (hash21(c + 1.93) > occupancy) continue;
      /* Power law on the radius. Real clast populations are many small and few
       * large, and a uniform draw gives a field of mid-sized stones that all
       * look like siblings — which is the "uniform thickness, uniform value"
       * complaint in its size form. */
      float r = mix(rMin, rMax, pow(hash21(c + 6.41), rPow));
      vec2 d = o + 0.16 + 0.68 * hash22(c) - f;
      vec2 e = rot(hash21(c + 5.27) * 6.2831853) * d;
      e.x /= 0.70 + 0.60 * hash21(c + 9.13);
      float dn = length(e) / r;
      float th = atan(e.y, e.x);
      dn *= 1.0 + 0.11 * sin(th * 3.0 + hash21(c + 2.11) * 6.2831853)
               + 0.06 * sin(th * 5.0 + hash21(c + 4.73) * 6.2831853);
      if (dn < best){ best = dn; bid = hash21(c + 3.59); br = r; }
    }
  }
  return vec3(best, bid, br);
}

/* Boot prints.
 *
 * On a damp but unsaturated tread a print is *compaction*, not displacement:
 * 2-6 mm deep, crisp-edged, lug pattern legible, and no raised rim, because
 * almost no material moves. That also makes each one a sealed low spot in a
 * low-permeability surface, so prints hold water for hours and carry the
 * darkest and glossiest pixels on the trail.
 *
 * Three overlapping ages rather than a scatter of clean isolated ones. A trail
 * that has been walked holds fresh prints stamped over half-dissolved older
 * ones, and isolated crisp prints read as a stamp tool.
 *
 * Returns:
 *   x  print interior, 1 inside falling off at the rim
 *   y  lug bars within the interior
 */
vec2 boots(vec2 p, float cells, float seed, float occupancy, float age){
  vec2 g = p * (cells / 8.0);
  vec2 gp = vec2(cells);
  vec2 i = floor(g), f = fract(g);

  float best = 9.0, blug = 0.0;
  for (int y = -1; y <= 1; y++){
    for (int x = -1; x <= 1; x++){
      vec2 o = vec2(float(x), float(y));
      vec2 c = mod(i + o, gp) + seed;
      if (hash21(c + 8.17) > occupancy) continue;
      vec2 d = o + 0.10 + 0.80 * hash22(c) - f;
      /* Aligned with travel to within 35 degrees. Boots point down the trail, so
       * a print at a random azimuth reads as an animal track — but holding them
       * all to within a few degrees of one axis is worse: it produced a ladder
       * of identical stamps down the centreline that read as a caterpillar
       * track. Real prints scatter in heading as people step round each other. */
      vec2 e = rot((hash21(c + 1.31) - 0.5) * 1.2) * d;
      /* A 30 x 11 cm sole in cell units, at 0.7 to 1.0 of full size so that
       * neighbouring prints are not congruent. */
      float sc = 0.70 + 0.30 * hash21(c + 4.09);
      vec2 q = abs(e) - vec2(0.15, 0.40) * sc + 0.09;
      float sd = (length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - 0.09) / 0.09;
      if (sd < best){
        best = sd;
        blug = smoothstep(0.30, 0.70, abs(fract(e.y * 11.0) - 0.5) * 2.0);
      }
    }
  }
  float inside = 1.0 - smoothstep(-0.55, 0.35 + age, best);
  return vec2(inside, blug * inside);
}

void needleMat(vec2 p, float c0, float widK, float clump, out float cov,
               out float id, out float h, out float along){
  cov = 0.0; id = 0.0; h = 0.0; along = 0.0;
  float pr = clamp(0.26 + 0.86 * clump, 0.0, 1.0);
  needleTake(needle(p, c0,         c0 * widK,         0.0,  pr), cov, id, h, along);
  needleTake(needle(p, c0,         c0 * widK,         17.3, pr), cov, id, h, along);
  needleTake(needle(p, c0,         c0 * widK,         34.6, pr), cov, id, h, along);
  needleTake(needle(p, c0,         c0 * widK,         51.9, pr), cov, id, h, along);
  needleTake(needle(p, c0 * 0.75,  c0 * 0.75 * widK,  9.1,  pr), cov, id, h, along);
  needleTake(needle(p, c0 * 0.75,  c0 * 0.75 * widK,  23.4, pr), cov, id, h, along);
  needleTake(needle(p, c0 * 1.25,  c0 * 1.25 * widK,  41.7, pr), cov, id, h, along);
  needleTake(needle(p, c0 * 1.25,  c0 * 1.25 * widK,  58.2, pr), cov, id, h, along);
  needleTake(needle(p, c0 * 0.625, c0 * 0.625 * widK, 66.5, pr), cov, id, h, along);
  needleTake(needle(p, c0 * 1.5,   c0 * 1.5 * widK,   72.8, pr), cov, id, h, along);
  h = min(h, 1.0);
}
`;

/* The compacted tread.
 *
 * What a boot-worn Pacific Northwest trail actually is: a strip where the
 * organic layer has been ground away and the mineral soil beneath is exposed,
 * compacted to something close to a ceramic, kept permanently damp by shade
 * and rain, with the stones that were always in the soil now standing proud
 * because the fines have washed out between them.
 *
 * ── It is damp compacted fines, and that is a texture, not a gradient ─────
 *
 * The thing being modelled is not topsoil. Trail construction strips the duff
 * and organics off and the tread wears down into the B horizon or the till
 * itself, so it is measurably lighter, yellower and less grey than the organic
 * layer beside it: 10YR 5/4 dry, 10YR 4/4 moist, for Puget-lowland glacial till
 * (Alderwood series). Wetting a soil to field capacity costs between half and
 * three Munsell value steps, which through the ASTM reflectance curve is a
 * factor of 0.33-0.60 on linear albedo; 0.45 is the middle of that and is what
 * the wet end of the ramp below is set to.
 *
 * The substrate has to carry *grain*. Alderwood tread is a gravelly sandy loam,
 * 15-65% gravel, and at 0.88 mm per texel a 5 mm crumb is six texels — fully
 * resolvable, and its absence is the whole of why the previous version read as a
 * smooth tan gradient with scratches in it, i.e. as sandpaper. So there is a
 * packed-cell term at 5.6 mm as well as the tonal fbm bands.
 *
 * ── The tread is the LIGHT element, and it is nearly NEUTRAL ──────────────
 *
 * This file used to assert that the trail reads from a distance because it is
 * "a dark, needle-free line through a pale needle-covered floor". That is
 * wrong, and it produced a saturated orange stripe measuring sat 0.71 against
 * duff at 0.50 — a fluorescent ribbon down the middle of the frame.
 *
 * What a measured transect across a real trail edge actually shows is that the
 * *value* barely moves — 142, 122, 107 out of 255 from swept tread to litter
 * mass — and that the variable carrying the boundary is saturation, which runs
 * 0.07 at the tread centre to 0.29 off-trail, a fourfold rise over 300-500 mm.
 * So the tread is not a pale tan ribbon either. It is a nearly achromatic
 * grey-brown, barely brighter than the duff, and the edge is a saturation ramp
 * rather than a value step. Anything above about 0.20 saturation here reads as
 * paint however correct its brightness is.
 *
 * ── Wet does not mean glossy everywhere ──────────────────────────────────
 *
 * Measured on wet trail photographs, damp mineral soil runs a 1st-99th
 * percentile spread of 4 to 233 out of 255: a dark matte substrate carrying
 * sparse near-clipping specular hits. That is the signature, and a uniform low
 * roughness cannot produce it — it gives the sheet of pewter this had before.
 * Gloss belongs on free water, on polished high spots where boot soles have
 * sheared the fines into a sealed plane, and on stone crowns, and nowhere else;
 * loose granular material has no continuous film and stays matte.
 *
 * Standing water reads *bright and cool*, not dark: it mirrors the fog, so it
 * measures 1.5-2.0x the adjacent mud and about 45 sRGB units bluer. The way to
 * get that with an environment map in the scene is a dark albedo at a very low
 * roughness, which is what the pooling cores are given — the brightness then
 * comes from the fog dome by reflection rather than from a painted highlight,
 * and it tracks the sky automatically.
 */
export const TREAD = HELP + /* glsl */ `
void surf(vec2 uv, out vec3 albedo, out float height, out float rough, out float ao){
  vec2 p = uv * 8.0;
  vec2 per = vec2(8.0);

  /* The soil matrix. Tonal bands at 1.1 m, 29 cm and 8 cm, then the packed-cell
   * grain that stops the whole thing being an interpolated gradient. */
  float clod  = unit(pfbm(p * 0.75, per * 0.75, 3));
  float crumb = unit(pfbm(p * 3.125, per * 3.125, 4));
  float grain = unit(pfbm(p * 11.0, per * 11.0, 3));
  /* Packed grain, as a mosaic of individually-toned grains with a thin dark
   * border between them.
   *
   * Not as distance from each cell's feature site, which is what this was. That
   * puts exactly one bright point in every cell, and at 12 mm cells over a tread
   * it is a regular dot lattice covering the whole surface — the two-component
   * hash lattice failure glsl.ts warns about, arrived at from the other
   * direction. It is invisible in a downscaled capture and unmissable at 1:1,
   * which is why it survived three rounds. Giving each grain a flat tone from its
   * own id keeps the granularity and has no lattice in it, because the tone is a
   * property of the grain rather than of its distance from a grid site. */
  vec2 gw = pworley(p * 20.0, per * 20.0);
  float gid = pworleyId(p * 20.0, per * 20.0);
  float gid2 = pworleyId(p * 33.0, per * 33.0);
  /* Two incommensurate cell sizes, 12 mm and 7.6 mm, and neither at full
   * amplitude. One Worley field is one grain per cell at one spacing, and a
   * single spacing is a lattice whatever the grains are coloured — the tread
   * carried a visible regular dot field at 1:1 through both a feature-site
   * version and a per-grain-tone version of this, because the defect is the
   * single characteristic length. Real fines are graded across a decade of sizes,
   * so no one spacing is available for the eye to lock onto. */
  float sand = hash21(vec2(gid * 37.1, 3.7)) * 0.55
             + hash21(vec2(gid2 * 19.3, 8.2)) * 0.45;
  float gborder = 1.0 - smoothstep(0.0, 0.12, gw.y - gw.x);
  /* Dark grains: the organic fragments and dark minerals that are 5-15% of a
   * gravelly loam by volume, and the reason the substrate has any bite at the
   * scale a phone resolves from a metre away. Whole grains rather than dots at
   * cell centres, for the same reason. */
  float speck = step(0.88, hash21(vec2(gid * 11.9, 5.1)))
              + step(0.92, hash21(vec2(gid2 * 23.7, 2.4)));

  /* The aggregate. Three size-graded populations of individually-placed rounded
   * clasts: 8 cm cells carrying 20-70 mm stones, 3 cm cells carrying 7-22 mm,
   * and 1.4 cm cells carrying the 2-8 mm gravel.
   *
   * Sparse on purpose. Areal exposure on a mature well-drained tread runs
   * 20-35%, and on a scoured one more, but the failure this replaces was density
   * as much as shape: a continuous mosaic with no soil showing between is a
   * cobbled street. These total about 8% over most of the tread and twice that
   * in the stony reaches, which is a trail with stones in it rather than a
   * trail made of stones. */
  float stony = smoothstep(0.34, 0.76, unit(pfbm(p * 1.375 + 13.0, per * 1.375, 3)));
  /* Cut hard from the occupancies above. The material is a silty clay loam over
   * decomposed basalt, which is a *fine* soil: the reference close-ups of wet
   * forest tread show a plastic, almost pastry-like surface with a handful of
   * clasts per square foot, not a graded aggregate. At the previous occupancies
   * the three populations together read as a sand-and-gravel path, and the fine
   * one was doing most of the damage because it tiles densely enough to become
   * the substrate rather than an inclusion in it. */
  vec3 sA = stones(p, 12.0, 0.0,  0.07 + 0.11 * stony, 0.10, 0.34, 2.0);
  vec3 sB = stones(p, 32.0, 21.7, 0.035 + 0.065 * stony, 0.09, 0.28, 2.2);
  /* The gravel population is the one that has to stay rare. It is the scale that
   * tiles densely enough to become the *substrate* rather than an inclusion, and
   * at the 0.24-0.48 occupancy it had, the near tread measured 0.087 saturation
   * against a 0.12-0.20 target: a field of neutral clasts averages the soil hue
   * away, so the reading was pale grey gravel path and not damp soil. */
  vec3 sC = stones(p, 64.0, 47.3, 0.022 + 0.045 * stony, 0.10, 0.26, 2.4);

  /* Proudness scales with radius, and every clast is a spherical cap rather
   * than a plateau — the flat-topped plates read as broken crockery because a
   * plateau has no silhouette curvature for the normal map to shade. A cap
   * standing 20-40% of its own diameter is the settled geometry: clasts come to
   * rest with the long axis horizontal and the tread lowers around them. */
  float capA = sqrt(max(0.0, 1.0 - sA.x * sA.x));
  float capB = sqrt(max(0.0, 1.0 - sB.x * sB.x));
  float capC = sqrt(max(0.0, 1.0 - sC.x * sC.x));
  float proud = capA * sA.z * 1.75 + capB * sB.z * 0.95 + capC * sC.z * 0.55;

  /* Which population owns this texel, by normalised distance, so the collar and
   * the crease below can be written once. */
  float dn = min(min(sA.x, sB.x), sC.x);
  float stoneId = sA.x <= min(sB.x, sC.x) ? sA.y
                : (sB.x <= sC.x ? sB.y + 0.31 : sC.y + 0.67);
  /* How much of a stone this clast reads as, by its population.
   *
   * The fine population is 3 cm cells, and giving its clasts the same pale
   * polished crown as a 5 cm cobble put a quasi-regular field of small bright
   * dots across the whole tread — the painted-on confetti the audit named, still
   * present after the occupancy cut because the defect is the *value*, not the
   * count. A 3 mm grain sitting in damp fines is barely distinguishable from the
   * fines; only a clast big enough for a sole to bear on gets a scuffed crown. */
  float sizeW = sA.x <= min(sB.x, sC.x) ? 1.0 : (sB.x <= sC.x ? 0.55 : 0.16);
  /* The crown is only the middle of the cap. Outside it the stone is still
   * stone but it is wearing a coat of fines: the reference note is that the
   * stone-to-soil transition happens *on the stone*, over its lowest few
   * millimetres, as a dirty collar — so there is no hard colour edge anywhere
   * around a clast, which is what the plates had. */
  float crown = 1.0 - smoothstep(0.30, 0.86, dn);
  float body  = 1.0 - smoothstep(0.86, 1.04, dn);
  /* The junction crease: 1-3 mm of packed fines against the clast where water
   * lingers. One term, and it is most of the difference between gravel that is
   * embedded and a pattern of light patches lying on top. */
  float crease = 1.0 - smoothstep(0.0, 0.22, abs(dn - 1.06));

  /* Height. Grain and crumb are the base relief, the clasts stand on top of it,
   * and the clods put a slow undulation under everything so the tread is not a
   * flat plane with pebbles on it. */
  height = clod * 0.24 + crumb * 0.28 + grain * 0.10 + sand * 0.13 + proud;

  /* Boot prints. Two ages so they overprint: the fresh pass crisp, the older one
   * softened and half filled.
   *
   * Sparse. At the occupancy this started on, five prints landed in every 0.9 m
   * of tread and the result was unmistakably a machine track rather than
   * evidence of feet. Roughly one clear print per square metre with a second
   * half-erased one behind it is what actually survives on a damp tread, and the
   * cue works better understated: a print the viewer has to notice reads as
   * real, one they cannot miss reads as a decal. */
  vec2 bt0 = boots(p, 3.0, 0.0,  0.17, 0.00);
  vec2 bt1 = boots(p, 3.0, 13.9, 0.13, 0.60);
  float print = max(bt0.x, bt1.x * 0.45);
  float lug = max(bt0.y, bt1.y * 0.3);
  // 2 mm of compaction, no rim: the print is pressed in, not dug out.
  height -= print * 0.13 + lug * 0.04;

  /* Wetness. Three contributions, and the pooling patches are the ones that
   * matter: the reference photographs put the darkest tread pixels a factor of
   * two below their surroundings, in irregular 5-20 cm patches following the
   * micro-topography, not in a soft gradient.
   *
   * The basin term keys off the height so water is in the low places by
   * construction
   * and can never be somewhere the geometry says is a high spot; the two noise
   * fields decide which stretches are wet at all. Boot prints are added at full
   * weight because a sealed print in a low-permeability tread holds water for
   * hours and is the tread's main puddle generator. */
  float basin = 1.0 - smoothstep(0.24, 0.58, height);
  float wetField = unit(pfbm(p * 0.75 + 41.0, per * 0.75, 3));
  float patchy = unit(pfbm(p * 1.75 + 17.0, per * 1.75, 3));
  /* Re-centred, and the sharpening backed off. Audited at a median of 0.62 over
   * 98.8% of the tread, which is not a mottle — it is a near-constant dark bias
   * with holes in it, and since it is the only term modulating the soil ramp the
   * tread came out bimodal: pale blotches where the field happened to dip, dark
   * everywhere else. The stretch-scale wetness now comes from the drainage
   * attribute in the material, so this term is only responsible for the
   * centimetre-to-handspan mottle it can actually resolve inside a 90 cm tile. */
  float damp = clamp(basin * 0.40 + contrast(wetField, 2.2) * 0.72
                     + patchy * 0.30 - 0.24, 0.0, 1.0);
  damp = clamp(contrast(damp, 1.8) + print * 0.24, 0.0, 1.0);
  /* Free water, as opposed to merely damp.
   *
   * Audited at 48% of the tread area with at least a tenth of it at full
   * strength, which is not a small fraction of anything — and since this drives a
   * near-mirror roughness, the consequence was not visible puddles but a neutral
   * specular wash over half the trail that pulled the hue out of the soil. The
   * gate is now high enough that it fires on the low percent it is supposed to. */
  float water = smoothstep(0.93, 0.995, damp);

  /* Water fills the interstices, so a wet patch is the *smoothest* part of a
   * tread, not the roughest.
   *
   * This had it backwards in both channels at once, and the result was damp
   * patches that read as ice or foil: they carried more high-frequency relief than
   * the dry soil around them and a raised diffuse brightness, so they sparkled and
   * looked granular where they should have been glassy. Flattening the grain and
   * the packed-cell relief while keeping the centimetre undulation is what a film
   * of water actually does to a surface — the fines are submerged, not lit. */
  float submerged = smoothstep(0.52, 0.96, damp);
  height = mix(height, clod * 0.24 + crumb * 0.28 + proud, submerged * 0.85);

  /* Colour. 10YR till, ramped from the wet tone to the pale dried crust that
   * survives on the high points, with almost all of the range on the fine
   * scales.
   *
   * Weighting the ramp towards the clod and crumb terms paints the tread with
   * large smooth tonal blobs, and at the angle the trail is actually seen from
   * those stretch along the sightline into swirls that look like wood grain.
   * Compacted mineral soil has almost no tonal structure above a hand's width;
   * what it has is a granularity of a few millimetres, which the packed-cell
   * term carries. */
  /* Straight off the Munsell chip: 10YR 5/4, the Bw horizon of Puget-lowland
   * till, converts to a linear albedo of about (0.215, 0.156, 0.098) — luminance
   * 0.164, which is what the ASTM curve gives for value 5. The wet end is that
   * times 0.42, inside the 0.33-0.60 the ASTM curve gives for a soil taken to
   * field capacity.
   *
   * These are much more chromatic than the near-neutral pair they replace, and
   * that was the error: the *rendered* tread has to measure around 0.07-0.12
   * saturation, but the fog dome is neutral and bright and AgX pulls chroma out
   * of the midtones, so a near-neutral albedo delivers 0.025 and reads as wet
   * concrete. The albedo has to be well chromatic to arrive nearly grey. */
  /* 10YR 5/6 rather than 5/4, at the same 0.164 luminance — R/B raised from 2.19
   * to 3.2. Measured transfer: a 2.19 albedo ratio arrives in the frame as 1.08,
   * because the fog dome contributes a neutral specular term to a dielectric that
   * is nearly constant across the surface and AgX pulls chroma from the midtones
   * on top of it. 5/6 is still squarely inside the range a moist Puget-lowland B
   * horizon occupies, and it is what it takes to land in the 0.12-0.20 the
   * reference frames measure. */
  /* 7.5YR rather than 10YR, and value 4 rather than 5.
   *
   * 10YR 5/6 at luminance 0.164 delivered a pale orange-tan that reads as damp
   * sand, and it was right about saturation and wrong about hue and value at once:
   * 10YR is the yellow end of the soil hues, and yellow at a high value is sand.
   * A Puget-lowland forest tread that is wet most of the year is a 7.5YR-to-5YR
   * brown at value 4 — redder, darker, and with the green channel pulled down
   * relative to both neighbours, which is the specific difference between "brown
   * soil" and "tan sand".
   *
   * The chroma is back down near the physical figure, and the reason is a coupling
   * worth recording: the 3.3 R/B this carried was compensation for the fog dome's
   * neutral specular eating the hue, and that specular was mostly coming from a
   * standing-water term which the audit found firing over 48% of the tread. With
   * that term cut to the few percent it should occupy, the surface is matte, the
   * compensation is no longer paid for, and the same albedo measured 0.31
   * saturation against a 0.12-0.20 target — orange sand. Two errors had been
   * cancelling.
   *
   * ── And it was still 1.5x too bright ─────────────────────────────────────
   *
   * Measured: near-tread luma median 70 against a near-duff median 47, with the
   * darkest one percent of the tread at 52. That is inverted twice over. A wet
   * mineral tread photographs at or below the duff beside it — bare wet soil has a
   * lower albedo than a mat of dead needles, which is the opposite of the dry-trail
   * intuition — and a wet forest floor is mostly dark with a few bright specular
   * hits, where this was mostly bright with a few dark patches.
   *
   * It also carried a cost the frame could not show yet: with trees and dense fog
   * still to come, a tread brighter than its surroundings becomes a pale ribbon
   * glowing through a dark forest, and the fog density and exposure would then have
   * to be recalibrated against a tread that was wrong to begin with.
   *
   * So this is 7.5YR 3/2 rather than 4/4 — luminance 0.072 against 0.139. Dark warm
   * chocolate, which is what wet till actually is.
   *
   * The R/B ratio has to climb as the value falls, and it is the same mechanism as
   * every other chroma correction in this file: the fog dome's specular contribution
   * is a fixed neutral quantity, so as the diffuse term shrinks the specular becomes
   * a larger share of the pixel and pulls the hue towards grey. Dropping luminance
   * from 0.090 to 0.072 at a constant R/B cost 0.04 of measured saturation on its
   * own. 2.5 is what holds the reading inside the 0.12-0.20 band at this value. */
  vec3 drySoil = vec3(0.1030, 0.0655, 0.0405);
  /* Two separate tonal structures, not one averaged ramp.
   *
   * The grain terms carry a modest 1.4x spread at the millimetre-to-centimetre
   * scale, and the damp field carries a 2.4x spread at the patch scale. Folding
   * dampness in as a fourth term of one ramp alongside them is what made the
   * tread read uniform: averaging four uncorrelated unit fields cuts the variance
   * of the sum by half, so a term list that looked like it spanned the whole
   * range delivered a flat mid-grey everywhere. The reference decomposition is
   * unambiguous that these are different phenomena at different contrasts —
   * pooling patches up to 2x, fine mottle a few percent — so they are applied as
   * different operations. */
  /* The grain's share of the tonal ramp is cut to a third of what it was. A
   * visible per-grain tone variation is what makes a surface read as granular,
   * and a silty clay loam is not granular — it is a fine matrix whose tonal
   * structure comes from the crumb and clod scales, centimetres and up, not from
   * individual particles. The grain stays in the *normal* map, where it gives the
   * surface tooth without announcing a particle size. */
  float dryness = clamp(sand * 0.06 + grain * 0.30 + crumb * 0.34 + clod * 0.10 + 0.08, 0.0, 1.0);
  /* Collapsed towards its mean where the ground is wet, for the same reason the
   * relief is flattened: a submerged grain has no tone of its own to show. This is
   * what stops the wet patches being the noisiest thing in the frame. */
  dryness = mix(dryness, 0.5, submerged * 0.80);
  vec3 soil = mix(drySoil * 0.74, drySoil, dryness);
  /* A 3.7x range on the damp field, and centred above 1 so the mean is preserved
   * rather than dragged down.
   *
   * It has to be this wide because the render compresses it hard. Measured: the
   * baked albedo carries a 3:1 ratio between its 10th and 90th percentiles and
   * the delivered frame carries 1.43:1, because a dielectric under a bright fog
   * dome picks up a specular term that is near-constant across the surface and
   * AgX compresses the midtones on top of that. Authoring to the contrast you
   * want to *see* puts half of it in the frame; the map has to be pushed about
   * twice as far as looks right in isolation. */
  /* The bright end pulled in from 1.18. Three brighteners were compounding — this
   * one, the dryness ramp, and the stretch multiplier in the material — and their
   * product put the driest patches half again above the soil's own albedo, which
   * is where the sandy cast was coming from. Compacted mineral soil under fog does
   * not have a highlight; it has a less-dark state. */
  soil *= mix(0.96, 0.30, damp);
  /* Pulled in from 0.52. A dense field of hard dark points at one small scale is
   * itself a granularity cue — it reads as coarse sand with dark minerals in it,
   * which is the wrong material. The dark fraction of a silty loam is mostly fine
   * organic matter that tints the matrix rather than dotting it. */
  soil *= 1.0 - 0.30 * speck * (1.0 - submerged);
  /* Standing water on a low-permeability tread is the darkest thing on the
   * ground — a wet-dark film over soil already at the wet end, reading near
   * black in a frame whose tread mean is 68. Without this the wetness only ever
   * expressed as a mild grey mottle and the tread stayed chalky. */
  soil *= 1.0 - 0.40 * water;

  /* Damp patches go cooler as well as darker, which is the measurement that
   * makes wet ground read as wet rather than as dark ground: mud photographs at
   * R-B of +15 to +23 and free water at -1 to -26, a swing of some 45 sRGB
   * units towards blue. The iron staining that used to sit here pushed the hue
   * 9% the other way and was most of the 0.71 saturation. */
  /* Held to about half the swing the R-B measurements suggest. Taken at full
   * strength on top of a 10YR 5/6 dry tone it splits the tread into orange-tan
   * and blue-grey blotches — a hue contrast, where inspection at 1:1 says damp
   * mottling on real compacted soil is very largely a *value* contrast within one
   * hue, with the cool shift only arriving on genuinely standing water. */
  soil *= mix(vec3(1.016, 1.000, 0.986), vec3(0.972, 0.988, 1.020), damp);
  soil *= mix(vec3(1.0), vec3(0.94, 0.97, 1.04), water);

  /* The saturated rim.
   *
   * Where free water meets soil that is merely damp there is a band of fully
   * saturated ground, and it is the darkest thing on a wet trail — darker than the
   * water itself, because the water is returning a specular of the sky while the
   * soil beside it is returning almost nothing. Every reference close-up of a
   * puddle on a forest track has this ring and it is most of what identifies the
   * puddle as water rather than as a stain; without it the wet patches had no
   * boundary at all and read as a lighter material laid on top.
   *
   * Keyed on the wetness field being mid-range rather than on a separate noise, so
   * the rim is by construction the edge of the same patch. */
  float rim = (1.0 - smoothstep(0.0, 0.13, abs(damp - 0.82))) * (1.0 - water);
  soil *= 1.0 - 0.46 * rim;

  /* Stone colour. Local geology, which here means grey basalt and a paler
   * granite, both carrying a little of the soil's warmth because a clast that
   * has sat in this dirt for a century is stained by it. A clean blue-grey read
   * as gravel imported from somewhere else — the tell was that the stones were
   * the only cool-hued thing on the ground. */
  /* Brought down with the soil, not left where it was. The clasts, the grit, the
   * litter inclusions and the sticks were all sitting in one too-high, too-warm
   * band, and darkening only the matrix would have left the stones as bright
   * confetti on dark ground — a worse read than the uniform pale tread, because
   * the eye forgives a wrong overall level and does not forgive a wrong
   * relationship. A wet clast in wet soil is a much more forgiving target. */
  vec3 stoneC = mix(vec3(0.0475, 0.0460, 0.0430), vec3(0.0930, 0.0890, 0.0815),
                    hash21(vec2(stoneId, 4.1)));
  /* Boots polish an exposed crown clean of its clay coating, so it is lighter
   * than the flanks; the flanks keep the coating and are nearly soil coloured. */
  stoneC *= 0.74 + 0.42 * crown * sizeW;
  /* Silt film. A clast in a damp tread is never clean rock except on the very
   * crown a boot has just scuffed — the rest carries the local soil, so the
   * stone hue has to be mostly soil hue or the tread loses its cast. */
  stoneC = mix(soil * 1.15, stoneC, (0.34 + 0.46 * crown) * mix(0.35, 1.0, sizeW));

  albedo = mix(soil, stoneC, body * 0.82 * mix(0.30, 1.0, sizeW));
  height += sand * 0.03 - speck * 0.03 - gborder * 0.04;

  /* Strays: litter that has landed on the tread.
   *
   * There has to be some. The audit that stood before this said not one needle,
   * twig or cone lay on the tread in eight frames, under a forest that drops
   * litter continuously — and coverage on a measured trail photograph runs 5-20%
   * even at the swept centreline, rising to 60-90% at the edge. But it stays
   * clumped hard rather than spread, because what actually happens is that a few
   * needles collect against a clast or in a rut and the rest is bare. The rise
   * towards the edge is not done here; it comes from the material blend, which
   * hands over to the litter set across the last 40 cm.
   *
   * Twigs get their own coarse pass. Twigs are 10-20% of a PNW forest floor by
   * area and were entirely absent, and a 4 mm stick lying across a tread is a
   * far stronger scale cue than a needle because it casts a line of shadow. */
  float ncov, nid, nh, nalong;
  float strayClump = smoothstep(0.42, 0.84, unit(pfbm(p * 0.875 + 7.0, per * 0.875, 2)));
  needleMat(p, 24.0, 0.00194, strayClump, ncov, nid, nh, nalong);
  float strays = ncov * mix(0.30, 1.0, strayClump);
  /* Doug-fir and hemlock litter is a duller olive-brown than the orange-tan that
   * was here, and it darkens sharply as it decays — the range on a real floor
   * runs from a fresh olive-tan through mid red-brown to nearly black, and the
   * old end is most of it. */
  float age = hash21(vec2(nid, 2.2));
  vec3 needleC = age < 0.30 ? mix(vec3(0.0300, 0.0255, 0.0185), vec3(0.0530, 0.0430, 0.0290), age / 0.30)
                            : mix(vec3(0.0530, 0.0430, 0.0290), vec3(0.0830, 0.0700, 0.0430), (age - 0.30) / 0.70);
  albedo = mix(albedo, needleC, strays * 0.90);
  height += strays * 0.10;

  vec3 tw = needle(p, 8.0, 0.030, 88.4, 0.30);
  float twig = tw.x * step(0.62, hash21(vec2(tw.y, 5.9)));
  albedo = mix(albedo, mix(vec3(0.0420, 0.0360, 0.0290), vec3(0.0760, 0.0670, 0.0540),
                           hash21(vec2(tw.y, 8.3))), twig * 0.92);
  height += twig * 0.26;

  /* Roughness, and this map is where wetness actually lives.
   *
   * A uniform low floor over the damp half of the tread is what put a sheet of
   * pewter down the middle of the frame, and raising that floor to 0.60
   * everywhere is what then made the tread read chalky and dusty in eight
   * consecutive frames. Neither is what a wet trail measures: it is a matte
   * substrate carrying sparse near-clipping glints, a 1st-99th spread of 4 to
   * 233 out of 255. So the floor stays high and the gloss is *localised* — free
   * water, polished high spots, stone crowns — and each of those is a small
   * fraction of the area.
   *
   * Loose granular material is explicitly kept matte. It has no continuous
   * water film however wet the air is, and letting the grain go glossy is the
   * quickest way back to pewter. */
  rough = 0.93 - crumb * 0.06 + sand * 0.05;
  /* Polished high spots. Boot soles shear the surface fines on every raised
   * area into a sealed plane whose micro-roughness drops below the grain size,
   * so it holds an unbroken film. Elongated along travel and concentrated where
   * traffic converges, which here is everywhere the tread material is drawn. */
  /* The period has to be scaled by the same anisotropy as the coordinate. This
   * call passed the period unscaled, so the noise did not tile at the repeat,
   * and the tread carried a hard roughness seam at every 2 m patch boundary. At
   * the grazing angle the trail is actually viewed from, a seam in the *gloss*
   * of a wet surface under a bright fog dome is a bright transverse arc — which
   * is the corduroy banding down the tread, and it is why the artefact survived
   * both halving the mesh rows and making the tangent continuous.
   *
   * Higher frequency across than along, so what is left reads as the streaks a
   * sole leaves travelling over a high spot rather than as metre-wide plates.
   *
   * The height gate was 0.58-0.88 and it was inert: audited by writing the term
   * into an albedo channel, it read non-zero over 2.4% of the tread with a 90th
   * percentile of zero, because the height field almost never reaches 0.58 once
   * the clast population is sparse. An edit to its strength moved zero pixels,
   * which is how it was caught. Gating on the range the height field actually
   * occupies rather than on a guess is the whole fix. */
  vec2 pol = vec2(3.0, 1.0);
  /* Both gates matter, and the first pass at fixing this only moved the failure:
   * opening the height gate from 0.58 took the term from 2.4% coverage to 72.6%,
   * which is a polished trail rather than polished high spots on one. A sole seals
   * the raised tenth of a tread, not three quarters of it. */
  float high = smoothstep(0.36, 0.60, height);
  float polish = high * smoothstep(0.56, 0.86, unit(pfbm(p * pol + 61.0, per * pol, 2)));
  rough = mix(rough, 0.34, polish * 0.70);
  rough = mix(rough, 0.30, crown * body * 0.75);
  /* Damp is a mild effect; free water is not. 0.12 is a near-mirror and it is
   * what makes a print full of water reflect the fog dome instead of being
   * painted a lighter grey — the brightness then comes from the environment and
   * tracks the sky by construction. */
  /* Genuinely low now, where it was floored at 0.72 and 0.12.
   *
   * That floor was raised in an earlier round to stop the ground looking chromed,
   * and it was the right call against an albedo of 0.14-0.21: a bright diffuse plus
   * a strong specular is chrome. With the albedo down near 0.09 the specular has
   * something dark to sit on, which is the condition a wet surface actually
   * satisfies, so the sheen can now arrive as specular rather than as raised
   * diffuse — which is the whole difference between water and foil. */
  rough = mix(rough, 0.44, smoothstep(0.30, 0.92, damp) * 0.80);
  rough = mix(rough, 0.06, water * (1.0 - strays) * (1.0 - twig));
  rough = mix(rough, 0.88, max(strays, twig) * 0.8);

  /* Free water only. The general damp darkening is in the ramp above; this is
   * the extra step standing water takes, and it goes with the near-mirror
   * roughness so the brightness comes back as a reflection of the fog dome. That
   * is why a puddle photographs at 1.5-2x the mud beside it while having a
   * *lower* diffuse albedo than the mud. */
  albedo *= mix(1.0, 0.72, water);

  /* Boot evidence in the albedo, not only in the roughness.
   *
   * A sheared, sealed high spot is drier than the fines around it as well as
   * smoother, and on a trail described as boot-worn it is the main visible sign
   * that anything walks here — the roughness alone is nearly invisible under a
   * diffuse fog dome because there is no light source to glint off it.
   *
   * Scuffs are separate and anisotropic: a sole dragging over damp fines leaves a
   * short bright scrape a few centimetres long aligned with travel, and it is the
   * one cue that is unmistakably a foot rather than erosion. Kept sparse; the
   * failure mode on the other side is a tread that looks raked. */
  albedo *= 1.0 + 0.30 * polish;
  float scuff = smoothstep(0.72, 0.94, unit(pfbm(p * vec2(14.0, 2.0) + 29.0,
                                                per * vec2(14.0, 2.0), 2))) * high;
  albedo *= 1.0 + 0.34 * scuff;
  rough = mix(rough, 0.44, scuff * 0.6);

  /* Occlusion. Between the clasts, in the crumb hollows, and under the rim of
   * every boot print — the cavities that a sky-lit scene with no direct sun has
   * nothing else to darken. In flat fog light this map is doing most of the work
   * a shadow would do on a sunny day, so it is stronger than it would normally
   * be. The crease term is what beds the stones: without it they are light
   * patches lying on the surface. */
  ao = clamp(0.34 + 0.62 * height, 0.0, 1.0);
  ao *= 1.0 - 0.50 * crease;
  ao *= 1.0 - 0.18 * print - 0.09 * lug;
  ao = mix(ao, ao * 0.88, damp * 0.5);
  /* The saturated rim, again, in occlusion.
   *
   * Cutting its albedo was not enough and the reason is worth recording: the
   * darkest pixel the near tread could produce was luma 42 however far the diffuse
   * was taken down, because a dielectric under a bright fog dome returns a specular
   * term of roughly 0.04 of the sky whatever its albedo is — and taking the wet
   * roughness genuinely low, which is correct, makes that term sharper rather than
   * weaker. Occlusion is the only channel that attenuates both, so a saturated rim
   * has to be an occluded rim or it cannot be dark. */
  ao *= 1.0 - 0.55 * rim;
}
`;

/* The forest floor either side of the tread.
 *
 * The needle mat, and it is 80% of the surface area of the frame's lower half,
 * so it carries most of the burden of the ground looking real. Under it, dark
 * humus; over it, dead broadleaf litter (there is always some vine maple and
 * alder in a PNW conifer stand), scattered twigs, and moss where the light and
 * the damp allow.
 *
 * ── Three materials, not one, and moss is the biggest of them ─────────────
 *
 * The version of this that shipped was a needle mat with a trace of moss in the
 * hollows, and it rendered as dry-grass savanna: a uniform yellow-green field
 * with nothing dark in it and nothing green-grey. Two corrections, both from the
 * reference photographs rather than from reasoning.
 *
 * The humus has to be genuinely dark and genuinely neutral, and it has to be
 * *visible* — bare wet black earth between the litter, not a base coat that
 * nothing ever shows. Without it the floor has no bottom end and every value in
 * the frame lives in the same half stop.
 *
 * And moss is not a garnish. In a Carbon River stand the floor is described,
 * accurately, as a multi-coloured carpet of fluffy moss with the litter sitting
 * on top of it — moss is often the dominant hue of a PNW forest floor and it is
 * a cool grey-green, which in a scene where nothing else has any chroma at all
 * is the only thing keeping the ground from reading as sepia. It gets a third of
 * the surface here and its own clumping field, so it forms mats with edges
 * rather than a green wash.
 */
export const LITTER = HELP + /* glsl */ `
void surf(vec2 uv, out vec3 albedo, out float height, out float rough, out float ao){
  vec2 p = uv * 8.0;
  vec2 per = vec2(8.0);

  /* Where the mat is thin enough for the humus below to show. */
  float thin = unit(pfbm(p * 1.75, per * 1.75, 4));

  /* Drift. Needles do not fall evenly — they collect in the hollows and blow
   * off the mounds, in patches most of a metre across. This is now the
   * *clumping* input to the mat rather than only a tint over it, which is the
   * difference between litter and carpet: a real floor has drifts several
   * needles deep against bare patches where the humus is open.
   *
   * It is also the only thing carrying the surface past about 6 m. A 3 mm
   * needle subtends less than a pixel at 10 m no matter how the texture is
   * authored, so beyond that distance everything legible has to be at the
   * decimetre scale or larger — the drifts, the moss mats, and the stones. */
  float drift = unit(pfbm(p * 0.5 + 17.0, per * 0.5, 3));
  float drift2 = unit(pfbm(p * 1.125 + 63.0, per * 1.125, 2));
  float clump = clamp(contrast(drift * 0.78 + drift2 * 0.30 - 0.04, 1.7), 0.0, 1.0);

  /* Wet humus. Nearly neutral: decayed conifer duff is a black-brown and the
   * warm cast people expect belongs to the needles lying on it, not to it. */
  vec3 humus = mix(vec3(0.0205, 0.0172, 0.0148), vec3(0.0490, 0.0390, 0.0295),
                   unit(pfbm(p * 5.0 + 88.0, per * 5.0, 3)));

  /* The mat. Patch is 1.5 m over 1024 texels, so widK puts the needle at
   * 3.5 mm — two and a half texels, which survives one mip level and is the
   * finest thing worth authoring here. */
  float ncov, nid, nh, nalong;
  needleMat(p, 32.0, 0.00117, clump, ncov, nid, nh, nalong);

  /* Needle colour by age. A fallen needle starts a warm red-brown and greys
   * over about two years, and a real mat has every stage in it at once
   * because it is fed continuously. One colour for all of them is the giveaway.
   */
  /* Doug fir and hemlock litter is a duller olive-brown than the orange-tan that
   * was here — the old fresh stop had R/G at 1.74, which is a rust, where a
   * newly fallen needle photographs at about 1.25 and still carries a trace of
   * green. And the decay ramp has to be weighted to its dark end: needles darken
   * *sharply*, so most of a real mat is between mid-brown and near-black with
   * only the top layer still tan. Two thirds of the population past the mid stop
   * is what gives the mat a bottom to its value range. */
  float age = hash21(vec2(nid, 9.7));
  vec3 fresh = vec3(0.1230, 0.0995, 0.0415);
  vec3 mid   = vec3(0.0705, 0.0540, 0.0295);
  vec3 old   = vec3(0.0310, 0.0265, 0.0208);
  vec3 needleC = age < 0.34 ? mix(fresh, mid, age / 0.34)
                            : mix(mid, old, (age - 0.34) / 0.66);
  // Tips darken — a needle rots from its ends inwards.
  needleC *= 1.0 - 0.30 * smoothstep(0.45, 1.0, abs(nalong));

  /* How much of the humus shows through.
   *
   * Open, and much more open than the previous 0.06-0.34, which let it through
   * over about a tenth of the surface. A duff floor that never shows bare earth
   * has no bottom to its value range — the whole floor lives in half a stop and
   * reads as a carpet, which is precisely what the frame came back as. A third
   * of the litter here has visible humus under it. */
  albedo = mix(humus, needleC, ncov * smoothstep(0.20, 0.62, thin));
  height = nh * 0.62 + thin * 0.22;

  /* Cone scales. Hemlock and fir shed them by the thousand and they are the one
   * piece of litter with a hard edge and a curl, which is why a few percent of
   * them read out of all proportion to their coverage. */
  vec2 cs = pworley(p * 6.0 + 5.0, per * 6.0);
  float scaleId = pworleyId(p * 6.0 + 5.0, per * 6.0);
  float cone = step(0.80, scaleId) * (1.0 - smoothstep(0.10, 0.26, cs.x)) * clump;
  albedo = mix(albedo, mix(vec3(0.0420, 0.0300, 0.0195), vec3(0.0880, 0.0620, 0.0360),
                           hash21(vec2(scaleId, 6.6))), cone * 0.85);
  height += cone * 0.16;

  /* Broadleaf litter. Big flat pieces, sparse, and much lighter — a dead
   * bigleaf maple leaf is one of the few genuinely pale things on this floor
   * and a couple of them per square metre are worth having for exactly that
   * reason. Shaped by a low-frequency worley so they read as sheets rather
   * than as blobs. */
  vec2 lf = pworley(p * 1.375, per * 1.375);
  float leafId = pworleyId(p * 1.375, per * 1.375);
  float leaf = step(0.86, leafId) * (1.0 - smoothstep(0.16, 0.40, lf.x));
  // Curled edge: a dry leaf lifts at the rim, so the rim catches light.
  float rim = leaf * smoothstep(0.24, 0.38, lf.x);
  vec3 leafC = mix(vec3(0.0755, 0.0545, 0.0275), vec3(0.0430, 0.0300, 0.0160),
                   hash21(vec2(leafId, 3.3)));
  albedo = mix(albedo, leafC, leaf * 0.85);
  albedo += rim * leafC * 0.55;
  height += leaf * 0.14 + rim * 0.16;

  /* Twigs. Long, thin, dark, and straighter than anything else here, which is
   * what makes them read as wood rather than as more litter. Two populations at
   * different pitches so they are not all the same length; each is rare, because
   * twigs at anything above a tenth occupancy stop reading as sticks and start
   * reading as a brushed nap. */
  vec3 tw = needle(p + 21.0, 12.0, 0.055, 0.0, 1.0);
  vec3 tw2 = needle(p + 44.0, 6.0, 0.038, 31.0, 1.0);
  float twig = max(tw.x * step(0.88, tw.y), tw2.x * step(0.93, tw2.y));
  albedo = mix(albedo, vec3(0.0420, 0.0325, 0.0230), twig * 0.78);
  height += twig * 0.30;

  /* Bark flakes. 5-15% of a Doug fir floor by area, and they were missing
   * entirely — the audit counted one object class where reality has ten.
   *
   * Worth their coverage twice over because they are the warmest and chunkiest
   * thing down here: fir bark is thick, corky and red-brown to purplish, so a
   * flake is a 1-5 cm slab of the most saturated colour on the floor sitting
   * proud of a mat of near-neutral needles. Worley cells with a hard threshold,
   * because a flake has a broken edge and a flat face rather than a soft
   * outline. */
  vec2 bk = pworley(p * 3.0 + 29.0, per * 3.0);
  float bkId = pworleyId(p * 3.0 + 29.0, per * 3.0);
  float flake = step(0.88, bkId) * (1.0 - smoothstep(0.13, 0.19, bk.x));
  vec3 flakeC = mix(vec3(0.0570, 0.0330, 0.0230), vec3(0.1040, 0.0640, 0.0430),
                    hash21(vec2(bkId, 7.7)));
  albedo = mix(albedo, flakeC, flake * 0.90);
  height += flake * 0.30;

  /* Whole cones.
   *
   * The single most valuable object on this floor per unit of area it covers, and
   * it was missing: a Doug-fir cone is 6-9 cm, instantly recognisable in
   * silhouette, and it is therefore the one piece of litter that tells the viewer
   * how big everything else is. Nothing else in the near field fixes the scale,
   * which is why the whole frame previously read about three times too large.
   *
   * Two populations at swapped anisotropy so they do not all lie the same way — a
   * field of cones sharing one long axis reads as a printed pattern, and the axis
   * is the most visible thing about an elongated object. */
  vec2 cnA = vec2(3.9, 2.1), cnB = vec2(2.1, 3.9);
  vec2 k1 = pworley(p * cnA + 71.0, per * cnA);
  float cid1 = pworleyId(p * cnA + 71.0, per * cnA);
  vec2 k2 = pworley(p * cnB + 13.0, per * cnB);
  float cid2 = pworleyId(p * cnB + 13.0, per * cnB);
  float body1 = step(0.90, cid1) * (1.0 - smoothstep(0.20, 0.34, k1.x));
  float body2 = step(0.92, cid2) * (1.0 - smoothstep(0.20, 0.34, k2.x));
  float coneB = max(body1, body2);
  float cdn = body1 > body2 ? k1.x : k2.x;
  float cidW = body1 > body2 ? cid1 : cid2;
  /* The scale rows, which are the whole reason a cone is recognisable. Ridges
   * across the long axis, tightening towards the tip, and the ridge crowns catch
   * the sky while the gaps between them are the deepest shadow on this floor. */
  float rows = sin((body1 > body2 ? p.y * cnA.y : p.x * cnB.x) * 26.0 + cidW * 40.0);
  float ridge = coneB * (0.5 + 0.5 * rows);
  vec3 coneC = mix(vec3(0.0430, 0.0300, 0.0180), vec3(0.0870, 0.0605, 0.0350),
                   hash21(vec2(cidW, 4.4)));
  albedo = mix(albedo, coneC * (0.62 + 0.62 * ridge), coneB * 0.92);
  /* Proud, and domed rather than flat: a cone is a solid object lying on a mat,
   * so its silhouette has to lift clear of the surface or it reads as a stain. */
  height += coneB * (0.34 + 0.22 * sqrt(max(0.0, 1.0 - cdn * 3.0))) + ridge * 0.10;

  /* Rotting wood. Punky fragments off a fallen branch, and the palest thing on
   * the floor after the broadleaf litter — decayed sapwood bleaches to a grey-buff
   * and goes fibrous, so it reads as neither soil nor leaf. Rare, and soft-edged,
   * because a punky piece has no clean break left in it. */
  vec2 rw = pworley(p * 1.9 + 97.0, per * 1.9);
  float rwId = pworleyId(p * 1.9 + 97.0, per * 1.9);
  float rot = step(0.94, rwId) * (1.0 - smoothstep(0.14, 0.34, rw.x));
  /* Wet punk, not dry punk. Decayed sapwood bleaches pale when it dries out, and
   * on a floor that is soaked most of the year it is a saturated grey-brown at half
   * that value — this and the leaf litter were the brightest inclusions on the
   * floor and part of the same too-high band as the tread. */
  vec3 rotC = mix(vec3(0.0410, 0.0360, 0.0285), vec3(0.0730, 0.0640, 0.0510),
                  unit(pfbm(p * 18.0 + 3.0, per * 18.0, 2)));
  albedo = mix(albedo, rotC, rot * 0.88);
  height += rot * 0.22;

  /* Moss. A third of the floor, in mats with edges.
   *
   * The colour is the point. Living Sphagnum and Hypnum under a white overcast
   * is a *cool grey-green*, not a foliage green: the chroma is low and the hue
   * sits between green and grey, which is exactly what makes it read as a wet
   * northern forest rather than as a lawn. Two tones, because a moss mat is
   * pale and slightly yellow where it is growing and dark blue-green where it
   * is shaded and waterlogged, and the mottling between them at the centimetre
   * scale is most of what identifies it.
   *
   * Keyed off its own noise plus the low places, not off the needle drift, so
   * that moss and litter compete for the surface the way they actually do —
   * moss holds the hollows and the north sides, needles pile on top of it. */
  float mossN = unit(pfbm(p * 1.625 + 51.0, per * 1.625, 4));
  float hollow = 1.0 - smoothstep(0.20, 0.58, height);
  /* Moss loses where the needles have drifted deep. Without the clump term
   * the moss and the mat both key off the low places, so they land on the same
   * ground and the whole floor comes back one colour — a green turf with brown
   * flecks rather than alternating decimetre patches of each. */
  /* Crisper edges than the 0.52-0.80 band this replaces. A wide smoothstep spends
   * most of the moss area in its own transition, and in the transition the
   * needles underneath show through at 50% — which is exactly the reported defect,
   * needle sticks visible through the patches so the moss read as mint-green
   * spray settled on the ground rather than as a growing thing. Real moss has an
   * edge you could cut round: it is a colony, and it either occupies a patch of
   * ground or it does not. */
  /* Colonies at the metre scale on top of the patch-scale field. Moss spreads
   * from where it established, so a floor has square metres that are largely moss
   * and square metres with almost none; keying coverage off one 1.6/m field alone
   * gave a statistically uniform sprinkle of same-sized patches across the whole
   * frame, which read as blotches of paint rather than as colonies. */
  float mossReg = smoothstep(0.30, 0.72, unit(pfbm(p * 0.375 + 87.0, per * 0.375, 2)));
  float moss = smoothstep(0.60, 0.71,
                          mossN * 0.80 + hollow * 0.34 - clump * 0.30
                          - 0.16 * (1.0 - mossReg));
  /* Three scales, and they are combined by contrast rather than by averaging.
   *
   * The previous version summed two fields into the colour mix, and summing
   * independent noise halves its variance: the result sat near the middle of the
   * ramp nearly everywhere and every moss mat in the frame came back as one flat
   * grey-green tone. Brightened, the whole forest floor read as an algae crust on
   * a beach. A moss carpet in a photograph is the opposite of flat — it is a pile
   * of discrete cushions, near-black in the gaps between them and pale on the
   * crowns, and that near-four-to-one value range across a few centimetres is
   * most of what identifies it. */
  float cush = unit(pfbm(p * 5.5 + 71.0, per * 5.5, 3));
  float mossFuzz = unit(pfbm(p * 24.0, per * 24.0, 3));
  float mossTone = clamp(contrast(cush, 2.0) * 0.80 + mossFuzz * 0.30 - 0.05, 0.0, 1.0);
  /* Yellower and less blue than the pair this replaces, whose bright stop had
   * G/B at 1.74 and rendered as mint. Turgid PNW moss under a white overcast is a
   * yellow-green: the green stays close to the red and the blue drops away, which
   * here is G/B near 2.1. The bright stop also comes down, because at 0.146 green
   * the moss was the palest thing on the floor and a moss cushion is not brighter
   * than a fresh needle. */
  vec3 mossC = mix(vec3(0.0200, 0.0270, 0.0140), vec3(0.0690, 0.0820, 0.0395), mossTone);
  // Opaque. Moss grows *over* litter; anything showing through is a mistake.
  albedo = mix(albedo, mossC, moss);
  height = mix(height, 0.30 + cush * 0.44 + mossFuzz * 0.20, moss);
  rough = mix(0.94, 0.99, moss);

  /* Roughness. Dead needles are matte; the leaves have a slight waxy sheen
   * left; the humus underneath is wet and darker and shinier. */
  rough = mix(rough, 0.86, ncov * 0.5);
  rough = mix(rough, 0.66, leaf * 0.7);
  rough = mix(rough, 0.62, (1.0 - smoothstep(0.10, 0.40, thin)) * 0.6);

  /* Occlusion. A needle mat is deep, and the gaps between needles are little
   * light traps — this is a much stronger AO than a hard surface would carry
   * and it is what gives the mat its texture under a flat sky.
   *
   * With the environment lighting the whole ground now sits four times brighter
   * than it did, which means this can afford to reach much further down than the
   * 0.56 it did a moment ago — and it has to. A floor whose darkest value is
   * 0.56 of its brightest has no black in it anywhere, and a needle mat with no
   * black in it is a printed cloth. 0.38 puts the deep gaps between the moss
   * cushions and under the needle drifts at around RGB 45, which is where a
   * photograph puts them. */
  ao = clamp(0.38 + 0.62 * clamp(height * 1.25, 0.0, 1.0), 0.0, 1.0);
  /* Moss occludes itself, hard. A cushion carpet is a pile of discrete domes and
   * the gaps between them go nearly black — that self-shadowing is most of what
   * separates dense living moss from a green wash painted on the floor, and with
   * no directional light in the scene the AO map is the only place it can come
   * from. Driven by the cushion field rather than by a constant, so the dark is
   * in the creases. */
  ao *= mix(1.0, 0.34 + 0.66 * contrast(cush, 2.0), moss);
}
`;

export type GroundTextures = {
  tread: SurfaceSet;
  litter: SurfaceSet;
  dispose(): void;
};

/**
 * Bake both floors.
 *
 * `patch` differs between them on purpose. The tread is looked at from 1.5 m
 * away at the bottom of the frame and its detail has to survive that, so its
 * tile covers less ground and its texels are nearly three times as dense.
 *
 * Both are smaller than they were — 1.4 and 2.2 m — for two reasons that turned
 * out to be the same reason. Texel density: at 2.2 m a 1024 tile gives 2.1 mm
 * per texel, a needle is one and a half of them, and the mipmap chain has eaten
 * the mat by 4 m. And apparent scale: the tile size is what sets how big every
 * feature in the map *is*, and with the trail narrowed to its real 86 cm a
 * 2.2 m litter tile put 14 cm needles beside it. The two have to be calibrated
 * against each other or the frame contains two incompatible rulers, which is
 * exactly how a correctly-sized trail can still read three times too large.
 *
 * The cell counts passed to `needleMat` are tied to these numbers; changing a
 * patch without changing them changes the needle size.
 */
export function bakeGround(renderer: THREE.WebGLRenderer): GroundTextures {
  const tread = bakeSurface(renderer, TREAD, {
    size: 1024, patch: 0.9, bump: 0.016, anisotropy: 16,
  });
  const litter = bakeSurface(renderer, LITTER, {
    size: 1024, patch: 1.5, bump: 0.026, anisotropy: 16,
  });
  return {
    tread,
    litter,
    dispose() { tread.dispose(); litter.dispose(); },
  };
}
