/* The three surfaces the wood is made of.
 *
 * Same colour-space rules as `groundMaterials.ts`: every albedo written here is
 * LINEAR, the bake target is sRGB8 and the GPU encodes on write, so wet bark at
 * 0.036 is not a typing error — it is a sRGB value of about 55 out of 255,
 * which is what a trunk in a foggy photograph measures. Read that file's header
 * before touching a number in this one.
 *
 * Measured reference points, all linear:
 *
 *   Doug-fir ridge crown, wet     0.043  0.037  0.030
 *   same, weathered grey plate    0.031  0.030  0.028
 *   fresh inner bark in a fissure 0.055  0.030  0.018
 *   fissure floor                 0.008  0.006  0.005
 *   weathered snag, silvered      0.066  0.064  0.058
 *   snag, sheltered under a strap 0.048  0.038  0.026
 *   crustose lichen on bark       0.086  0.091  0.074
 *   algal film, wet north face    0.025  0.032  0.020
 *
 * The whole set is darker than the forest floor beside it and that is
 * deliberate. `env.ts` states the rule the scene depends on — the air is
 * brighter than anything solid in it, and every tree is a silhouette — so if a
 * trunk ever renders lighter than the fog behind it, something upstream is
 * wrong. The trunks are also the largest dark mass in the frame, which makes
 * them the thing that sets the picture's contrast: getting them a stop too
 * light does not read as "light trunks", it reads as no fog.
 *
 * ── The AO floor is the exposure control ──────────────────────────────────
 *
 * System 1 established this the expensive way and it applies with more force
 * here, because bark is a deeply cavitied surface being lit by a uniform dome.
 * A dielectric under a bright fog dome returns roughly 4% of the sky whatever
 * its albedo is, so lowering diffuse alone hits a floor; occlusion is the only
 * channel that attenuates diffuse and specular together.
 *
 * ── Two occlusion channels, and they are not interchangeable ──────────────
 *
 * The maps here carry only what the *surface* does: a furrow floor sees a
 * fifteen-degree strip of sky and a ridge crown sees a hemisphere. What the
 * *object* does — that this is a bole in a closed stand rather than a stick
 * lying in the open on the trail — belongs in the vertex attribute in
 * `forest.ts` and nowhere else, because these three sets are shared by every
 * piece of wood in the scene. Correcting the trunks' exposure here instead cost
 * a full round trip: cutting the bark and snag floors far enough to bring the
 * near boles under the duff also took every fallen log and every stick on the
 * floor down with them, and the capture came back with the deadwood rendering
 * as black ironwork — the darkest thing in a frame it has no business leading.
 */
import * as THREE from 'three';
import { bakeSurface, type SurfaceSet } from '@/world/bake';
import { MOSS } from './propMaterials';

/* Douglas-fir bark.
 *
 * ── What the thing actually is ────────────────────────────────────────────
 *
 * Measured on mature coastal Doug-fir in the Oregon Coast Range: the single
 * largest furrow on a tree averages 6.8 cm deep and reaches 20 cm on the very
 * biggest; the corky ridges between them are up to 15 cm thick. The pitch — the
 * ridge-to-ridge spacing round the bole — runs 6-12 cm on a stem of this age.
 * The descriptions that keep recurring in the literature are "interwoven" and
 * "twisted", and those two words are the whole design of this surface: the
 * ridges are not a set of parallel lines, they are an *anastomosing network*
 * that forks, runs, and rejoins, and every attempt at bark that reads as
 * corduroy has failed at exactly that point.
 *
 * Colour is pale-brown to grey-brown to nearly grey-black on the exposed
 * plates, with red-brown showing where a plate has recently lifted. The classic
 * note is that a big mature bole is "reminiscent of manila rope" — i.e. free of
 * the red or orange that a young Doug-fir has, which is why the red here is
 * confined to a minority of the fissures rather than being the base tone.
 *
 * ── Why worleyEdge and not pridged ────────────────────────────────────────
 *
 * `glsl.ts` says `pridged` exists because bark fissures are LINES, and that is
 * right about the problem and only half right about the solution. Ridged fbm
 * produces creases at the zero crossings of a noise field, which is a set of
 * closed wandering contours — good for a crack in dried mud, wrong for bark,
 * because bark fissures *branch* and contours never do. A Voronoi border network
 * branches by construction: every vertex where three cells meet is a fork. So
 * the ridge network is two `worleyEdge` fields stretched 4.5:1 vertically and
 * unioned, which forks at two different scales at once, and `pridged` is kept
 * for the fine splits *within* a plate, which is what it is actually good at.
 *
 * Two fields, at 7.8 cm and 12.7 cm, because one Worley field is one feature
 * per cell at one spacing and a single spacing is a lattice however it is
 * coloured — the artefact this project has been caught by three times.
 */
