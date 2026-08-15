/* Prove every term is live.
 *
 *   node tools/live.mjs [--t 0.22] [--pitch 0]
 *
 * System 1's most expensive finding was that four separate code paths in it
 * were inert or degenerate — a roughness value that changed zero pixels, a
 * polish term firing on 2.4% of the surface, a water term over-firing on 48%,
 * and a tiling bug that scaled a coordinate without scaling its period. All
 * four looked right in the source and all four were found by changing a
 * constant and checking that pixels actually moved.
 *
 * Doing that by hand costs an edit, a reload and a capture per term, which is
 * why it is done once at the end of a system rather than continuously. This
 * makes it one command: for each term in the table below, the bark body is
 * re-baked with that term substituted out, the new set is swapped into the live
 * material, the frame is re-rendered and compared with the reference.
 *
 * What the numbers mean:
 *
 *   moved   percentage of frame pixels that changed by more than one display
 *           level. A term that reports 0.0 is dead — either the code path never
 *           executes or its output is discarded downstream.
 *   mean    average absolute change over the pixels that moved, in display
 *           levels. This is the one that catches the *degenerate* case, which is
 *           more common and much harder to spot: a term that is alive, fires
 *           over the whole surface, and moves it by half a level.
 *   peak    the largest single-pixel change, which distinguishes a term that
 *           does a little everywhere from one that does a lot somewhere.
 *
 * Only pixels the wood actually covers can move, and the wood is roughly a
 * third of this frame, so a term that affects the entire bark surface tops out
 * around 30% moved. The figures are therefore read against each other rather
 * than against 100.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, finish } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const T = +flag('t', 0.22);
const PITCH = +flag('pitch', 0);

/* Each entry substitutes one term out of the bark body. The `find` string has
 * to appear exactly once — the tool checks, because a substitution that silently
 * matched nothing would report "dead" for a term that is perfectly alive, which
 * is the one failure mode of this test that would send someone in the wrong
 * direction for an afternoon. */
const TESTS = [
  ['line network', 'float bL = clamp((1.0 - lines) * 1.55 - 0.10, 0.0, 1.0);',
    'float bL = 0.46;'],
  ['line octaves', 'pridged(pw * sL, per * sL, 3)', 'pridged(pw * sL, per * sL, 1)'],
  ['cell network (forks)', '(eA.y - eA.x) * 4.5', '9.0'],
  ['cross-breaks', 'b = min(b, 0.46 - cross * 0.30);', ''],
  ['fissure depth field', 'fissure *= 0.26 + 0.90 * deepness;', 'fissure *= 0.80;'],
  ['ridge cross-section', 'pow(smoothstep(0.0, 0.34, b), 0.75)',
    'smoothstep(0.0, 0.34, b)'],
  ['plate mound', 'crown * (0.40 + 0.30 * mound)', 'crown * 0.55'],
  ['plate cork', 'cork * 0.26', 'cork * 0.0'],
  ['plate grit', 'grit * 0.07', 'grit * 0.0'],
  ['fine splits', 'split * 0.10', 'split * 0.0'],
  ['per-plate tone', 'plate *= mix(0.56, 1.34,', 'plate *= mix(0.95, 0.95,'],
  ['hand-scale tone', 'plate *= mix(0.82, 1.18, contrast', 'plate *= mix(1.0, 1.0, contrast'],
  ['fresh inner bark', 'fresh * 0.72', 'fresh * 0.0'],
  ['lichen', 'lichen * 0.88', 'lichen * 0.0'],
  ['algal film', 'algae * (0.30 + 0.34 * fissure)', 'algae * 0.0'],
  ['resin streaks', 'vec3(0.0130, 0.0098, 0.0070), resin * 0.85',
    'vec3(0.0130, 0.0098, 0.0070), resin * 0.0'],
  ['roughness: fissure', 'rough = mix(rough, 0.62, fissure * 0.35);', ''],
  ['roughness: resin', 'rough = mix(rough, 0.30, resin * 0.85);', ''],
  ['AO floor 0.14 -> 0.34', 'ao = clamp(0.14 + 0.40 * height, 0.0, 1.0);',
    'ao = clamp(0.34 + 0.40 * height, 0.0, 1.0);'],
  ['AO: fissure', 'ao *= 1.0 - 0.20 * fissure;', ''],
  ['albedo x0.5', 'albedo = mix(plate, deep, fissure * 0.55);',
    'albedo = mix(plate, deep, fissure * 0.55) * 0.5;'],
];

