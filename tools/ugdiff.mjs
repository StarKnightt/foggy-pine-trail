/* Differenced pairs for the undergrowth, with a receipt.
 *
 *   node tools/ugdiff.mjs --b "ug=noocc" [--a ""] [--t 0.35] [--pitch -0.35]
 *
 * The same job `fogdiff.mjs` does, plus two things this system needed and that
 * one does not provide.
 *
 * It reports the draw call count of each side. A differenced pair is only
 * evidence if the two sides are genuinely different builds, and the first run
 * of this against `fogdiff` returned "0.06 mean, 0.4% moved" for switching the
 * *entire plant population* off — a result that looks exactly like an inert
 * term and was in fact a harness problem. Printing calls alongside the pixels
 * makes that failure impossible to misread: 55 against 26 says the build
 * changed, and only then does the pixel column mean anything.
 *
 * And it pauses and zeroes the wind before reading. The plants animate, so two
 * captures taken at different wall-clock times differ by a few tenths of a
 * count over one per cent of the frame whatever is being tested — which is the
 * same order as some of the terms under test, and would have been reported as
 * a live term for a dead one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { run, finish, DEV_URL } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };

const A = flag('a', '');
const B = flag('b', '');
const T = +flag('t', 0.35);
const PITCH = +flag('pitch', -0.35);
const W = +flag('w', 1024), H = +flag('h', 576);
const SAVE = args.includes('--save');

const url = (q) => (q ? `${DEV_URL}/?${q}` : DEV_URL);

async function grab(browser, q) {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(90_000);
  await page.goto(url(q), { waitUntil: 'domcontentloaded' });
  page.getByRole('button', { name: /load it anyway/i })
    .click({ timeout: 8000 }).then(() => {}, () => {});
  await page.waitForFunction(() => !!window.__scene, null, { timeout: 120_000 });
  await page.waitForTimeout(2500);
  const out = await page.evaluate(([t, p]) => {
    const s = window.__scene;
    const r = s.renderer, gl = r.getContext();
    s.setPaused(true);
    s.goTo(t); s.setYaw(s.walker.yaw); s.setPitch(p); s.warp(2.0);
    s.renderOnce();
    const w = r.domElement.width, h = r.domElement.height;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let bin = '';
    for (let i = 0; i < px.length; i += 4) bin += String.fromCharCode(px[i], px[i + 1], px[i + 2]);
    return { w, h, b64: btoa(bin), ...s.info(), png: r.domElement.toDataURL('image/png') };
  }, [T, PITCH]);
  await page.close();
  return out;
}

await run({ width: W, height: H }, async () => {
  /* A second browser rather than a second navigation in the first one. The
   * pair has to be two independent boots of the page, because the thing being
   * switched is read once at mount and a navigation that the app treats as a
   * client-side transition would silently hand back the same build twice. */
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--disable-dev-shm-usage'],
  });
  let a, b;
  try {
    a = await grab(browser, A);
    b = await grab(browser, B);
  } finally {
    await browser.close().catch(() => {});
  }

  const pa = Buffer.from(a.b64, 'base64');
  const pb = Buffer.from(b.b64, 'base64');
  const { w, h } = a;
  const lum = (p, k) => 0.2126 * p[k] + 0.7152 * p[k + 1] + 0.0722 * p[k + 2];

  const BANDS = ['top', 'mid', 'low'];
  const stat = BANDS.map(() => ({ n: 0, sum: 0, max: 0, moved: 0, sa: 0, sb: 0 }));
  const all = { n: 0, sum: 0, max: 0, moved: 0, sa: 0, sb: 0 };
  for (let j = 0; j < h; j++) {
    const band = j > h * 0.66 ? 0 : j > h * 0.33 ? 1 : 2;
    for (let i = 0; i < w; i++) {
      const k = (j * w + i) * 3;
      const la = lum(pa, k), lb = lum(pb, k);
      const d = Math.abs(la - lb);
      for (const s of [stat[band], all]) {
        s.n++; s.sum += d; s.sa += la; s.sb += lb;
        if (d > s.max) s.max = d;
        if (d >= 1) s.moved++;
      }
    }
  }

  const line = (name, s) => `  ${name.padEnd(6)} mean|d|=${(s.sum / s.n).toFixed(2).padStart(6)}  `
    + `max=${s.max.toFixed(0).padStart(4)}  moved>=1LSB=${((100 * s.moved) / s.n).toFixed(1).padStart(5)}%  `
    + `meanLuma ${(s.sa / s.n).toFixed(1)} -> ${(s.sb / s.n).toFixed(1)}`;

  console.log(`\n  A = ${A || '(shipped)'}   B = ${B || '(shipped)'}   t=${T} pitch=${PITCH}  ${w}x${h}`);
  console.log(`  build   calls ${a.calls} -> ${b.calls}   tris ${(a.triangles / 1000) | 0}k -> ${(b.triangles / 1000) | 0}k`);
  BANDS.forEach((n, i) => console.log(line(n, stat[i])));
  console.log(line('FRAME', all));
  if (a.calls === b.calls && a.triangles === b.triangles && all.moved === 0) {
    console.error('\n  ✗ NOTHING MOVED and the build is identical. The term under test is inert.');
    process.exitCode = 1;
  }
  if (SAVE) {
    const dir = path.join(ROOT, 'shots', 'ugdiff');
    fs.mkdirSync(dir, { recursive: true });
    for (const [n, o] of [['a', a], ['b', b]]) {
      fs.writeFileSync(path.join(dir, `${n}.png`), Buffer.from(o.png.split(',')[1], 'base64'));
    }
    console.log(`  wrote shots/ugdiff/a.png and b.png`);
  }
  console.log('');
});

finish(process.exitCode || 0);
