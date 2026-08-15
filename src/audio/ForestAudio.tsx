'use client';

/* System 7 — the one component, and the only thing the scene has to know about.
 *
 * Everything else in src/audio is plain TypeScript with no React, no three and
 * (outside engine.ts) no Web Audio. This file exists to do the four things that
 * need a React tree: put the listener on the camera, resume a suspended context
 * off the gesture the scene already asks for, drive the engine from the frame
 * loop, and hang a debug surface where the rest of the project's tooling looks
 * for one.
 *
 * Integration, in full — two attributes in src/scene/Forest.tsx:
 *
 *   import { ForestAudio, footstep } from '@/audio/ForestAudio';
 *   ...
 *   <Rig onFootstep={footstep} />
 *   <ForestAudio />
 *
 * `Rig` already takes `onFootstep` and `walker.advanceGait` already calls it
 * once per footfall with 0 or 1, so nothing in src/scene changes but those.
 */
import { useEffect } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { ForestAudio as Engine, type AudioDebug } from './engine';

declare global {
  interface Window { __audio?: AudioDebug }
}

/* A module singleton rather than a ref, for two practical reasons.
 *
 * React's StrictMode mounts every component twice in development, and an
 * AudioContext per mount is two contexts, two wind beds and a browser warning
 * about how many contexts a page may have. And `footstep` below has to be a
 * stable function reference that exists *before* this component mounts,
 * because the scene passes it to Rig as a prop.
 */
let engine: Engine | null = null;

function getEngine(): Engine {
  if (!engine) engine = new Engine();
  return engine;
}

/**
 * The hook the walker calls, once per footfall, with 0 or 1 for the foot.
 *
 * Safe to pass to `Rig` before any audio exists: it does nothing until the
 * context is running and the step buffers have been baked, which is a handful
 * of frames after the click. The optional second argument is the surface, 0
 * for the compacted tread and 1 for needle duff; left out, the engine wanders
 * between them on its own, because the walker does not track its offset from
 * the trail centreline and should not have to start.
 */
export function footstep(foot: number, surface?: number): void {
  engine?.footstep(foot, surface);
}

export function ForestAudio() {
  const { gl, camera } = useThree();

  useEffect(() => {
    const e = getEngine();
    camera.add(e.listener);

    /* Autoplay policy.
     *
     * The context is created suspended and stays that way until a user
     * gesture. The scene already asks for a click to take pointer lock, so
     * that click is the gesture; keydown is here too, because someone who
     * alt-tabs away and comes back with W should not find the forest silent.
     * Both listeners survive until unmount rather than removing themselves
     * after the first hit, because a browser may suspend a context again at
     * any time and the next gesture has to be able to bring it back.
     */
    const kick = () => {
      void e.resume().then(() => {
        if (e.state !== 'running' || e.isBuilt) return;
        /* Called straight from the gesture, not deferred. It used to go to a
         * requestIdleCallback because it rendered the room and two wind beds
         * inline and could not be allowed to stall the frame that grabs the
         * pointer; now it only allocates nodes and returns in under a
         * millisecond, and every sample is queued for `update` to render
         * against a frame budget. Being on the gesture's own stack is worth
         * having: a throw in here reaches the browser with a stack and a source
         * position, where in an idle callback it was an anonymous page error
         * with no caller — which is how a NotSupportedError from the convolver
         * managed to leave the entire system silent and reporting zeroes. */
        e.build();
      });
    };

    const canvas = gl.domElement;
    canvas.addEventListener('pointerdown', kick);
    window.addEventListener('keydown', kick);
    return () => {
      canvas.removeEventListener('pointerdown', kick);
      window.removeEventListener('keydown', kick);
      camera.remove(e.listener);
    };
  }, [gl, camera]);

  /* A backgrounded tab hands back a delta of several seconds, and the gust
   * envelope is a function of accumulated time — one unclamped frame would
   * jump the weather forward by a minute. */
  useFrame((_, rawDelta) => {
    engine?.update(Math.min(rawDelta, 0.05), camera);
  });

  /* The debug surface.
   *
   * `window.__audio` is the real home; mirroring onto `__scene.audio` when Rig
   * creates it keeps everything under one handle for anything driving the
   * scene from a tool.
   *
   * What it is for is the failure mode this system is most likely to have. A
   * Web Audio graph that produces silence produces no error, so every bus
   * carries an `everDb` — the loudest level it has ever passed — and any bus
   * still reading -Infinity after a minute of walking has a disconnected node
   * or a zero gain in it. That is a fact a later agent can establish from a
   * headless browser without listening to anything.
   *
   * Read `report().problems` and not `report().silent`. `silent` lists buses
   * that exist and are quiet, so it is empty both when everything works and
   * when nothing was ever built; `problems` reports the absence of a bank as
   * the first thing wrong. tools/audiolive.mjs is the harness for both.
   */
  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return;
    const api = getEngine().debug();
    window.__audio = api;
    /* Rig creates `window.__scene` in its own effect and deletes it on
     * unmount, so there is no mount order in which writing to it once here is
     * reliable. A short poll costs nothing and stops once it has landed. */
    let tries = 0;
    const id = setInterval(() => {
      const scene = (window as unknown as { __scene?: { audio?: AudioDebug } }).__scene;
      if (scene) { scene.audio = api; clearInterval(id); }
      if (++tries > 40) clearInterval(id);
    }, 100);
    return () => {
      clearInterval(id);
      delete window.__audio;
    };
  }, []);

  return null;
}
