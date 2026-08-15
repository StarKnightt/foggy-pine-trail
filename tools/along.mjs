/* Tread brightness as a function of position along the trail.
 *
 * `node tools/along.mjs [tag]`
 *
 * The defect this measures is "the tread is uniformly bright along its entire
 * length", which matters out of proportion to how it sounds: a continuous pale
 * stripe against a dark field reads as an object lying on top of the field, so a
 * trail with no along-length value variation reads as a raised causeway however
 * correct its measured cross-section is. Neither the whole-frame histogram nor a
 * single stop can see it — the histogram is dominated by sky and one stop has
 * nothing to compare against.
 *
 * So: walk the trail, frame the tread the same way at every station, and report
 * the near-tread value. The number that matters is the spread across stations.
 * Under about 15 sRGB units of range is a ribbon; a real trail photographed along
 * its length runs 40 or more.
 */
import { run, finish } from './harness.mjs';

const tag = process.argv[2] || 'along';
const STATIONS = [0.08, 0.20, 0.32, 0.44, 0.56, 0.68, 0.80, 0.92];
/* The tread just in front of the walker, where it fills the frame and is not yet
 * mixed with fog. Deliberately narrow in x so a station where the trail curves
 * does not sample the duff beside it. */
const BOX = [0.455, 0.80, 0.545, 0.95];

await run({ width: 1600, height: 900 }, async ({ page }) => {
  const rows = await page.evaluate(([stations, box]) => {
    const s = window.__scene;
    const r = s.renderer;
    const gl = r.getContext();
    s.setPaused(true);

    const out = [];
    for (const t of stations) {
      s.goTo(t);
      s.setYaw(s.walker.yaw);
      s.setPitch(-0.35);
      s.warp(2.0);
      s.renderOnce();

      const w = r.domElement.width, h = r.domElement.height;
      const px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);

      const [x0, y0, x1, y1] = box;
      const j0 = Math.round((1 - y1) * h), j1 = Math.round((1 - y0) * h);
      const lum = [];
      let rs = 0, gs = 0, bs = 0, n = 0;
      for (let j = j0; j < j1; j++) {
        for (let i = Math.round(x0 * w); i < Math.round(x1 * w); i++) {
          const k = (j * w + i) * 4;
          rs += px[k]; gs += px[k + 1]; bs += px[k + 2]; n++;
          lum.push(0.2126 * px[k] + 0.7152 * px[k + 1] + 0.0722 * px[k + 2]);
        }
      }
      lum.sort((a, b) => a - b);
      const q = (f) => Math.round(lum[Math.min(lum.length - 1, (lum.length * f) | 0)]);
      out.push({
        t,
        lum: Math.round(lum.reduce((a, b) => a + b, 0) / n),
        p05: q(0.05), p50: q(0.5), p95: q(0.95),
        rgb: [Math.round(rs / n), Math.round(gs / n), Math.round(bs / n)],
      });
    }
    s.setPaused(false);
    return out;
  }, [STATIONS, BOX]);

  console.log('\n  near-tread value by station along the trail');
  console.log('     t     lum   p05  p50  p95        rgb');
  for (const r of rows) {
    console.log(`  ${r.t.toFixed(2)}   ${String(r.lum).padStart(4)}  ${String(r.p05).padStart(4)}`
      + ` ${String(r.p50).padStart(4)} ${String(r.p95).padStart(4)}   `
      + `${String(r.rgb[0]).padStart(3)},${String(r.rgb[1]).padStart(3)},${String(r.rgb[2]).padStart(3)}`);
  }
  const v = rows.map((r) => r.lum);
  const lo = Math.min(...v), hi = Math.max(...v);
  console.log(`\n  across stations: min=${lo} max=${hi} range=${hi - lo}`
    + `  ratio=${(hi / Math.max(1, lo)).toFixed(2)}x`);
  console.log(`  darkest 5th percentile anywhere: ${Math.min(...rows.map((r) => r.p05))}`);
}, { tag });

finish(process.exitCode || 0);
