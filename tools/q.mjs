/* One framing, one query string, one PNG — so a dev switch can be measured
 * with the same region tool as a shipped capture.
 *
 *   node tools/q.mjs out --q "ug=noocc" [--t 0.60] [--pitch 0] [--w 1600] [--h 900]
 *
 * `fogdiff.mjs` answers "did this term move any pixels", which is the question
 * that catches an inert term. It cannot answer "what does the fern measure with
 * the term off", which is the question that decides how much of the term to
 * keep, and that one needs an image the region tools can read.
 */
import { writeFile } from 'node:fs/promises';
import { run, finish, DEV_URL } from './harness.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };

const OUT = args[0] && !args[0].startsWith('--') ? args[0] : 'q';
const Q = flag('q', '');
const T = +flag('t', 0.60);
const PITCH = +flag('pitch', 0);
const W = +flag('w', 1600), H = +flag('h', 900);

await run({ width: W, height: H, url: Q ? `${DEV_URL}/?${Q}` : DEV_URL }, async ({ page }) => {
  const shot = await page.evaluate(([t, p]) => {
    const s = window.__scene;
    s.setPaused(true);
    s.goTo(t); s.setYaw(s.walker.yaw); s.setPitch(p); s.warp(2.0);
    s.renderOnce();
    const url = s.renderer.domElement.toDataURL('image/png');
    s.setPaused(false);
    return url;
  }, [T, PITCH]);
  const path = `shots/_${OUT}.png`;
  await writeFile(path, Buffer.from(shot.slice(shot.indexOf(',') + 1), 'base64'));
  console.log(`\n  ${path}  t=${T} pitch=${PITCH} q=${Q || '(shipped)'}\n`);
});

finish(process.exitCode || 0);
