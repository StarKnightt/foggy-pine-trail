'use client';

/* Camera rig, input, and the debug surface the capture harness drives.
 *
 * `window.__scene` is a remote control for the renderer, so it only exists in
 * development. The harness needs to put the camera in exactly the same places
 * every run, let the simulation settle without waiting for wall-clock time,
 * and read numbers back rather than opinions — screenshots lie about exposure
 * and a fog scene is the worst possible subject for judging brightness by eye.
 */
import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import type { RootState } from '@react-three/fiber';
import * as THREE from 'three';
import { Walker } from './walker';
import { crossSection, groundHeight, allBigStones } from '@/world/ground';

const KEYS: Record<string, string> = {
  KeyW: 'f', ArrowUp: 'f',
  KeyS: 'b', ArrowDown: 'b',
  KeyA: 'l', ArrowLeft: 'l',
  KeyD: 'r', ArrowRight: 'r',
};

export type DebugScene = {
  goTo(u: number): void;
  setYaw(rad: number): void;
  setPitch(rad: number): void;
  warp(seconds: number): void;
  setPaused(p: boolean): void;
  renderOnce(): void;
  setDriven(on: boolean): void;
  step(dt: number): void;
  readonly clock: number;
  info(): { calls: number; triangles: number; programs: number; textures: number; geometries: number };
  probe(sampleStep?: number): Record<string, number>;
  crossSection(along: number, half?: number, step?: number): number[];
  /** The height authority itself, for proving a term in it actually builds. */
  height(x: number, z: number): number;
  /** Every stone the heightfield has banked soil against. */
  bigStones(): {
    at: number; side: number; size: number; buried: number; moss: number;
    wx?: number; wz?: number;
  }[];
  readonly fps: number;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  walker: Walker;
};

declare global {
  interface Window { __scene?: DebugScene }
}

