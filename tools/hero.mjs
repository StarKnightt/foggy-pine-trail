/* Hero stills, at posting resolution.
 *
 *   node tools/hero.mjs [tag] [--views "0.35:-0.35@roots; 0.5:0.62@canopy"]
 *                       [--views @views.json] [--w 3200] [--h 1800]
 *                       [--fov 0] [--settle 2.0] [--cpu]
 *
 * Requires a dev server already running on port 3100. It will not start one.
 *
 * Not a variant of `shoot.mjs`. That tool exists to make two builds
 * comparable, so its stop list is fixed on purpose and changing it destroys
 * the comparison. This one exists to produce pictures somebody will post, so
 * the framing is the whole question and it has to be answerable from the
 * command line — a critic is choosing between framings and every round trip
 * that requires editing a file is a round trip that gets skipped.
 *
 * ── The viewpoint spec ────────────────────────────────────────────────────
 *
 *   t[:pitch[:yaw[:fov]]][@name]      semicolon or comma separated
 *
 * `t` is normalised progress along the trail, `pitch` and `yaw` are radians
 * (yaw relative to the walker's own heading, so 0 is straight down the
 * trail), `fov` overrides the camera's. `--views @file.json` reads the same
 * fields as an array of objects instead, for a list long enough that a shell
 * string stops being readable.
 *
 * ── Why the pitch defaults are what they are ──────────────────────────────
 *
 * Level is the worst framing this scene has. It puts the nearest ground four
 * metres out, so the tread — the mud, the roots, the litter, the part with
 * the most resolved detail in the project — is a thin band at the bottom of
 * the frame, and the picture becomes trunks and fog. The defaults below are
 * tipped down between six and twenty degrees, which is where a person walking
 * a trail actually looks, and one is tipped up into the canopy because that
 * is the only framing in which the fog's vertical structure is visible at
 * all.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const tag = args[0] && !args[0].startsWith('--') ? args[0] : 'hero';
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };

const W = +flag('w', 3200), H = +flag('h', 1800);
const FOV = +flag('fov', 0);
const SETTLE = +flag('settle', 2.0);

const DEFAULT_VIEWS =
  '0.08:-0.14@gate; 0.24:-0.30@tread; 0.38:-0.10@bend; ' +
  '0.50:0.55@canopy; 0.66:-0.22@deadfall; 0.86:-0.12@away';

function parseViews(spec) {
  if (spec.startsWith('@')) {
    const raw = JSON.parse(fs.readFileSync(path.resolve(ROOT, spec.slice(1)), 'utf8'));
    return raw.map((v, i) => ({
      t: +v.t, pitch: +(v.pitch ?? 0), yaw: +(v.yaw ?? 0), fov: +(v.fov ?? 0),
      name: v.name || String(i).padStart(2, '0'),
    }));
  }
  return spec.split(/[;,]/).map((s) => s.trim()).filter(Boolean).map((s, i) => {
    const [nums, name] = s.split('@');
    const [t, pitch = 0, yaw = 0, fov = 0] = nums.split(':').map(Number);
    /* A misparsed `t` silently becomes NaN, `goTo` clamps it to 0, and the
     * result is a plausible-looking picture of the wrong place — the failure
     * mode that wastes a whole critique round. */
    if (!Number.isFinite(t)) throw new Error(`bad viewpoint "${s}": t is not a number`);
    return { t, pitch, yaw, fov, name: name || String(Math.round(t * 100)).padStart(2, '0') };
  });
}

const VIEWS = parseViews(flag('views', DEFAULT_VIEWS));

/* High-resolution frames are slower to render and much slower to encode and
 * read back than the 1600x900 the stills tool uses, so the harness's 300 s
 * default is not comfortably clear of a six-shot run at 3200x1800. Scaled to
 * the work asked for rather than simply enlarged, so it still catches a
 * wedged dev server. */
if (!process.env.SHOOT_CAP_MS) {
  process.env.SHOOT_CAP_MS = String(180_000 + VIEWS.length * 45_000);
}
const { run, capture, finish, DEV_URL } = await import('./harness.mjs');

const outDir = path.join(ROOT, 'shots', tag);
const mediaDir = path.join(ROOT, 'media');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(mediaDir, { recursive: true });

console.log(`hero: ${VIEWS.length} stills at ${W}x${H}`);
console.log('      ' + VIEWS.map((v) => `${v.name}@t=${v.t}`).join('  '));

