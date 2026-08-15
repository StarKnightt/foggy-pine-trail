/* Prove the walker cannot leave the trail corridor.
 *
 * This exists because the failure it guards against was shipped and found by a
 * person rather than by a tool: the trail-recentring vector was inverted and
 * its magnitude scaled with distance, so holding a strafe key fed itself and
 * accelerated the camera out of the built world in about a second.
 *
 * A visual check would not have caught it. The symptom is a black frame, which
 * looks like a dozen unrelated faults, and it only triggers on an input no
 * capture uses — every `shoot.mjs` framing teleports to a stop and walks
 * forward, so the entire archive was blind to it.
 *
 * Asserted numerically instead, by driving the real `update()` with the worst
 * input available — full lateral strafe, held, both directions, from several
 * points along the walk — and requiring the excursion to stay bounded.
 */
import { run, finish } from './harness.mjs';

/* Long enough to reach the boundary and then push against it for a while.
 *
 * At 1.15 m/s a walker needs 26 s to cross 30 m of slack, so the 15 s this used
 * when the corridor was a metre wide would now finish mid-journey and report a
 * clean pass on a walker that was still travelling. A test whose duration is
 * shorter than the thing it measures is the most confident kind of wrong. */
const SECONDS = 55;
const DT = 1 / 60;
/* The spring's slack is `ROAM` (30 m) and the hard backstop is `ROAM_HARD`
 * (35 m). Allowing 36 leaves a frame of overshoot at the backstop without
 * accepting a walker meaningfully outside it. The world's ground stops at 44. */
const LIMIT = 36.0;

await run({ width: 900, height: 520 }, async ({ page }) => {
  const results = await page.evaluate(([seconds, dt]) => {
    const s = window.__scene;
    const w = s.walker;
    const steps = Math.round(seconds / dt);
    const out = [];

    for (const start of [0.1, 0.4, 0.75]) {
      for (const strafe of [-1, 1]) {
        w.placeAt(start);
        const x0 = w.x, z0 = w.z;
        let worst = 0;
        const trace = [];
        for (let i = 0; i < steps; i++) {
          w.update(dt, { forward: 0, strafe });
          /* Displacement from where the walk began. The trail moves under the
           * walker by at most a few centimetres here because there is no
           * forward input, so this is the lateral excursion. */
          const d = Math.hypot(w.x - x0, w.z - z0);
          if (d > worst) worst = d;
          if (i % Math.round(steps / 5) === 0) trace.push(+d.toFixed(2));
        }
        out.push({
          start, strafe,
          worst: +worst.toFixed(3),
          final: +Math.hypot(w.x - x0, w.z - z0).toFixed(3),
          trace,
          finite: Number.isFinite(w.x) && Number.isFinite(w.z),
        });
      }
    }
    return out;
  }, [SECONDS, DT]);

  let bad = 0;
  for (const r of results) {
    /* Runaway is *acceleration*, not motion.
     *
     * This first asked whether the excursion was still growing at the end,
     * which was right against a 0.8 m boundary reached in a tenth of a second
     * and wrong against a 30 m one approached down a 2.5 m ramp: an asymptotic
     * settle is still growing on its last sample, by design, and the check
     * failed a walker that was behaving exactly as specified. Comparing the
     * last increment against the previous one distinguishes the two — a spring
     * settling decelerates, and the positive-feedback bug this exists to catch
     * grew its step every frame. */
    const n = r.trace.length;
    const diverging = n > 2
      && (r.trace[n - 1] - r.trace[n - 2]) > (r.trace[n - 2] - r.trace[n - 3]) + 0.05;
    const ok = r.finite && r.worst <= LIMIT && !diverging;
    if (!ok) bad++;
    console.log(
      `  t=${r.start.toFixed(2)} strafe=${r.strafe > 0 ? '+1' : '-1'}  ` +
      `worst=${String(r.worst).padStart(6)} m  final=${String(r.final).padStart(6)} m  ` +
      `trace=[${r.trace.join(' ')}]  ${ok ? 'ok' : 'FAIL'}`,
    );
  }

  if (bad) {
    console.error(`\n✗ ${bad} of ${results.length} runs left the corridor or diverged.`);
    process.exitCode = 1;
  } else {
    console.log(`\n✓ all ${results.length} runs stayed inside ${LIMIT} m and settled`);
  }
});

finish(process.exitCode || 0);
