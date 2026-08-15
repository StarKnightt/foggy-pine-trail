/* Read numbers out of the running page.
 *
 * `node tools/px.mjs "<expression>"` evaluates the expression with `s` bound
 * to `window.__scene` and prints the JSON result. For the questions that a
 * screenshot cannot answer — what is actually in a baked texture, what value a
 * uniform holds, whether a chunk replacement took — this is the tool, and
 * reaching for it early is consistently faster than reasoning about the
 * shader.
 */
import { run, finish } from './harness.mjs';

const expr = process.argv.slice(2).filter((a) => !a.startsWith('--')).join(' ');
if (!expr) {
  console.error('usage: node tools/px.mjs "<expression using s>"');
  process.exit(1);
}

await run({ width: 900, height: 520 }, async ({ page }) => {
  const out = await page.evaluate((src) => {
    try {
      const r = new Function('s', 'THREE', 'return (' + src + ')')(
        window.__scene, window.__THREE,
      );
      return JSON.stringify(r, (k, v) => (typeof v === 'number' ? +v.toFixed(5) : v), 2);
    } catch (e) {
      return 'THREW: ' + (e && e.stack ? e.stack : String(e));
    }
  }, expr);
  console.log(out);
});

finish(process.exitCode || 0);