await run({ width: 1600, height: 900 }, async ({ page }) => {
  const attrs = await page.evaluate(([t, pitch]) => {
    const s = window.__scene;
    s.setPaused(true);
    s.goTo(t);
    s.setYaw(s.walker.yaw);
    s.setPitch(pitch);
    s.warp(2.0);
    s.renderOnce();

    /* Keep the reference on the page. Shipping a 5.8 MB byte array back over
     * the CDP bridge twenty times is most of a minute of pure transfer. */
    const r = s.renderer, g = r.getContext();
    const w = r.domElement.width, h = r.domElement.height;
    const ref = new Uint8Array(w * h * 4);
    g.readPixels(0, 0, w, h, g.RGBA, g.UNSIGNED_BYTE, ref);
    window.__ref = { ref, w, h };
    return s.scene.userData.woodAttrs ? s.scene.userData.woodAttrs() : null;
  }, [T, PITCH]);

  if (attrs) {
    console.log('\n  ── vertex attributes, over the whole wood ──');
    console.log('  name       min     max     mean    >0.5');
    for (const [k, v] of Object.entries(attrs)) {
      console.log(`  ${k.padEnd(10)} ${String(v.min).padEnd(7)} ${String(v.max).padEnd(7)}`
        + ` ${String(v.mean).padEnd(7)} ${v.over}%`);
    }
  }

  const body = await page.evaluate(() => {
    const p = window.__scene.scene.userData.barkProbe;
    return p ? p.body : null;
  });
  if (!body) {
    console.error('\n  ✗ no barkProbe on the scene — is this a development build?');
    process.exitCode = 1;
    return;
  }

  console.log('\n  ── bark terms, by how much of the frame each one moves ──');
  console.log('  term                       moved    mean   peak');

  for (const [label, find, repl] of TESTS) {
    const n = body.split(find).length - 1;
    if (n !== 1) {
      console.log(`  ${label.padEnd(26)} ✗ pattern matched ${n} times, not 1`);
      process.exitCode = 1;
      continue;
    }
    const mutated = body.replace(find, repl);
    const res = await page.evaluate((src) => {
      const s = window.__scene;
      s.scene.userData.barkProbe.swap(src);
      s.renderOnce();
      const r = s.renderer, g = r.getContext();
      const { ref, w, h } = window.__ref;
      const now = new Uint8Array(w * h * 4);
      g.readPixels(0, 0, w, h, g.RGBA, g.UNSIGNED_BYTE, now);
      let moved = 0, sum = 0, peak = 0;
      for (let i = 0; i < now.length; i += 4) {
        const d = Math.max(
          Math.abs(now[i] - ref[i]),
          Math.abs(now[i + 1] - ref[i + 1]),
          Math.abs(now[i + 2] - ref[i + 2]),
        );
        if (d > 1) { moved++; sum += d; }
        if (d > peak) peak = d;
      }
      const total = (w * h) | 0;
      return {
        moved: +((100 * moved) / total).toFixed(2),
        mean: +(sum / Math.max(1, moved)).toFixed(1),
        peak,
      };
    }, mutated);
    console.log(`  ${label.padEnd(26)} ${String(res.moved).padStart(6)}%`
      + ` ${String(res.mean).padStart(6)} ${String(res.peak).padStart(6)}`);
  }

  await page.evaluate(() => {
    window.__scene.scene.userData.barkProbe.restore();
    delete window.__ref;
    window.__scene.setPaused(false);
  });
  console.log(`\n  (reference frame: t=${T} pitch=${PITCH}, ${path.basename(ROOT)})\n`);
});

finish(process.exitCode || 0);
