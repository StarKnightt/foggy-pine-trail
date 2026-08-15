/* Headless capture plumbing.
 *
 * Adapted from night-street/tools/harness.mjs, which was itself adapted from
 * jungle-trail. Two properties matter and both are about not wrecking the
 * machine it runs on:
 *
 *   It never starts a server. Next's dev server is the only thing that can
 *   build the page, so the harness attaches to one that is already running and
 *   tells you to start it if there is not.
 *
 *   Teardown is installed before anything is launched, on every exit path. A
 *   headless Chromium left behind keeps rendering and holds the GPU, and the
 *   next run then fails in a way that looks like a scene bug. Node and every
 *   Chromium child are also pinned to a subset of cores at low priority, so a
 *   capture does not make the machine unusable while it runs.
 */
import { chromium } from 'playwright';
import { exec } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';

export const DEV_URL = process.env.TRAIL_URL || 'http://127.0.0.1:3100';

const AFFINITY = '0xF00';   // top four of twelve logical cores
const ps = (c) => exec('powershell -NoProfile -Command "' + c + '"', () => {});

ps(`$p=Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue; ` +
   `if($p){ $p.PriorityClass='BelowNormal'; $p.ProcessorAffinity=${AFFINITY} }`);

const tameChildren = () => ps(
  'Get-Process chrome-headless-shell,headless_shell -ErrorAction SilentlyContinue | ForEach-Object ' +
  `{ try { $_.PriorityClass = 'Idle'; $_.ProcessorAffinity = ${AFFINITY} } catch {} }`);
setTimeout(tameChildren, 1500).unref();
const tamer = setInterval(tameChildren, 4000);
tamer.unref();

/* Guaranteed teardown. Not optional politeness — a browser left rendering is
 * the worst outcome of a failed run. */
const closeables = [];
let closing = false;
async function teardown(code, why) {
  if (closing) return;
  closing = true;
  if (why) console.error('\n[teardown] ' + why);
  for (const t of closeables) { try { await t.close(); } catch { /* going down anyway */ } }
  clearInterval(tamer);
  process.exit(code);
}
export const finish = (code = 0) => teardown(code);
process.on('SIGINT', () => teardown(130, 'interrupted'));
process.on('SIGTERM', () => teardown(143, 'terminated'));
process.on('uncaughtException', (e) => teardown(1, (e && e.stack) || e));
process.on('unhandledRejection', (e) => teardown(1, (e && e.stack) || e));

const COMMON = [
  '--autoplay-policy=no-user-gesture-required',
  '--disable-dev-shm-usage',
  '--disable-features=CalculateNativeWinOcclusion,site-per-process',
  '--disable-background-timer-throttling',
  '--renderer-process-limit=1',
];

// Headless Chromium defaults to SwiftShader even with a GPU present; each of
// these is needed to get it onto the real adapter.
const GPU_ARGS = [...COMMON, '--use-angle=d3d11', '--enable-gpu-rasterization',
  '--ignore-gpu-blocklist', '--enable-zero-copy'];
const CPU_ARGS = [...COMMON, '--use-gl=angle', '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl',
  '--disable-lcd-text', '--js-flags=--single-threaded-gc'];

/** Is the dev server already up? The harness never starts one. `TRAIL_URL` can
 * point at a deployment rather than the local server, so pick the client that
 * matches the scheme — `http.get` throws outright on an https URL. */
