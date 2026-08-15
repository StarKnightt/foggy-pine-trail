/* Put the camera anywhere and look at anything, optionally with the scene
 * mutated first.
 *
 * `node tools/orbit.mjs out --eye 3,1.6,-19 --at 5,3,-22 [--js "..."] [--fov 55]`
 * `node tools/orbit.mjs out --target 5,0,-22 --dist 4 --bearing 0.7 --eye-y 2.5`
 *
 * Every other capture tool in this directory frames the scene from the walker,
 * which is the right default for judging the picture and useless for judging a
 * single object. A trunk that shows through from one bearing and not from
 * another cannot be found from six fixed stops on a trail, and the report that
 * prompted this said "from every viewing angle", which is a claim about an
 * orbit rather than about a frame.
 *
 * The `--js` hook runs in the page before the render, so a one-line experiment
 * on a material or a geometry does not need a file edit and a rebuild. That
 * matters here specifically because the decisive test for an open shell is
 * forcing the material two-sided and seeing whether the hole fills, and doing
 * that by editing the source would also change the program cache key and half
 * a dozen other things with it.
 */
import { writeFile } from 'node:fs/promises';
import { run, finish, DEV_URL } from './harness.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const vec = (k, d) => { const v = flag(k, null); return v ? v.split(',').map(Number) : d; };

const OUT = args[0] && !args[0].startsWith('--') ? args[0] : 'orbit';
const Q = flag('q', '');
const W = +flag('w', 1600), H = +flag('h', 900);
const JS = flag('js', '');
const FOV = +flag('fov', 0);

const AT = vec('at', null);
const TARGET = vec('target', null);
let EYE = vec('eye', null);
if (!EYE && TARGET) {
  const d = +flag('dist', 5), b = +flag('bearing', 0);
  EYE = [TARGET[0] + Math.sin(b) * d, +flag('eye-y', 1.6), TARGET[2] + Math.cos(b) * d];
}

await run({ width: W, height: H, url: Q ? `${DEV_URL}/?${Q}` : DEV_URL }, async ({ page }) => {
  const res = await page.evaluate(([eye, at, js, fov]) => {
    const s = window.__scene;
    s.setPaused(true);
    // Settle the wind and gait clocks first, so two captures are comparable.
    s.warp(2.0);
    let note = '';
    if (js) { try { note = String(eval(js)); } catch (e) { note = 'JS ERROR: ' + e.message; } }
    const c = s.camera;
    if (fov) { c.fov = fov; }
    c.position.set(eye[0], eye[1], eye[2]);
    c.up.set(0, 1, 0);
    c.lookAt(at[0], at[1], at[2]);
    c.updateProjectionMatrix();
    c.updateMatrixWorld(true);
    s.renderer.render(s.scene, s.camera);
    const url = s.renderer.domElement.toDataURL('image/png');
    s.setPaused(false);
    return { url, note };
  }, [EYE, AT || TARGET, JS, FOV]);

  const path = `shots/_${OUT}.png`;
  await writeFile(path, Buffer.from(res.url.slice(res.url.indexOf(',') + 1), 'base64'));
  console.log(`\n  ${path}  eye=${EYE}  at=${AT || TARGET}${res.note ? `\n  js -> ${res.note}` : ''}\n`);
});

finish(process.exitCode || 0);
