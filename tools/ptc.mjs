/* Measure the particle system. Stills are the wrong instrument for it.
 *
 *   node tools/ptc.mjs count [--t 0.03,0.42,...] [--q p=big12] [--pin 7.0]
 *   node tools/ptc.mjs seq   [--t 0.42] [--n 12] [--dt 0.1] [--tag ptcseq]
 *   node tools/ptc.mjs cost  [--t 0.42]
 *   node tools/ptc.mjs pair  --a "p=nofocus" --b "" [--t 0.42] [--pin 7.0]
 *
 * Requires the dev server already running on 3100. It will not start one.
 *
 * ── Why this exists rather than `shoot.mjs` plus an opinion ───────────────
 *
 * Two questions have to be answered with numbers and neither can be read off a
 * PNG. "How many particles are actually visible in a frame" is the difference
 * between a system that is inert and one that is snow, and eyeballing it on a
 * 1600x900 frame where most particles are one pixel across is hopeless. "Does
 * it move like air" is a question about a *sequence*, and the whole capture
 * path in this project renders one frame from a paused loop.
 *
 * `count` answers the first by rendering the identical frame twice with the
 * points hidden and shown, differencing, and flood-filling the changed pixels
 * into clusters. A cluster is a particle. The peak delta per cluster is how
 * strongly it reads, in display code values, against whatever it happens to be
 * standing in front of — which is the only measure that means anything in a
 * scene whose background runs from 13 to 190.
 *
 * `seq` answers the second by pinning the clock to exact values, so the frames
 * are separated by precisely the interval asked for rather than by however
 * long a headless screenshot took. It matches clusters between consecutive
 * frames by nearest centroid and reports the implied screen-space speeds, so
 * "the drift is 4 cm/s" is a measurement and not a claim. Never trust the
 * timestamp requestAnimationFrame hands you here; it is synthesised.
 *
 * `pair` answers the third question, which is whether a term is alive at all.
 * It loads the page twice with different `?p=` switches, puts the camera and
 * the clock in exactly the same state both times, and differences the two
 * frames pixel for pixel. This project has shipped six code paths that
 * typechecked and changed nothing, and the only defence that has ever worked
 * is a differenced pair. Two loads rather than a runtime toggle because the
 * switches substitute constants at compile time, which is deliberate — see the
 * header of `Particles.tsx` — and therefore cannot be flipped in place.
 *
 * All three pin the clock before every render. Two `renderOnce()` calls are
 * tens of milliseconds apart on this machine and a needle covers three
 * centimetres in that, so an unpinned differenced pair measures the motion and
 * not the term.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, capture, finish, DEV_URL } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const cmd = args[0] && !args[0].startsWith('--') ? args[0] : 'count';
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };

const STOPS = flag('t', '0.03,0.42,0.78').split(',').map(Number);
const W = +flag('w', 1600), H = +flag('h', 900);
const PIN = +flag('pin', 7.0);
const N = +flag('n', 12);
const DT = +flag('dt', 0.1);
const PITCH = +flag('pitch', 0);
const TAG = flag('tag', 'ptc');
const Q = flag('q', '');

/* Threshold in display code values, on the maximum channel difference.
 *
 * Two is above the dither, which fog.ts sets to one LSB peak to peak and which
 * is regenerated identically for a given pixel — interleaved gradient noise is
 * a function of gl_FragCoord alone, so it cancels exactly in a differenced
 * pair and this could in principle be 1. Two, because the tone map is not
 * exactly reproducible across a program switch and one count of slack costs
 * nothing: a particle that only ever moves a pixel by one code value is not
 * visible by any definition worth using.
 */
const THRESH = +flag('thresh', 2);

