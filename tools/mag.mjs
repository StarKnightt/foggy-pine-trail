/* Magnify a region and stretch its contrast about its own median.
 *
 *   node tools/mag.mjs <tag> --t 0.60 [--pitch 0] [--crop x0,y0,x1,y1] [--zoom 3]
 *                            [--gain 3] [--pivot auto|<0-255>]
 *
 * `look.mjs --stops` is an *exposure* change, and exposure is the wrong
 * instrument for this scene. The whole frame lives in a fourteen-code-value
 * band around 193, so two and a half stops does not reveal the structure in it,
 * it clips it: the crop above came back as a white rectangle with two trunks in
 * it. The critic's reports are all "at 3x contrast", which is a different
 * operation — pivot on the region's own median and multiply the deviation —
 * and every defect this round was found with it. So the tool has to do that
 * one.
 *
 * Reported alongside the picture because a number settles arguments a picture
 * starts: the region's p1/median/p99 and the fraction of it above 180, which is
 * the statistic the mid-ground histogram target is written in.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, finish } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const tag = args[0] && !args[0].startsWith('--') ? args[0] : 'mag';
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };

const T = +flag('t', 0.6);
const PITCH = +flag('pitch', 0);
const CROP = (flag('crop', '0,0,1,1') || '').split(',').map(Number);
const ZOOM = +flag('zoom', 3);
const GAIN = +flag('gain', 3);
const PIVOT = flag('pivot', 'auto');
const W = +flag('w', 1024), H = +flag('h', 576);

await run({ width: W, height: H }, async ({ page }) => {
  const out = await page.evaluate(([t, pitch, crop, zoom, gain, pivotArg]) => {
    const s = window.__scene;
    s.setPaused(true);
    s.goTo(t);
    s.setYaw(s.walker.yaw);
    s.setPitch(pitch);
    s.warp(2.0);
    s.renderOnce();

    const cv = s.renderer.domElement;
    const W = cv.width, H = cv.height;
    const sx = Math.round(crop[0] * W), sy = Math.round(crop[1] * H);
    const sw = Math.max(1, Math.round((crop[2] - crop[0]) * W));
    const sh = Math.max(1, Math.round((crop[3] - crop[1]) * H));

    const c0 = document.createElement('canvas');
    c0.width = sw; c0.height = sh;
    c0.getContext('2d').drawImage(cv, sx, sy, sw, sh, 0, 0, sw, sh);
    const img = c0.getContext('2d').getImageData(0, 0, sw, sh);
    const d = img.data;

    const lums = new Float64Array(sw * sh);
    for (let i = 0, k = 0; i < d.length; i += 4, k++) {
      lums[k] = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    }
    const sorted = Float64Array.from(lums).sort();
    const q = (f) => sorted[Math.min(sorted.length - 1, Math.round(f * (sorted.length - 1)))];
    let over = 0, mid = 0;
    for (const v of lums) { if (v > 180) over++; if (v >= 70 && v <= 150) mid++; }
    const pivot = pivotArg === 'auto' ? q(0.5) : Number(pivotArg);

    for (let i = 0; i < d.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        d[i + c] = Math.max(0, Math.min(255, 128 + (d[i + c] - pivot) * gain));
      }
    }
    c0.getContext('2d').putImageData(img, 0, 0);

    const c1 = document.createElement('canvas');
    c1.width = sw * zoom; c1.height = sh * zoom;
    const x1 = c1.getContext('2d');
    x1.imageSmoothingEnabled = false;
    x1.drawImage(c0, 0, 0, sw * zoom, sh * zoom);

    return {
      png: c1.toDataURL('image/png'),
      px: sw * sh, sw, sh,
      p1: +q(0.01).toFixed(1), med: +q(0.5).toFixed(1), p99: +q(0.99).toFixed(1),
      pivot: +pivot.toFixed(1),
      over180: +(100 * over / lums.length).toFixed(1),
      mid70_150: +(100 * mid / lums.length).toFixed(1),
    };
  }, [T, PITCH, CROP, ZOOM, GAIN, PIVOT]);

  const dir = path.join(ROOT, 'shots', tag);
  fs.mkdirSync(dir, { recursive: true });
  const name = `mag-g${GAIN}x${ZOOM}.png`;
  fs.writeFileSync(path.join(dir, name), Buffer.from(out.png.split(',')[1], 'base64'));
  console.log(`\n  shots/${tag}/${name}   ${out.sw}x${out.sh} -> x${ZOOM}, gain ${GAIN} about ${out.pivot}`);
  console.log(`  p1 ${out.p1}  med ${out.med}  p99 ${out.p99}   >180 ${out.over180}%   70-150 ${out.mid70_150}%\n`);
});

finish(process.exitCode || 0);
