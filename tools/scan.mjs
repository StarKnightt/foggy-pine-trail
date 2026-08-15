/* Luma, depth and fog-only luma for every pixel along one scanline.
 *
 *   node tools/scan.mjs [--t 0.94] [--pitch 0] [--y 0.42]
 *                       [--x0 0] [--x1 1] [--step 2] [--w 1024] [--h 576]
 *                       [--min 0]        only print columns nearer than --max
 *                       [--max 400]      and further than --min
 *
 * Every value question in this scene is a question about a *relationship*
 * between a surface and the air in front of it, and neither a screenshot nor a
 * histogram can express it: a column that measures 74 is a bug if it is 22 m
 * away and correct if it is 3 m away. Reading the frame alone cannot tell those
 * apart, and a whole round of argument about "unfogged rods" came from trying.
 *
 * Three renders of the same frame, so the three numbers for a pixel describe
 * the same surface:
 *
 *   beauty  what ships.
 *   fog     every material overridden with unlit black, so each pixel measures
 *           exactly what a perfectly black object at that depth looks like
 *           after fog, tone mapping and the sRGB encode. Deriving that curve
 *           analytically was tried first and was wrong, because the fog mix
 *           happens in linear light before a tone curve that is not a power
 *           law — at 12.5 m the closed form said 119 and the truth was 71.
 *   depth   MeshDepthMaterial with RGBA packing, unpacked back to view-space
 *           metres. This replaced a raycast per pixel, which was correct and
 *           took five minutes a scanline against 400k untriangulated triangles.
 *
 * `dev = beauty - fog` is then the only number that matters: how much of the
 * pixel is surface rather than air. dev near zero at any depth means the
 * object is contributing nothing and you are looking at fog in the shape of a
 * tree, which is a different failure from "too dark" and needs a different fix.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, finish } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };

const T = +flag('t', 0.94);
const PITCH = +flag('pitch', 0);
const Y = +flag('y', 0.42);
const X0 = +flag('x0', 0), X1 = +flag('x1', 1);
const STEP = +flag('step', 2);
const MIN = +flag('min', 0), MAX = +flag('max', 1e4);
const W = +flag('w', 1024), H = +flag('h', 576);

await run({ width: W, height: H }, async ({ page }) => {
  const out = await page.evaluate(([t, pitch, yf, x0, x1, step]) => {
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

    s.scene.overrideMaterial = new THREE.MeshBasicMaterial({ color: 0x000000, fog: true });
    s.renderOnce();
    const air = grab();

    /* View-space distance written straight out as a 24-bit fixed point value.
     * MeshDepthMaterial with RGBADepthPacking was tried first and reported
     * 0.1 m for the entire frame; rather than keep guessing at whose byte order
     * or whose depth transform was at fault, this encodes the one quantity
     * actually wanted and leaves nothing to interpret. The scene background is
     * dropped for this pass so sky decodes to a clean zero. */
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
          float a = floor( d * 255.0 );
          float b = floor( fract( d * 255.0 ) * 255.0 );
          gl_FragColor = vec4( a / 255.0, b / 255.0, 0.0, 1.0 );
        }`,
    });
    dm.fog = false;
    s.scene.overrideMaterial = dm;
    r.setClearColor(0x000000, 1);
    s.renderOnce();
    const depth = grab();

    s.scene.overrideMaterial = null;
    s.scene.background = bg;
    s.renderOnce();
    const lum = (px, k) => 0.2126 * px[k] + 0.7152 * px[k + 1] + 0.0722 * px[k + 2];

    const j = Math.round((1 - yf) * h);          // readPixels is bottom-up
    const rows = [];
    for (let i = Math.round(x0 * w); i < Math.round(x1 * w); i += step) {
      const k = (j * w + i) * 4;
      const raw = (depth[k] + depth[k + 1] / 255) / 255;
      const d = raw <= 0 ? -1 : raw * DFAR;
      rows.push([i, +d.toFixed(1), Math.round(lum(beauty, k)), Math.round(lum(air, k))]);
    }
    s.setPaused(false);
    return { rows, density: s.scene.fog.density, w, h };
  }, [T, PITCH, Y, X0, X1, STEP]);

  console.log(`\n  t=${T} pitch=${PITCH} y=${Y}  fogDensity=${out.density}  ${out.w}x${out.h}`);
  console.log('     x   dist  beauty   air    dev');
  let n = 0, sum = 0;
  for (const [x, d, b, a] of out.rows) {
    if (d < 0 || d < MIN || d > MAX) continue;
    n++; sum += b - a;
    console.log(`  ${String(x).padStart(4)} ${String(d).padStart(6)} ${String(b).padStart(7)} ${String(a).padStart(5)} ${String(b - a).padStart(6)}`);
  }
  if (n) console.log(`  mean dev over ${n} columns: ${(sum / n).toFixed(1)}`);
  console.log('');
});

finish(process.exitCode || 0);
