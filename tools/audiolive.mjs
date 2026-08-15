/* Prove the audio graph actually runs in a browser.
 *
 * `tools/audio.mjs` verifies the DSP offline and `tools/audiograph.mjs`
 * verifies the graph topology against a mock, and neither can answer the one
 * question that matters at integration time: does sound actually flow through
 * these nodes in Chrome. A Web Audio graph that produces nothing raises no
 * error and throws no exception — it is silent, and silence is
 * indistinguishable from a scene that is simply quiet at that moment.
 *
 * The gesture is the whole reason this needs a script rather than a one-line
 * evaluate. Browsers refuse to start an AudioContext without a user
 * interaction, so a bare `report()` on a freshly loaded page always answers
 * "nothing is playing" truthfully and uselessly: the bank has not been baked,
 * there are no voices, and `silent` is empty because it is a list of buses
 * that exist and are quiet, and no buses exist yet.
 *
 * So this dispatches a real pointer event, waits for the staged bake to drain,
 * fires one of everything, and only then reads the meters.
 *
 * Two things were added after the first run of this script found the bank had
 * never been built at all. It surfaces `report().problems` and
 * `report().buildError`, because the failure was an exception thrown inside the
 * bake's requestIdleCallback that reached nothing but the page's error log. And
 * it samples the frame clock across the bake window, because the bake is spread
 * one stage per frame for the sole purpose of not hitching the render, and that
 * claim was never actually measured.
 */
import { run, finish } from './harness.mjs';

const fail = (msg) => { console.error(`✗ ${msg}`); process.exitCode = 1; };

