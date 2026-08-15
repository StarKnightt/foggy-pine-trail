/* Print the trail's cross-section in centimetres.
 *
 * `node tools/xsect.mjs [half_metres]`
 *
 * The profile is the one property of the ground that a render cannot be trusted
 * on: foreshortened at 1.6m eye height a 30cm trench and a 10cm bench look
 * about the same, so the depth has to be read as numbers. Sampling at several
 * stations down the trail also catches the failure a single station hides —
 * depth that comes from the terrain the trail is crossing rather than from
 * `trailDepth`, which varies along the length and shows up here as stations
 * that disagree.
 *
 * Reference target (boot-worn single-track): 45-60cm of walkable flat base
 * carrying 2-4cm of dish, then a 5-15cm rise into the duff bank, and under 15cm
 * total from tread centre to undisturbed floor.
 */
import { run, finish } from './harness.mjs';

const HALF = +(process.argv[2] || 1.6);
const STEP = 0.02;
const STATIONS = [3, 9, 16, 24, 33, 44];

await run({ width: 640, height: 400 }, async ({ page }) => {
  const data = await page.evaluate(
    ([stations, half, step]) => stations.map((a) => window.__scene.crossSection(a, half, step)),
    [STATIONS, HALF, STEP],
  );

  const n = data[0].length;
  const mid = (n - 1) / 2;

  /* Quoted against the floor just outside the disturbed margin, and not against
   * the outermost samples: the hummock bands are 2.4 m and 7 m and the trail
   * rides them, so at 1.6 m out the floor is legitimately 10-15 cm off the
   * centreline height, and calling that trail depth reports terrain as a trench.
   *
   * Median rather than mean, over a wide band rather than a narrow one, because
   * a root swell is 16 cm across and raises the ground 6 cm. A mean over 15 cm
   * of shoulder that happens to land on one reported four of six stations 12 cm
   * deeper than they are. Both shoulders, so a sidehill station does not read as
   * a one-sided cut. */
  const med = (a) => { const s = [...a].sort((p, q) => p - q); return s[s.length >> 1]; };
  const pick = (lo, hi) => {
    const ix = [];
    for (let i = 0; i < n; i++) {
      const s = Math.abs(-HALF + i * STEP);
      if (s >= lo && s <= hi) ix.push(i);
    }
    return ix;
  };
  const shoulder = pick(0.55, 1.20);
  const base = pick(0, 0.20);
  const rel = data.map((h) => {
    const floor = med(shoulder.map((i) => h[i]));
    return h.map((v) => (v - floor) * 100);
  });

  /* All the profile statistics are confined to the corridor. Outside 90 cm the
   * shape belongs to the hummock field, and letting it in makes every number a
   * mixture of two things that are tuned separately. */
  const i0 = Math.round((HALF - 0.90) / STEP);
  const i1 = n - 1 - i0;

  const stat = (all) => {
    const r = all.slice(i0, i1 + 1);
    let lo = 1e9, loAt = 0;
    for (let i = 0; i < r.length; i++) if (r[i] < lo) { lo = r[i]; loAt = i; }
    /* Flat base = the run around the deepest point staying within 4cm of it,
     * which is the dish tolerance a boot reads as level. */
    let a = loAt, b = loAt;
    while (a > 0 && r[a - 1] < lo + 4) a--;
    while (b < r.length - 1 && r[b + 1] < lo + 4) b++;
    /* Steepest 10cm window, as a percentage grade — the "near-vertical wall"
     * complaint is a number, and this is it. */
    const w = Math.round(0.10 / STEP);
    let grade = 0;
    for (let i = 0; i + w < r.length; i++) {
      const g = Math.abs(r[i + w] - r[i]) / 10;
      if (g > grade) grade = g;
    }
    return {
      base: med(base.map((i) => all[i])),
      dishCm: Math.max(...base.map((i) => all[i])) - Math.min(...base.map((i) => all[i])),
      flatCm: (b - a) * STEP * 100,
      gradePct: grade * 100,
    };
  };

  const f = (x, w = 6) => x.toFixed(1).padStart(w);
  console.log(`cross-section, +-${HALF}m about the centreline, cm relative to floor\n`);
  console.log('  station     base     dish  flatbase  maxgrade');
  for (let i = 0; i < STATIONS.length; i++) {
    const s = stat(rel[i]);
    console.log(
      `  ${String(STATIONS[i] + 'm').padStart(6)}  ${f(s.base)}   ${f(s.dishCm)}` +
      `  ${f(s.flatCm)}cm   ${f(s.gradePct)}%`,
    );
  }

  /* An ASCII section at one station, because the shape of the transition (V vs
   * U vs bench-and-bank) is what the numbers above cannot show. */
  const r = rel[2];
  const lo = Math.min(...r), hi = Math.max(...r);
  const rows = 16;
  console.log(`\nsection at ${STATIONS[2]}m,  ${lo.toFixed(1)}cm to ${hi.toFixed(1)}cm, ${(2 * HALF).toFixed(1)}m wide`);
  for (let y = 0; y < rows; y++) {
    const top = hi - ((hi - lo) * y) / rows;
    const bot = hi - ((hi - lo) * (y + 1)) / rows;
    let line = '';
    for (let i = 0; i < n; i += 2) line += r[i] <= top && r[i] > bot ? '#' : r[i] > top ? ' ' : '.';
    console.log(`  ${top.toFixed(1).padStart(6)} |${line}`);
  }
});

finish(process.exitCode || 0);