const results = [];

await run({ width: W, height: H, url: DEV_URL }, async ({ page, errs, gl }) => {
  for (const v of VIEWS) {
    await page.evaluate(([t, pitch, yaw, fov, settle]) => {
      const s = window.__scene;
      if (fov) { s.camera.fov = fov; s.camera.updateProjectionMatrix(); }
      s.goTo(t);
      // Yaw is relative to the walker's own heading down the trail, so 0
      // frames the path rather than an arbitrary compass direction.
      s.setYaw(s.walker.yaw + yaw);
      s.setPitch(pitch);
      /* Run the gait and the ground spring out. A teleport leaves the height
       * spring mid-flight, and a still taken on that frame is a photograph of
       * a camera that is still falling. */
      s.warp(settle);
    }, [v.t, v.pitch, v.yaw, v.fov || FOV, SETTLE]);
    // Let the wind and the particle fields advance past the teleport.
    await page.waitForTimeout(400);

    const file = path.join(outDir, `${v.name}.png`);
    await capture(page, file);

    const st = await page.evaluate(() => {
      const s = window.__scene;
      const p = s.camera.position;
      return {
        pos: [+p.x.toFixed(2), +p.y.toFixed(3), +p.z.toFixed(1)],
        ...s.info(), hist: s.probe(),
      };
    });
    results.push({ ...v, file: path.basename(file), ...st });

    const hi = st.hist;
    console.log(`  ${v.name.padEnd(9)} t=${v.t.toFixed(2)} pitch=${v.pitch.toFixed(2)} ` +
      `pos=${st.pos.join(',')} calls=${st.calls} tris=${(st.triangles / 1000).toFixed(0)}k`);
    console.log(`            lum med=${hi.median} p10=${hi.p10} p90=${hi.p90} ` +
      `contrast=${hi.contrast} sat=${hi.sat} black=${hi.blackPct}% blown=${hi.blownPct}%`);
  }
  console.log(`\n  adapter: ${gl.renderer}`);
  if (errs.length) console.log(`  page errors: ${new Set(errs).size}`);
});

/* Stat what was written. A still that reports success without checking the
 * filesystem is trusting the one step most likely to have failed. */
let bad = 0;
for (const r of results) {
  const p = path.join(outDir, r.file);
  const size = fs.existsSync(p) ? fs.statSync(p).size : 0;
  if (size < 50_000) { bad++; console.log(`  MISSING/EMPTY  ${r.file}`); continue; }
  // Alongside the video, so everything postable is in one directory.
  fs.copyFileSync(p, path.join(mediaDir, `${tag}-${r.name}.png`));
  console.log(`  wrote media/${tag}-${r.name}.png  ${(size / 1048576).toFixed(1)} MB`);
}
if (bad) process.exitCode = 1;

/* A contact sheet, because the question these stills exist to answer is
 * "which framing", and that is a comparison. Six 14 MB files in a directory
 * get looked at one at a time, in whatever order the file manager sorts them,
 * and the choice then gets made against whichever was seen last. */
if (!bad) {
  const sheet = path.join(outDir, '_sheet');
  fs.mkdirSync(sheet, { recursive: true });
  results.forEach((r, i) => fs.copyFileSync(
    path.join(outDir, r.file), path.join(sheet, String(i).padStart(2, '0') + '.png')));
  const cols = Math.min(3, results.length);
  const rows = Math.ceil(results.length / cols);
  const out = path.join(mediaDir, `${tag}-contact.png`);
  const r = spawnSync('ffmpeg', [
    '-y', '-i', path.join(sheet, '%02d.png'),
    '-vf', `scale=640:-1,tile=${cols}x${rows}`, '-update', '1', '-frames:v', '1', out,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  fs.rmSync(sheet, { recursive: true, force: true });
  if (r.status === 0) {
    console.log(`  wrote media/${path.basename(out)}   order: ` +
      results.map((x) => x.name).join(', '));
  } else {
    // Not a failure of the run: the stills are the deliverable and they exist.
    console.log('  (no contact sheet — ffmpeg unavailable or failed)');
  }
}

fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({
  tag, when: new Date().toISOString(), viewport: [W, H], views: VIEWS, results,
}, null, 2));

console.log(`\n  → ${path.relative(ROOT, outDir)}`);
finish(process.exitCode || 0);
