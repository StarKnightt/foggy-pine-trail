/* Differenced pairs. The only thing that has ever caught an inert term here.
 *
 *   node tools/fogdiff.mjs --b "fog=noheight" [--a ""] [--t 0.42] [--pitch 0]
 *
 * Renders the same camera twice — once with the shipped fog, once with one
 * term switched off by query string — and reports how many pixels moved and by
 * how much. The switches substitute constants into the same GLSL, so the two
 * programs are structurally identical and a measured difference cannot be an
 * artifact of having compiled a different shader.
 *
 * This project has shipped four separate code paths that typechecked, read
 * correctly and changed zero pixels. Every one of them would have been caught
 * by a number in the "changed" column being zero.
 *
 * Both frames come from the same browser and the same page, navigated between
 * the two URLs, so the adapter, the driver state and the texture bakes are
 * identical across the pair.
 */
import { run, finish, DEV_URL } from './harness.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };

const A = flag('a', '');
const B = flag('b', '');
const T = +flag('t', 0.42);
const PITCH = +flag('pitch', 0);
const W = +flag('w', 1024), H = +flag('h', 576);

const url = (q) => (q ? `${DEV_URL}/?${q}` : DEV_URL);

await run({ width: W, height: H, url: url(A) }, async ({ page }) => {
  /* Driven clock, not `renderOnce`.
   *
   * `renderOnce` re-poses the camera and redraws, but it does not advance the
   * frame clock, so every time-driven uniform in the scene — the wind sway on
   * the trees and the undergrowth, the particle field, the grain seed — holds
   * whatever phase the rAF loop happened to leave it at. Across two page loads
   * that is an arbitrary offset, and it measured as a floor of mean|dY| = 1.7
   * over 96% of the frame: larger than most of the terms this tool exists to
   * test, and identical for all of them. Six differences were run against it
   * and reported the same number, which is the instrument failing in the
   * direction that looks like a result.
   *
   * `setDriven` zeroes a virtual clock and hands r3f its delta, so stepping a
   * fixed number of fixed steps puts every subscriber at a reproducible phase.
   * Paused as well, so the walker itself does not integrate. */
  const shoot = async () => page.evaluate(async ([T, P]) => {
    const s = window.__scene;
    const r = s.renderer, gl = r.getContext();
    const tick = () => new Promise((res) => requestAnimationFrame(() => res()));
    s.setPaused(true);
    s.setDriven(true);
    await tick(); await tick(); // frameloop flips through React state
    s.goTo(T); s.setYaw(s.walker.yaw); s.setPitch(P); s.warp(2.0);
    for (let i = 0; i < 30; i++) s.step(1 / 60);
    const w = r.domElement.width, h = r.domElement.height;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    s.setDriven(false);
    s.setPaused(false);
    /* Base64 rather than an array of a million numbers: the JSON round trip
     * for the array form takes longer than the render does. */
    let bin = '';
    for (let i = 0; i < px.length; i += 4) {
      bin += String.fromCharCode(px[i], px[i + 1], px[i + 2]);
    }
    return { w, h, b64: btoa(bin) };
  }, [T, PITCH]);

  const a = await shoot();
  await page.goto(url(B), { waitUntil: 'domcontentloaded' });
  page.getByRole('button', { name: /load it anyway/i })
    .click({ timeout: 8000 }).then(() => {}, () => {});
  await page.waitForFunction(() => !!window.__scene, null, { timeout: 90_000 });
  await page.waitForTimeout(2000);
  const b = await shoot();

  const pa = Buffer.from(a.b64, 'base64');
  const pb = Buffer.from(b.b64, 'base64');
  const { w, h } = a;

  const lum = (p, k) => 0.2126 * p[k] + 0.7152 * p[k + 1] + 0.0722 * p[k + 2];

  /* Split by image row. Vertical position is the axis the height term acts
   * along, so a term that only moves the canopy shows as a change in the top
   * band and nothing in the bottom one — which is a stronger statement than a
   * whole-frame mean, and would catch a term that had accidentally become a
   * uniform lift. */
  const BANDS = ['top', 'mid', 'low'];
  const mk = () => ({ n: 0, sum: 0, max: 0, moved: 0, sa: 0, sb: 0, ch: 0 });
  const stat = BANDS.map(mk);
  const all = mk();

  for (let j = 0; j < h; j++) {
    // readPixels is bottom-up: j = h-1 is the top of the image.
    const band = j > h * 0.66 ? 0 : j > h * 0.33 ? 1 : 2;
    for (let i = 0; i < w; i++) {
      const k = (j * w + i) * 3;
      const la = lum(pa, k), lb = lum(pb, k);
      const d = Math.abs(la - lb);
      /* A hue rotation about the achromatic axis moves no luma by
       * construction, so a luma-only difference reports a working chroma term
       * as inert. r-b is the axis both chroma terms here act along. */
      const dc = Math.abs((pa[k] - pa[k + 2]) - (pb[k] - pb[k + 2]));
      for (const s of [stat[band], all]) {
        s.n++; s.sum += d; s.sa += la; s.sb += lb; s.ch += dc;
        if (d > s.max) s.max = d;
        if (d >= 1 || dc >= 1) s.moved++;
      }
    }
  }

  const line = (name, s) => `  ${name.padEnd(6)} mean|dY|=${(s.sum / s.n).toFixed(2).padStart(6)}  ` +
    `mean|dRB|=${(s.ch / s.n).toFixed(2).padStart(5)}  ` +
    `max=${s.max.toFixed(0).padStart(4)}  moved=${((100 * s.moved) / s.n).toFixed(1).padStart(5)}%  ` +
    `Y ${(s.sa / s.n).toFixed(1)} -> ${(s.sb / s.n).toFixed(1)}`;

  console.log(`\n  A = ${A || '(shipped)'}   B = ${B || '(shipped)'}   t=${T} pitch=${PITCH}  ${w}x${h}`);
  BANDS.forEach((n, i) => console.log(line(n, stat[i])));
  console.log(line('FRAME', all));
  if (all.moved === 0) {
    console.error('\n  ✗ NOTHING MOVED. The term under test is inert.');
    process.exitCode = 1;
  }
  console.log('');
});

finish(process.exitCode || 0);
