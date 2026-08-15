/* Look at a frame properly.
 *
 *   node tools/look.mjs [tag] [--t 0.35] [--pitch -0.35] [--fov 0] [--stops 2.5]
 *
 * Two things `shoot.mjs` does not do, both of which turned out to matter more
 * than the pictures themselves.
 *
 * ── It writes a brightened copy ───────────────────────────────────────────
 *
 * A dark frame hides its own artefacts. The forest floor in this scene shipped
 * for a whole revision with a regular diagonal lattice woven through it — a
 * literal repeating diamond mesh from four rotated needle layers — and it was
 * invisible at the presented exposure and unmissable two and a half stops up.
 * Anything a later system might lift the floor onto is worth looking at now, so
 * every capture gets a `-bright` sibling.
 *
 * ── It samples regions, not the whole frame ───────────────────────────────
 *
 * `probe()` reports one histogram for the frame, and the question that decides
 * whether this scene reads as a photograph is a *relationship*: how the bare
 * tread sits against the duff beside it and against the sky. Those are three
 * numbers and a global median cannot express any of them. The rectangles below
 * are fixed fractions of the frame and are only meaningful for the `down`
 * framing at the default stop, where the trail runs up the middle — which is
 * why that framing is the default here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, finish } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const tag = args[0] && !args[0].startsWith('--') ? args[0] : 'look';
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };

const T = +flag('t', 0.35);
const PITCH = +flag('pitch', -0.35);
const FOV = +flag('fov', 0);
const STOPS = +flag('stops', 2.5);
const W = +flag('w', 1600), H = +flag('h', 900);
/* `--crop x0,y0,x1,y1 --zoom n`, fractions of the frame, y from the top.
 *
 * Reading a 1600x900 capture through a viewer that downsamples it to 1024 wide
 * loses exactly the scale the near tread has to be judged at, and three
 * consecutive rounds of guessing at what a "band" was came from inspecting a
 * downscale. A 1:1 or magnified crop of the near tread answers in one look. */
const CROP = (flag('crop', '') || '').split(',').map(Number);
const ZOOM = +flag('zoom', 1);

const outDir = path.join(ROOT, 'shots', tag);
fs.mkdirSync(outDir, { recursive: true });

/* x0, y0, x1, y1 as fractions of the frame, y from the top.
 *
 * The three trunk boxes are pinned to the `--t 0.42 --pitch -0.10` framing,
 * where each of them lands on a different near bole. They exist because the
 * question System 2 kept failing on — "is a trunk darker than the ground it
 * stands on" — is one the eye answers wrongly under a bright fog dome: a
 * mid-grey column against near-white air looks dark, and it measured lighter
 * than the duff in every capture that was judged by looking. Compare
 * trunkNear/trunkMid against duffLeft/duffRight at the same stop, never across
 * stops, and never against `sky`, which is the fog and is supposed to win.
 */
const REGIONS = {
  treadNear: [0.44, 0.86, 0.56, 0.98],
  treadMid: [0.45, 0.60, 0.55, 0.68],
  duffLeft: [0.08, 0.78, 0.24, 0.92],
  duffRight: [0.76, 0.78, 0.92, 0.92],
  trunkNear: [0.905, 0.16, 0.960, 0.44],
  trunkMid: [0.700, 0.13, 0.755, 0.38],
  trunkFar: [0.180, 0.10, 0.222, 0.34],
  sky: [0.40, 0.02, 0.60, 0.10],
};