/** Flood fill the changed pixels into clusters. One cluster is one particle. */
const CLUSTER = `
function cluster( a, b, w, h, thresh ) {
  const seen = new Uint8Array( w * h );
  const out = [];
  const stack = new Int32Array( w * h );
  const delta = ( i ) => Math.max(
    Math.abs( a[ i * 4 ] - b[ i * 4 ] ),
    Math.abs( a[ i * 4 + 1 ] - b[ i * 4 + 1 ] ),
    Math.abs( a[ i * 4 + 2 ] - b[ i * 4 + 2 ] ) );
  let changed = 0, sumAbs = 0;
  for ( let i = 0; i < w * h; i++ ) {
    const d = delta( i );
    if ( d >= thresh ) { changed++; sumAbs += d; }
  }
  for ( let start = 0; start < w * h; start++ ) {
    if ( seen[ start ] || delta( start ) < thresh ) continue;
    let sp = 0;
    stack[ sp++ ] = start;
    seen[ start ] = 1;
    let n = 0, sx = 0, sy = 0, peak = 0, bg = 0, fgv = 0;
    while ( sp > 0 ) {
      const i = stack[ --sp ];
      const x = i % w, y = ( i / w ) | 0;
      const d = delta( i );
      n++; sx += x; sy += y;
      if ( d > peak ) {
        peak = d;
        // readPixels is bottom-up; luma of the background and of the particle.
        bg = a[ i * 4 ] * 0.2126 + a[ i * 4 + 1 ] * 0.7152 + a[ i * 4 + 2 ] * 0.0722;
        fgv = b[ i * 4 ] * 0.2126 + b[ i * 4 + 1 ] * 0.7152 + b[ i * 4 + 2 ] * 0.0722;
      }
      for ( let dy = -1; dy <= 1; dy++ ) for ( let dx = -1; dx <= 1; dx++ ) {
        const nx = x + dx, ny = y + dy;
        if ( nx < 0 || ny < 0 || nx >= w || ny >= h ) continue;
        const j = ny * w + nx;
        if ( seen[ j ] || delta( j ) < thresh ) continue;
        seen[ j ] = 1;
        stack[ sp++ ] = j;
      }
    }
    out.push( { n, x: +( sx / n ).toFixed(1), y: +( sy / n ).toFixed(1),
                peak, bg: Math.round( bg ), fg: Math.round( fgv ) } );
  }
  out.sort( ( p, q ) => q.peak - p.peak );
  return { clusters: out, changed, sumAbs };
}`;

/** Render the same frame twice, particles hidden and shown, and cluster. */
const DIFF = `
function diffOnce( t ) {
  const s = window.__scene;
  const p = s.scene.userData.particles;
  const gl = s.renderer, ctx = gl.getContext();
  const c = gl.domElement, w = c.width, h = c.height;
  p.pin( t );
  s.setPaused( true );
  p.setVisible( false );
  s.renderOnce();
  const A = new Uint8Array( w * h * 4 );
  ctx.readPixels( 0, 0, w, h, ctx.RGBA, ctx.UNSIGNED_BYTE, A );
  p.setVisible( true );
  s.renderOnce();
  const B = new Uint8Array( w * h * 4 );
  ctx.readPixels( 0, 0, w, h, ctx.RGBA, ctx.UNSIGNED_BYTE, B );
  const r = cluster( A, B, w, h, ${THRESH} );

  /* An amplified difference image, because a table of cluster peaks says how
   * strong the particles are and nothing at all about *where* they are. The
   * failure this catches is the one a count cannot: every particle bunched
   * into one corner of the frame, or all of them sitting on the ground plane,
   * both of which produce a perfectly healthy set of numbers. */
  const cv = document.createElement( 'canvas' );
  cv.width = w; cv.height = h;
  const g2 = cv.getContext( '2d' );
  const img = g2.createImageData( w, h );
  for ( let y = 0; y < h; y++ ) {
    for ( let x = 0; x < w; x++ ) {
      // readPixels is bottom-up and ImageData is top-down.
      const i = ( ( h - 1 - y ) * w + x ) * 4, o = ( y * w + x ) * 4;
      const bgl = ( A[ i ] * 0.2126 + A[ i + 1 ] * 0.7152 + A[ i + 2 ] * 0.0722 ) * 0.22;
      for ( let c = 0; c < 3; c++ ) {
        img.data[ o + c ] = Math.min( 255, bgl + Math.abs( A[ i + c ] - B[ i + c ] ) * 6 );
      }
      img.data[ o + 3 ] = 255;
    }
  }
  g2.putImageData( img, 0, 0 );
  return { w, h, ...r, png: cv.toDataURL( 'image/png' ) };
}`;

