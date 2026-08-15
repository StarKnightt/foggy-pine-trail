/* Does the ground actually rise into the stones?
 *
 * `node tools/collar.mjs`
 *
 * Written because of the root swell, which was authored, was correct in the
 * height function, and was never built: its half-width was 16 cm against a 22 cm
 * mesh row spacing, so it fell between rows and the tubes ended up standing on
 * earth that existed only in code. The frame showed a row of croquet hoops with
 * daylight under them and nothing about the source suggested a sampling problem.
 *
 * So a collar is not proved by reading the code or by looking at a render. It is
 * proved by two numbers: the rise the height function reports at the stone, and
 * the rise that survives being sampled on the mesh's own row spacing. If the
 * second is much smaller than the first, the collar is in the same trap.
 */
import { run, finish } from './harness.mjs';

/* The mesh steps 22 cm along z. Sampling the profile at exactly that spacing is
 * what the ground geometry does, so it reproduces the failure if there is one. */
const ROW = 0.22;

await run({ width: 640, height: 400 }, async ({ page }) => {
  const out = await page.evaluate((row) => {
    const s = window.__scene;
    const stones = s.bigStones();
    if (!stones.length) return { error: 'no big stones generated' };

    /* The biggest few, since those are the ones the audit called faceted tents
     * and the ones whose collar has the most to prove. */
    const pick = stones.slice().sort((a, b) => b.size - a.size).slice(0, 6);
    const rows = [];
    for (const st of pick) {
      /* Walk out from the stone in +x, which is across the rows, and compare the
       * continuous profile against one sampled on the row grid. */
      const probe = (dx, dz) => s.height(st.wx + dx, st.wz + dz);
      const at = probe(0, 0);
      let far = 0;
      for (const d of [1.2, -1.2, 0, 0]) far += probe(d, d === 0 ? 1.2 : 0);
      far /= 4;
      /* Same measurement, but only allowed to see positions the mesh has a row
       * at. If the collar is narrower than a row it disappears here. */
      const snap = (v) => Math.round(v / row) * row;
      const atSnap = s.height(snap(st.wx), snap(st.wz));
      let farSnap = 0;
      for (const d of [1.2, -1.2, 0, 0]) {
        farSnap += s.height(snap(st.wx + d), snap(st.wz + (d === 0 ? 1.2 : 0)));
      }
      farSnap /= 4;
      rows.push({
        size: +(st.size * 100).toFixed(1),
        side: +st.side.toFixed(2),
        rise: +((at - far) * 1000).toFixed(1),
        riseSnapped: +((atSnap - farSnap) * 1000).toFixed(1),
      });
    }
    return { rows, total: stones.length };
  }, ROW);

  if (out.error) { console.error('  ' + out.error); process.exitCode = 1; return; }

  console.log(`\n  ${out.total} stones with a collar. Rise at the stone vs 1.2 m out, in mm.`);
  console.log('  "snapped" samples only on the 22 cm mesh rows, which is what gets built.\n');
  console.log('   size/cm  side/m    rise   snapped');
  for (const r of out.rows) {
    console.log(`   ${String(r.size).padStart(6)}  ${String(r.side).padStart(6)}`
      + `  ${String(r.rise).padStart(6)}   ${String(r.riseSnapped).padStart(6)}`);
  }
  const keep = out.rows.filter((r) => r.rise > 4);
  const survived = keep.filter((r) => r.riseSnapped > r.rise * 0.5).length;
  console.log(`\n  ${survived}/${keep.length} collars survive the mesh row spacing`
    + ' (over half the continuous rise)');
});

finish(process.exitCode || 0);
