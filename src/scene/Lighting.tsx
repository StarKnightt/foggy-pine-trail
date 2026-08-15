'use client';

/* Lighting.
 *
 * Placeholder shape for System 1 — enough to see the ground honestly, and
 * deliberately not more. System 5 replaces it. What is here already obeys the
 * one rule the whole scene depends on: no directional light, no shadow map,
 * nothing with an azimuth. Every photon in this frame arrives from glowing air
 * after being scattered many times, and the moment a directional term appears
 * the picture stops being a foggy morning and becomes an overcast afternoon.
 *
 * The primitive is an environment map of the fog, not a hemisphere light.
 *
 * A hemisphere light is the analytic integral of a two-colour *dome* against a
 * cosine lobe, and that is the right model for a clear overcast: bright sky
 * above, dark ground below, everything lit from one side. Fog is a different
 * object. The air is the source and the surface is inside it, so radiance
 * arrives from the full sphere and the up-to-down ratio collapses. Two things
 * follow that a hemisphere light cannot deliver at any intensity:
 *
 *   The floor lands in the right band. env.ts explains the numbers; the short
 *   version is that a hemisphere light with a duff-reflectance ground colour
 *   renders wet duff at RGB 25 and this renders it near 80, because the lower
 *   hemisphere here is glowing air rather than a single dark reflectance.
 *
 *   Wet surfaces read as wet. Everything on this trail is soaked, and all of
 *   the roughness authored into the ground and prop bakes was inert with only
 *   analytic lights in the scene — MeshStandardMaterial has nothing to reflect
 *   without an envMap, so the damp-lowers-roughness logic changed literally no
 *   pixels. With an environment there is a broad low-contrast sheen that
 *   strengthens where the surface is wet, which is most of what distinguishes
 *   damp mineral soil from dry dust.
 *
 * Cost is one 128x64 float equirect built on the CPU once, run through PMREM
 * once, plus one extra texture fetch per shaded pixel. The same texture is the
 * sky, which is the second reason it exists: `scene.background` set to a Color
 * is a clear value that never passes through the tone map, so it sat at 182
 * while the fog-saturated ground it was supposed to be continuous with came out
 * of AgX at 202. A dome mesh is tone mapped like everything else and the seam
 * at the horizon closes exactly.
 */
import { useEffect, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { FOG_RADIANCE, FOG_DENSITY } from './env';
import { domeRadianceAt, fogAirAt } from './fog';

/* 128x64 is far more than the shading needs — PMREM's irradiance mip is a
 * handful of texels — but the same texture is stretched across the sky dome,
 * where a coarse vertical gradient bands visibly. */
const DOME_W = 128;
const DOME_H = 64;

/* Radius sits inside the 260 m far plane with room to spare. The dome is drawn
 * without depth so the exact figure only has to keep it out of the near plane. */
const DOME_R = 220;

function fogDome(profile: (el: number, out: THREE.Color) => THREE.Color): THREE.DataTexture {
  const data = new Float32Array(DOME_W * DOME_H * 4);
  const c = new THREE.Color();

  for (let y = 0; y < DOME_H; y++) {
    /* DataTexture row 0 is v = 0, and SphereGeometry puts v = 1 at the +Y pole,
     * so v runs nadir to zenith. */
    const v = (y + 0.5) / DOME_H;
    const el = (v - 0.5) * 2; // -1 nadir .. 0 horizon .. +1 zenith

    /* The profiles live in fog.ts, because the fog has to evaluate the same
     * function per fragment or distant geometry stops dissolving into the sky
     * it is standing against. Two copies of "what colour is the air" is two
     * answers to it. */
    profile(el, c);

    for (let x = 0; x < DOME_W; x++) {
      const i = (y * DOME_W + x) * 4;
      data[i] = c.r;
      data[i + 1] = c.g;
      data[i + 2] = c.b;
      data[i + 3] = 1;
    }
  }

  const t = new THREE.DataTexture(data, DOME_W, DOME_H, THREE.RGBAFormat, THREE.FloatType);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.NoColorSpace;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = THREE.RepeatWrapping;
  t.needsUpdate = true;
  return t;
}

export function Lighting() {
  const scene = useThree((s) => s.scene);
  const gl = useThree((s) => s.gl);

  /* Two domes, identical above the horizon and deliberately different below
   * it, and the difference is a fix rather than a subtlety.
   *
   * Below the horizon `domeRadianceAt` falls towards FOG_NADIR, which is not
   * air — it is what a surface sees looking down, a short path through glowing
   * air onto wet duff, and env.ts's floor levels depend on it. That is right
   * for the environment map and wrong for anything visible, because the only
   * place the dome is *seen* below the horizon is past the rim of the ground
   * mesh at forty-four metres, where the fog has long since saturated and is
   * painting `fogAirAt`. One texture for both put a two-to-three count
   * horizontal seam along the far ground line all the way across the frame:
   * the ground converging on one colour and the sky behind it being another.
   *
   * Cost of the split is one extra 128x64 float texture, no extra PMREM — the
   * sky dome is a plain textured mesh and never goes through one. */
  const { sky, env } = useMemo(() => {
    const skyTex = fogDome(fogAirAt);
    const envTex = fogDome(domeRadianceAt);
    const pmrem = new THREE.PMREMGenerator(gl);
    const target = pmrem.fromEquirectangular(envTex);
    pmrem.dispose();
    envTex.dispose();
    return { sky: skyTex, env: target };
  }, [gl]);

  useEffect(() => {
    /* FogExp2 is what turns USE_FOG and FOG_EXP2 on and what publishes the
     * `fogDensity` uniform; the maths it names is entirely replaced by the
     * chunk patch in fog.ts, which reads that one uniform and nothing else off
     * it. `fogColor` is left set to the horizon value because three's uniform
     * is still declared, but nothing reads it — the fog's colour is the dome's
     * elevation profile evaluated along the view ray. */
    scene.fog = new THREE.FogExp2(FOG_RADIANCE.getHex(), FOG_DENSITY);
    scene.environment = env.texture;
    scene.background = null;
    return () => {
      scene.fog = null;
      scene.environment = null;
    };
  }, [scene, env]);

  useEffect(() => () => {
    env.dispose();
    sky.dispose();
  }, [env, sky]);

  return (
    <mesh renderOrder={-1000} frustumCulled={false}>
      <sphereGeometry args={[DOME_R, 32, 24]} />
      {/* No depth at all: drawn first, everything else lands on top. Fog off
        * because this *is* the fog — running FogExp2 over it at 220 m would
        * flatten the gradient to a single value and undo the point. */}
      <meshBasicMaterial
        map={sky}
        side={THREE.BackSide}
        depthWrite={false}
        depthTest={false}
        fog={false}
      />
    </mesh>
  );
}
