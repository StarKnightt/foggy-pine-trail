/* Capture the walk as a video.
 *
 *   node tools/reel.mjs [tag] [--from 0.02] [--seconds 35] [--fps 30]
 *                       [--w 1600] [--h 900] [--pitch -0.10] [--preroll 30]
 *                       [--aim 3.0] [--turn 1.6] [--crf 18]
 *                       [--keep] [--purge] [--noVideo] [--cpu]
 *
 * Requires a dev server already running on port 3100. It will not start one.
 *
 * ── Why the scene has to be driven ────────────────────────────────────────
 *
 * `setDriven(true)` puts r3f into `frameloop: 'never'`, so every subscriber
 * takes its delta from the timestamp handed to `advance` instead of from the
 * wall clock. That is not a nicety. A frame here costs ~150 ms to render,
 * encode and read back, and the walk only advances 1/30 s per frame — so on
 * the wall clock the dust, the undergrowth wind, the fog patch and the audio
 * engine would all run about four and a half times further between frames
 * than the walker does. Played back, the trees would creep past a blizzard.
 *
 * ── Why the walker is simulated rather than interpolated ──────────────────
 *
 * The obvious implementation is to lerp the camera along the trail spline.
 * It is also the wrong one: the gait bob, the weight-transfer roll and the
 * handheld drift are the entire reason the result reads as a person rather
 * than as a dolly, and all three live inside `Walker.update`. So the tool
 * holds W down through the real keyboard path and lets the rig's own
 * `useFrame` produce the motion, exactly as it would for someone playing.
 *
 * ── Why it steers ─────────────────────────────────────────────────────────
 *
 * `Walker.update` translates along `yaw` and never turns; turning is the
 * mouse's job. Held forward with a fixed heading the walker leaves the trail
 * within ten metres — the curve wanders about six metres of lateral offset
 * over the walk — and then either crabs against the roam spring or walks into
 * a bole. So the tool also supplies the look input: it aims at a point a few
 * metres ahead on the centreline and turns towards it at a rate slow enough
 * to read as a person following a path rather than as a steering correction.
 *
 * The centreline is sampled out of `walker.placeAt` rather than re-derived
 * from the control points, because a second copy of the curve in a tool is a
 * copy that goes stale the first time the real one is retuned.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const tag = args[0] && !args[0].startsWith('--') ? args[0] : 'reel';
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };

const FPS = +flag('fps', 30);
const FROM = +flag('from', 0.02);
const SECONDS = +flag('seconds', 35);
const W = +flag('w', 1600), H = +flag('h', 900);
const PITCH = +flag('pitch', -0.10);
const PREROLL = +flag('preroll', 30);
/* Every frame by default. It is one extra round trip against a ~130 ms frame,
 * and it is the only way to tell a smooth walk from a stuttering one without
 * watching a thousand pictures: a jump in `calls` is an LOD or culling switch
 * popping, a discontinuity in `pos.y` is the gait breaking, and a `speed`
 * that sags is the held key having been dropped. */
const PROBE_EVERY = +flag('probeEvery', 1);
const NO_VIDEO = args.includes('--noVideo');
const PURGE = args.includes('--purge');
const FRAMES = Math.max(1, Math.round(SECONDS * FPS));
const DT = 1 / FPS;

/* The harness watchdog defaults to 300 s, which is a sensible ceiling for a
 * six-frame stills run and a guaranteed kill for a thousand-frame one. It has
 * to be raised deliberately, and it has to stay proportional to the work
 * asked for rather than becoming "very large": the watchdog exists to catch a
 * wedged dev server or a shader compile loop, and a flat one-hour cap would
 * let a wedge sit there for an hour. Two seconds a frame is roughly ten times
 * the measured cost, plus the three-minute first-compile boot budget.
 *
 * Set before the harness is imported, because `run()` reads it at call time
 * and an explicit outer override should still win. */
if (!process.env.SHOOT_CAP_MS) {
  process.env.SHOOT_CAP_MS = String(180_000 + FRAMES * 2000);
}
const { run, capture, finish, DEV_URL } = await import('./harness.mjs');

const outDir = path.join(ROOT, 'shots', tag);
const mediaDir = path.join(ROOT, 'media');
if (!args.includes('--keep')) fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(mediaDir, { recursive: true });

const have = (bin) => {
  const r = spawnSync(bin, ['-version'], { stdio: 'ignore', shell: process.platform === 'win32' });
  return !r.error && r.status === 0;
};
const HAVE_FFMPEG = have('ffmpeg');