export function Rig({ onFootstep }: { onFootstep?: (foot: number) => void }) {
  const { gl, scene, camera } = useThree();
  /* Read off the store rather than destructured, so the driven-loop controls
   * below are the same functions r3f's own loop uses. */
  const advance = useThree((s: RootState) => s.advance);
  const setFrameloop = useThree((s: RootState) => s.setFrameloop);
  const vclock = useRef(0);
  const walker = useMemo(() => new Walker(), []);
  const held = useRef(new Set<string>());
  const paused = useRef(false);
  const fps = useRef(0);
  const euler = useMemo(() => new THREE.Euler(0, 0, 0, 'YXZ'), []);

  useEffect(() => { walker.onFootstep = onFootstep ?? null; }, [walker, onFootstep]);

  useEffect(() => {
    const canvas = gl.domElement;
    const down = (e: KeyboardEvent) => {
      /* Jump is an event, not a held state. Space arrives repeatedly while the
       * key is down via the OS auto-repeat, and `e.repeat` is the only thing
       * that separates a second press from the same press being re-announced —
       * without it, holding space bunny-hops on every repeat interval. */
      if (e.code === 'Space') {
        if (!e.repeat) walker.jump();
        e.preventDefault();
        return;
      }
      const k = KEYS[e.code];
      if (k) { held.current.add(k); e.preventDefault(); }
    };
    const up = (e: KeyboardEvent) => { const k = KEYS[e.code]; if (k) held.current.delete(k); };
    const blur = () => held.current.clear();
    const click = () => { if (document.pointerLockElement !== canvas) canvas.requestPointerLock(); };
    const move = (e: MouseEvent) => {
      if (document.pointerLockElement !== canvas) return;
      walker.look(e.movementX, e.movementY);
    };

    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    canvas.addEventListener('click', click);
    document.addEventListener('mousemove', move);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
      canvas.removeEventListener('click', click);
      document.removeEventListener('mousemove', move);
    };
  }, [gl, walker]);

  const apply = useMemo(() => () => {
    camera.position.set(walker.eye.x, walker.eye.y, walker.eye.z);
    euler.set(
      walker.pitch + walker.driftPitch,
      walker.yaw + walker.driftYaw,
      walker.roll,
    );
    camera.quaternion.setFromEuler(euler);
  }, [camera, euler, walker]);

  useFrame((_, rawDelta) => {
    // A backgrounded tab hands back a delta of several seconds.
    const dt = Math.min(rawDelta, 0.05);
    if (dt > 0) fps.current = fps.current ? fps.current * 0.92 + (1 / dt) * 0.08 : 1 / dt;
    if (paused.current) { apply(); return; }
    const h = held.current;
    walker.update(dt, {
      forward: (h.has('f') ? 1 : 0) - (h.has('b') ? 1 : 0),
      strafe: (h.has('r') ? 1 : 0) - (h.has('l') ? 1 : 0),
    });
    apply();
  });

  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return;

    const api: DebugScene = {
      goTo(u) { walker.placeAt(THREE.MathUtils.clamp(u, 0, 1)); walker.warp(0.35); apply(); },
      setYaw(rad) { walker.yaw = rad; apply(); },
      setPitch(rad) { walker.pitch = rad; apply(); },
      warp(seconds) { walker.warp(seconds); apply(); },
      setPaused(p) { paused.current = !!p; },
      renderOnce() { apply(); gl.render(scene, camera); },
      /* `frameloop: 'never'` makes r3f take its delta from the timestamp
       * handed to `advance` rather than from the clock, so every subscriber
       * sees exactly the interval the output will be played back at. */
      setDriven(on) {
        setFrameloop(on ? 'never' : 'always');
        vclock.current = 0;
      },
      step(dt) {
        vclock.current += dt;
        advance(vclock.current);
      },
      get clock() { return vclock.current; },
      crossSection(along, half, step) { return crossSection(along, half, step); },
      height(x, z) { return groundHeight(x, z); },
      bigStones() { return allBigStones(); },
      info() {
        const i = gl.info;
        return {
          calls: i.render.calls,
          triangles: i.render.triangles,
          programs: i.programs ? i.programs.length : 0,
          textures: i.memory.textures,
          geometries: i.memory.geometries,
        };
      },
      /**
       * Describe the frame numerically.
       *
       * A fog scene is the hardest possible subject to judge by eye, because
       * almost the whole histogram lives in a narrow band in the upper
       * midtones and small differences there are exactly what separates
       * "atmospheric" from "washed out". `contrast` and the percentile spread
       * are the numbers that actually distinguish the two; `blownPct` catches
       * fog that has been pushed until it clips, which is the specific way a
       * white-out fails.
       */
      probe(sampleStep = 4) {
        const c = gl.domElement;
        const w = c.width, h = c.height;
        const ctx = gl.getContext();
        gl.render(scene, camera);
        const px = new Uint8Array(w * h * 4);
        ctx.readPixels(0, 0, w, h, ctx.RGBA, ctx.UNSIGNED_BYTE, px);

        const lum: number[] = [];
        let black = 0, blown = 0, total = 0, upper = 0, un = 0, lower = 0, ln = 0;
        let sat = 0;
        for (let j = 0; j < h; j += sampleStep) {
          for (let i = 0; i < w; i += sampleStep) {
            const k = (j * w + i) * 4;
            const r = px[k] / 255, g = px[k + 1] / 255, b = px[k + 2] / 255;
            const l = r * 0.2126 + g * 0.7152 + b * 0.0722;
            const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
            sat += mx > 1e-4 ? (mx - mn) / mx : 0;
            lum.push(l);
            total++;
            if (l < 0.02) black++;
            if (l > 0.98) blown++;
            // readPixels is bottom-up, so high j is the top of the image.
            if (j > h * 0.58) { upper += l; un++; } else { lower += l; ln++; }
          }
        }
        lum.sort((a, b) => a - b);
        const q = (p: number) => +lum[Math.min(lum.length - 1, Math.floor(p * lum.length))].toFixed(3);
        return {
          p01: q(0.01), p10: q(0.1), median: q(0.5), p90: q(0.9), p99: q(0.99),
          mean: +(lum.reduce((a, b) => a + b, 0) / lum.length).toFixed(3),
          contrast: +((q(0.95) - q(0.05)) * 255).toFixed(0),
          blackPct: +((100 * black) / total).toFixed(1),
          blownPct: +((100 * blown) / total).toFixed(1),
          /* Mean saturation. The brief bans bright colour, and this is how
           * that is checked rather than argued about: a real foggy conifer
           * photograph sits around 0.10-0.18. Anything above 0.25 has a
           * colour in it that does not belong. */
          sat: +(sat / total).toFixed(3),
          upper: +(upper / Math.max(1, un)).toFixed(3),
          lower: +(lower / Math.max(1, ln)).toFixed(3),
        };
      },
      get fps() { return fps.current; },
      camera: camera as THREE.PerspectiveCamera,
      renderer: gl,
      scene,
      walker,
    };

    window.__scene = api;
    (window as unknown as { __THREE?: unknown }).__THREE = THREE;
    return () => { delete window.__scene; };
  }, [gl, scene, camera, walker, apply, advance, setFrameloop]);

  useEffect(() => { walker.placeAt(0); apply(); }, [walker, apply]);

  return null;
}