await run({ width: 900, height: 520 }, async ({ page }) => {
  /* Installed before the gesture, so the sample window covers the bake from its
   * first frame. rAF timestamps come from the compositor, so this measures what
   * the scene actually presented rather than what the render loop attempted. */
  await page.evaluate(() => {
    window.__fps = { t: [], stop: false, bakeDone: -1 };
    /* `performance.now()` inside the callback, not the timestamp the callback is
     * handed. Headless Chromium synthesises its vsync clock, so the argument
     * arrives in near-perfect 16.67 ms steps whether or not the main thread kept
     * up — measured that way this scene reported an unwavering 60.0 fps mean and
     * a 16.8 ms worst frame across a bake that visibly was not free. Wall time
     * between callbacks is what a viewer would actually see. */
    const tick = () => {
      const now = performance.now();
      window.__fps.t.push(now);
      if (window.__fps.bakeDone < 0 && window.__audio
        && window.__audio.report().built && window.__audio.report().pendingStages === 0) {
        window.__fps.bakeDone = now;
      }
      if (!window.__fps.stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  /* A baseline of the same frame clock before anything audio happens. Headless
   * Chromium on a shared GPU does not hold 60 fps on this scene anyway, so an
   * absolute number from the bake window on its own would convict the bake of
   * the compositor's stutter. The comparison is the measurement. */
  await page.waitForTimeout(1200);

  /* The gesture, and a check that it landed. A click can be eaten — by pointer
   * lock, by Next's dev error overlay, by a frame that happened to be
   * recompiling — and if it is, the bake does not start and every number below
   * is measured over the wrong window. Which is not hypothetical: one run of
   * this script silently measured thirty seconds of idle page because the bake
   * did not begin until `KeyW` arrived and tripped the keydown listener. */
  const canvas = page.locator('canvas');
  const built = () => page.evaluate(() => !!window.__audio && window.__audio.report().built);
  let clicks = 0;
  await page.evaluate(() => { window.__fps.clickAt = performance.now(); });
  for (; clicks < 3; clicks++) {
    await canvas.click({ position: { x: 400, y: 260 } }).catch(() => {});
    await page.waitForFunction(() => !!window.__audio && window.__audio.report().built,
      null, { timeout: 3000 }).catch(() => {});
    if (await built()) break;
    console.log('  (the click did not start the bake — retrying)');
    await page.evaluate(() => { window.__fps.clickAt = performance.now(); });
  }
  if (!(await built())) {
    fail('three clicks and the bake never started — nothing below is measuring what it says');
  }

  /* The bake is deliberately spread across frames against a millisecond budget
   * so it cannot hitch the render, which makes it about a hundred frames — a
   * second and a half in principle and rather more under a headless
   * compositor. */
  await page.waitForFunction(
    () => !!window.__audio && window.__audio.report().built
      && window.__audio.report().pendingStages === 0,
    null, { timeout: 30_000 },
  ).catch(() => {});

  const before = await page.evaluate(() => {
    window.__fps.stop = true;
    return { rep: window.__audio.report(), fps: window.__fps };
  });

  console.log(`  context      ${before.rep.state ?? '(unreported)'}`);
  const costs = Object.entries(before.rep.stageCost ?? {}).sort((a, b) => b[1] - a[1]);
  console.log(`  bank         ${before.rep.bufferKb} kB in ${costs.length} stages, ` +
    `${before.rep.pendingStages} pending`);
  console.log(`  bake cost    wiring ${before.rep.buildMs} ms, worst single frame of bake ` +
    `${before.rep.worstStageMs} ms (${before.rep.worstStage})`);
  console.log(`  total/stage  ${costs.slice(0, 4).map(([n, ms]) => `${n} ${ms}ms`).join(', ')}`);
  /* A whole frame's budget, not the 4 ms the bake aims for.
   *
   * The tight number belongs to tools/audiograph.mjs, which renders the same
   * bank in Node with nothing else running and measures it deterministically.
   * This runs a browser at Idle priority pinned to four cores against a live
   * dev server, and a GC pause or somebody else's recompile lands inside a
   * stage's timing window: the same wren stage has measured 11 ms and 63 ms on
   * consecutive runs of identical code. Failing on that would make this script
   * noise, and its whole purpose is to be believed. */
  if (before.rep.worstStageMs > 33.4) {
    fail(`one bake stage cost ${before.rep.worstStageMs} ms — over a whole 30 fps frame`);
  }
  if (before.rep.buildError) console.error(`  build error  ${before.rep.buildError}`);

  /* Frames before and during the bake. The worst single frame is the number
   * that matters, not the mean: a mean of sixty hides one 200 ms stall, and one
   * 200 ms stall is exactly what baking a megabyte of noise inline looks like —
   * which is what this reported before the bake was split up. */
  const { t, clickAt, bakeDone } = before.fps;
  const gapsIn = (lo, hi) => {
    const w = t.filter((x) => x >= lo && x <= hi);
    return w.slice(1).map((x, i) => x - w[i]);
  };
  const stat = (label, gaps) => {
    if (gaps.length < 4) { console.log(`  ${label}  (too few frames to judge)`); return null; }
    const sorted = [...gaps].sort((a, b) => a - b);
    const worst = sorted[sorted.length - 1];
    const mean = gaps.reduce((s, x) => s + x, 0) / gaps.length;
    const over = (ms) => gaps.filter((g) => g > ms).length;
    console.log(`  ${label}  ${gaps.length} frames, mean ${(1000 / mean).toFixed(1)} fps, ` +
      `worst ${worst.toFixed(1)} ms (${(1000 / worst).toFixed(1)} fps), ` +
      `over 20/33 ms: ${over(20)}/${over(33.4)}`);
    return { worst, mean, over33: over(33.4) };
  };
  const base = stat('fps before  ', gapsIn(0, clickAt));
  /* Only a window that actually closed. An open-ended one measures the idle
   * page after the bake, or the dev server recompiling, and calls it a hitch. */
  const bake = bakeDone > clickAt ? stat('fps in bake ', gapsIn(clickAt, bakeDone)) : null;
  if (!bake) console.log('  fps in bake  (the bake did not complete inside the sample window)');
  /* Judged against the baseline rather than an absolute, and 30 fps is the
   * scene's budget, so a frame the bake pushes past 33 ms is a real hitch.
   *
   * With one caveat that has to be in the arithmetic rather than in a footnote:
   * the engine times its own stages, and a frame cannot be the bake's fault if
   * it is longer than the baseline plus the largest stage the engine measured.
   * This runs against a live Next dev server, and a recompile triggered by
   * somebody else's save shows up here as a 1100 ms frame — attributing that to
   * an 11 ms stage would be wrong, and a check that cries wolf gets ignored,
   * which is how the bug this script was written for survived. */
  const stage = before.rep.worstStageMs ?? 0;
  /* More than one, because a hundred-frame window on a contended box produces
   * the occasional outlier whatever is running in it, and a bake that genuinely
   * hitches produces a run of them rather than one. */
  if (base && bake && bake.over33 > 1) {
    const explains = base.worst + stage + 8;
    if (bake.worst <= explains) {
      fail(`${bake.over33} frames over 33 ms during the bake, worst ${bake.worst.toFixed(0)} ms ` +
        `against a ${base.worst.toFixed(0)} ms baseline — the bake is hitching the render`);
    } else {
      console.log(`  note         ${bake.worst.toFixed(0)} ms worst frame is more than the ` +
        `${base.worst.toFixed(0)} ms baseline plus the ${stage.toFixed(1)} ms worst stage can ` +
        `account for — that is the dev server recompiling or the machine being busy, not the bake`);
    }
  }

  /* Walk. Footsteps are the one layer driven by the simulation rather than by
   * a schedule, so leaving the walker still would leave that bus legitimately
   * silent and make the check ambiguous. */
  const soakSec = Number((process.argv.find((a) => a.startsWith('--soak=')) || '').slice(7) || 6);
  await page.evaluate(() => { window.__scene.setPaused(false); });
  await page.keyboard.down('KeyW');
  if (soakSec <= 6) {
    await page.waitForTimeout(soakSec * 1000);
  } else {
    /* `--soak=180` walks for three minutes and watches the live one-shot count.
     * Every footstep, drip, call and crack allocates a source and a gain and
     * relies on `onended` to disconnect them; a leak there is invisible in a
     * short run and unbounded in a long one. tools/audiograph.mjs proves the
     * same property against a mock over ten minutes, which is faster but is
     * only as good as the mock — this is the same claim in Chrome. */
    let peak = 0;
    for (let s = 0; s < soakSec; s += 10) {
      await page.waitForTimeout(10_000);
      const r = await page.evaluate(() => window.__audio.report());
      peak = Math.max(peak, r.voices);
      console.log(`  soak ${String(s + 10).padStart(4)}s  voices ${String(r.voices).padStart(3)} ` +
        `(peak ${peak})  bank ${r.bufferKb} kB  ${JSON.stringify(r.counts)}`);
    }
    /* A bounded ceiling, not zero: a handful of one-shots are legitimately in
     * flight at any moment. Unbounded growth is what a leak looks like. */
    if (peak > 24) fail(`${peak} concurrent one-shots at peak — sources are not being reclaimed`);
  }
  await page.keyboard.up('KeyW');

  // Nothing waits two minutes for a bird.
  for (const [kind, which] of [['bird', 'thrush'], ['bird', 'wren'], ['crack', null]]) {
    await page.evaluate(([k, w]) => window.__audio.fire(k, w ?? undefined), [kind, which]);
    await page.waitForTimeout(700);
  }

  const after = await page.evaluate(() => window.__audio.report());
  console.log(`  voices       ${after.voices}`);
  console.log(`  gust         ${typeof after.gust === 'number' ? after.gust.toFixed(3) : after.gust}`);
  console.log('  buses');
  for (const [name, v] of Object.entries(after.buses ?? {})) {
    console.log(`    ${name.padEnd(10)} ${JSON.stringify(v)}`);
  }
  console.log(`  counts       ${JSON.stringify(after.counts ?? {})}`);

  /* `problems` is the check, not `silent`. `silent` lists buses that exist and
   * are quiet, so it is empty both when everything works and when nothing was
   * ever built — it cannot fail for the most likely failure mode, which is how
   * a completely dead audio system passed this script once already. */
  const problems = after.problems ?? ['report() has no problems field — engine is older than this tool'];
  for (const p of problems) fail(p);

  if (!Object.keys(after.buses ?? {}).length) fail('no buses exist at all — this run proves nothing');
  if (!after.bufferKb) fail('the bank is empty');
  /* Six seconds of KeyW at 1.15 m/s is about 6.9 m, and a 0.66 m step length
   * puts that at ten footfalls. Anything under five means the gait hook is not
   * reaching the audio, which no meter above would notice. */
  if ((after.counts?.steps ?? 0) < 5) fail(`only ${after.counts?.steps ?? 0} footsteps in six seconds of walking`);
  for (const s of after.silent ?? []) fail(`bus ${s} exists and has passed no signal`);

  if (!process.exitCode) {
    console.log('\n✓ bank built, every bus is passing signal, footsteps firing, no hitch in the bake');
  }
});

finish(process.exitCode || 0);