console.log(`reel: ${FRAMES} frames @ ${FPS} fps = ${(FRAMES / FPS).toFixed(1)}s   ${W}x${H}`);
console.log(`      from t=${FROM}  watchdog=${(+process.env.SHOOT_CAP_MS / 1000) | 0}s  ffmpeg=${HAVE_FFMPEG}`);

const telemetry = [];
let wrote = 0;

await run({ width: W, height: H, url: DEV_URL }, async ({ page, errs, gl }) => {
  /* Everything the per-frame hook needs, installed once. The hook itself runs
   * inside `capture`'s single evaluate — the drawing buffer is not preserved,
   * so stepping, rendering and reading back cannot be three round trips. */
  await page.evaluate(({ from, dt, pitch, aim, turn }) => {
    const s = window.__scene;
    const w = s.walker;

    /* The centreline, read out of the walker itself. 241 samples over 48 m is
     * a station every 20 cm, finer than the aim distance by an order of
     * magnitude, so the heading target never steps visibly. */
    const N = 240;
    const pathPts = [];
    for (let i = 0; i <= N; i++) {
      w.placeAt(i / N);
      pathPts.push([w.x, w.z]);
    }

    s.setDriven(true);
    w.placeAt(from);
    w.pitch = pitch;
    /* Settle the ground spring and the gait before the first captured frame.
     * `placeAt` snaps the height field, but a teleport still leaves the walk
     * at zero pace, and the first second of a clip that opens on someone
     * accelerating from a standstill reads as a cut into motion. */
    w.warp(2.0);

    let idx = 0;
    const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

    window.__reel = {
      /* One captured frame's worth of simulation.
       *
       * `capture` pauses the rig before calling this, and a paused rig skips
       * `walker.update` entirely — which would advance the world and leave
       * the walker standing still. Unpausing here rather than teaching the
       * harness about driven mode, because every other tool in this project
       * wants the pause. */
      frame() {
        s.setPaused(false);

        // Aim a few metres up the trail, the way a walker looks where they
        // are going rather than at their own feet.
        while (idx < pathPts.length - 1) {
          const [ax, az] = pathPts[idx];
          if (Math.hypot(ax - w.x, az - w.z) >= aim) break;
          idx++;
        }
        const [ax, az] = pathPts[idx];
        const want = Math.atan2(-(ax - w.x), -(az - w.z));
        w.yaw += wrap(want - w.yaw) * Math.min(1, dt * turn);

        /* Re-announced every frame rather than pressed once. The rig holds
         * input in a Set keyed off keydown/keyup and clears it on `blur`; a
         * single press at the top of a thousand-frame run is one stray focus
         * event away from the walk quietly stopping halfway through, with no
         * error and no way to tell from the frames until they are assembled.
         * The OS auto-repeats a held key exactly like this anyway. */
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
        s.step(dt);
      },
      state() {
        return {
          t: +w.progress.toFixed(4),
          pos: [+w.x.toFixed(3), +w.eye.y.toFixed(4), +w.z.toFixed(3)],
          yaw: +w.yaw.toFixed(4),
          speed: +w.speed.toFixed(3),
          phase: +w.phase.toFixed(3),
          ...s.info(),
        };
      },
    };
  }, { from: FROM, dt: DT, pitch: PITCH, aim: +flag('aim', 3.0), turn: +flag('turn', 1.6) });

  /* Pre-roll. Not captured: it exists so the pace, the ground spring and the
   * heading are all at their steady values on frame 0000. */
  for (let i = 0; i < PREROLL; i++) await page.evaluate(() => window.__reel.frame());

  const t0 = Date.now();
  for (let i = 0; i < FRAMES; i++) {
    const file = path.join(outDir, String(i).padStart(4, '0') + '.png');
    await capture(page, file, { before: 'window.__reel.frame()' });
    wrote++;

    if (i % PROBE_EVERY === 0 || i === FRAMES - 1) {
      const st = await page.evaluate(() => window.__reel.state());
      telemetry.push({ frame: i, ...st });
    }
    if (i % 60 === 0 || i === FRAMES - 1) {
      const per = (Date.now() - t0) / (i + 1);
      const eta = ((FRAMES - i - 1) * per) / 1000;
      const last = telemetry[telemetry.length - 1] || {};
      console.log(
        `  ${String(i).padStart(4, '0')}/${FRAMES}  t=${(last.t ?? 0).toFixed(3)} ` +
        `calls=${last.calls ?? '?'} tris=${((last.triangles ?? 0) / 1000).toFixed(0)}k  ` +
        `${per.toFixed(0)}ms/f  eta ${eta.toFixed(0)}s`);
    }
  }

  console.log(`\n  captured ${wrote} frames in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  console.log(`  adapter: ${gl.renderer}`);
  if (errs.length) console.log(`  page errors: ${new Set(errs).size}`);
});

/* Verify the frames reached disk before claiming a clip exists. A run that
 * reports success without stat'ing the output is trusting the one step most
 * likely to have failed silently. */
const files = fs.readdirSync(outDir).filter((f) => f.endsWith('.png')).sort();
let bytes = 0, thin = 0;
for (const f of files) {
  const size = fs.statSync(path.join(outDir, f)).size;
  bytes += size;
  if (size < 15000) { thin++; console.log(`  THIN/EMPTY  ${f}  ${size} B`); }
}
console.log(`  ${files.length} png on disk, ${(bytes / 1048576).toFixed(0)} MB total` +
  (thin ? `, ${thin} suspiciously small` : ''));
if (files.length !== FRAMES || thin) process.exitCode = 1;

const stem = path.join(mediaDir, tag);
const MP4 = [
  '-y', '-framerate', String(FPS), '-i', path.join(outDir, '%04d.png'),
  /* crf 18 is a near-visually-lossless master, and against this subject it is
   * expensive: the grain and the needle detail decorrelate every frame, so
   * 35 s lands near 170 MB. That is the right default for something the owner
   * will re-encode for each destination, but it is over the inline limit of
   * most places one would post it, hence the flag. Measured on this scene at
   * 35 s: crf 18 is 171 MB, crf 23 is 77 MB. */
  '-c:v', 'libx264', '-preset', 'slow', '-crf', flag('crf', '18'),
  '-pix_fmt', 'yuv420p', '-movflags', '+faststart', `${stem}.mp4`,
];
/* Animated WebP for the preview rather than GIF: a foggy forest is a
 * continuous-tone subject and GIF's 256-colour palette turns the fog into
 * visible bands, which is precisely the gradient this project is judged on.
 * Half rate and half width, because it is a thumbnail. */
const WEBP = [
  '-y', '-framerate', String(FPS), '-i', path.join(outDir, '%04d.png'),
  '-vf', `fps=${Math.round(FPS / 2)},scale=800:-2:flags=lanczos`,
  '-c:v', 'libwebp', '-lossless', '0', '-q:v', '72', '-loop', '0',
  '-preset', 'picture', `${stem}.webp`,
];
const show = (a) => 'ffmpeg ' + a.map((x) => (/[ %]/.test(x) ? `"${x}"` : x)).join(' ');

if (NO_VIDEO) {
  console.log('\n  --noVideo: frames only.');
} else if (!HAVE_FFMPEG) {
  console.log('\n  ffmpeg is NOT available on this machine — no video was assembled.');
  console.log('  All frames are on disk. Run these two commands from the project root:\n');
  console.log('    ' + show(MP4));
  console.log('    ' + show(WEBP) + '\n');
} else {
  for (const [what, a] of [['mp4', MP4], ['webp', WEBP]]) {
    const r = spawnSync('ffmpeg', a, { stdio: ['ignore', 'ignore', 'pipe'] });
    if (r.status !== 0) {
      console.error(`\n  ffmpeg ${what} failed:\n` + String(r.stderr).split('\n').slice(-12).join('\n'));
      process.exitCode = 1;
    } else {
      const p = `${stem}.${what}`;
      console.log(`  wrote ${path.relative(ROOT, p)}  ${(fs.statSync(p).size / 1048576).toFixed(1)} MB`);
    }
  }
}

fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({
  tag, when: new Date().toISOString(), viewport: [W, H], fps: FPS,
  from: FROM, seconds: FRAMES / FPS, frames: files.length, pitch: PITCH,
  preroll: PREROLL, ffmpeg: HAVE_FFMPEG, bytes, telemetry,
}, null, 2));

/* Chromium's `toDataURL` writes PNGs at a low compression level, so a frame
 * of dense needle noise lands around 3.5 MB and a full-length reel is several
 * gigabytes. Kept by default because the frames are the master and re-shooting
 * costs minutes, but there is a flag, because this machine's system drive
 * does not have many of those gigabytes spare. */
if (PURGE && !process.exitCode) {
  for (const f of files) fs.rmSync(path.join(outDir, f));
  console.log(`  --purge: removed ${files.length} frames (${(bytes / 1048576).toFixed(0)} MB)`);
}

console.log(`\n  → ${path.relative(ROOT, outDir)}`);
finish(process.exitCode || 0);
