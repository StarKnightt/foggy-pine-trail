/* Differenced pairs for the post chain, both frames from one page load.
 *
 *   node tools/postdiff.mjs [--t 0.42] [--pitch 0] [--terms nolift,nohue,...]
 *
 * Why not tools/fogdiff.mjs, which does the same job across two loads: the
 * null test failed. Differencing the shipped build against the shipped build
 * came back at mean|dY| = 1.73 over 96% of the frame, so the noise floor was
 * larger than every term in this chain and all of them measured the same
 * number. Something in the scene is phased off a clock that begins at page
 * load, and `renderOnce` re-poses and redraws without advancing it, so the
 * phase is frozen per load and arbitrary across loads. Driving r3f's clock did
 * not help, which locates it in elapsed time rather than in the delta.
 *
 * Inside one load nothing between two `renderOnce` calls advances time, so the
 * pair is bit-identical and the floor is a true zero — verified below on every
 * run, because a differencing tool whose floor is not measured is the thing it
 * exists to catch.
 *
 * `window.__post.set` recompiles the quad's fragment shader with a different
 * constant set. Same GLSL, same program structure; only the numbers change, so
 * a measured difference cannot be an artifact of a different shader.
 */
import { run, finish, DEV_URL } from './harness.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };

const T = +flag('t', 0.42);
const PITCH = +flag('pitch', 0);
const W = +flag('w', 1024), H = +flag('h', 576);
const TERMS = flag('terms', 'nodof,nolift,nohue,nonear,novig,nograin,nodither,nograde')
  .split(',').filter(Boolean);

await run({ width: W, height: H, url: DEV_URL }, async ({ page }) => {
  const ok = await page.evaluate(() => !!window.__post);
  if (!ok) {
    console.error('\n  ✗ window.__post missing — is ?nohdr set, or not a dev build?');
    process.exitCode = 1;
    return;
  }

  /* `setDriven` before anything else, and no `step` afterwards.
   *
   * The floor was still 1.715 with both frames from one load, because the wait
   * that lets React commit the new flag set is a wait during which the rAF loop
   * keeps running: the wind phase moves and the grain seed, which is
   * `floor(clock * GRAIN_HZ)`, lands on a different value. So the pair was two
   * different instants after all. `frameloop: 'never'` stops the loop dead
   * while leaving React's own scheduling alone, which freezes every animated
   * uniform and every seed at one instant for the whole run. `renderOnce` does
   * not advance any of them, so all the draws below are the same moment. */
  await page.evaluate(([T, P]) => {
    const s = window.__scene;
    s.setPaused(true);
    s.setDriven(true);
    s.goTo(T); s.setYaw(s.walker.yaw); s.setPitch(P); s.warp(2.0);
  }, [T, PITCH]);
  await page.waitForTimeout(300);

  const shoot = async (q) => {
    await page.evaluate((q) => window.__post.set(q), q);
    await page.waitForTimeout(120);
    return page.evaluate(() => {
      const s = window.__scene, r = s.renderer, gl = r.getContext();
      s.renderOnce();
      const w = r.domElement.width, h = r.domElement.height;
      const px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let bin = '';
      for (let i = 0; i < px.length; i += 4) bin += String.fromCharCode(px[i], px[i + 1], px[i + 2]);
      return { w, h, b64: btoa(bin) };
    });
  };

  const lum = (p, k) => 0.2126 * p[k] + 0.7152 * p[k + 1] + 0.0722 * p[k + 2];

  /* Bands by image row. A term that only touches the near ground has to show in
   * `low` and nowhere else; a whole-frame mean would let a term that had become
   * a uniform lift pass as if it were localised. */
  const BANDS = ['top', 'mid', 'low'];

  const compare = (a, b) => {
    const pa = Buffer.from(a.b64, 'base64'), pb = Buffer.from(b.b64, 'base64');
    const { w, h } = a;
    const mk = () => ({ n: 0, dy: 0, dc: 0, max: 0, moved: 0, ya: 0, yb: 0 });
    const st = BANDS.map(mk), all = mk();
    for (let j = 0; j < h; j++) {
      const band = j > h * 0.66 ? 0 : j > h * 0.33 ? 1 : 2; // readPixels is bottom-up
      for (let i = 0; i < w; i++) {
        const k = (j * w + i) * 3;
        const la = lum(pa, k), lb = lum(pb, k);
        const dy = Math.abs(la - lb);
        /* A hue rotation about the achromatic axis moves no luma at all, so a
         * luma-only difference reports a working chroma term as inert. r-b is
         * the axis both chroma terms here act along. */
        const dc = Math.abs((pa[k] - pa[k + 2]) - (pb[k] - pb[k + 2]));
        for (const s of [st[band], all]) {
          s.n++; s.dy += dy; s.dc += dc; s.ya += la; s.yb += lb;
          if (dy > s.max) s.max = dy;
          if (dy >= 1 || dc >= 1) s.moved++;
        }
      }
    }
    return { st, all };
  };

  const line = (name, s) =>
    `  ${name.padEnd(6)} |dY|=${(s.dy / s.n).toFixed(3).padStart(6)}  ` +
    `|dRB|=${(s.dc / s.n).toFixed(3).padStart(6)}  max=${s.max.toFixed(0).padStart(3)}  ` +
    `moved=${((100 * s.moved) / s.n).toFixed(1).padStart(5)}%  ` +
    `Y ${(s.ya / s.n).toFixed(2)} -> ${(s.yb / s.n).toFixed(2)}`;

  const shipped = await shoot('');

  console.log(`\n  t=${T} pitch=${PITCH}  ${W}x${H}   A = shipped, B = A with the term off\n`);

  /* The floor does not come out at exactly zero: a few hundredths of a percent
   * of pixels move, by up to ~100 code values, in the canopy. That is the
   * particle field, which is another agent's and appears to phase off something
   * other than r3f's clock. It is far too sparse to hide any term below, but a
   * term has to clear it to count, so it is printed and compared against rather
   * than asserted away. */
  const nul = compare(shipped, await shoot(''));
  const floor = nul.all.dy / nul.all.n;
  const floorPct = (100 * nul.all.moved) / nul.all.n;
  console.log(`  floor  |dY|=${floor.toFixed(4)}  moved=${floorPct.toFixed(3)}%` +
    `${floorPct < 0.5 ? '  ✓ terms above this are real' : '  ✗ TOO HIGH TO MEASURE ANYTHING'}`);
  if (floorPct >= 0.5) process.exitCode = 1;

  const inert = [];
  for (const t of TERMS) {
    const { st, all } = compare(shipped, await shoot(t));
    console.log(`\n  ── ${t} ${'─'.repeat(Math.max(0, 56 - t.length))}`);
    BANDS.forEach((n, i) => console.log(line(n, st[i])));
    console.log(line('FRAME', all));
    const pct = (100 * all.moved) / all.n;
    if (pct <= floorPct * 3) { console.log(`  ✗ INERT (at or below the ${floorPct.toFixed(3)}% floor)`); inert.push(t); }
  }

  await page.evaluate(() => { window.__post.set(''); window.__scene.setDriven(false); });

  if (inert.length) {
    console.error(`\n  ✗ inert: ${inert.join(', ')}`);
    process.exitCode = 1;
  }
  console.log('');
});

finish(process.exitCode || 0);
