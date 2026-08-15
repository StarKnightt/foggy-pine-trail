/* Does the trench vary along its length, or is it extruded?
 *
 * `node tools/vary.mjs`
 *
 * `xsect.mjs` answers whether the cross-section is the right *shape* at a handful
 * of stations, and it passed while the trail still read as a drainage channel. The
 * defect it cannot see is invariance: two dark parallel wall-bands running from the
 * camera to the vanishing point with no break, no widening and no stretch where the
 * tread comes flush with the floor. That regularity, not the depth, is what reads
 * as a channel, and it is a statement about the *sequence* of cross-sections rather
 * than about any one of them.
 *
 * So this walks the whole trail at a fine step and reports, for each station, the
 * incised depth and the width of the disturbed corridor. What matters is the spread
 * and specifically how much of the length is essentially flush — a trail that is
 * cut everywhere is the failure, however correct each individual section measures.
 */
import { run, finish } from './harness.mjs';

const STEP = 0.5;
/* Flush means you would not notice a step. 2 cm over the width of a boot is at the
 * limit of what reads as a cut at all in a photograph. */
const FLUSH_CM = 2.0;

await run({ width: 640, height: 400 }, async ({ page }) => {
  const rows = await page.evaluate((step) => {
    const s = window.__scene;
    const out = [];
    for (let a = 1; a < 47; a += step) {
      /* Half a metre either side at 2 cm, which resolves both the base and the top
       * of the bank. The reference is the median of the outer shoulders, the same
       * robust estimator `xsect` settled on after mean-based references were
       * skewed by root lips. */
      const xs = s.crossSection(a, 1.2, 0.02);
      const mid = (xs.length - 1) / 2;
      const shoulder = [];
      for (let i = 0; i < xs.length; i++) {
        const off = Math.abs(i - mid) * 0.02;
        if (off > 0.62 && off < 1.15) shoulder.push(xs[i]);
      }
      shoulder.sort((p, q) => p - q);
      const ref = shoulder[(shoulder.length / 2) | 0];
      let lo = Infinity;
      for (let i = mid - 20; i <= mid + 20; i++) lo = Math.min(lo, xs[i]);
      const depth = (ref - lo) * 100;
      /* Corridor width: how far out the surface is still measurably below the
       * shoulder reference. */
      let w = 0;
      for (let i = mid; i < xs.length; i++) {
        if (xs[i] < ref - 0.012) w = (i - mid) * 0.02;
      }
      out.push({ a: +a.toFixed(1), depth: +depth.toFixed(1), width: +(w * 200).toFixed(0) });
    }
    return out;
  }, STEP);

  const d = rows.map((r) => r.depth);
  const w = rows.map((r) => r.width);
  const q = (arr, f) => { const s = arr.slice().sort((a, b) => a - b); return s[(s.length * f) | 0]; };
  const flush = rows.filter((r) => r.depth < FLUSH_CM).length;

  console.log('\n  incised depth and corridor width every 0.5 m down the trail\n');
  let line = '  depth/cm ';
  for (let i = 0; i < rows.length; i += 2) {
    const v = rows[i].depth;
    line += v < 2 ? '.' : v < 5 ? '_' : v < 9 ? '-' : v < 14 ? '=' : '#';
  }
  console.log(line);
  line = '  width/cm ';
  for (let i = 0; i < rows.length; i += 2) {
    const v = rows[i].width;
    line += v < 50 ? '.' : v < 80 ? '_' : v < 110 ? '-' : v < 145 ? '=' : '#';
  }
  console.log(line);
  console.log('\n  legend  depth . <2  _ <5  - <9  = <14  # 14+ cm');

  console.log(`\n  depth   p05=${q(d, 0.05)} p50=${q(d, 0.5)} p95=${q(d, 0.95)}`
    + `  min=${Math.min(...d)} max=${Math.max(...d)} cm`);
  console.log(`  width   p05=${q(w, 0.05)} p50=${q(w, 0.5)} p95=${q(w, 0.95)}`
    + `  min=${Math.min(...w)} max=${Math.max(...w)} cm`);
  console.log(`  flush   ${flush}/${rows.length} stations under ${FLUSH_CM} cm`
    + ` (${Math.round((100 * flush) / rows.length)}% of the length)`);
});

finish(process.exitCode || 0);
