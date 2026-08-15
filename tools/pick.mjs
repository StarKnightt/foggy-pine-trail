/* What is that? — a raycast at a point in the frame.
 *
 *   node tools/pick.mjs --t 0.60 [--pitch 0] --at 0.72,0.48 [--at ...]
 *
 * Every review round so far has cost an hour to an artefact that could not be
 * named from the picture: "the pentagons" were stub end caps, "the wires" were
 * truncated poles, and "the trapezoid plateau" below was guessed at three times
 * before being measured. The frame cannot say which builder drew a thing, but a
 * ray can: the merged buffers are one per tile per family, so the family alone
 * separates canopy from wood, and the hit's height above `groundHeight` plus
 * its vertex attributes separate a log from a bole from a limb.
 */
import { writeFile } from 'node:fs/promises';
import { run, finish } from './harness.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const ats = [];
for (let i = 0; i < args.length; i++) if (args[i] === '--at') ats.push(args[i + 1].split(',').map(Number));
if (!ats.length) ats.push([0.5, 0.5]);

const T = +flag('t', 0.6);
const PITCH = +flag('pitch', 0);

await run({ width: 1024, height: 576 }, async ({ page }) => {
  const out = await page.evaluate(([t, pitch, ats]) => {
    const s = window.__scene;
    const THREE = window.__THREE;
    s.setPaused(true);
    s.goTo(t);
    s.setYaw(s.walker.yaw);
    s.setPitch(pitch);
    s.warp(2.0);
    s.renderOnce();

    const rc = new THREE.Raycaster();
    rc.far = 300;
    const res = [];
    for (const [fx, fy] of ats) {
      rc.setFromCamera(new THREE.Vector2(fx * 2 - 1, 1 - fy * 2), s.camera);
      /* A 3x3 fan a third of a pixel apart rather than a single ray.
       * A twelve-pixel stem at twenty metres is a target a third of a degree
       * across and the frame coordinate read off a magnified crop is not that
       * accurate; a single ray slipping past the thing being asked about and
       * hitting the trunk behind it is how the last two artefacts were
       * misattributed. The nearest hit over the fan is the answer. */
      let hits = [];
      for (let q = 0; q < 9; q++) {
        const ox = ((q % 3) - 1) * 0.0006, oy = (((q / 3) | 0) - 1) * 0.001;
        rc.setFromCamera(new THREE.Vector2((fx + ox) * 2 - 1, 1 - (fy + oy) * 2), s.camera);
        hits = hits.concat(rc.intersectObject(s.scene, true).filter((h) => h.object.visible));
      }
      hits.sort((a, b) => a.distance - b.distance);
      if (!hits.length) { res.push({ at: [fx, fy], miss: true }); continue; }
      const h = hits[0];
      const g = h.object.geometry;
      const has = (n) => !!(g.getAttribute && g.getAttribute(n));
      const attr = (n) => {
        const a = g.getAttribute(n);
        if (!a || h.face == null) return null;
        return +a.getX(h.face.a).toFixed(3);
      };
      res.push({
        at: [fx, fy],
        name: h.object.name || '(unnamed)',
        parent: h.object.parent?.name || '',
        dist: +h.distance.toFixed(2),
        p: [+h.point.x.toFixed(2), +h.point.y.toFixed(2), +h.point.z.toFixed(2)],
        ground: s.groundHeight ? +s.groundHeight(h.point.x, h.point.z).toFixed(2) : 0,
        family: has('aTread') ? 'ground' : has('aMoss') ? 'wood/canopy' : 'other',
        occ: attr('aOcc'), weather: attr('aWeather'), moss: attr('aMoss'),
        tone: attr('aTone'),
        mat: h.object.material?.name || h.object.material?.type,
        alphaTest: h.object.material?.alphaTest ?? null,
        tris: g.index ? g.index.count / 3 : 0,
        /* The three corners of the hit triangle, in world space. A cap is the
         * one thing in this geometry whose vertices all share a y, so this is
         * what separates "the stem ends here" from "the stem is behind
         * something": guessing between those two cost the last two rounds. */
        face: h.face ? ['a', 'b', 'c'].map((q) => {
          const i = h.face[q];
          const p = new THREE.Vector3().fromBufferAttribute(g.getAttribute('position'), i);
          h.object.localToWorld(p);
          return [+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2)];
        }) : null,
      });
    }
    /* The frame the rays were actually cast into, returned with them.
     * Two rounds were lost to reading a coordinate off a magnified capture and
     * aiming it into a viewport that turned out to be framed differently; the
     * only way to be sure the ray went where it was pointed is to mark it in
     * the picture the ray saw. */
    s.renderOnce();
    const shot = s.renderer.domElement.toDataURL('image/png');
    s.setPaused(false);
    return { res, shot };
  }, [T, PITCH, ats]);

  const png = out.shot.slice(out.shot.indexOf(',') + 1);
  await writeFile('shots/_pick.png', Buffer.from(png, 'base64'));
  console.log('\n  frame the rays saw: shots/_pick.png');
  for (const r of out.res) {
    if (r.miss) { console.log(`  ${r.at}  — nothing`); continue; }
    console.log(`  at ${r.at[0]},${r.at[1]}  ${r.dist} m  world ${r.p.join(', ')}  ground y=${r.ground}  (${(r.p[1] - r.ground).toFixed(2)} above)`);
    console.log(`      mesh ${r.name}  family ${r.family}  mat ${r.mat} alphaTest ${r.alphaTest}  tris ${r.tris}`);
    console.log(`      aOcc ${r.occ}  aWeather ${r.weather}  aMoss ${r.moss}  aTone ${r.tone}`);
    if (r.face) console.log(`      face ${r.face.map((v) => v.join('/')).join('  ')}`);
  }
  console.log('');
});

finish(process.exitCode || 0);