export const BARK = /* glsl */ `
mat2 rot(float a){ float s = sin(a), c = cos(a); return mat2(c, -s, s, c); }

void surf(vec2 uv, out vec3 albedo, out float height, out float rough, out float ao){
  vec2 p = uv * 8.0;
  vec2 per = vec2(8.0);
  /* One p-unit is 17.5 cm of bark at the patch this bakes at, and every scale
   * below is chosen against that and then rounded to a multiple of 1/8 so the
   * period stays a whole number of lattice cells. */

  /* The ridge network. Stretched 4.5:1 so the cells are long vertical slivers,
   * which is what makes their borders run up the bole.
   *
   * Jitter is high — 0.78 and 0.86 — and the first attempt at this had it at
   * about a half on the reasoning that low jitter straightens the borders into
   * the long runs bark fissures actually have. It does, and it also pins every
   * cell near its lattice site, and a Voronoi whose sites are near a regular
   * grid has borders that *are* the grid. Rendered at 1600 wide it came back as
   * black fishnet stretched over every trunk in the frame: a perfectly regular
   * diamond mesh, which is the single-characteristic-length failure glsl.ts
   * warns about arriving through the one primitive that was supposed to avoid
   * it. The long straight runs have to come from the anisotropy instead. */
  /* A vertical flow warp, applied before the Worley and *not* after it.
   *
   * Anisotropy alone was the whole of the first design and it produced the
   * wrong shape for a reason that only shows up in the baked normal map: a
   * Voronoi cell stretched 8:1 is a lens, and a lens has a point at each end.
   * Dumped at 512 the map was a field of spearheads — long flat facets tapering
   * to a sharp tip top and bottom, all aligned — which is the shape a fir cone
   * scale has and is nothing like a corky ridge. Stretching harder makes the
   * spears longer and sharper; it cannot make them blunt.
   *
   * Warping the domain instead buys the long run from a *different* mechanism.
   * The cells stay near enough equant to have blunt ends and rounded crowns,
   * and the borders between them are dragged sideways by up to 10 cm as they
   * climb, so a border that starts between one pair of cells wanders into the
   * next pair and keeps going: the run length stops being the cell length. That
   * is also what the field descriptions mean by "interwoven".
   *
   * The warp is periodic on the same period as everything else, so p + w(p)
   * differs by exactly one period across the seam and the lattice still wraps. */
  /* Both warp bands are themselves stretched. A warp whose own features are as
   * tall as they are wide drags the border back and forth several times over
   * one cell, which closes it into a ring: the first amplitude that fixed the
   * spearheads replaced them with a field of short curled blobs — brain coral,
   * and a worse read than the spears because at least the spears ran vertically.
   * The drift has to be slow *along* the run, so the warp field is 4:1 and 2.5:1
   * and the total amplitude is well under half a cell width. */
  vec2 sW = vec2(0.5, 0.25);
  vec2 sW2 = vec2(1.0, 0.375);
  float flow = pfbm(p * sW + 5.0, per * sW, 3)
             + pfbm(p * sW2 + 61.0, per * sW2, 2) * 0.34;
  vec2 pw = p + vec2(flow * 0.40, 0.0);

  /* The furrows themselves, and this is the fourth mechanism tried for them.
   *
   * A cell field cannot produce this shape and the reason is structural rather
   * than a matter of tuning: a Voronoi cell has a characteristic size in *both*
   * axes, so its borders terminate at intervals set by the cell length however
   * far the lattice is stretched. Every build driven by one came back as a
   * pattern of closed lozenges — pinecone scales at 8:1, spearheads at 5:1,
   * brain coral once a domain warp was added to break the alignment up. What a
   * mature Doug-fir has instead is a furrow that runs *metres*: the photographs
   * show three or four major runs crossing a half-metre of bole from the bottom
   * of the frame to the top without ending, and that continuity is the single
   * most recognisable thing about the species.
   *
   * Ridged noise is lines, which is why glsl.ts carries it, and the vertical
   * correlation length is set by the period rather than by any cell size: at
   * one lattice cell per tile in y the base octave varies once over 1.4 m, and
   * since the tile stacks up the bole with the same phase, a furrow is
   * continuous for the whole fifteen metres. The higher octaves keep the same
   * 12:1 anisotropy — pridged doubles p and per together — so they add wander
   * along a run instead of chopping it into segments. */
  /* Three octaves, not four, and the base at eight cells rather than twelve.
   *
   * Each octave of a ridged sum contributes its own set of lines, so the furrow
   * count is not the base frequency — it is the sum over the octaves, and at
   * four octaves from a twelve-cell base the map came back with about thirty
   * runs across the tile: a 5 cm pitch, which is half what a mature bole has and
   * reads as combing. The Oregon Coast Range figure is 6-12 cm ridge to ridge
   * and the old-growth photographs are wider still, three or four major runs
   * across a half metre. */
  vec2 sL = vec2(1.0, 0.125);
  float lines = pridged(pw * sL, per * sL, 3);
  float bL = clamp((1.0 - lines) * 1.55 - 0.10, 0.0, 1.0);

  /* The cellular field is kept, demoted to what it is actually good at.
   *
   * A Voronoi border network forks by construction — every vertex where three
   * cells meet is a junction — and forks are the one thing a ridged field has
   * none of, because a ridge line is a contour of a smooth function and
   * contours do not branch. Scaled up by 2.2 it loses almost everywhere against
   * the line field and only registers where a border happens to be unusually
   * narrow, which puts a cross-link or a fork in perhaps one place in ten. The
   * cell ids stay because they are what gives two neighbouring plates different
   * ages, and that is the term that stops bark reading as one material with
   * lines drawn on it. */
  vec2 sA = vec2(2.0, 0.25);
  vec2 sB = vec2(1.25, 0.375);
  vec3 eA = worleyEdge(pw * sA, per * sA, 0.72);
  vec3 eB = worleyEdge(pw * sB, per * sB, 0.82);

  /* Combined as one distance field, by taking the nearer of the two borders,
   * rather than as two thresholded masks unioned with a max.
   *
   * The difference is the whole appearance of the surface. Two masks give a
   * binary answer — fissure or not — so the only thing the height map can build
   * from them is a plateau with a slot in it, and a plateau has no curvature for
   * the normal map to shade: the second build came back as flat polygonal tiles
   * with hard black outlines, which is crazed pottery glaze and not bark. One
   * distance field can be shaped into a *cross-section*, and the cross-section
   * is what a corky ridge actually is. The 1.6 on the second field is the ratio
   * of its cell size to the first's, so the two contribute borders at
   * comparable apparent widths rather than the coarser one swamping it. */
  /* Only the coarser cell field contributes a fissure, and only barely.
   *
   * Both of them in the minimum put so many short branching strokes over the
   * line field that a 2x crop read as crazing on a glaze — the vertical runs
   * were there underneath and you could trace them, but the eye assembled the
   * strokes into a net instead. "Only occasionally branching" is the brief and
   * it means occasionally: at 4.5 the border has to be in the narrowest few per
   * cent of the distribution before it beats the lines. The second field stays
   * for its cell ids, which is all it was ever good for here. */
  float b = min(bL, (eA.y - eA.x) * 4.5);

  /* Cross-breaks. A mature ridge is not one continuous rope for the height of
   * the tree — it is broken into blocks, which is where the "jigsaw" in the
   * field descriptions comes from.
   *
   * The block length is the number that decides whether this surface is bark or
   * an alligator, and the first three builds had it four times too short. At a
   * 11.7 cm vertical period against an 8.75 cm ridge pitch the cross-breaks and
   * the ridge borders are the same length, so the network they make together is
   * isotropic: the 2x crop came back as a field of pointed scales, which is
   * pinecone or crocodile and is *not* what any amount of retuning the Voronoi
   * would have fixed, because the Voronoi cells were already 46-70 cm long and
   * were never the thing making the pattern. The blocks on a mature bole are a
   * third of a metre, so the break has to be four times longer than the ridge
   * pitch rather than one and a third times, and it has to be a notch in the
   * ridge rather than a full-depth crossing — cutting b all the way to the
   * fissure threshold is what welded the breaks into the border network and
   * closed the cells. */
  vec2 sX = vec2(0.25, 0.5);
  float xb = pridged(p * sX, per * sX, 2);
  float crossGate = smoothstep(0.62, 0.86, unit(pfbm(p * 0.75 + 19.0, per * 0.75, 2)));
  float cross = pow(clamp(xb, 0.0, 1.0), 9.0) * crossGate;
  b = min(b, 0.46 - cross * 0.30);

  /* The ridge cross-section.
   *
   * A power of 0.6 on a smoothstep that runs most of the way to the cell centre:
   * the surface climbs steeply out of the fissure and then flattens over the
   * crown, which is the profile of a rounded corky mass. Running the smoothstep
   * over a narrow band instead — 0.01 to 0.15, which is what the second build
   * did — saturates within a few millimetres of the fissure and leaves the whole
   * plate at one height, and a flat plate under a fog dome has no shading across
   * it at all. */
  /* Rounded rather than plateaued, and the exponent moved from 0.6 to 1.1 on
   * the evidence of the baked normal map rather than of the render.
   *
   * Under 0.6 the profile reaches full height a fifth of the way in from the
   * border and then holds, so the cell interior is a *plane* and the only
   * normal variation on it is at the rim. Lit by a uniform dome a plane returns
   * one value: the map dumped as a facetted mosaic with hard creases, which is
   * why the surface read as scales rather than as a mass however the colour was
   * tuned. Above one the crown domes continuously across the whole plate, which
   * is both what a corky ridge is and the only thing that gives an unlit-by-
   * anything-directional surface a gradient to shade with.
   *
   * Saturating well before the middle of the plate once the network became a
   * line field rather than a cell field. The two cases want opposite profiles: a
   * cell that plateaus is a flat *facet* and reads as a scale, whereas a ridge
   * between two parallel furrows that plateaus is a flat-topped corky rib, which
   * is what the bark actually is — the photographs show broad flat ridge backs
   * carrying their own fine flake detail, not rounded ropes. Left domed at 0.52
   * the map came back as drapery. */
  float crown = pow(smoothstep(0.0, 0.34, b), 0.75);
  /* The dark line is much narrower than the groove is wide, because what reads
   * as the fissure is the part of it that sees no sky rather than the whole
   * depression. */
  /* A wide soft trough with a narrow dark core, rather than one band.
   *
   * A single smoothstep gives a fissure with one width, and at 2x on a near
   * bole that is a drawn line — the crop came back looking like crazing on a
   * glaze, a net of uniform dark strokes over pale polygons, which is a
   * different failure from the scales but arrives at the same place. A real
   * furrow is a V: it starts shading a couple of centimetres out from the seam
   * and goes black only in the last few millimetres, and the gradient between
   * those two is what says the surface has depth. */
  float fissure = (1.0 - smoothstep(0.0, 0.21, b)) * 0.52
                + (1.0 - smoothstep(0.0, 0.075, b)) * 0.48;
  /* And its depth varies along its length.
   *
   * This is the term that separates bark from combing. With every border in the
   * network cut to the same depth and the same darkness, the surface came back
   * as an even rake of parallel black lines at one pitch — the third version of
   * the same complaint, arrived at from a third direction. On a real bole one
   * run in four is a genuine 7 cm furrow and the rest are shallow seams a
   * fingernail deep that fade out and pick up again, which is what makes the
   * network read as something that grew rather than as something drawn. Two
   * bands so the variation itself has no single length either. */
  float deepness = clamp(unit(pfbm(p * vec2(1.0, 0.5) + 83.0, per * vec2(1.0, 0.5), 3)) * 0.72
                       + unit(pfbm(p * vec2(2.5, 1.5) + 29.0, per * vec2(2.5, 1.5), 2)) * 0.46
                       - 0.10, 0.0, 1.0);
  fissure *= 0.26 + 0.90 * deepness;

  /* The plate face, and this is where the second build had nothing at all.
   *
   * A Doug-fir ridge is not a smooth facet: it is a corky mass a hand's width
   * across whose own surface wanders by a centimetre or two, split by fine
   * checks, and rough enough at the millimetre scale to catch a fingernail. All
   * three scales are here because with the plates smooth the only thing the
   * normal map says is "here is a line", and a surface whose only structure is
   * lines is read as a pattern printed on a cylinder. */
  float mound = unit(pfbm(p * vec2(3.0, 1.0) + 7.0, per * vec2(3.0, 1.0), 3));
  /* The checks within a plate run *along* it, so they are stretched on the same
   * axis as everything else here. At 4:1 they were 12 cm dashes at the same
   * vertical pitch as the cross-breaks, which is a second contribution to the
   * same isotropic mesh from a term that was supposed to be sub-plate detail. */
  vec2 sS = vec2(6.0, 0.75);
  float split = pow(clamp(pridged(p * sS, per * sS, 3), 0.0, 1.0), 3.0);
  /* Flakes, and they run the *other* way to everything else in this shader.
   *
   * The close-up photographs are unambiguous about this and it is easy to get
   * backwards: the large structure is vertical furrows, but the surface of each
   * ridge back is broken into small corky flakes that are wider than they are
   * tall, stacked in rough horizontal courses like coarse masonry. Running this
   * band vertically like the rest reinforced the furrows into corduroy and left
   * the ridge backs with nothing crossing them, which is most of why a flat-
   * topped rib read as extruded plastic. */
  vec2 sC = vec2(5.0, 9.0);
  float cork = unit(pfbm(p * sC, per * sC, 3));
  /* The finest band, now strongly vertical. Its amplitude and the flakes' have
   * been traded against each other, because between them they were deciding the
   * *direction* of the surface and they had it wrong.
   *
   * Measured on the hero bole against a real trunk photographed close: mean
   * per-pixel |dx| came out at 13.2 against the reference's 10.1, so the
   * amplitude was right and a little over. The horizontal-to-vertical gradient
   * ratio came out at 0.95 against a reference of 2.67 -- perfectly isotropic,
   * which is the signature of a noise field rather than of furrows, and it is
   * why a correct quantity of surface detail still read as speckle.
   *
   * Both fine bands were pulling that way. The grit was isotropic by
   * construction. The cork is deliberately *anti*-vertical, 5 across against 9
   * up, on the sound observation that a ridge back breaks into flakes wider
   * than they are tall -- true of the plant, and a mistake at this amplitude,
   * because at 0.26 it was the largest fine term in the map and it was voting
   * the wrong way. The flake courses stay at 42% of the weight and the grit
   * takes over the amplitude at 7.5:1 anisotropy. */
  vec2 sG = vec2(30.0, 4.0);
  float grit = unit(pfbm(p * sG, per * sG, 2));

  height = crown * (0.40 + 0.30 * mound) + cork * 0.11 + grit * 0.20
         - split * 0.10 - cross * 0.14;
  height = clamp(height, 0.0, 1.0);

  /* Plate identity. Two adjacent ridges are different ages — one has lifted and
   * greyed and the one beside it has not — and that per-plate tone step is most
   * of what stops a bark map reading as one material with lines drawn on it. */
  float pid = eA.z;
  float pid2 = eB.z;
  float age = clamp(hash21(vec2(pid * 31.7, 4.1)) * 0.62
                  + hash21(vec2(pid2 * 17.3, 9.2)) * 0.38, 0.0, 1.0);

  /* Colour. Grey-brown at the weathered end, warmer brown at the young end, and
   * the ramp is weighted so most plates sit near the grey — the "manila rope"
   * note is that a big bole has no red in it at a distance, and the warmth has
   * to be an inclusion rather than the base. */
  /* Chromatic well past what the surface measures, because almost none of it
   * survives the trip. The ground established the transfer: an authored R/B of
   * 2.19 arrives in the frame at 1.08, because the fog dome contributes a
   * neutral specular term that is a large fraction of a dark pixel and AgX pulls
   * chroma out of the midtones on top of it. A bole authored at the grey these
   * two tones average to renders as wet concrete, which is what the first
   * capture came back as — a forest of stone columns. */
  vec3 grey  = vec3(0.0292, 0.0252, 0.0190);
  vec3 brown = vec3(0.0530, 0.0352, 0.0202);
  vec3 plate = mix(grey, brown, contrast(age, 1.6));
  /* A 2.4x value range from plate to plate, which is much wider than it looks
   * like it should be and is the term that stops the surface reading as one
   * material with lines drawn on it. Two neighbouring ridges on a real bole are
   * different ages: one has lifted and greyed and is shedding, the one beside it
   * is still sound and nearly black with water. At the 1.35x the two base tones
   * gave on their own, everything between the fissures was the same value and
   * the map had nothing in it but the network. */
  plate *= mix(0.56, 1.34, hash21(vec2(pid * 13.3, 7.7)) * 0.6
                         + hash21(vec2(pid2 * 5.1, 1.9)) * 0.4);
  /* Within a plate the crown is scoured pale and the flanks keep a wash of the
   * darker weathering products. */
  plate *= 0.78 + 0.38 * crown;
  plate *= 0.86 + 0.28 * mound;
  plate *= 0.96 + 0.08 * cork;
  /* The fine band, in *albedo* rather than in height, and putting it here is
   * the whole of the anisotropy fix.
   *
   * Stretching the height map's grit vertically changed the measured gradient
   * ratio on the hero bole by 0.02, from 1.00 to 1.02, which is nothing — and
   * the reason is the one this project keeps relearning about its own lighting.
   * The scene has no directional source; the dome is rotationally symmetric
   * about Y by construction. A normal map works by turning a perturbed normal
   * into a change in irradiance, and under a symmetric dome there is almost no
   * change in irradiance to be had, so the whole height/normal path is nearly
   * invisible and every millimetre of relief authored into it is decoration on
   * a term the renderer barely reads. What the eye is actually measuring when
   * it measures "bark speckle" here is albedo.
   *
   * So the vertical band goes on the albedo directly, at 7.5:1, and it is the
   * only fine term left with any weight. Target from the reference photographs
   * is a horizontal-to-vertical gradient ratio of 2.67 against the 0.95 this
   * surface measured. */
  plate *= 0.84 + 0.32 * grit;
  /* A tonal band at the hand scale, incommensurate with everything else here.
   *
   * A bole is fifteen metres of a 1.4 m tile and the eye finds a repeat in a
   * narrow vertical object almost instantly, so the map needs structure at every
   * scale it can hold — and the largest one it can hold is the tile. This is the
   * inside half of that job; Trees.tsx carries the outside half in world space,
   * at a scale the tile cannot reach at all. */
  /* Run through a contrast curve, because summed octaves of value noise are
   * clustered hard around their own mean. Measured by differencing: as a plain
   * unit-mapped fbm this term moved 3.9% of the frame — a ±18% swing that
   * spent nearly all of its area within a couple of percent of no change at all,
   * which is the *degenerate* rather than the dead case and is the one that
   * survives review. Expanding the middle of the distribution is what turns it
   * into a tonal band the eye can find. */
  plate *= mix(0.82, 1.18, contrast(unit(pfbm(p * 0.625 + 41.0, per * 0.625, 3)), 1.9));

  /* The fissure floor. Dark, wet, and *not* black.
   *
   * The first version had it at 0.008 with an 80% occlusion cut on top, and the
   * two compounded into a hard black line network — which is not what a furrow
   * looks like even at the bottom, because a 2 cm gap in a 7 cm ridge still sees
   * a fifteen-degree strip of a very bright sky. Nearer a third of the plate,
   * not a twentieth. */
  vec3 deep = vec3(0.0175, 0.0128, 0.0092);
  /* Red-brown fresh inner bark, in the minority of fissures where a plate has
   * come away recently. Keyed off the plate id so it is a property of the gap
   * between two particular ridges rather than a wash over the whole map. */
  float fresh = smoothstep(0.74, 0.90, hash21(vec2(pid * 7.9, 2.3)));
  deep = mix(deep, vec3(0.0520, 0.0272, 0.0148), fresh * 0.72);

  /* 0.72 rather than a full replacement. The fissure has to be legible and it
   * must not be a painted black line: with the albedo taken all the way down and
   * a 50% occlusion cut on top of it the two compounded into hard ink, and a
   * surface whose darks are ink is an engraving. Most of the darkening belongs
   * in occlusion, where it also takes the specular with it. */
  albedo = mix(plate, deep, fissure * 0.55);

  /* Crustose lichen. Pale crusts a few centimetres across, and one of the few
   * genuinely light things in this forest — worth its coverage several times
   * over because it is the only high-frequency *bright* detail on an object that
   * is otherwise the darkest mass in the frame. Sparse, and it does not grow in
   * the fissures, which is where the water runs.
   *
   * Thresholded noise rather than a Worley disc, and the reason is the lattice
   * artefact the shared noise header warns about. The first build took these as the distance to each cell's
   * feature point, which puts exactly one crust at one size in every cell: at 2x
   * magnification the near trunks carried a regular field of identical white
   * dots at a fixed pitch, which is the single most recognisable signature of
   * procedural texture there is and was by far the loudest thing in the crop.
   * Two fbm bands have no lattice in them at any frequency, and the intersection
   * of the two gives a crust with an irregular outline and no characteristic
   * size. */
  float lc0 = unit(pfbm(p * 3.5 + 61.0, per * 3.5, 3));
  float lc1 = unit(pfbm(p * 9.0 + 23.0, per * 9.0, 2));
  float lichen = smoothstep(0.66, 0.79, lc0 * 0.72 + lc1 * 0.34)
               * (1.0 - fissure) * crown;
  float lichenFuzz = unit(pfbm(p * 20.0, per * 20.0, 2));
  albedo = mix(albedo, mix(vec3(0.0560, 0.0600, 0.0490), vec3(0.0790, 0.0820, 0.0660),
                           lichenFuzz), lichen * 0.88);
  height += lichen * 0.06;

  /* Algal film. Everything on a coastal trunk below the crown carries a
   * green-black film of Desmococcus, heavier in the fissures and on the weather
   * side. It is the only chroma on the bark and without it the bole is a grey
   * ramp; the vertex attribute over in Trees.tsx decides how much of the bole gets
   * it, so this is only the pattern. */
  float algae = smoothstep(0.46, 0.80, unit(pfbm(p * vec2(1.5, 0.75) + 53.0,
                                                 per * vec2(1.5, 0.75), 3)));
  albedo = mix(albedo, vec3(0.0250, 0.0320, 0.0200), algae * (0.30 + 0.34 * fissure));

  /* Resin. A Doug-fir bleeds from every wound and the run dries to a hard black
   * streak down the bole. Rare, very anisotropic, and the one feature here with
   * a hard vertical edge. */
  vec2 sR = vec2(0.5, 0.125);
  float resin = smoothstep(0.86, 0.96, pridged(p * sR, per * sR, 2))
              * smoothstep(0.55, 0.75, unit(pfbm(p * 1.0 + 71.0, per * 1.0, 2)));
  albedo = mix(albedo, vec3(0.0130, 0.0098, 0.0070), resin * 0.85);

  /* Roughness. Corky bark is matte almost everywhere — it is a foam, it holds no
   * film — and the exceptions are the ones worth having: resin is a hard varnish,
   * and a wet fissure floor holds standing water. Keeping the crowns matte is
   * what stops the bole picking up a sheet of sky reflection and going grey. */
  rough = 0.94 - cork * 0.05;
  rough = mix(rough, 0.99, lichen);
  rough = mix(rough, 0.62, fissure * 0.35);
  rough = mix(rough, 0.30, resin * 0.85);

  /* Occlusion, and this is where the bark's value actually lives.
   *
   * A 7 cm furrow 2 cm wide sees a strip of sky about fifteen degrees across:
   * its floor receives on the order of a twentieth of what the ridge crown
   * beside it does. That ratio is the reason bark reads as bark under flat light
   * and nothing else in the pipeline can supply it — there is no shadow map, and
   * the normal map only tilts the surface, it cannot occlude it. The floor at
   * 0.24 is below the ground's, because a trunk is a silhouette. */
  /* Driven off the height, with only a small extra term for the fissure itself.
   *
   * The two were being counted twice: the height field already falls to near
   * zero in a fissure, so a 0.22 floor put the groove at 0.25 and a further 48%
   * cut on top of that took it to 0.13 against a crown at 0.94 — a seven-to-one
   * value ratio inside one material, which is not a fissure, it is ink. Bark
   * photographed in flat light runs about three to one from ridge crown to
   * furrow floor. */
  /* Bark micro-relief only, and deliberately nothing else.
   *
   * At a 0.26 floor the near boles read 72, 92 and 105 against a duff of 51 and
   * a fog of 185 — every trunk in the frame lighter than the ground it stands
   * out of, which is why an earlier capture read as birch. The correction was to
   * drive this floor down to 0.14, and it worked on that symptom and caused a
   * worse one: with a vertex closure term of 0.60 multiplying it, a mid-ground
   * bole ended up returning 17% of the indirect light and measured *five per
   * cent* of the range available to it — at 13 m a black object rendered 74, the
   * fog 194, and the trunk 81. There was nothing left for a terminator, a
   * texture or a tone to vary within, and eight-bit quantisation turned what
   * remained into the two flat plateaus with a hard step that the last review
   * read as facets on a low-segment cylinder.
   *
   * Two terms were doing one job in two places. This map is shared with every
   * log, stub and stick on the floor, none of which are in a closed stand, so
   * "a trunk is a silhouette" has no business being baked into it — that is a
   * property of where the object is standing and it now lives on the bole's
   * vertex occlusion, varying with bearing, in skyView(). What is left here is
   * what a photograph of bark in flat light actually shows: about two and a half
   * to one from ridge crown to furrow floor. */
  ao = clamp(0.40 + 0.56 * height, 0.0, 1.0);
  ao *= 1.0 - 0.20 * fissure;
  ao *= 1.0 - 0.16 * split;
  ao *= 1.0 - 0.11 * cross;
  /* Lichen sits proud of the plate and is the one thing up here that is not in a
   * hole, so it gets its occlusion back. */
  ao = mix(ao, min(1.0, ao + 0.22), lichen);
}
`;

