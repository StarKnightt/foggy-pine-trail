/* The ground's silhouette against the air, column by column.
 *
 *   node tools/skyline.mjs [--t 0.60] [--pitch 0] [--step 8] [--w 1024] [--h 576]
 *                          [--all]   include the trees, not just the floor
 *
 * The frame says "there is a straight line across the mid-ground" and cannot
 * say what is drawing it, and the candidates are not distinguishable by eye:
 * the far rim of the ground mesh, the graded columns turning the terrain into
 * three-metre facets at range, the terrain honestly asymptoting to the horizon,
 * and a colour step between saturated air and the dome all produce a horizontal
 * boundary in the same place. They are trivially distinguishable by *distance*.
 * A rim shows one distance across the whole width; facets show a staircase; an
 * honest horizon shows distance climbing smoothly to the far plane.
 *
 * Everything except the floor is hidden by default, because a trunk crossing
 * the boundary hides the very column that would have shown the step.
 */
import { run, finish } from './harness.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };

const T = +flag('t', 0.60);
const PITCH = +flag('pitch', 0);
const STEP = +flag('step', 8);
const W = +flag('w', 1024), H = +flag('h', 576);
const ALL = args.includes('--all');

await run({ width: W, height: H }, async ({ page }) => {
  const out = await page.evaluate(([t, pitch, step, all]) => {
    const s = window.__scene;
    const THREE = window.__THREE;
    const r = s.renderer;
    const gl = r.getContext();

    s.setPaused(true);
    s.goTo(t);
    s.setYaw(s.walker.yaw);
    s.setPitch(pitch);
    s.warp(2.0);

    /* The floor is the one mesh carrying `aTread`; the dome has to stay so the
     * beauty pass still has something for the silhouette to be measured
     * against. Restored from a recorded list rather than by re-traversing,
     * because `visible` is also driven by the tile culling every frame. */
    const hidden = [];
    if (!all) {
      s.scene.traverse((o) => {
        if (!o.isMesh || !o.visible) return;
        const g = o.geometry;
        const floor = g && g.getAttribute && g.getAttribute('aTread');
        const dome = o.material && o.material.fog === false;
        if (!floor && !dome) { hidden.push(o); o.visible = false; }
      });
    }

    const w = r.domElement.width, h = r.domElement.height;
    const buf = new Uint8Array(w * h * 4);
    const grab = () => { gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf); return buf.slice(); };

    s.renderOnce();
    const beauty = grab();

    const DFAR = 400;
    const bg = s.scene.background;
    s.scene.background = null;
    const dm = new THREE.ShaderMaterial({
      uniforms: { uFar: { value: DFAR } },
      vertexShader: `
        varying float vD;
        void main() {
          #ifdef USE_INSTANCING
            vec4 mv = modelViewMatrix * instanceMatrix * vec4( position, 1.0 );
          #else
            vec4 mv = modelViewMatrix * vec4( position, 1.0 );
          #endif
          vD = -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying float vD;
        uniform float uFar;
        void main() {
          float d = clamp( vD / uFar, 0.0, 1.0 );
          gl_FragColor = vec4( floor( d * 255.0 ) / 255.0,
                               floor( fract( d * 255.0 ) * 255.0 ) / 255.0, 0.0, 1.0 );
        }`,
    });
    dm.fog = false;
    s.scene.overrideMaterial = dm;
    r.setClearColor(0x000000, 1);
    s.renderOnce();
    const depth = grab();
    s.scene.overrideMaterial = null;
    s.scene.background = bg;

    const lum = (px, k) => 0.2126 * px[k] + 0.7152 * px[k + 1] + 0.0722 * px[k + 2];
    const cols = [];
    for (let i = 0; i < w; i += step) {
      // readPixels is bottom-up, so the silhouette is the highest j with cover.
      let j = -1;
      for (let q = h - 1; q >= 0; q--) {
        const k = (q * w + i) * 4;
        if (depth[k] || depth[k + 1]) { j = q; break; }
      }
      if (j < 0) { cols.push([i, -1, -1, 0, 0, -1]); continue; }
      const k = (j * w + i) * 4;
      const d = ((depth[k] + depth[k + 1] / 255) / 255) * DFAR;
      const above = Math.min(h - 1, j + 4), below = Math.max(0, j - 4);

      /* The silhouette and the *visible* edge are not the same row and the
       * difference is the whole point: past ~35 m the floor is fogged to
       * within a code value of the air, so what the eye reads as the horizon
       * is the highest row that is actually darker than its sky. A silhouette
       * that is ragged over 18 px is worthless if the visible edge under it is
       * ruled. */
      const sky = lum(beauty, (above * w + i) * 4);
      let v = j;
      for (let q = j; q >= 0; q--) {
        if (lum(beauty, (q * w + i) * 4) < sky - 6) { v = q; break; }
      }
      cols.push([i, h - 1 - j, +d.toFixed(1),
                 Math.round(sky), Math.round(lum(beauty, (below * w + i) * 4)),
                 h - 1 - v]);
    }

    for (const o of hidden) o.visible = true;
    s.renderOnce();
    s.setPaused(false);
    return { cols, w, h };
  }, [T, PITCH, STEP, ALL]);

  console.log(`\n  t=${T} pitch=${PITCH} ${out.w}x${out.h}${ALL ? ' (all geometry)' : ' (floor only)'}`);
  console.log('     x    row   dist   air  ground   d(row)   vis');
  let prev = null;
  const rows = [], vis = [];
  for (const [x, row, d, air, gnd, v] of out.cols) {
    const dr = prev === null || row < 0 ? 0 : row - prev;
    if (row >= 0) { prev = row; rows.push(row); vis.push(v); }
    console.log(`  ${String(x).padStart(4)} ${String(row).padStart(6)} ${String(d).padStart(6)} ${String(air).padStart(5)} ${String(gnd).padStart(7)} ${String(dr).padStart(8)} ${String(v).padStart(5)}`);
  }
  const stat = (a, label) => {
    if (!a.length) return;
    const lo = Math.min(...a), hi = Math.max(...a);
    const mean = a.reduce((p, q) => p + q, 0) / a.length;
    let sd = 0;
    for (const v of a) sd += (v - mean) ** 2;
    sd = Math.sqrt(sd / a.length);
    console.log(`  ${label}: min ${lo} max ${hi} band ${hi - lo} px, sd ${sd.toFixed(1)} px`);
  };
  console.log('');
  stat(rows, 'silhouette rows');
  stat(vis, 'visible edge  ');
  console.log('');
});

finish(process.exitCode || 0);
