'use client';

/* Roots, stones and fallen wood.
 *
 * Two meshes, two draw calls, every prop in the wood. See `trailProps.ts` for
 * why these are geometry rather than more heightfield, and for how they are
 * kept sitting on the floor.
 *
 * ── The two shader patches ────────────────────────────────────────────────
 *
 * Both are the same trick the ground uses: a per-vertex weight computed at
 * build time, when the world position and the trail are both known, carried
 * into the fragment shader to select between two appearances. It is worth
 * saying why that is better than the obvious alternative of deriving the same
 * thing in the shader from world position:
 *
 *   `aWear` is how polished a piece of wood is, and it depends on where the
 *   piece lies relative to the tread *and* on which way that bit of its
 *   surface faces. The second half is not available from world position at
 *   all — two points a centimetre apart on opposite sides of a root have the
 *   same xz and completely different answers.
 *
 *   `aMoss` is per *facet*, not per point. Moss grows on a face of a rock and
 *   stops at its edge, and reproducing that from a noise field means finding
 *   the edge again in the shader, which is exactly the information the
 *   geometry already has and the shader does not.
 */
import { useEffect, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { buildTrailProps } from '@/world/trailProps';
import { bakeProps } from './propMaterials';

export function TrailProps() {
  const gl = useThree((s) => s.gl);

  const built = useMemo(() => {
    const geo = buildTrailProps();
    const tex = bakeProps(gl);

    /* ── Wood ─────────────────────────────────────────────────────────── */

    const wood = new THREE.MeshStandardMaterial({
      map: tex.wood.map,
      normalMap: tex.wood.normalMap,
      roughnessMap: tex.wood.ormMap,
      aoMap: tex.wood.ormMap,
      roughness: 1,
      metalness: 0,
      normalScale: new THREE.Vector2(1.2, 1.2),
      dithering: true,
    });

    wood.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
attribute float aWear;
attribute float aTint;
attribute float aContact;
varying float vWear;
varying float vTint;
varying float vContact;`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
vWear = aWear;
vTint = aTint;
vContact = aContact;`,
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
varying float vWear;
varying float vTint;
varying float vContact;`,
        )
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
{
  /* Per-piece tone. One bake serves every root and every stick, and without
   * this they are all the same wood — which nothing in a forest is, and which
   * the eye picks up immediately when forty of them are in frame. */
  diffuseColor.rgb *= mix(0.78, 1.26, vTint);

  /* The polished crown. Where boots cross a root they wear the bark off and
   * burnish the wood under it, and that strip is the lightest thing on the
   * whole trail surface — around 0.19 linear against 0.075 for the rest of the
   * root. It is a small area and it does a large amount of work: it is the
   * one highlight in a frame that has no direct light in it at all. */
  diffuseColor.rgb = mix(diffuseColor.rgb,
                         diffuseColor.rgb * 1.55 + vec3(0.0110, 0.0086, 0.0056),
                         vWear * 0.80);

  /* The contact crease. Authored in the geometry — see contactAt() — because
   * this scene has no shadow map and no directional light to cast one with, and
   * a prop with no dark line where it meets the soil reads as a decal however
   * well the rest of it is shaded. Down to a fifth is not subtle and it is not
   * meant to be: a real undercut under a root is nearly black, because the only
   * thing lighting it is a centimetre-wide strip of sky. */
  diffuseColor.rgb *= mix(1.0, 0.22, vContact);
}`,
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, 0.40, vWear * 0.85);
// The crease is a cavity, and a cavity does not catch a sky reflection.
roughnessFactor = mix(roughnessFactor, 1.0, vContact * 0.8);`,
        );
    };
    wood.customProgramCacheKey = () => 'prop-wood-3';

    /* ── Stone ────────────────────────────────────────────────────────── */

    const stone = new THREE.MeshStandardMaterial({
      map: tex.stone.map,
      normalMap: tex.stone.normalMap,
      roughnessMap: tex.stone.ormMap,
      aoMap: tex.stone.ormMap,
      roughness: 1,
      metalness: 0,
      normalScale: new THREE.Vector2(1.0, 1.0),
      dithering: true,
    });

    /* The moss set is sampled at its own texel density, and the rock's uv is
     * already metres over the rock patch — so the ratio of the two patches is
     * the whole of the conversion. Doing it as a uniform rather than baking
     * both at the same patch keeps the moss fine enough to read as a pile. */
    const mossUvScale = tex.stone.patch / tex.moss.patch;

    stone.onBeforeCompile = (shader) => {
      shader.uniforms.uMossMap = { value: tex.moss.map };
      shader.uniforms.uMossNormal = { value: tex.moss.normalMap };
      shader.uniforms.uMossOrm = { value: tex.moss.ormMap };
      shader.uniforms.uMossUv = { value: mossUvScale };

      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
attribute float aMoss;
attribute float aContact;
attribute float aCrown;
varying float vMoss;
varying float vContact;
varying float vCrown;`,
        )
        .replace('#include <begin_vertex>', `#include <begin_vertex>
vMoss = aMoss;
vContact = aContact;
vCrown = aCrown;`);

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
uniform sampler2D uMossMap;
uniform sampler2D uMossNormal;
uniform sampler2D uMossOrm;
uniform float uMossUv;
varying float vMoss;
varying float vContact;
varying float vCrown;`,
        )
        .replace(
          '#include <map_fragment>',
          `{
  vec4 rockC = texture2D( map, vMapUv );
  vec4 mossC = texture2D( uMossMap, vMapUv * uMossUv );
  diffuseColor *= mix( rockC, mossC, vMoss );

  /* Crown lighter, buried flank darker. A stone in a trail is not one tone: the
   * exposed top has been scoured for a century and the part that has been under
   * the soil is stained by it, and the step between them at the soil line is
   * what makes the stone read as *bedded* rather than as placed. */
  diffuseColor.rgb *= mix(0.78, 1.20, vCrown);

  /* The bedding crease. Same reasoning as the wood, and the same numbers: there
   * is no shadow map in this scene, so the dark line where a rock meets the
   * ground has to be authored into the geometry or it does not exist. */
  diffuseColor.rgb *= mix(1.0, 0.24, vContact);
}`,
        )
        .replace(
          '#include <normal_fragment_maps>',
          `{
  mat3 tbnP = getTangentFrame( - vViewPosition, normal, vNormalMapUv );
  vec3 nr = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
  vec3 nm = texture2D( uMossNormal, vNormalMapUv * uMossUv ).xyz * 2.0 - 1.0;
  vec3 mapN = mix( nr, nm, vMoss );
  mapN.xy *= normalScale;
  normal = normalize( tbnP * mapN );
}`,
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `float roughnessFactor = roughness;
{
  float rr = texture2D( roughnessMap, vRoughnessMapUv ).g;
  float rm = texture2D( uMossOrm, vRoughnessMapUv * uMossUv ).g;
  roughnessFactor *= mix( rr, rm, vMoss );
  // Polished by boots and rain on top, matte where the soil has been against it.
  roughnessFactor = mix( roughnessFactor, 0.42, vCrown * 0.6 );
  roughnessFactor = mix( roughnessFactor, 1.0, vContact * 0.8 );
}`,
        )
        .replace(
          '#include <aomap_fragment>',
          `{
  float ar = texture2D( aoMap, vAoMapUv ).r;
  float am = texture2D( uMossOrm, vAoMapUv * uMossUv ).r;
  float ambientOcclusion = ( mix( ar, am, vMoss ) - 1.0 ) * aoMapIntensity + 1.0;
  reflectedLight.indirectDiffuse *= ambientOcclusion;
  #if defined( USE_CLEARCOAT )
    clearcoatSpecularIndirect *= ambientOcclusion;
  #endif
  #if defined( USE_SHEEN )
    sheenSpecularIndirect *= ambientOcclusion;
  #endif
  #if defined( USE_ENVMAP ) && defined( STANDARD )
    float dotNV = saturate( dot( geometryNormal, geometryViewDir ) );
    reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNV, ambientOcclusion, material.roughness );
  #endif
}`,
        );
    };
    stone.customProgramCacheKey = () => 'prop-stone-3';

    return {
      geo, wood, stone,
      dispose() {
        geo.wood.dispose();
        geo.stones.dispose();
        wood.dispose();
        stone.dispose();
        tex.dispose();
      },
    };
  }, [gl]);

  useEffect(() => built.dispose, [built]);

  return (
    <>
      {/* Never culled: each of these is one merged buffer spanning the whole
        * world, so the bounding sphere is always in view and the test can only
        * cost time. */}
      <mesh geometry={built.geo.wood} material={built.wood} frustumCulled={false} />
      <mesh geometry={built.geo.stones} material={built.stone} frustumCulled={false} />
    </>
  );
}