/* Weathered barkless wood: snags, the exposed sapwood on a fallen log, the
 * break at the end of a stub.
 *
 * ── This is the pale element and it has to stay pale ──────────────────────
 *
 * Everything else in this scene has been pulled darker at some point in its
 * development, usually correctly. This one must not be. A silvered snag is
 * genuinely one of the lightest large objects in a Pacific Northwest forest —
 * that is why they are called silver snags — and it is the only vertical in the
 * frame that is not near-black. Cutting it to match the bark would remove the
 * one value contrast the wall of wood has in it.
 *
 * The silvering is a real surface: UV and rain destroy the lignin in the outer
 * few tenths of a millimetre and leave loose bleached cellulose fibres, so the
 * face is pale, fibrous and completely matte, while the wood inside every check
 * is still the warm brown it always was. That two-tone — pale face, warm crack —
 * is most of what identifies weathered wood, and rendering the checks as simply
 * darker grey is what makes CG driftwood look like painted concrete.
 *
 * ── The grain runs where the geometry says ────────────────────────────────
 *
 * Everything here is vertical in uv, and the spiral is applied by twisting the
 * uv in `forest.ts`. Shearing inside the bake would break the lattice wrap and
 * put a horizontal seam every 1.4 m up every snag in the wood.
 */
export const SNAG = /* glsl */ `
void surf(vec2 uv, out vec3 albedo, out float height, out float rough, out float ao){
  vec2 p = uv * 8.0;
  vec2 per = vec2(8.0);

  /* Grain. 16:1, and the ratio is not a stylistic choice — the fibres are metres
   * long and a fraction of a millimetre across, and anything under about ten to
   * one reads as woodgrain wallpaper. Two bands: the growth rings, which on a
   * coastal conifer are 1-4 mm apart, and the fibre bundles inside them. */
  vec2 gR = vec2(6.0, 0.375);
  float ring = unit(pfbm(p * gR, per * gR, 4));
  vec2 gF = vec2(22.0, 1.375);
  float fibre = unit(pfbm(p * gF, per * gF, 3));

  /* Checks. Wood dries and splits *along* the grain, and it does it in a few
   * deep splits rather than many shallow ones because each one that opens
   * relieves the stress that would have opened its neighbours. Ridged noise
   * stretched hard and raised to a high power, which is what turns a field of
   * scratches into three or four real cracks. */
  vec2 cK = vec2(1.0, 0.125);
  float check = pow(clamp(pridged(p * cK, per * cK, 3), 0.0, 1.0), 5.0);
  /* And the shallow surface checking that covers the whole face between them.
   * Same mechanism, an order of magnitude finer, and it is what gives the
   * silvered surface its tooth. */
  vec2 cF = vec2(4.0, 0.5);
  float shake = pow(clamp(pridged(p * cF, per * cF, 3), 0.0, 1.0), 3.0);

  /* Erosion. Weathering does not take the wood down evenly — the soft earlywood
   * between the rings goes first and the dense latewood stands proud, so an old
   * snag develops a fine corduroy that follows its own growth rings. It is a
   * small relief and it is one of the most recognisable things about very old
   * weathered wood. */
  float relief = smoothstep(0.40, 0.72, ring);

  height = 0.42 + relief * 0.30 + fibre * 0.20 - check * 0.70 - shake * 0.22;
  height = clamp(height, 0.0, 1.0);

  /* Colour. Silver-grey face, warm brown inside every split. The face itself is
   * not one tone: sheltered strips stay browner, and a snag that has lost its
   * bark recently is warmer all over than one that has stood for forty years. */
  vec3 silver = vec3(0.0700, 0.0680, 0.0620);
  vec3 shelter = vec3(0.0480, 0.0382, 0.0262);
  float weathered = smoothstep(0.28, 0.76, unit(pfbm(p * vec2(1.0, 0.375) + 11.0,
                                                     per * vec2(1.0, 0.375), 3)));
  vec3 face = mix(shelter, silver, weathered);
  // Latewood is darker as well as harder, which is what makes the ring pattern
  // legible on a face that has almost no other colour in it.
  face *= 0.88 + 0.22 * (1.0 - relief);
  face *= 0.92 + 0.16 * fibre;

  albedo = mix(face, vec3(0.0155, 0.0112, 0.0075), max(check, shake * 0.55) * 0.90);

  /* Woodpecker work and beetle galleries.
   *
   * Every standing dead conifer in this forest has been worked over by pileated
   * woodpeckers and bark beetles, and the holes are the single feature that says
   * "this has been dead a long time" rather than "this is a peeled log". Rare
   * and hard-edged; the excavated wood inside them is fresh and warm. */
  vec2 hw = pworley(p * vec2(2.0, 1.0), per * vec2(2.0, 1.0));
  float hid = pworleyId(p * vec2(2.0, 1.0), per * vec2(2.0, 1.0));
  float hole = step(0.955, hid) * (1.0 - smoothstep(0.09, 0.15, hw.x));
  albedo = mix(albedo, vec3(0.0250, 0.0175, 0.0110), hole);
  height -= hole * 0.55;

  /* The green cast. A snag on a coastal floor is not clean grey wood — it has
   * the same algal film everything else out here has, thinner and in the
   * shelter of the checks. Small, and the one thing keeping this off a pure
   * grey ramp. */
  float algae = smoothstep(0.54, 0.86, unit(pfbm(p * vec2(1.375, 0.625) + 37.0,
                                                 per * vec2(1.375, 0.625), 3)));
  albedo = mix(albedo, vec3(0.0330, 0.0400, 0.0280), algae * 0.42);

  /* Weathered wood is dead matte — the surface is a mat of loose broken fibres,
   * which is about the most efficient diffuser there is. The only thing here
   * that is not matte is the inside of a fresh check, where the wood is intact
   * and wet. */
  rough = 0.97 - fibre * 0.04;
  rough = mix(rough, 0.58, check * 0.55);

  /* Floor at 0.32, above bark's 0.24 and below the ground's. A snag has to sit
   * clearly lighter than the live trunks around it or the whole point of having
   * one is lost, and it gets there through occlusion rather than albedo for the
   * same reason everything else in this project does. */
  /* Held at roughly twice the bark's, which is the ratio that matters rather
   * than the absolute: a silver snag is the one pale vertical in the wood and
   * the contrast against the live boles is the whole reason to have one. It
   * came down with the bark rather than staying put, because a snag that is
   * four times the value of everything around it stops reading as wood. */
  ao = clamp(0.38 + 0.52 * height, 0.0, 1.0);
  ao *= 1.0 - 0.72 * check;
  ao *= 1.0 - 0.30 * shake;
  ao *= 1.0 - 0.75 * hole;
}
`;

