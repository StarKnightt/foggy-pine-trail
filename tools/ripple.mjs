/*
 * Samples groundHeight straight down the trail centreline and prints the
 * along-trail profile in millimetres, plus the first differences.
 *
 * Written because the transverse corduroy banding on the tread survived both a
 * halving of the mesh row spacing and a fix to the tangent continuity, which
 * ruled out the two structural explanations and left no way to proceed except to
 * look at the numbers the height function actually returns. A periodic ripple
 * shows up in the differences as a sign alternation at a fixed period; a smooth
 * profile does not.
 */
import { run, finish } from './harness.mjs';

const STEP = 0.02;
const SPAN = 6.0;

await run({ width: 640, height: 400 }, async ({ page }) => {
  const rows = await page.evaluate(({ step, span }) => {
    const out = [];
    for (let a = 2.0; a < 2.0 + span; a += step) {
      // Middle sample of a three-wide cross-section is the centreline height.
      const xs = window.__scene.crossSection(a, step, step);
      out.push([a, xs[(xs.length - 1) / 2] * 1000]);
    }
    return out;
  }, { step: STEP, span: SPAN });

  console.log('\n  along-trail centreline profile, millimetres');
  console.log('  along     h      dh');
  let prev = null;
  let flips = 0, lastSign = 0;
  for (const [a, h] of rows) {
    const dh = prev === null ? 0 : h - prev;
    if (prev !== null) {
      const sg = Math.sign(dh);
      if (sg !== 0 && lastSign !== 0 && sg !== lastSign) flips++;
      if (sg !== 0) lastSign = sg;
    }
    console.log(`  ${a.toFixed(2)}  ${h.toFixed(1).padStart(7)}  ${dh.toFixed(2).padStart(6)}`);
    prev = h;
  }
  console.log(`\n  sign changes in dh: ${flips} over ${SPAN} m`);
  console.log(`  implies a mean ripple period of ${(2 * SPAN / Math.max(1, flips)).toFixed(3)} m`);
});