const PRELUDE = CLUSTER + DIFF;

async function station(page, t, pitch) {
  await page.evaluate(([t, pitch]) => {
    const s = window.__scene;
    s.goTo(t);
    s.setYaw(s.walker.yaw);
    s.setPitch(pitch);
    s.warp(2.0);
  }, [t, pitch]);
  await page.waitForTimeout(120);
}

await run({ width: W, height: H, url: Q ? `${DEV_URL}/?${Q}` : DEV_URL },
  async ({ page }) => {

  const ok = await page.evaluate(() => !!window.__scene?.scene?.userData?.particles);
  if (!ok && cmd !== 'pair') {
    console.error('✗ scene.userData.particles is not published — the system is not mounted.');
    process.exitCode = 1;
    return;
  }

  const counts = await page.evaluate(() => {
    const p = window.__scene.scene.userData.particles;
    return p ? { dust: p.dust, needle: p.needle, leaf: p.leaf, total: p.total, flags: p.flags }
             : { dust: 0, needle: 0, leaf: 0, total: 0, flags: 'system off' };
  });
  console.log(`  population: ${counts.total} points  ` +
    `(dust ${counts.dust}, needle ${counts.needle}, leaf ${counts.leaf})`);
  console.log(`  switches:   ${JSON.stringify(counts.flags)}`);

  if (cmd === 'count') {
    let grand = 0, frames = 0;
    for (const t of STOPS) {
      await station(page, t, PITCH);
      const r = await page.evaluate(([pre, pin]) => {
        new Function(pre + '; window.__ptc = { diffOnce, cluster };')();
        return window.__ptc.diffOnce(pin);
      }, [PRELUDE, PIN]);

      const dif = path.join(ROOT, 'shots', TAG, `diff-${Math.round(t * 100)}.png`);
      fs.mkdirSync(path.dirname(dif), { recursive: true });
      fs.writeFileSync(dif, Buffer.from(r.png.split(',')[1], 'base64'));

      const cl = r.clusters;
      const strong = cl.filter((c) => c.peak >= 8);
      const solid = cl.filter((c) => c.peak >= 20);
      grand += strong.length; frames++;
      console.log(`\n  t=${t.toFixed(2)}  changed=${r.changed}px ` +
        `(${((100 * r.changed) / (r.w * r.h)).toFixed(3)}% of frame)  ` +
        `mean|d|=${(r.sumAbs / Math.max(1, r.changed)).toFixed(1)}`);
      console.log(`    clusters: ${cl.length} total, ${strong.length} at >=8 counts, ` +
        `${solid.length} at >=20`);
      for (const c of cl.slice(0, 10)) {
        console.log(`      px=${String(c.n).padStart(4)}  peak=${String(c.peak).padStart(3)}  ` +
          `bg=${String(c.bg).padStart(3)} -> fg=${String(c.fg).padStart(3)}  ` +
          /* Brighter or darker than what it is standing in front of, and
           * deliberately not labelled as one population or the other. A needle
           * is darker than fog and brighter than a wet trunk, so the sign says
           * what the background is, not what the particle is. Use
           * `--q p=nodust` or `--q p=noneedles` to attribute a cluster; doing
           * it by sign mislabelled a broadleaf at a metre and a half as a
           * grain and nearly bought a fix for a defect that did not exist. */
          `at ${c.x},${c.y}  ${c.fg > c.bg ? 'lighter than bg' : 'darker than bg'}`);
      }
      console.log(`    → ${path.relative(ROOT, dif)}`);
    }
    console.log(`\n  mean legible particles per frame: ` +
      `${(grand / Math.max(1, frames)).toFixed(1)}`);
  }

  if (cmd === 'cost') {
    for (const t of STOPS) {
      await station(page, t, PITCH);
      const r = await page.evaluate(async (pin) => {
        const s = window.__scene;
        const p = s.scene.userData.particles;
        const gl = s.renderer, ctx = gl.getContext();
        p.pin(pin);
        s.setPaused(true);
        const px = new Uint8Array(4);
        const bench = (on) => {
          p.setVisible(on);
          for (let i = 0; i < 40; i++) s.renderOnce();
          ctx.readPixels(0, 0, 1, 1, ctx.RGBA, ctx.UNSIGNED_BYTE, px);
          const t0 = performance.now();
          const NREP = 300;
          for (let i = 0; i < NREP; i++) s.renderOnce();
          /* Forces the queue to drain. Without it this times how fast the
           * driver accepts commands, which on a warm pipeline is a number
           * about the CPU and not about the frame. */
          ctx.readPixels(0, 0, 1, 1, ctx.RGBA, ctx.UNSIGNED_BYTE, px);
          return (performance.now() - t0) / NREP;
        };
        /* Interleaved, three times each, taking the minimum. A single A/B pair
         * on a machine with a browser and a dev server on it measures whatever
         * else was scheduled. */
        let offBest = Infinity, onBest = Infinity;
        for (let k = 0; k < 3; k++) {
          offBest = Math.min(offBest, bench(false));
          onBest = Math.min(onBest, bench(true));
        }
        p.setVisible(true);
        s.renderOnce();
        const info = s.info();
        p.setVisible(false);
        s.renderOnce();
        const infoOff = s.info();
        p.setVisible(true);
        return { off: offBest, on: onBest, calls: info.calls, callsOff: infoOff.calls,
                 tris: info.triangles };
      }, PIN);
      console.log(`\n  t=${t.toFixed(2)}  frame ${r.off.toFixed(3)} ms -> ${r.on.toFixed(3)} ms` +
        `   particles cost ${(r.on - r.off).toFixed(3)} ms`);
      console.log(`    draw calls ${r.callsOff} -> ${r.calls}   triangles ${r.tris}`);
    }
  }

  if (cmd === 'pair') {
    /* Both halves get `ug=nowind`, and it is not optional.
     *
     * `Undergrowth.tsx` drives its wind from a clock accumulated in `useFrame`
     * from wall-clock deltas, so two page loads reach the tool with the ferns
     * at different points in a 17-second cycle. The amplitude is 12 mm, which
     * is under a pixel and invisible — and which flips alpha-test edges all
     * over the middle of the frame. Measured: 1166 changed pixels between two
     * identical builds, peaks of 144 code values, every one of them a fern
     * edge. Freezing the term makes the null difference exactly zero, which is
     * the only baseline worth differencing against. */
    const A = ['ug=nowind', flag('a', 'p=nofocus')].filter(Boolean).join('&');
    const B = ['ug=nowind', flag('b', '')].filter(Boolean).join('&');
    const grab = async (q) => {
      await page.goto(q ? `${DEV_URL}/?${q}` : DEV_URL, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: /load it anyway/i })
        .click({ timeout: 8000 }).catch(() => {});
      /* Not waiting on `userData.particles` — `?p=off` never publishes it, and
       * that is the one comparison the whole system has to be able to make. */
      await page.waitForFunction(() => !!window.__scene, null, { timeout: 90_000 });
      await page.waitForTimeout(1500);
      /* Everything in one evaluate, with the loop paused *before* the camera
       * is placed. The `count` path can afford to settle the gait for 120 ms
       * with the loop live because it differences two renders from the same
       * load; across two loads that wait is 120 ms of walker simulation that
       * does not repeat, and the sub-millimetre camera difference it leaves
       * flips alpha-test edges all over the undergrowth. Measured: 298 changed
       * pixels with peaks of 107 code values, none of them a particle. */
      return page.evaluate(([pin, t, pitch]) => {
        const s = window.__scene;
        s.setPaused(true);
        /* The gait phase is never reset by `placeAt`, and the handheld drift
         * that `walker.ts` applies on top of the look angles is a function of
         * it — so the camera's pose depends on how many seconds the loop
         * happened to run before the tool got control, which across two page
         * loads is not the same number. Left alone this differences 7098
         * pixels between two *identical* builds, all of them alpha-test edges
         * in the undergrowth flipping under a sub-millimetre camera shift. */
        s.walker.phase = 0;
        s.walker.speed = 0;
        s.goTo(t);
        s.setYaw(s.walker.yaw);
        s.setPitch(pitch);
        s.warp(2.0);
        s.scene.userData.particles?.pin(pin);
        s.renderOnce();
        const gl = s.renderer, ctx = gl.getContext();
        const c = gl.domElement;
        const px = new Uint8Array(c.width * c.height * 4);
        ctx.readPixels(0, 0, c.width, c.height, ctx.RGBA, ctx.UNSIGNED_BYTE, px);
        return { w: c.width, h: c.height, px: Array.from(px) };
      }, [PIN, STOPS[0], PITCH]);
    };
    const ra = await grab(A);
    const rb = await grab(B);
    const r = await page.evaluate(([pre, a, b, w, h, th]) => {
      new Function(pre + '; window.__ptc = { cluster };')();
      return window.__ptc.cluster(Uint8Array.from(a), Uint8Array.from(b), w, h, th);
    }, [CLUSTER, ra.px, rb.px, ra.w, ra.h, THRESH]);
    console.log(`\n  A: ?${A || '(none)'}   B: ?${B || '(none)'}   t=${STOPS[0]} pin=${PIN}`);
    console.log(`    changed ${r.changed} px (${((100 * r.changed) / (ra.w * ra.h)).toFixed(4)}%)` +
      `  mean|d| ${(r.sumAbs / Math.max(1, r.changed)).toFixed(1)}` +
      `  clusters ${r.clusters.length}`);
    for (const c of r.clusters.slice(0, 8)) {
      console.log(`      px=${String(c.n).padStart(4)}  peak=${String(c.peak).padStart(3)}  ` +
        `A=${String(c.bg).padStart(3)} -> B=${String(c.fg).padStart(3)}  at ${c.x},${c.y}`);
    }
    if (!r.changed) console.log('    ✗ ZERO PIXELS MOVED — the term is inert.');
  }

  if (cmd === 'seq') {
    const t = STOPS[0];
    await station(page, t, PITCH);
    const outDir = path.join(ROOT, 'shots', TAG);
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });

    let prev = null;
    for (let i = 0; i < N; i++) {
      const tt = PIN + i * DT;
      const r = await page.evaluate(([pre, pin]) => {
        new Function(pre + '; window.__ptc = { diffOnce, cluster };')();
        return window.__ptc.diffOnce(pin);
      }, [PRELUDE, tt]);

      await capture(page, path.join(outDir, `${String(i).padStart(2, '0')}.png`), {
        before: `s.scene.userData.particles.pin(${tt});`,
      });

      const cl = r.clusters.filter((c) => c.peak >= 8);
      /* Nearest-centroid matching between consecutive frames. Only accepted
       * inside a radius that a particle could plausibly have crossed in DT, so
       * a particle that appears or disappears does not get paired with an
       * unrelated one on the other side of the frame. */
      const speeds = [];
      if (prev) {
        for (const c of cl) {
          let best = null, bd = 1e9;
          for (const q of prev) {
            const d = Math.hypot(c.x - q.x, c.y - q.y);
            if (d < bd) { bd = d; best = q; }
          }
          if (best && bd < 60) speeds.push(bd / DT);
        }
      }
      speeds.sort((a, b) => a - b);
      const med = speeds.length ? speeds[speeds.length >> 1] : 0;
      console.log(`  t=${tt.toFixed(2)}s  clusters>=8: ${String(cl.length).padStart(3)}  ` +
        `changed=${String(r.changed).padStart(5)}px  ` +
        `median tracked speed ${med.toFixed(1)} px/s` +
        (speeds.length ? `  (n=${speeds.length}, max ${speeds[speeds.length - 1].toFixed(0)})` : ''));
      prev = cl;
    }
    await page.evaluate(() => window.__scene.scene.userData.particles.pin(null));
    console.log(`\n  → ${path.relative(ROOT, outDir)}`);
  }
});

finish(process.exitCode || 0);
