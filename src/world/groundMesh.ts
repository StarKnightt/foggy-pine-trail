/* The forest floor as geometry.
 *
 * ── Why the grid is graded ────────────────────────────────────────────────
 *
 * The trail is 0.86 m wide and its bank is 85 mm high, and a root crossing
 * it is 45 mm. Sampling that at a uniform spacing fine enough to hold it —
 * call it 12 cm — over the whole 88 x 84 m world is 500,000 vertices, and
 * every one of the ones past thirty metres is behind fog so thick that the
 * ground there is a flat grey field. It is the entire vertex budget spent on
 * the part of the frame nobody can see.
 *
 * So the columns are graded. Finest across the corridor the trail wanders in,
 * coarser out to five and a half metres, then growing geometrically to three
 * metres a step at the world edge.
 * The rows stay uniform because the walk moves along them — there is no "far"
 * in z, every row is close at some point in the walk.
 *
 * The grid is regular in topology, which matters: a quadtree or a stitched
 * two-resolution mesh would need seam handling, and a seam in a ground plane
 * under grazing fog light is a visible crack.
 *
 * ── The blend weight ──────────────────────────────────────────────────────
 *
 * `aTread` is where the trail is, computed per vertex from the same distance
 * field the height function used. It is the *only* thing that tells the
 * material where the path is, so the tread texture and the trough geometry
 * cannot drift out of register — which they absolutely would if the shader
 * re-derived the path from a world-space noise.
 *
 * It has a soft edge, and the softness is asymmetric: the tread gives way to
 * litter over about 40 cm on the outside, because that is a real gradient —
 * needles blow in from the edge and the boot traffic thins out. A hard edge
 * reads as a stencil.
 */
import * as THREE from 'three';
import { groundHeight, trailShape } from './ground';
import { trail } from './trail';
import { DIMS } from './dims';
import { Noise2D, clamp, smoothstep } from './noise';

/* Only used to wander the litter boundary. Its own instance rather than the
 * ground's, because sharing one would tie the edge of the trail to the duff
 * roughness and the two have nothing to do with each other. */
const edgeNoise = new Noise2D(0x0edd6e);

/** Column positions in x, fine near the trail corridor and coarse outside. */
function columns(): Float32Array {
  /* Centred on the mean of the trail's wander rather than on zero. The trail
   * runs from x = -0.5 to x = -3.2, so a grid centred on the origin would
   * spend its fine columns half a corridor to the right of the corridor. */
  const centre = -1.4;
  /* Three tiers, not two. The trail's bank is `trailBank` = 16 cm wide and
   * carries the whole rise out of the tread, so at the 13 cm columns that used
   * to run the full 5 m the raised cosine was spanned by barely one sample and
   * collapsed into a single flat facet — and because the trail wanders in x, the
   * facet fell at a different phase on every row. That is the terraced contour
   * banding along the trail lip: it is a sampling artefact, not a material one.
   * 6 cm gives the bank three samples.
   *
   * The corridor band has to be 2.7 m each side of `centre`, not the 0.9 m the
   * corridor is wide, because the trail wanders from x = -0.5 to x = -3.2 and
   * these columns are fixed in world x rather than following the curve.
   *
   * Rows stay at 22 cm: z is the along-trail direction to within 3° over the
   * whole length, so row spacing samples a direction the profile is constant in.
   */
  const bandHalf = 2.7;
  const fineHalf = 5.5;
  const bank = 0.06;
  const fine = 0.13;
  /* The coarse tier's ceiling, and it is set by the *silhouette* rather than by
   * how much relief the surface needs.
   *
   * At 3 m a column is 58 px wide where the ground meets the air thirty-five
   * metres out, so the terrain's upper envelope up there was drawn as a
   * polyline of 58 px flat segments — which is a staircase with the occasional
   * flat-topped trapezoid standing proud, and it is exactly what the review
   * reported once the fog stopped hiding it. The surface itself was fine; it is
   * only ever seen at a grazing angle out there, and a grazing angle is where a
   * facet's silhouette is at its most visible and its shading at its least.
   *
   * 1.1 m brings that down to 21 px, below the width of the terrain features
   * doing the varying, so the envelope samples the field rather than
   * quantising it. Costs 36 columns a side: 85k vertices against 71k, on a
   * mesh that is 4 of the scene's 60 draw calls and none of its cost. */
  const growth = 1.16;
  const maxStep = 1.1;

  const right: number[] = [];
  let x = 0;
  while (x < bandHalf) { right.push(x); x += bank; }
  while (x < fineHalf) { right.push(x); x += fine; }
  let step = fine;
  while (x < DIMS.worldHalf) {
    right.push(x);
    step = Math.min(step * growth, maxStep);
    x += step;
  }
  right.push(DIMS.worldHalf);

  const out: number[] = [];
  for (let i = right.length - 1; i > 0; i--) out.push(centre - right[i]);
  for (let i = 0; i < right.length; i++) out.push(centre + right[i]);
  return Float32Array.from(out);
}

