'use client';

/* The scene root.
 *
 * Renderer settings are the interesting part of this file; everything else is
 * assembly.
 *
 *   AgX rather than ACES or Reinhard. The frame is one enormous field of
 *   bright, nearly neutral air with dark objects in it, and the whole question
 *   is what happens in the top two stops. ACES adds a saturation boost on the
 *   way up and skews neutrals warm as they roll off, which turns even fog into
 *   a cream colour; Reinhard has no shoulder worth the name and clips the fog
 *   to a flat white plate. AgX rolls off long and holds hue, which is what a
 *   phone's own pipeline does and therefore what the reference photographs
 *   look like.
 *
 *   No canvas MSAA — on the HDR path. Every silhouette that matters here is a
 *   tree trunk against fog, a high-contrast near-vertical edge and the single
 *   worst case for aliasing, so this is not a place to save. It is off because
 *   System 8 renders into a 4x multisampled target instead, where the resolve
 *   happens in radiance rather than in display code values. That is the same
 *   multisampling in a different place, and the different place is the correct
 *   one: averaging four sRGB-encoded samples of bright air against near-black
 *   bark is a perceptual average of two numbers that are not lights. `?nohdr`
 *   draws to the canvas and turns it back on, so that path stays byte-for-byte
 *   the build the archive was judged through.
 *
 *   far = 260 m. Nothing is visible past 40, but the far plane also sets the
 *   depth buffer's precision distribution, and System 8's defocus reconstructs
 *   distance from depth. Keeping it as tight as the scene allows is what stops
 *   that reconstruction from banding.
 */
import { Canvas } from '@react-three/fiber';
import * as THREE from 'three';
import { useEffect } from 'react';
import { Ground } from './Ground';
import { TrailProps } from './TrailProps';
import { Trees } from './Trees';
import { Undergrowth } from './Undergrowth';
import { Particles } from './Particles';
import { Lighting } from './Lighting';
import { Rig } from './Rig';
import { Post } from './post';
import { useHdr } from './pipeline';
import { installShaderErrorWatch } from './shaderWatch';
import { installFog } from './fog';
import { EXPOSURE } from './env';
import { ForestAudio, footstep } from '@/audio/ForestAudio';

export default function Forest({ onReady }: { onReady?: () => void }) {
  /* Read once, before the Canvas exists, because three caches a program per
   * material on first draw and both the fog's dither placement and the
   * canvas's own multisampling are decided here. A value that could change
   * after mount would be a value that describes a build nobody is running. */
  const hdr = useHdr();
  return (
    <div className="fixed inset-0 bg-[#0b0e0d]">
      <Canvas
        gl={{
          antialias: !hdr,
          powerPreference: 'high-performance',
          stencil: false,
          depth: true,
          alpha: false,
        }}
        dpr={[1, 1.5]}
        /* No shadow map anywhere in this scene. See env.ts: there is no
         * directional source to cast one, and enabling the map would cost a
         * depth pass over every tree to produce nothing. */
        shadows={false}
        camera={{ fov: 52, near: 0.05, far: 260 }}
        onCreated={({ gl }) => {
          /* Before any material has had a chance to link. A program three has
           * already checked can never be reported. */
          installShaderErrorWatch(gl);
          /* Also before the first material links. The fog is a mutation of
           * THREE.ShaderChunk, and three caches a program per material the
           * first time it draws — anything compiled before this call keeps the
           * stock chunks for the life of the page, silently and only on some
           * surfaces. */
          installFog(hdr);
          gl.outputColorSpace = THREE.SRGBColorSpace;
          gl.toneMapping = THREE.AgXToneMapping;
          gl.toneMappingExposure = EXPOSURE;
        }}
      >
        <Lighting />
        <Ground />
        <Trees />
        <Undergrowth />
        <TrailProps />
        <Particles />
        <Rig onFootstep={footstep} />
        {/* Last child that draws. It owns the frame loop at priority 1, which
          * is what stops r3f rendering the scene to the canvas itself, and it
          * is mounted after Rig so that the debug surface exists by the time
          * it wraps the renderer. */}
        <Post />
        <ForestAudio />
        <Ready onReady={onReady} />
      </Canvas>
      <Hud />
    </div>
  );
}

/* Tell the gate the veil can come down.
 *
 * One frame after mount, not on mount: the bakes happen inside the children's
 * `useMemo`s, which run before this effect, but the first *draw* has not
 * happened yet when the effect fires. Lifting the veil then shows a black
 * canvas for one frame, which reads as a flash.
 */
function Ready({ onReady }: { onReady?: () => void }) {
  useEffect(() => {
    if (!onReady) return;
    const id = requestAnimationFrame(() => requestAnimationFrame(onReady));
    return () => cancelAnimationFrame(id);
  }, [onReady]);
  return null;
}

function Hud() {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 p-4 text-center">
      <p className="text-[11px] font-medium tracking-[0.18em] text-white/20 uppercase">
        Click to look &middot; WASD to walk
      </p>
    </div>
  );
}
