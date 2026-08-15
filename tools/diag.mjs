/* One-off measurements against the running page.
 *
 * `px.mjs` takes an expression; anything that needs statements — a texture
 * readback, a temporary render target, a loop — does not fit through it, and
 * quoting a multi-line JS body through a Windows shell mangles it. So the
 * awkward questions get a file.
 */
import { run, finish } from './harness.mjs';

await run({ width: 640, height: 360 }, async ({ page }) => {
  const out = await page.evaluate(() => {
    const s = window.__scene;
    const THREE = window.__THREE;
    const r = s.renderer;

    let ground = null;
    s.scene.traverse((o) => { if (o.isMesh && o.geometry.getAttribute('aTread')) ground = o; });
    if (!ground) return { error: 'no ground mesh found' };
    const m = ground.material;
    const gl = r.getContext();
    const W = r.domElement.width, H = r.domElement.height;

    /* Statistics of a texture, read back through a shader so the sampler's own
     * colour-space decode is included — which is the number the material
     * actually sees, not the number that was written. */
    const readQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
    readQuad.frustumCulled = false;
    const readScene = new THREE.Scene().add(readQuad);
    const readCam = new THREE.Camera();

    function texStats(tex, size) {
      size = size || 128;
      const rt = new THREE.WebGLRenderTarget(size, size, { depthBuffer: false, stencilBuffer: false });
      const mat = new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        uniforms: { t: { value: tex } },
        vertexShader:
          'in vec3 position; in vec2 uv; out vec2 v;' +
          'void main(){ v = uv; gl_Position = vec4(position.xy,0.,1.); }',
        fragmentShader:
          'precision highp float; uniform sampler2D t; in vec2 v; out vec4 o;' +
          'void main(){ o = vec4(textureLod(t, v, 0.0).rgb, 1.0); }',
        depthTest: false, depthWrite: false,
      });
      readQuad.material = mat;
      const prev = r.getRenderTarget();
      r.setRenderTarget(rt);
      r.render(readScene, readCam);
      const buf = new Uint8Array(size * size * 4);
      r.readRenderTargetPixels(rt, 0, 0, size, size, buf);
      r.setRenderTarget(prev);
      rt.dispose(); mat.dispose();

      const n = size * size;
      const stat = [0, 1, 2].map((ch) => {
        let sum = 0, mx = 0, mn = 255;
        const vals = [];
        for (let i = 0; i < n; i++) {
          const v = buf[i * 4 + ch];
          sum += v; if (v > mx) mx = v; if (v < mn) mn = v;
          vals.push(v);
        }
        vals.sort((a, b) => a - b);
        return {
          mean: +(sum / n / 255).toFixed(4),
          min: +(mn / 255).toFixed(4),
          p99: +(vals[(n * 0.99) | 0] / 255).toFixed(4),
          max: +(mx / 255).toFixed(4),
        };
      });
      return stat;
    }

    function frame() {
      s.renderOnce();
      const px = new Uint8Array(W * H * 4);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return px;
    }
    // "Not the black clear colour" — tone mapping moves any specific colour we
    // might test for, so the only reliable question is whether anything drew.
    function litPct(px) {
      let n = 0;
      for (let i = 0; i < W * H; i++) if (px[i * 4] > 4 || px[i * 4 + 1] > 4 || px[i * 4 + 2] > 4) n++;
      return +((100 * n) / (W * H)).toFixed(1);
    }

    s.setPaused(true);
    s.goTo(0.35);
    s.setPitch(-0.35);

    const fog = s.scene.fog, bg = s.scene.background;
    s.scene.fog = null;
    s.scene.background = null;
    r.setClearColor(0x000000, 1);

    const real = ground.material;
    const probeMat = new THREE.MeshBasicMaterial({ color: 0xff0000, fog: false });
    ground.material = probeMat;
    const coverage = {};
    for (const [name, side] of [['front', THREE.FrontSide], ['back', THREE.BackSide]]) {
      probeMat.side = side;
      probeMat.needsUpdate = true;
      coverage[name] = litPct(frame());
    }
    coverage.tris = r.info.render.triangles;
    ground.material = real;
    probeMat.dispose();

    s.scene.fog = fog;
    s.scene.background = bg;

    const maps = m.userData.maps;
    const surfaces = {};
    if (maps) {
      for (const k of ['tread', 'litter']) {
        surfaces[k] = {
          albedo: texStats(maps[k].map),
          orm: texStats(maps[k].ormMap),
        };
      }
    }

    return {
      coverage,
      surfaces,
      shader: m.userData.shader
        ? {
            hasTreadMap: m.userData.shader.fragmentShader.includes('uTreadMap'),
            hasVTread: m.userData.shader.vertexShader.includes('vTread ='),
          }
        : 'not stashed',
    };
  });
  console.log(JSON.stringify(out, null, 2));
});

finish(process.exitCode || 0);
