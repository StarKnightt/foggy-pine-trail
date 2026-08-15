/* The fog, measured. Three questions this scene cannot answer by eye.
 *
 *   node tools/fog.mjs [--t 0.42] [--pitch 0] [--q "fog=noheight"]
 *                      [--w 1280] [--h 720] [--noperf]
 *
 * ── 1. The curve ──────────────────────────────────────────────────────────
 *
 * Luma of a perfectly black object against distance. Every material is
 * overridden with unlit black, so each pixel measures the air in front of that
 * surface and nothing else, after fog, tone mapping and the sRGB encode.
 * scan.mjs already does this along one scanline; the fog needs it as a
 * *surface* over distance and altitude, because height structure is the whole
 * point of System 3 and a single scanline is a slice at one height.
 *
 * Deriving the curve instead of measuring it was tried on this project and was
 * wrong by 48 counts at 12.5 m, because the mix happens in linear light in
 * front of a tone curve that is not a power law. So: render it and read it.
 *
 * ── 2. The banding ────────────────────────────────────────────────────────
 *
 * A near-uniform bright field quantised to 8 bits is the worst case for Mach
 * banding, and the sky here spans about 14 unique values across 900 rows. Two
 * numbers say whether that is fixed: how many distinct luma values the sky
 * region contains, and the largest step between adjacent rows. Dither raises
 * the first and drops the second; a smoother gradient alone raises the first
 * and leaves the second.
 *
 * ── 3. The cost ───────────────────────────────────────────────────────────
 *
 * Frame time from `performance.now()` deltas inside a rAF loop, never the
 * timestamp rAF is handed. Headless Chromium synthesises that timestamp on a
 * fixed 60 Hz cadence, so a frame that takes 90 ms is reported as 16.7 and a
 * stalling build measures as a perfect one.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, finish, DEV_URL } from './harness.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };

const T = +flag('t', 0.42);
const PITCH = +flag('pitch', 0);
const Q = flag('q', '');
const W = +flag('w', 1280), H = +flag('h', 720);
const PERF = !args.includes('--noperf');

const url = Q ? `${DEV_URL}/?${Q}` : DEV_URL;

await run({ width: W, height: H, url }, async ({ page }) => {
  const out = await page.evaluate(([t, pitch]) => {
    const s = window.__scene;
    const THREE = window.__THREE;
    const r = s.renderer;
    const gl = r.getContext();

    s.setPaused(true);
    s.goTo(t);
    s.setYaw(s.walker.yaw);
    s.setPitch(pitch);
    s.warp(2.0);

    const w = r.domElement.width, h = r.domElement.height;
    const buf = new Uint8Array(w * h * 4);
    const grab = () => {
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      return buf.slice();
    };

    s.renderOnce();
    const beauty = grab();

    /* fog:true so the override still receives whatever the fog chunk does. An
     * override with fog off measures nothing at all and looks identical to a
     * fog that has been switched off, which is the failure this tool exists to
     * make impossible. */
    s.scene.overrideMaterial = new THREE.MeshBasicMaterial({ color: 0x000000, fog: true });
    s.renderOnce();
    const air = grab();

    /* Radial distance from the camera and world altitude, written out as
     * fixed point. Radial and not view-space z, because that is the quantity
     * the fog is now a function of; measuring against planar depth would put a
     * spurious spread into every bin toward the frame edges. */
    const DFAR = 400, YLO = -10, YHI = 60;
    const bg = s.scene.background;
    s.scene.background = null;
    const dm = new THREE.ShaderMaterial({
      uniforms: { uFar: { value: DFAR }, uYlo: { value: YLO }, uYhi: { value: YHI } },
      vertexShader: `
        varying vec3 vW;
        void main() {
          #ifdef USE_INSTANCING
            vec4 mv = modelViewMatrix * instanceMatrix * vec4( position, 1.0 );
            vW = ( modelMatrix * instanceMatrix * vec4( position, 1.0 ) ).xyz;
          #else
            vec4 mv = modelViewMatrix * vec4( position, 1.0 );
            vW = ( modelMatrix * vec4( position, 1.0 ) ).xyz;
          #endif
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying vec3 vW;
        uniform float uFar; uniform float uYlo; uniform float uYhi;
        void main() {
          float d = clamp( length( vW - cameraPosition ) / uFar, 0.0, 1.0 );
          float y = clamp( ( vW.y - uYlo ) / ( uYhi - uYlo ), 0.0, 1.0 );
          gl_FragColor = vec4( floor( d * 255.0 ) / 255.0,
                               floor( fract( d * 255.0 ) * 255.0 ) / 255.0,
                               floor( y * 255.0 ) / 255.0, 1.0 );
        }`,
    });
    dm.fog = false;
    s.scene.overrideMaterial = dm;
    r.setClearColor(0x000000, 1);
    s.renderOnce();
    const geo = grab();

    s.scene.overrideMaterial = null;
    s.scene.background = bg;
    s.renderOnce();

    const lum = (px, k) => 0.2126 * px[k] + 0.7152 * px[k + 1] + 0.0722 * px[k + 2];

    /* Height bands chosen from what the frame is made of: the tread and the
     * litter, the boles at eye level, the lower limbs, and the crowns the
     * trees agent measured at 104-138 and wants at 30-70. */
    const BANDS = [[-2, 2.5], [2.5, 7], [7, 13], [13, 40]];
    const BIN = 2.5, NBIN = 20;
    const cell = BANDS.map(() => Array.from({ length: NBIN }, () => ({ n: 0, a: 0, b: 0 })));

    for (let j = 0; j < h; j += 2) {
      for (let i = 0; i < w; i += 2) {
        const k = (j * w + i) * 4;
        const raw = (geo[k] + geo[k + 1] / 255) / 255;
        if (raw <= 0) continue;
        const d = raw * DFAR;
        if (d > NBIN * BIN) continue;                 // the dome, and anything past the fog
        const y = YLO + (geo[k + 2] / 255) * (YHI - YLO);
        const bi = Math.floor(d / BIN);
        const band = BANDS.findIndex(([lo, hi]) => y >= lo && y < hi);
        if (band < 0) continue;
        const c = cell[band][bi];
        c.n++; c.a += lum(air, k); c.b += lum(beauty, k);
      }
    }

    /* Banding, measured as what banding physically is rather than as a proxy.
     *
     * A Mach band is a *coherent* edge: a run of rows that all carry exactly
     * the same code value, then a step to the next one. The eye's lateral
     * inhibition draws a line on that boundary even though the step is one
     * LSB. Two numbers describe it directly:
     *
     *   modal   the fraction of pixels in a row that share the row's most
     *           common value. 1.00 means the row is a flat plate and the band
     *           edge above and below it is a clean contour. Dither turns the
     *           row into a mixture and drives this down.
     *   plateau the longest run of consecutive rows whose modal value is
     *           identical. That is the width of a band in pixels; a run of
     *           forty rows is what a visible band looks like at this size.
     *
     * Read off the green channel, which carries 72% of the luma and is where a
     * one-LSB contour is most visible.
     */
    const rowsSky = [];
    const modal = [];
    const modalFrac = [];
    for (let j = 0; j < h; j++) {
      let sum = 0, n = 0;
      const hist = new Map();
      /* Every pixel in the row that is open sky, not a contiguous strip. In
       * the framing that actually has a sky gradient in it — looking up — the
       * sky arrives as slots between crowns, and a strip test finds no row in
       * the whole frame that is clear all the way across. */
      for (let i = 0; i < w; i++) {
        const k = (j * w + i) * 4;
        const raw = (geo[k] + geo[k + 1] / 255) / 255;
        if (raw > 0 && raw * DFAR < 190) continue;
        sum += lum(beauty, k); n++;
        hist.set(beauty[k + 1], (hist.get(beauty[k + 1]) || 0) + 1);
      }
      if (n < 60) continue;
      let mv = 0, mc = 0;
      for (const [v, c] of hist) if (c > mc) { mc = c; mv = v; }
      rowsSky.push(sum / n);
      modal.push(mv);
      modalFrac.push(mc / n);
    }
    let maxStep = 0;
    for (let i = 1; i < rowsSky.length; i++) {
      maxStep = Math.max(maxStep, Math.abs(rowsSky[i] - rowsSky[i - 1]));
    }
    let plateau = 0, runLen = 0;
    for (let i = 0; i < modal.length; i++) {
      runLen = i && modal[i] === modal[i - 1] ? runLen + 1 : 1;
      if (runLen > plateau) plateau = runLen;
    }

    /* The largest coherent horizontal edge in the frame, which is what a fog
     * that fails to close looks like.
     *
     * The ground mesh is finite — 44 m to the side and running out 23 m ahead
     * of the last trail stop — and past its rim the camera sees the dome. If
     * the fog has not reached the sky by the rim, or if the two are not the
     * same colour, the last strip of ground carries a step in a dead straight
     * horizontal line all the way across. Three column strips rather than one:
     * an edge is *coherent*, so it shows in all three at the same row, where a
     * trunk silhouette shows in one.
     */
    const seam = [0.08, 0.42, 0.78].map((f0) => {
      const i0 = Math.round(w * f0), i1 = i0 + Math.round(w * 0.14);
      let prev = null, best = 0, at = 0;
      for (let j = 0; j < h; j++) {
        let sum = 0;
        for (let i = i0; i < i1; i++) sum += lum(beauty, (j * w + i) * 4);
        const m = sum / (i1 - i0);
        if (prev !== null && Math.abs(m - prev) > best) { best = Math.abs(m - prev); at = j; }
        prev = m;
      }
      return { step: +best.toFixed(2), row: h - at };
    });

    s.setPaused(false);
    return {
      seam,
      bands: BANDS,
      bin: BIN,
      cell: cell.map((band) => band.map((c) => (c.n < 40 ? null : {
        n: c.n, air: +(c.a / c.n).toFixed(1), dev: +((c.b - c.a) / c.n).toFixed(1),
      }))),
      sky: {
        rows: rowsSky.length,
        modal: +(modalFrac.reduce((a, b) => a + b, 0) / Math.max(1, modalFrac.length)).toFixed(3),
        plateau,
        uniqRows: new Set(modal).size,
        maxStep: +maxStep.toFixed(2),
        lo: +Math.min(...rowsSky).toFixed(1),
        hi: +Math.max(...rowsSky).toFixed(1),
      },
      cam: [+s.camera.position.x.toFixed(2), +s.camera.position.y.toFixed(2), +s.camera.position.z.toFixed(1)],
    };
  }, [T, PITCH]);

  console.log(`\n  t=${T} pitch=${PITCH} ${Q ? '?' + Q : '(shipped)'}  cam=${out.cam.join(',')}  ${W}x${H}`);
  console.log('\n  AIR — luma of a black object, by distance (m) and world altitude (m)');
  const head = out.cell[0].map((_, i) => String(Math.round((i + 0.5) * out.bin)).padStart(5)).join('');
  console.log('    band      ' + head);
  out.cell.forEach((band, bi) => {
    const [lo, hi] = out.bands[bi];
    const row = band.map((c) => (c ? String(Math.round(c.air)).padStart(5) : '    ·')).join('');
    console.log(`    y ${String(lo).padStart(3)}..${String(hi).padStart(3)} ` + row);
  });
  console.log('\n  DEV — beauty minus air: how much of the pixel is surface');
  console.log('    band      ' + head);
  out.cell.forEach((band, bi) => {
    const [lo, hi] = out.bands[bi];
    const row = band.map((c) => (c ? String(Math.round(c.dev)).padStart(5) : '    ·')).join('');
    console.log(`    y ${String(lo).padStart(3)}..${String(hi).padStart(3)} ` + row);
  });

  const s = out.sky;
  console.log(`\n  SKY  rows=${s.rows} range=${s.lo}..${s.hi} over ${s.uniqRows} code values  ` +
    `modalFraction=${s.modal}  longestFlatRun=${s.plateau} rows  maxRowStep=${s.maxStep}`);
  console.log('  SEAM largest horizontal row-to-row step per column strip: ' +
    out.seam.map((c) => `${c.step} @y${c.row}`).join('   '));

  if (PERF) {
    const perf = await page.evaluate(async () => {
      const s = window.__scene;
      s.setPaused(false);
      const dt = [];
      await new Promise((done) => {
        let last = performance.now(), n = 0;
        const tick = () => {
          /* performance.now(), never the argument rAF supplies. Headless
           * Chromium synthesises that on a 60 Hz cadence whatever the GPU is
           * doing, so a build that stalls reports a flat 16.7 ms. */
          const now = performance.now();
          if (n++ > 20) dt.push(now - last);        // skip the warm-up
          last = now;
          if (dt.length < 180) requestAnimationFrame(tick); else done();
        };
        requestAnimationFrame(tick);
      });
      dt.sort((a, b) => a - b);

      /* Uncapped draw cost as well, because the loop above is pinned to vsync
       * and reports 16.7 ms for anything that fits inside a frame — which
       * makes it useless for comparing a build against `?fog=off`. Rendering
       * back to back and reading one pixel at the end forces the pipeline to
       * drain, so the elapsed time is GPU work rather than a queue depth. */
      s.setPaused(true);
      const r = s.renderer, gl = r.getContext();
      const one = new Uint8Array(4);
      for (let i = 0; i < 20; i++) s.renderOnce();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, one);
      const t0 = performance.now();
      const N = 120;
      for (let i = 0; i < N; i++) s.renderOnce();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, one);
      const draw = (performance.now() - t0) / N;
      s.setPaused(false);

      return {
        med: +dt[dt.length >> 1].toFixed(2),
        p95: +dt[Math.floor(dt.length * 0.95)].toFixed(2),
        draw: +draw.toFixed(2),
        calls: s.info().calls,
      };
    });
    console.log(`  PERF median ${perf.med} ms (${(1000 / perf.med).toFixed(0)} fps)  ` +
      `p95 ${perf.p95} ms (${(1000 / perf.p95).toFixed(0)} fps)  ` +
      `uncappedDraw ${perf.draw} ms  calls=${perf.calls}`);
  }
  console.log('');
  void path, fileURLToPath;
});

finish(process.exitCode || 0);
