/* Dump the baked ground maps to PNG, and their statistics.
 *
 * `node tools/tex.mjs [tag]`
 *
 * Looking at a baked map directly settles a question the render cannot: whether
 * a texture is flat or whether something downstream is flattening it. The
 * specific failure this was written for is a tread that measured the right mean
 * value and the right saturation and still read as a smooth gradient — from the
 * frame alone there is no way to tell whether the mottling is missing from the
 * map, being averaged away by the mip chain, or being buried under a constant
 * specular term from the environment.
 *
 * Read through a sampler rather than off the render target, so the colour-space
 * decode is included and the numbers are what the material sees.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { run, finish } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tag = process.argv[2] || 'tex';
const outDir = path.join(ROOT, 'shots', tag);
fs.mkdirSync(outDir, { recursive: true });

const ONLY = process.argv.slice(3).filter((a) => !a.startsWith('--'));

await run({ width: 900, height: 520 }, async ({ page }) => {
  await page.evaluate((only) => { window.__texOnly = only.length ? only : null; }, ONLY);
  const out = await page.evaluate(() => {
    const s = window.__scene;
    const THREE = window.__THREE;
    const r = s.renderer;

    /* Any material that publishes a `maps` bag, keyed by the attribute that
     * identifies its geometry. The bark set is only reachable this way — it is
     * bound as a bare uniform inside a patched shader and not as a material
     * slot, so nothing that walks the material can see it, and the question
     * this tool exists to settle ("is the flatness in the map or downstream of
     * it") is one the bark needed answering more urgently than the ground did. */
    const sets = {};
    s.scene.traverse((o) => {
      if (!o.isMesh || !o.material || !o.material.userData.maps) return;
      const bag = o.material.userData.maps;
      for (const k of Object.keys(bag)) if (bag[k] && bag[k].map) sets[k] = bag[k];
    });
    if (!Object.keys(sets).length) return { error: 'no material published userData.maps' };

    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
    quad.frustumCulled = false;
    const scene = new THREE.Scene().add(quad);
    const cam = new THREE.Camera();

    const grab = (tex, size) => {
      const rt = new THREE.WebGLRenderTarget(size, size, { depthBuffer: false, stencilBuffer: false });
      const mat = new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        uniforms: { t: { value: tex } },
        vertexShader: 'in vec3 position; in vec2 uv; out vec2 v;'
          + 'void main(){ v = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader: 'precision highp float; uniform sampler2D t; in vec2 v; out vec4 o;'
          + 'void main(){ o = vec4(textureLod(t, v, 0.0).rgb, 1.0); }',
        depthTest: false, depthWrite: false,
      });
      quad.material = mat;
      const prev = r.getRenderTarget();
      r.setRenderTarget(rt);
      r.render(scene, cam);
      const buf = new Uint8Array(size * size * 4);
      r.readRenderTargetPixels(rt, 0, 0, size, size, buf);
      r.setRenderTarget(prev);
      rt.dispose(); mat.dispose();

      /* Percentile spread of luminance, which is the number that says whether a
       * surface has tonal structure. A mean tells you the exposure is right and
       * nothing else. */
      const lum = [];
      for (let i = 0; i < size * size; i++) {
        lum.push(0.2126 * buf[i * 4] + 0.7152 * buf[i * 4 + 1] + 0.0722 * buf[i * 4 + 2]);
      }
      lum.sort((a, b) => a - b);
      const q = (f) => Math.round(lum[Math.min(lum.length - 1, (lum.length * f) | 0)]);

      /* Per-channel percentiles as well as luminance, so a term under audit can
       * be written into one channel and read back as a distribution rather than
       * inferred from a difference. What matters for an inert term is coverage —
       * a term whose 99th percentile is zero never fires anywhere, and no amount
       * of tuning its strength will change a pixel. */
      const chan = [];
      for (let c = 0; c < 3; c++) {
        const v = [];
        for (let i = 0; i < size * size; i++) v.push(buf[i * 4 + c]);
        v.sort((a, b) => a - b);
        const cq = (f) => Math.round(v[Math.min(v.length - 1, (v.length * f) | 0)]);
        const nz = v.reduce((n, x) => n + (x > 2 ? 1 : 0), 0) / v.length;
        chan.push({ p50: cq(0.5), p90: cq(0.9), p99: cq(0.99), max: v[v.length - 1],
                    live: +(nz * 100).toFixed(1) });
      }

      const cv = document.createElement('canvas');
      cv.width = size; cv.height = size;
      const ctx = cv.getContext('2d');
      const img = ctx.createImageData(size, size);
      for (let j = 0; j < size; j++) {
        const src = (size - 1 - j) * size * 4, dst = j * size * 4;
        for (let i = 0; i < size * 4; i++) img.data[dst + i] = buf[src + i];
        for (let i = 3; i < size * 4; i += 4) img.data[dst + i] = 255;
      }
      ctx.putImageData(img, 0, 0);
      return {
        png: cv.toDataURL('image/png'),
        stats: { p1: q(0.01), p25: q(0.25), p50: q(0.5), p75: q(0.75), p99: q(0.99) },
        chan,
      };
    };

    const res = {};
    const only = window.__texOnly;
    for (const [set, which] of Object.entries(sets)) {
      if (only && !only.includes(set)) continue;
      res[set + '-albedo'] = grab(which.map, 512);
      res[set + '-normal'] = grab(which.normalMap, 512);
      res[set + '-orm'] = grab(which.ormMap, 512);
    }
    quad.geometry.dispose();
    return res;
  });

  if (out.error) { console.error('  ' + out.error); process.exitCode = 1; return; }

  console.log('\n  luminance percentiles of the baked maps, 0-255 in the sampled space');
  console.log('  albedo: spread is the tonal structure. orm: g = roughness, r = ao.\n');
  for (const [name, v] of Object.entries(out)) {
    const st = v.stats;
    console.log(`  ${name.padEnd(14)} p1=${String(st.p1).padStart(3)}  p25=${String(st.p25).padStart(3)}`
      + `  p50=${String(st.p50).padStart(3)}  p75=${String(st.p75).padStart(3)}  p99=${String(st.p99).padStart(3)}`
      + `   spread=${st.p99 - st.p1}`);
    if (process.argv.includes('--chan')) {
      for (const [i, c] of v.chan.entries()) {
        console.log(`    ${'rgb'[i]}  p50=${String(c.p50).padStart(3)} p90=${String(c.p90).padStart(3)}`
          + ` p99=${String(c.p99).padStart(3)} max=${String(c.max).padStart(3)}  nonzero=${c.live}%`);
      }
    }
    const f = path.join(outDir, name + '.png');
    fs.writeFileSync(f, Buffer.from(v.png.split(',')[1], 'base64'));
  }
  console.log(`\n  → ${path.relative(ROOT, outDir)}`);
});

finish(process.exitCode || 0);