export type TreeTextures = {
  bark: SurfaceSet;
  snag: SurfaceSet;
  moss: SurfaceSet;
  dispose(): void;
};

/**
 * Bake all three.
 *
 * The bark patch is the number that sets how big every feature on every trunk
 * in the wood is, so it is worth stating what it buys: 1.4 m over 1024 texels
 * is 1.37 mm a texel, which puts a 2 cm fissure at fifteen texels and a 8 cm
 * ridge at sixty. A trunk 1.5 m away fills about 400 pixels of a 1600-wide
 * frame across its 1.1 m of visible width, so the map is being magnified about
 * 1.5x at the closest the walk ever gets — which is the right place to be.
 *
 * `bump` is a height range in metres and 0.050 is the measured furrow depth on
 * a mature bole (the Oregon Coast Range study puts the largest furrow on an
 * average tree at 6.8 cm). It is a very strong normal map by the standards of
 * anything else in this project and it is supposed to be: the fissure is the
 * single deepest surface feature in the scene.
 *
 * The moss set is `propMaterials.ts`'s, imported rather than rewritten. The two
 * uses are genuinely the same material — a wet Hylocomium carpet on a nurse log
 * and one on a boulder are the same organism at the same age — and a second
 * copy of that surface would be two things to keep in step for no gain. It is
 * baked at a coarser patch here because a log is looked at from further away
 * than a stone in the tread, and because a cushion carpet on a metre-thick log
 * has bigger cushions on it than one on a 20 cm rock.
 */