await run({ width: W, height: H }, async ({ page, gl }) => {
  const out = await page.evaluate(([t, pitch, fov, stops, regions, cropBox, zoom]) => {
    const s = window.__scene;
    const r = s.renderer;
    const gl2 = r.getContext();

    s.setPaused(true);
    if (fov) { s.camera.fov = fov; s.camera.updateProjectionMatrix(); }
    s.goTo(t);
    s.setYaw(s.walker.yaw);
    s.setPitch(pitch);
    s.warp(2.0);
    s.renderOnce();

    const w = r.domElement.width, h = r.domElement.height;
    const px = new Uint8Array(w * h * 4);
    gl2.readPixels(0, 0, w, h, gl2.RGBA, gl2.UNSIGNED_BYTE, px);

    const stat = (x0, y0, x1, y1) => {
      let rs = 0, gs = 0, bs = 0, n = 0;
      const lum = [];
      // readPixels is bottom-up; the rectangles are given top-down.
      const j0 = Math.round((1 - y1) * h), j1 = Math.round((1 - y0) * h);
      for (let j = j0; j < j1; j++) {
        for (let i = Math.round(x0 * w); i < Math.round(x1 * w); i++) {
          const k = (j * w + i) * 4;
          rs += px[k]; gs += px[k + 1]; bs += px[k + 2]; n++;
          lum.push(0.2126 * px[k] + 0.7152 * px[k + 1] + 0.0722 * px[k + 2]);
        }
      }
      const R = rs / n, G = gs / n, B = bs / n;
      const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
      /* Percentile spread inside the region, which is a different question from
       * the mean and the one that says whether the surface has any tonal
       * structure left by the time it reaches the frame. A tread can measure the
       * right mean value, the right saturation, and still be a flat gradient —
       * that combination is exactly what a correct albedo map buried under a
       * large constant specular term looks like, and there is no way to tell the
       * two apart from a mean. */
      lum.sort((a, b) => a - b);
      const q = (f) => Math.round(lum[Math.min(lum.length - 1, (lum.length * f) | 0)]);
      return {
        rgb: [Math.round(R), Math.round(G), Math.round(B)],
        val: +(mx / 255).toFixed(3),
        sat: +(mx > 0 ? (mx - mn) / mx : 0).toFixed(3),
        /* Luma median and floor. The mean of a region says nothing about the
         * relationship that decides this scene — whether the bare tread sits
         * above or below the duff beside it — because a few bright specular hits
         * drag a mean and leave a median alone. The floor matters for the same
         * reason in reverse: a wet forest floor is mostly dark with a few bright
         * hits, and a region whose darkest decile is still mid-grey is inverted
         * however good its average looks. */
        med: q(0.50), p01: q(0.01),
        p10: q(0.10), p90: q(0.90), spread: q(0.90) - q(0.10),
      };
    };

    const measured = {};
    for (const [name, box] of Object.entries(regions)) measured[name] = stat(...box);

    const raw = r.domElement.toDataURL('image/png');

    /* Brightened copy, made from the pixels just read rather than by changing
     * the renderer's exposure — the point is to inspect the delivered frame,
     * and re-rendering it brighter would also re-roll the tone curve and hide
     * whatever the shadows are doing. */
    const gain = Math.pow(2, stops);
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(w, h);
    for (let j = 0; j < h; j++) {
      const src = (h - 1 - j) * w * 4, dst = j * w * 4;
      for (let i = 0; i < w * 4; i += 4) {
        for (let c = 0; c < 3; c++) {
          // Gain in display space, which is the space the artefact is in.
          img.data[dst + i + c] = Math.min(255, px[src + i + c] * gain);
        }
        img.data[dst + i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const bright = cv.toDataURL('image/png');

    let crop = null;
    if (cropBox.length === 4 && cropBox.every((v) => !Number.isNaN(v))) {
      const [x0, y0, x1, y1] = cropBox;
      const sx = Math.round(x0 * w), sy = Math.round(y0 * h);
      const sw = Math.max(1, Math.round((x1 - x0) * w));
      const sh = Math.max(1, Math.round((y1 - y0) * h));
      const cc = document.createElement('canvas');
      cc.width = sw * zoom; cc.height = sh * zoom;
      const cx = cc.getContext('2d');
      cx.imageSmoothingEnabled = false;
      cx.drawImage(cv, sx, sy, sw, sh, 0, 0, sw * zoom, sh * zoom);
      crop = cc.toDataURL('image/png');
    }

    s.setPaused(false);
    return { measured, raw, bright, crop, hist: s.probe(), fps: +s.fps.toFixed(1), ...s.info() };
  }, [T, PITCH, FOV, STOPS, REGIONS, CROP, ZOOM]);

  const write = (name, dataUrl) => {
    const f = path.join(outDir, name);
    fs.writeFileSync(f, Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log(`  wrote ${path.relative(ROOT, f)}  ${(fs.statSync(f).size / 1024) | 0} kB`);
  };

  console.log(`\n  t=${T} pitch=${PITCH} calls=${out.calls} tris=${(out.triangles / 1000) | 0}k`);
  for (const [name, m] of Object.entries(out.measured)) {
    console.log(`  ${name.padEnd(10)} rgb=${String(m.rgb[0]).padStart(3)},${String(m.rgb[1]).padStart(3)},${String(m.rgb[2]).padStart(3)}`
      + `  med=${String(m.med).padStart(3)}  sat=${m.sat}`
      + `  p01=${String(m.p01).padStart(3)}  p10-90=${String(m.p10).padStart(3)}-${String(m.p90).padStart(3)}`
      + ` spread=${String(m.spread).padStart(3)}`);
  }
  const hi = out.hist;
  console.log(`  frame      med=${hi.median} contrast=${hi.contrast} sat=${hi.sat} black=${hi.blackPct}% blown=${hi.blownPct}%`);
  console.log(`  adapter    ${gl.renderer}\n`);

  write('raw.png', out.raw);
  write(`bright-${STOPS}.png`, out.bright);
  if (out.crop) write(`crop-${STOPS}x${ZOOM}.png`, out.crop);
});

finish(process.exitCode || 0);