export type GroundGeometry = {
  geometry: THREE.BufferGeometry;
  vertices: number;
};

export function buildGroundGeometry(): GroundGeometry {
  const xs = columns();
  /* 22 cm, and it was worth proving rather than assuming: the transverse
   * corduroy banding on the tread survived a test at 9 cm completely unchanged
   * while costing 200k triangles, which rules the geometry out and puts the
   * artefact in the material. Only the *columns* need to be fine, because only
   * the cross-trail profile has centimetre-scale structure in it. */
  const dz = 0.22;
  const rows = Math.round((DIMS.zMax - DIMS.zMin) / dz) + 1;
  const cols = xs.length;

  const count = rows * cols;
  const pos = new Float32Array(count * 3);
  const nrm = new Float32Array(count * 3);
  const tread = new Float32Array(count);
  const wet = new Float32Array(count);

  const tr = trail();

  /* Where water sits on the tread, as a 1-D profile down the trail.
   *
   * Measured defect this exists to fix: the near-tread value across eight
   * stations spanned 70-81 out of 255, a range of 11 and a ratio of 1.16. That is
   * a ribbon of constant brightness, and a continuous pale stripe against a dark
   * field reads as an object lying *on* the floor no matter how correct the
   * cross-section underneath it measures. It was the last reason the trail still
   * read as a raised causeway rather than as a bench cut into the duff.
   *
   * Driven off the centreline's own relief rather than off a free-running noise,
   * so the dark stretches land where water would actually collect: a station that
   * sits below the running mean of its neighbours is a sag that drains into
   * itself and stays saturated for weeks, and one that sits above it sheds and
   * dries. Sampled every 25 cm and smoothed over +/-4 m, which is the length over
   * which a walker reads "this stretch is wet" rather than "this puddle".
   *
   * A 1-D profile because the alternative — asking groundHeight for a
   * neighbourhood mean per vertex — is three more height evaluations across
   * 200k vertices, and the quantity only varies along the trail. */
  const SP = 0.25;
  const np = Math.max(2, Math.round(DIMS.trailLength / SP) + 1);
  const centre = new Float32Array(np);
  for (let i = 0; i < np; i++) {
    const c = tr.pointAtAlong(i * SP);
    centre[i] = groundHeight(c.x, c.z);
  }
  const half = Math.round(4.0 / SP);
  const sag = new Float32Array(np);
  for (let i = 0; i < np; i++) {
    let acc = 0, n = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(np - 1, i + half); j++) {
      acc += centre[j]; n++;
    }
    /* Positive where the trail sits below its neighbourhood. Normalised by 6 cm
     * because that is the amplitude the sag actually has once the trail has been
     * cut into the macro relief, so the term spans its range instead of living in
     * the bottom tenth of it. */
    sag[i] = clamp((acc / n - centre[i]) / 0.045, -1, 1);
  }

  for (let r = 0; r < rows; r++) {
    const z = DIMS.zMax - r * dz;
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const x = xs[c];
      const y = groundHeight(x, z);
      pos[i * 3] = x;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = z;

      /* One curve evaluation, reused by the tread weight, the shape and the
       * drainage below. `distance()` and `at()` both walk the bucketed field, and at
       * 200k vertices three separate calls is three times the build cost for one
       * answer. */
      const st = tr.at(x, z);
      const d = st.dist;
      /* Full tread across the level base and a third of the way up the bank,
       * handing over to litter at the top of the bank.
       *
       * This has to end where the *geometry* ends and it is worth being exact
       * about, because the pale mineral material is what the eye takes as the
       * edge of the trail — not the shape. Running it 45 cm past the tread, as
       * it did, laid bare soil all the way up the bank and over the berm, so the
       * visible path was 1.26 m wide with steeply sloping outer thirds: a V, and
       * a V half again as wide as the trail it was drawn on.
       *
       * But it is not a hand's width either, which is what it was tightened to.
       * A transect measured across a real trail edge runs 142, 122, 107 out of
       * 255 in value and 0.07, 0.17, 0.29 in saturation from swept tread to
       * litter mass: the boundary is a *saturation ramp over 300-500 mm*, not a
       * value step, and it is carried by litter drifting onto the tread rather
       * than by the mineral soil stopping. Litter coverage grades from 5-20% at
       * the swept centreline to 60-90% at the edge, so the handover starts on
       * the flat base and finishes past the top of the bank. A 16 cm crossfade
       * gave the clean geometric crease with nothing lying across it. */
      /* The boundary also wanders by ±11 cm at a 1.4 m wavelength. Nothing else
       * in the scene has two parallel straight edges 86 cm apart, and drawing
       * the litter line at a constant distance from the centreline gave the
       * trail exactly that — a stripe, which reads as paint on the floor rather
       * than as the place where the litter stops. Real trail edges scallop: the
       * duff creeps in where nobody's boot goes and gets pushed back where they
       * cut a corner. Two octaves at different scales so the scallop has both a
       * lobe size and a ragged sub-lobe, since a single smooth wobble reads as a
       * deliberate curve. */
      const wander = edgeNoise.fbm(x * 0.72, z * 0.72, 2) * 0.075
        + edgeNoise.fbm(x * 3.1 + 40, z * 3.1, 2) * 0.035;
      /* Tracks the geometry's own width down the trail. The bare mineral material is
       * what the eye takes as the width of the path — more than the shape is — so a
       * trough that narrows under a stripe of constant width would still read as a
       * constant-width trail with a mis-fitting trench in it. */
      const alongV = st.t * DIMS.trailLength;
      const shape = trailShape(alongV);
      tread[i] = 1 - smoothstep(DIMS.trailFlat * 0.62 * shape.width,
                                DIMS.trailHalf * shape.width + 0.20, d + wander);

      /* Sag down the trail, plus the dish across it: water collects along the
       * centreline of the base and drains off the bank, so the wettest ground is
       * a sagging stretch's middle and the driest is the lip of a stretch that
       * sheds. Multiplied rather than added, because a bank stays drained even in
       * a wet stretch and a dish holds nothing on a stretch that drains. */
      const k = clamp(alongV / SP, 0, np - 1);
      const k0 = Math.floor(k);
      const s = sag[k0] + (sag[Math.min(np - 1, k0 + 1)] - sag[k0]) * (k - k0);
      /* Only a light cross-trail weighting. At the 0.65 this carried, the wet
       * term became a dark stripe down the centreline flanked by pale lips, which
       * reads as a gutter — the V-channel defect arriving through the material
       * after the geometry had been fixed. The variation that matters is along the
       * length; the dish only decides where inside a wet stretch the water sits. */
      const dishIn = 1 - smoothstep(0, DIMS.trailHalf, d);
      wet[i] = clamp(s * 0.5 + 0.5, 0, 1) * (0.80 + 0.20 * dishIn);
    }
  }

  /* Normals from the height function rather than from the triangles.
   *
   * Face normals averaged over a graded grid are wrong in a specific and
   * visible way: the columns are 6 cm apart near the trail and 3 m apart at
   * the edge, so the same slope produces a differently weighted average at
   * each end and the shading changes across the grading boundary even though
   * the surface does not. Differencing the analytic height at a fixed 6 cm
   * everywhere gives one answer that does not know the grid exists.
   */
  const e = 0.06;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const x = pos[i * 3], z = pos[i * 3 + 2];
      const nx = groundHeight(x - e, z) - groundHeight(x + e, z);
      const nz = groundHeight(x, z - e) - groundHeight(x, z + e);
      const ny = 2 * e;
      const l = Math.hypot(nx, ny, nz) || 1;
      nrm[i * 3] = nx / l;
      nrm[i * 3 + 1] = ny / l;
      nrm[i * 3 + 2] = nz / l;
    }
  }

  const idx = new Uint32Array((rows - 1) * (cols - 1) * 6);
  let k = 0;
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c, b = a + 1, d = a + cols, e2 = d + 1;
      /* Winding: rows advance towards -z while columns advance towards +x, so
       * the two edge vectors of a quad cross to point *down*. Ordering a-b-d
       * rather than the a-d-b that the loop indices suggest is what puts the
       * face normal up. Getting this wrong does not produce inverted shading —
       * the vertex normals are analytic and stay correct — it produces an
       * invisible ground, because every triangle is back-facing and culled,
       * and the frame then shows nothing but fog with a few slivers of terrain
       * seen edge-on. It reads exactly like a lighting or texture failure.
       *
       * Diagonal flipped per cell on a checkerboard. A grid whose quads all
       * split the same way has a systematic diagonal in its shading, and on a
       * near-flat surface lit by a uniform sky — which is exactly this scene —
       * it shows as faint corduroy running at 45 degrees. */
      if (((r + c) & 1) === 0) {
        idx[k++] = a; idx[k++] = b; idx[k++] = d;
        idx[k++] = b; idx[k++] = e2; idx[k++] = d;
      } else {
        idx[k++] = a; idx[k++] = e2; idx[k++] = d;
        idx[k++] = a; idx[k++] = b; idx[k++] = e2;
      }
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('aTread', new THREE.BufferAttribute(tread, 1));
  g.setAttribute('aWet', new THREE.BufferAttribute(wet, 1));
  /* A uv attribute three will not use — the ground shader derives its own from
   * world position — but which has to exist, because `MeshStandardMaterial`
   * with any map set compiles `#include <uv_vertex>` and that reads `uv`. */
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingSphere();

  return { geometry: g, vertices: count };
}
