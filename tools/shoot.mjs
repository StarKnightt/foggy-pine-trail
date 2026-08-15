/* Capture the walk.
 *
 * The same viewpoints every run, so two builds can be put side by side and
 * actually compared, and so a critic looking only at pictures is looking at
 * the same pictures each time.
 *
 *   node tools/shoot.mjs [tag] [--t 0,0.25,...] [--w 1600] [--h 900]
 *                        [--yaw 0] [--pitch 0] [--fov 0] [--js "..."] [--cpu]
 *
 * Requires a dev server already running on port 3100. It will not start one.
 *
 * ── The stop list ─────────────────────────────────────────────────────────
 *
 * Six along the trail plus two framings, and the two framings are the reason
 * this is not just a loop over positions.
 *
 * `down` tips the camera to about twenty degrees below level. A trail walker
 * looks at the trail — that is where the roots and the mud are, and it is the
 * framing that carries every phone photograph anyone has ever taken on a hike.
 * Shooting only dead level puts the nearest visible ground four metres out and
 * makes the tread impossible to judge.
 *
 * `up` looks into the canopy, which is the only view in which the fog's
 * vertical structure is visible at all. A fog layer with a top is the whole
 * difference between weather and a distance fade, and it cannot be assessed
 * from a level frame.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, capture, finish, DEV_URL } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const tag = args[0] && !args[0].startsWith('--') ? args[0] : 'run';
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };

const STOPS = flag('t', '0.03,0.22,0.42,0.6,0.78,0.94').split(',').map(Number);
const W = +flag('w', 1600), H = +flag('h', 900);
const YAW = +flag('yaw', 0);
const PITCH = +flag('pitch', 0);
const FOV = +flag('fov', 0);
const JS = flag('js', '');
const NAME = flag('name', null);
const NO_EXTRA = args.includes('--noExtra');

const outDir = path.join(ROOT, 'shots', tag);
if (!args.includes('--keep')) fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

/* `--q fog=noheight` appends a query string. The fog's per-term switches are
 * read off `window.location.search`, and a differenced pair of *pictures* is
 * how a term that changes nothing gets caught before it ships. */
const Q = flag('q', '');

await run({ width: W, height: H, url: Q ? `${DEV_URL}/?${Q}` : DEV_URL },
  async ({ page, errs, gl, readShaderErrors }) => {
  await page.evaluate(([fov, js]) => {
    const s = window.__scene;
    if (fov) { s.camera.fov = fov; s.camera.updateProjectionMatrix(); }
    if (js) new Function('s', js)(s);
  }, [FOV, JS]);

  const results = [];
  const plan = STOPS.map((t) => ({ t, pitch: PITCH, name: null }));
  if (!NO_EXTRA) {
    plan.push({ t: 0.35, pitch: -0.35, name: 'down' });
    plan.push({ t: 0.5, pitch: 0.62, name: 'up' });
  }

  for (const { t, pitch: sp, name } of plan) {
    await page.evaluate(([t, yaw, pitch]) => {
      const s = window.__scene;
      s.goTo(t);
      // The walker's own heading down the trail, plus whatever was asked for.
      s.setYaw(s.walker.yaw + yaw);
      s.setPitch(pitch);
      /* Settle the gait and anything else that springs, so the frame is the
       * one you would get by walking here rather than by teleporting. */
      s.warp(2.0);
    }, [t, YAW, sp]);
    await page.waitForTimeout(200);

    const st = await page.evaluate(() => {
      const s = window.__scene;
      const p = s.camera.position;
      return {
        fps: +s.fps.toFixed(1),
        pos: [+p.x.toFixed(2), +p.y.toFixed(3), +p.z.toFixed(1)],
        ...s.info(),
        hist: s.probe(),
      };
    });

    const stem = name ?? NAME ?? String(Math.round(t * 100)).padStart(2, '0');
    const file = path.join(outDir, `${stem}.png`);
    await capture(page, file);
    results.push({ t, pitch: sp, file: path.basename(file), ...st });

    const hi = st.hist;
    console.log(`  ${stem.padEnd(5)} t=${t.toFixed(2)} pos=${st.pos.join(',')}  ` +
      `calls=${String(st.calls).padStart(3)} tris=${(st.triangles / 1000).toFixed(0)}k ` +
      `prog=${st.programs} tex=${st.textures}`);
    console.log(`        lum med=${hi.median} p10=${hi.p10} p90=${hi.p90} mean=${hi.mean} ` +
      `contrast=${hi.contrast} sat=${hi.sat} black=${hi.blackPct}% blown=${hi.blownPct}% ` +
      `up=${hi.upper} low=${hi.lower}`);
  }

  /* Steady-state frame rate, measured after everything is warm. The number
   * taken in the first second is a measurement of the shader compiler. */
  const perf = await page.evaluate(async () => {
    const s = window.__scene;
    s.setPaused(false);
    await new Promise((r) => setTimeout(r, 2500));
    return { fps: +s.fps.toFixed(1), ...s.info() };
  });
  console.log(`\n  steady: ${perf.fps} fps   calls=${perf.calls} tris=${(perf.triangles / 1000).toFixed(0)}k`);
  console.log(`  adapter: ${gl.renderer}`);

  const shaderErrors = await readShaderErrors();

  fs.writeFileSync(
    path.join(outDir, 'report.json'),
    JSON.stringify({
      tag, when: new Date().toISOString(), viewport: [W, H], query: Q,
      gl, camera: { yaw: YAW, pitch: PITCH, fov: FOV || 52 },
      perf, results, errors: [...new Set(errs)], shaderErrors,
    }, null, 2),
  );

  /* Say what was written, and fail if it was not. A capture that reports
   * success without checking the filesystem is trusting the one thing most
   * likely to have gone wrong. */
  let bad = 0;
  for (const r of results) {
    const p = path.join(outDir, r.file);
    const size = fs.existsSync(p) ? fs.statSync(p).size : 0;
    if (size < 15000) { bad++; console.log(`  MISSING/EMPTY  ${path.relative(ROOT, p)}`); }
    else console.log(`  wrote ${path.relative(ROOT, p)}  ${(size / 1024).toFixed(0)} kB`);
  }
  if (bad) {
    console.error(`\n  ${bad} capture(s) did not reach disk`);
    process.exitCode = 1;
  }

  console.log(`\n  → ${path.relative(ROOT, outDir)}`);
});

finish(process.exitCode || 0);