export function reachable(url, timeoutMs = 2500) {
  const client = url.startsWith('https:') ? https : http;
  return new Promise((resolve) => {
    const req = client.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

/**
 * Capture one frame deterministically.
 *
 * `page.screenshot()` waits for the compositor and races the render loop for
 * the GL context. Pausing the loop, rendering once and reading the canvas back
 * is faster and reproducible — and it has to happen inside a single evaluate,
 * because the drawing buffer is not preserved and is gone by the next task.
 */
export async function capture(page, file, opts = {}) {
  const url = await page.evaluate((before) => {
    const s = window.__scene;
    s.setPaused(true);
    if (before) new Function('s', before)(s);
    s.renderOnce();
    const data = s.renderer.domElement.toDataURL('image/png');
    s.setPaused(false);
    return data;
  }, opts.before || '');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
  return file;
}

/**
 * Boot exactly one browser against the running dev server, run `body`, and
 * guarantee teardown.
 */
export async function run(opts, body) {
  const {
    width = 1600, height = 900,
    cpu = process.argv.includes('--cpu'),
    timeout = 180_000,
    url = DEV_URL,
  } = opts || {};

  /* A hard ceiling on the whole run. Every individual await in here has a
   * timeout, but a run can still fail to terminate as a whole, and no
   * per-call timeout catches that. Unref'd so it never keeps a healthy run
   * alive, and it exits hard rather than throwing, because by definition
   * something is already not returning. */
  const HARD_CAP = Number(process.env.SHOOT_CAP_MS || 300_000);
  const watchdog = setTimeout(() => {
    console.error(`\n✗ WATCHDOG: capture exceeded ${(HARD_CAP / 1000) | 0}s and was killed.`);
    console.error('  Likely: dev server wedged mid-compile, a shader compile loop, or a');
    console.error('  headless Chromium left over from an earlier run holding the GPU.');
    process.exit(2);
  }, HARD_CAP);
  watchdog.unref();

  if (!(await reachable(url))) {
    clearTimeout(watchdog);
    console.error(`✗ nothing is serving ${url}.`);
    console.error('  Start the dev server first, in its own terminal:  pnpm dev');
    console.error('  (One dev server, port 3100. The harness will not start a second one.)');
    process.exitCode = 1;
    return { errs: ['dev server not reachable'], gl: null, shaderErrors: [] };
  }

  const browser = await chromium.launch({ headless: true, args: cpu ? CPU_ARGS : GPU_ARGS });
  closeables.push(browser);

  const errs = [];
  let code = 0, gl = null, shaderErrors = [];
  try {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    page.setDefaultTimeout(Math.min(timeout, 90_000));
    page.setDefaultNavigationTimeout(Math.min(timeout, 90_000));
    page.on('pageerror', (e) => errs.push('[pageerror] ' + (e.stack || e.message || e)));
    page.on('console', (m) => {
      const t = m.type();
      if (t === 'error') errs.push('[console] ' + m.text());
      else if (t === 'warning' && /React|Warning|three/i.test(m.text())) errs.push('[warn] ' + m.text());
    });
    page.on('requestfailed', (r) => errs.push('[netfail] ' + r.url().slice(0, 140)));
    page.on('crash', () => errs.push('[crash] renderer process died'));

    console.log(`→ ${url}  ${width}x${height}  backend=${cpu ? 'swiftshader' : 'gpu'}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });

    /* Get past the front door. `Gate.tsx` will not mount the scene unless
     * `(pointer: fine)`, `requestPointerLock` and `innerWidth >= 700` all
     * hold, and several diagnostics deliberately run at viewports narrower
     * than that because they read numbers rather than pixels. Clicking the
     * override rather than widening the viewport, because a viewport is a
     * measurement parameter and a tool that quietly got a different one than
     * it asked for is the worse failure. */
    const gate = page.getByRole('button', { name: /load it anyway/i });
    gate.click({ timeout: 8000 }).then(
      () => console.log('   gate: clicked through the desktop check'),
      () => {},
    );

    const boot = Number(process.env.SHOOT_BOOT_MS || 180_000);
    /* A module that throws on load never defines __scene, so a plain wait
     * burns the whole timeout to report an error the page already knew about.
     * Race the wait against the error list instead. */
    await Promise.race([
      page.waitForFunction(() => !!window.__scene, null, { timeout: boot }),
      (async () => {
        for (let i = 0; i < boot / 250; i++) {
          await new Promise((r) => setTimeout(r, 250));
          const fatal = errs.find((e) => e.startsWith('[pageerror]') || e.startsWith('[crash]'));
          if (fatal) throw new Error('page threw during boot: ' + fatal.slice(0, 400));
        }
      })(),
    ]);

    gl = await page.evaluate(() => {
      const c = document.createElement('canvas');
      const g = c.getContext('webgl2');
      const dbg = g && g.getExtension('WEBGL_debug_renderer_info');
      return {
        renderer: dbg ? g.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown',
        vendor: dbg ? g.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : 'unknown',
      };
    });
    const soft = /swiftshader|software|llvmpipe/i.test(gl.renderer);
    console.log(`   adapter: ${gl.renderer}${soft ? '  (SOFTWARE — CPU bound)' : ''}`);

    // Let the first-frame shader compiles and the texture bakes finish.
    await page.waitForTimeout(1500);
    const readShaderErrors = () => page.evaluate(() => window.__shaderErrors || []);
    await body({ page, url, errs, gl, readShaderErrors });

    shaderErrors = await page.evaluate(() => window.__shaderErrors || []);
  } catch (err) {
    console.error('\n✗ capture failed:', (err && err.message) || err);
    code = 1;
  } finally {
    await browser.close().catch(() => {});
  }

  if (errs.length) {
    console.log('\n─── page errors ───');
    [...new Set(errs)].slice(0, 15).forEach((e) => console.log(' ', e));
  }

  /* A failed GLSL link is a hard failure of the run, and deliberately not
   * folded into the console-error list. A program that fails to link renders
   * as a flat untextured fallback and reads as a lighting bug; three reports
   * it lazily from the first draw that uses it, so "zero console errors" can
   * pass with a dead program in the frame. */
  if (shaderErrors.length) {
    code = 1;
    console.error('\n' + '═'.repeat(72));
    console.error(`✗✗✗  ${shaderErrors.length} SHADER PROGRAM(S) FAILED TO LINK`);
    console.error('     Affected surfaces are drawing an untextured fallback.');
    console.error('     Do NOT review this build; the pixels are not the build.');
    console.error('═'.repeat(72));
    for (const e of shaderErrors) {
      console.error(`\n  ── program: ${e.program}`);
      if (e.programLog) console.error(`     link: ${e.programLog}`);
      for (const [stage, text] of [['vertex', e.vertex], ['fragment', e.fragment]]) {
        if (!text) continue;
        console.error(`     ${stage}:`);
        for (const line of String(text).split('\n')) console.error('       ' + line);
      }
    }
    console.error('\n' + '═'.repeat(72) + '\n');
  } else {
    console.log('  shader programs: all linked');
  }

  // Never clear a failure the body already recorded.
  process.exitCode = code || process.exitCode || 0;
  return { errs: [...new Set(errs)], gl, shaderErrors };
}