export function bakeTrees(renderer: THREE.WebGLRenderer): TreeTextures {
  const bark = bakeSurface(renderer, BARK, {
    size: 1024, patch: 1.4, bump: 0.050, anisotropy: 16,
  });
  const snag = bakeSurface(renderer, SNAG, {
    size: 1024, patch: 1.4, bump: 0.022, anisotropy: 16,
  });
  const moss = bakeSurface(renderer, MOSS, {
    size: 512, patch: 0.42, bump: 0.014, anisotropy: 16,
  });
  return {
    bark, snag, moss,
    dispose() { bark.dispose(); snag.dispose(); moss.dispose(); },
  };
}

/* The needle mass, as a cutout.
 *
 * Baked as an RGBA image rather than a surface because it is a billboard: it
 * needs an alpha channel and it does not need a normal or an ORM, and inventing
 * a height field for a canopy sheet twenty metres overhead would be paying for
 * two targets that are never sampled.
 *
 * What has to be legible is only this: the roof is broken, and it is broken at
 * the scale of a branch rather than at the scale of a leaf. At the range this
 * is seen from — twenty to thirty metres, through two scale heights of fog —
 * an individual needle is a hundredth of a pixel and the only structure that
 * survives is the gap between one hanging spray and the next. So the alpha is
 * built from a sparse field of drooping sprays and not from a needle texture,
 * and the whole map is dark: a canopy seen from underneath is backlit by a
 * bright overcast and reads as a silhouette, exactly like the trunks do.
 */
export const CANOPY = /* glsl */ `
/* The card carries a whole *spray complex* — a branchlet with a dozen shoots on
 * it — rather than one frond.
 *
 * This is the third parameterisation of this map and the previous two failed
 * for the same underlying reason, which is worth stating once because it is not
 * obvious and it cost three rounds. The map was drawing *one botanical unit per
 * card*: first a rosette, then a frond. A card is a metre of geometry, so one
 * unit per card means the smallest thing in the canopy is a metre across — and
 * a metre-across foliage unit, seen against bright air with clean edges, is
 * individually resolvable at any distance in this scene. The report that came
 * back was "discrete black clumps hanging in mid-air", and separately that a
 * blade was about a sixth of a nearby trunk's apparent width. Both are the same
 * measurement: the unit is the card.
 *
 * ── What the literature does ──────────────────────────────────────────────
 *
 * Every production conifer renderer breaks the identity between card and unit.
 * SpeedTree's conifer leaf card is a *cluster* texture with many sprigs on it,
 * and its LOD works by removing interior cards and growing the survivors —
 * which only works because a card was never one leaf to begin with. The
 * cross-billboard libraries in the Three.js ecosystem do the same thing at
 * smaller scale: a leaf instance is two crossed planes carrying a cluster map,
 * and density is bought by instance count against a texture that is already
 * dense. The advice that turns up repeatedly on the art side is to spend
 * geometry on silhouette and resolution on the interior, never the reverse.
 *
 * So the card is now a branchlet system: an axis running along u, fourteen
 * shoots leaving it alternately left and right and swept towards the tip, each
 * shoot a solid filament with its own needle fringe. At the size the geometry
 * now draws these — 0.35 to 1.0 m rather than 0.2 to 2.1 — a shoot is eight to
 * twelve centimetres, which is what a Douglas-fir shoot actually measures, and
 * the resolvable unit in the frame is a shoot rather than a card.
 *
 * ── Why the shoot core is solid ───────────────────────────────────────────
 *
 * The halftone dot pattern the review found on the larger blades is what an
 * alpha *test* does to a map whose alpha spends most of its area within a few
 * hundredths of the threshold. The old map got there deliberately, on a
 * porosity argument, and the argument is wrong for a cut: mipping a field that
 * straddles the cut gives you a coverage fraction that then either all passes
 * or all fails per texel, and the speckle is the boundary between those. Here
 * each shoot has a solid two-texel core with the fringe outside it, so what
 * mips down is a filament of known width rather than a noise field, and the
 * coverage decays smoothly. The remaining loss is handed back by the footprint
 * term in Trees.tsx.
 */
vec4 shade(vec2 uv){
  float u = uv.x;
  float y = uv.y - 0.5;

  /* The branchlet itself. Solid, and the only part of the card that is: it is
   * what stops a complex seen edge-on from vanishing entirely. */
  float a = (1.0 - smoothstep(0.0035, 0.0090, abs(y))) * (1.0 - smoothstep(0.90, 1.0, u));

  /* Fourteen shoots. The number is set by the geometry it rides on: the cards
   * are 0.35-1.0 m and a Douglas-fir branchlet of that length carries twelve to
   * eighteen of the previous seasons' shoots, so this is a count read off the
   * plant rather than tuned against the frame. */
  const int N = 14;
  for (int i = 0; i < N; i++) {
    float fi = float(i);
    float h1 = fract(sin(fi * 12.9898 + 4.13) * 43758.5453);
    float h2 = fract(sin(fi * 78.2330 + 1.71) * 43758.5453);

    /* Where it leaves the axis, and which side. Alternating rather than random,
     * because conifer phyllotaxy is close to alternate and a randomly sided
     * sequence reads as a mess rather than as a plant. The jitter is on the
     * spacing, which is where the real variation lives. */
    float su = 0.04 + 0.88 * (fi + 0.30 + 0.40 * h1) / float(N);
    float side = mod(fi, 2.0) < 0.5 ? 1.0 : -1.0;

    /* The complex's envelope: narrow at the base, widest a third of the way
     * out, drawn to a point. This is the outline the silhouette is read from
     * and it is the reason the card does not need to be leaf-shaped. */
    float env = 0.470 * smoothstep(0.0, 0.19, su) * (1.0 - 0.88 * smoothstep(0.34, 1.0, su));
    float slen = env * (0.82 + 0.42 * h2);
    if (slen < 0.008) continue;

    /* Out to the side and swept towards the tip. The sweep is the single most
     * recognisable thing about conifer foliage against the sky — a shoot that
     * leaves at ninety degrees reads as a fern. */
    vec2 d = normalize(vec2(0.58 + 0.55 * h1, side));
    vec2 lp = vec2(u - su, y);
    float p = dot(lp, d);
    if (p < 0.0 || p > slen) continue;
    float q = dot(lp, vec2(-d.y, d.x));
    float pr = p / slen;

    /* Needle half-length off the shoot, tapering to the shoot's own tip. */
    float nl = 0.0285 * (0.62 + 0.44 * h2)
             * smoothstep(0.0, 0.12, pr) * (1.0 - 0.74 * smoothstep(0.52, 1.0, pr));
    /* The comb. Sheared by the across coordinate so a needle points outward and
     * forward at once. Two-and-a-half texels a needle at the bake size, which
     * is under a pixel on screen at every range this is ever seen from — it is
     * here to give the fringe a texture in the mip chain, not to be resolved. */
    float nd = abs(fract(p * 205.0 + abs(q) * 52.0) - 0.5) * 2.0;
    float needle = 1.0 - smoothstep(0.20, 0.72, nd);
    float fringe = needle * (1.0 - smoothstep(nl * 0.55, nl, abs(q)));
    /* And the solid core. See the header: this is what survives mipping. */
    float core = 1.0 - smoothstep(nl * 0.26, nl * 0.48, abs(q));
    a = max(a, max(core, fringe) * (1.0 - smoothstep(0.88, 1.0, pr)));
  }

  /* One coarse field, and its authority is small on purpose. Real crowns are
   * shaded out unevenly and whole sectors of a complex die back, but a strong
   * low-frequency modulation on an alpha cut is what produced the "clumps of
   * dark leaves" reading twice already: it survives mipping when the structure
   * does not, so at distance it becomes the only thing left and the card turns
   * back into a blob. */
  float gap = unit(pfbm(vec2(u * 5.0, uv.y * 3.0), vec2(40.0, 24.0), 3));
  a *= 0.86 + 0.24 * gap;

  /* Dark, and barely green. Backlit conifer foliage against a bright overcast
   * has almost no chroma left in it — but the subcanopy crowns now stand at
   * five to twenty metres where the fog has not taken it yet, so there is a
   * little more here than the pure silhouette argument would allow. */
  float fine = unit(pfbm(uv * 42.0, vec2(42.0), 2));
  vec3 col = mix(vec3(0.0046, 0.0058, 0.0042), vec3(0.0104, 0.0128, 0.0086), fine);
  return vec4(col, clamp(a, 0.0, 1.0));
}
`;

