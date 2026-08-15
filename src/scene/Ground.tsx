'use client';

/* The forest floor.
 *
 * One mesh, one material, two baked surfaces blended by a vertex attribute.
 *
 * ── Why the blend is patched into MeshStandardMaterial ────────────────────
 *
 * The alternative is two meshes, one per surface, and it does not work. The
 * boundary between a trail and the litter beside it is a gradient about forty
 * centimetres wide, and two meshes can only meet at a line. Stencilling one
 * over the other with alpha needs a second full depth-sorted pass over the
 * largest surface in the frame, and coplanar geometry under grazing light
 * z-fights.
 *
 * So it is one surface, and the material samples both texture sets and mixes.
 * Four chunk replacements — albedo, normal, roughness, occlusion — because
 * three keeps each of those in its own include, and every one of them has to
 * agree about where the trail is or the tread's roughness will run past its
 * colour.
 *
 * ── Why the UVs are world space ───────────────────────────────────────────
 *
 * The grid is graded, so its columns are 13 cm apart in the middle and 3 m
 * apart at the edges. Any uv attribute defined per vertex would stretch by a
 * factor of twenty across that boundary. Deriving uv from world xz in the
 * fragment shader gives a texel density that depends only on where the ground
 * is, which is the correct answer and also happens to be free.
 */
import { useEffect, useMemo, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { buildGroundGeometry } from '@/world/groundMesh';
import { bakeGround } from './groundMaterials';

export function Ground() {
  const gl = useThree((s) => s.gl);

  const { geometry, material, dispose } = useMemo(() => {
    const { geometry } = buildGroundGeometry();
    const tex = bakeGround(gl);

    const material = new THREE.MeshStandardMaterial({
      /* The litter set goes in the standard slots, which is what makes three
       * define USE_MAP, USE_NORMALMAP, USE_ROUGHNESSMAP and USE_AOMAP and
       * therefore what makes the four chunks below exist to be replaced. The
       * tread set arrives as extra uniforms. */
      map: tex.litter.map,
      normalMap: tex.litter.normalMap,
      roughnessMap: tex.litter.ormMap,
      aoMap: tex.litter.ormMap,
      roughness: 1,
      metalness: 0,
      /* 1.35 rather than 1. The floor is lit almost entirely by a uniform sky
       * through fog, which is the least revealing light there is — it has no
       * direction, so it produces no shading gradient across a bump, and the
       * only thing standing between this surface and looking like flat brown
       * paper is the normal map. Pushing it slightly past physical is the
       * standard compensation and it is doing the job a raking sun would. */
      normalScale: new THREE.Vector2(1.35, 1.35),
      aoMapIntensity: 1,
      dithering: true,
    });

    /* The tread set reaches the GPU as loose uniforms rather than as material
     * slots, which means nothing outside the shader can find it — including
     * the capture harness, whose whole job is to answer "what is actually in
     * that texture" without trusting the picture. */
    material.userData.maps = tex;

    material.onBeforeCompile = (shader) => {
      material.userData.shader = shader;
      shader.uniforms.uTreadMap = { value: tex.tread.map };
      shader.uniforms.uTreadNormal = { value: tex.tread.normalMap };
      shader.uniforms.uTreadOrm = { value: tex.tread.ormMap };
      shader.uniforms.uLitterPatch = { value: tex.litter.patch };
      shader.uniforms.uTreadPatch = { value: tex.tread.patch };

      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
attribute float aTread;
attribute float aWet;
varying float vTread;
varying float vWet;
varying vec3 vGroundWorld;`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
vTread = aTread;
vWet = aWet;
vGroundWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;`,
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
uniform sampler2D uTreadMap;
uniform sampler2D uTreadNormal;
uniform sampler2D uTreadOrm;
uniform float uLitterPatch;
uniform float uTreadPatch;
varying float vTread;
varying float vWet;
varying vec3 vGroundWorld;

vec2 litterUv(){ return vGroundWorld.xz / uLitterPatch; }
vec2 treadUv(){ return vGroundWorld.xz / uTreadPatch; }

float gh21( vec2 p ){ return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453123 ); }
float gvn( vec2 p ){
  vec2 i = floor( p ), f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( gh21( i ), gh21( i + vec2( 1.0, 0.0 ) ), f.x ),
              mix( gh21( i + vec2( 0.0, 1.0 ) ), gh21( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
}

/* Breaks the 90 cm tile. A repeat that lands eight times between the camera and
 * the fog is visible however good the texture inside it is.
 *
 * This used to carry the wetness variation as well, and it could not: measured
 * across eight stations, the 2x albedo swing it applies delivered a near-tread
 * range of 11 out of 255, because the render compresses authored albedo contrast
 * by about half and a 4.5 m noise averages away inside the footprint the tread
 * occupies at the distance it is read from. Wetness now comes from the drainage
 * attribute, which is both larger and keyed to the terrain. */
float groundStretch(){
  float s = gvn( vGroundWorld.xz * 0.22 ) * 0.64 + gvn( vGroundWorld.xz * 0.62 + 7.3 ) * 0.36;
  return smoothstep( 0.20, 0.80, s );
}

/* Wetness carried up from the drainage attribute, sharpened.
 *
 * The attribute is deliberately smooth — a 4 m running mean of the centreline's
 * own relief — but a trail does not fade between wet and dry over 4 m, it has
 * saturated stretches with edges. Pushing it through a contrast curve puts most
 * of the area at one end or the other, which is what makes the length of the
 * trail read as a sequence of stretches rather than as a gradient. */
float treadWet(){
  /* A metre-scale term on top of the 4 m drainage, so a wet stretch is not one
   * flat tone for its whole length — within a sag the water still sits in the
   * lower half of it. Without this the trail reads as a sequence of painted
   * blocks, which is a different artefact from the ribbon but no better. */
  float w = clamp( vWet * 1.48 - 0.24 + ( gvn( vGroundWorld.xz * 0.85 + 3.1 ) - 0.5 ) * 0.30,
                   0.0, 1.0 );
  return w * w * ( 3.0 - 2.0 * w );
}

/* Free water, as opposed to saturated soil.
 *
 * Kept to a few percent of the tread by construction. The equivalent term inside
 * the bake was audited at 48% of the area and full strength over at least a
 * tenth, and because standing water carries a near-mirror roughness that reflects
 * a bright neutral fog dome, over-firing it does not read as puddles — it
 * neutralises the hue of everything it touches and turns the wet stretches grey.
 * That is the mechanism that made an authored R/B of 2.8 arrive at 1.06. */
float treadPool( float wet ){
  return smoothstep( 0.95, 1.0, wet ) * smoothstep( 0.70, 0.92, groundStretch() );
}

/* The tread/duff boundary, ragged.
 *
 * The vertex weight already scallops at +/-11 cm over 1.4 m, and it was not
 * enough: at the decimetre scale the edge was still a smooth curve, and the audit
 * called it a clean geometric crease with not one needle lying across it. A trail
 * under a forest that drops litter continuously cannot have a litter-free tread.
 *
 * Perturbing the blend weight rather than adding a separate litter layer is what
 * makes this cheap and also what makes it correct: a finger of duff reaching into
 * the tread *is* the litter material occupying tread ground, so it arrives with
 * the right colour, normal, roughness and occlusion at once. Two octaves, and the
 * perturbation is windowed to the boundary so the middle of the tread and the
 * open duff are untouched. */
float treadWeight(){
  float band = 1.0 - smoothstep( 0.0, 0.46, abs( vTread - 0.5 ) );
  float f = gvn( vGroundWorld.xz * 5.5 ) * 0.66 + gvn( vGroundWorld.xz * 13.0 + 5.0 ) * 0.34;
  return clamp( vTread + ( f - 0.5 ) * 1.30 * band, 0.0, 1.0 );
}`,
        )
        /* Albedo. Both sets sampled with their own texel density and mixed by
         * the vertex weight. */
        .replace(
          '#include <map_fragment>',
          `{
  vec4 litC = texture2D( map, litterUv() );
  vec4 trdC = texture2D( uTreadMap, treadUv() );
  float st = groundStretch();
  trdC.rgb *= mix( 0.82, 1.14, st );
  litC.rgb *= mix( 0.84, 1.12, st );
  /* A 4.4x swing, authored, to deliver something near 2x in the frame. The
   * measured transfer is about half — a dielectric under a bright fog dome picks
   * up a near-constant specular term and AgX compresses the midtones on top of
   * it — so a range that looks excessive in the map is what arrives as correct.
   * The wet end is warm, not neutral: saturated forest soil is a dark warm brown
   * and pulling it towards grey is what made the tread read as wet concrete. */
  float wet = treadWet();
  /* The wet end is strongly chromatic because it has to survive the trip. At the
   * diffuse level saturated soil sits at, the fog dome's neutral specular is a
   * large fraction of the pixel, so an authored R/B of 1.4 arrived as 1.02 and the
   * wet stretches read as neutral grey — wet concrete again, one scale down. 2.8
   * is what lands as a warm brown. */
  trdC.rgb *= mix( vec3( 1.04, 1.03, 1.01 ), vec3( 0.335, 0.215, 0.130 ), wet );
  /* Standing water in the worst of the sags. Small in area and very dark, which
   * is the only place in the tread that goes near black. */
  float pool = treadPool( wet );
  trdC.rgb *= mix( vec3( 1.0 ), vec3( 0.30, 0.32, 0.40 ), pool );
  /* The saturated ring at the stretch scale, the same term the bake carries at the
   * patch scale. A pool's own diffuse is nearly black and its brightness comes back
   * as specular; the soil in the ring beside it has neither, so it is the darkest
   * ground in the frame. */
  float ring = ( 1.0 - smoothstep( 0.0, 0.13, abs( wet - 0.91 ) ) ) * ( 1.0 - pool );
  trdC.rgb *= 1.0 - 0.40 * ring;
  diffuseColor *= mix( litC, trdC, treadWeight() );
}`,
        )
        /* Normals. One tangent frame for both, which is only valid because
         * both uv sets are world-axis-aligned and differ by a scale — a
         * rotated tread uv would need its own frame and would light the trail
         * as though the sky had moved. */
        .replace(
          '#include <normal_fragment_maps>',
          `{
  mat3 tbnG = getTangentFrame( - vViewPosition, normal, litterUv() );
  vec3 nl = texture2D( normalMap, litterUv() ).xyz * 2.0 - 1.0;
  vec3 nt = texture2D( uTreadNormal, treadUv() ).xyz * 2.0 - 1.0;
  vec3 mapN = mix( nl, nt, treadWeight() );
  mapN.xy *= normalScale;
  normal = normalize( tbnG * mapN );
}`,
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `float roughnessFactor = roughness;
{
  float rl = texture2D( roughnessMap, litterUv() ).g;
  float rt = texture2D( uTreadOrm, treadUv() ).g;
  /* The wet stretches are smoother as well as darker, and it has to be the same
   * field driving both or the sheen lands where the ground is dry. Saturated soil
   * is only mildly glossy — it goes plastic rather than mirrored — so the general
   * wet floor stops at 0.62 and only standing water is allowed to reflect. */
  float wet = treadWet();
  /* Gated on the top half of the wetness field rather than applied in proportion to
   * it. Damp soil is matte — it is darker, not shinier, and only an actual film of
   * water is smooth. Taking the roughness down linearly in wetness put a sheen along
   * the entire length of the trail, and a dark glossy strip winding through a matte
   * floor reads as a stream rather than as a path. */
  rt = mix( rt, min( rt, 0.38 ), smoothstep( 0.46, 0.96, wet ) );
  /* Near-zero, so a pool returns a clean specular of the fog dome. Standing water
   * is the smoothest thing in the frame and the previous 0.14 floor was still
   * scattering it into a matte grey patch. */
  rt = mix( rt, 0.045, treadPool( wet ) );
  roughnessFactor *= mix( rl, rt, treadWeight() );
}`,
        )
        .replace(
          '#include <aomap_fragment>',
          `{
  float al = texture2D( aoMap, litterUv() ).r;
  float at = texture2D( uTreadOrm, treadUv() ).r;
  float w = treadWeight();
  /* The undercut. The duff mat is 3-5 cm thick and cohesive, so where a trail has
   * cut it the mat overhangs the mineral soil and there is a hard dark line under
   * its lip — in the reference photographs that line is the single strongest cue
   * that the tread is *below* the floor rather than laid on it, and with no shadow
   * map in the scene nothing else will produce it.
   *
   * Biased to the tread side of the boundary, which is where the overhang casts.
   * Tight, because the whole value of the cue is that it is a line: widened out to
   * a soft band it becomes an airbrushed outline and reads as a painted edge. */
  float lip = ( 1.0 - smoothstep( 0.0, 0.21, abs( w - 0.62 ) ) )
            * smoothstep( 0.10, 0.42, w );
  float ambientOcclusion = ( mix( al, at, w ) - 1.0 ) * aoMapIntensity + 1.0;
  ambientOcclusion *= 1.0 - 0.40 * lip;
  /* The stretch-scale saturated ring, occluded for the same reason the patch-scale
   * one is: without attenuating the specular the ring cannot go darker than the
   * 0.04 of sky every dielectric returns. */
  float wetA = treadWet();
  float ringA = ( 1.0 - smoothstep( 0.0, 0.13, abs( wetA - 0.91 ) ) )
              * ( 1.0 - treadPool( wetA ) ) * w;
  ambientOcclusion *= 1.0 - 0.42 * ringA;
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
    /* Any change to the patch above needs a new program. Three keys its
     * program cache on this string, and without it a hot reload silently
     * reuses the old shader. */
    material.customProgramCacheKey = () => 'ground-blend-3';

    return {
      geometry,
      material,
      dispose() {
        geometry.dispose();
        material.dispose();
        tex.dispose();
      },
    };
  }, [gl]);

  const ref = useRef<THREE.Mesh>(null);
  useEffect(() => dispose, [dispose]);

  return (
    <mesh
      ref={ref}
      geometry={geometry}
      material={material}
      receiveShadow
      /* Never culled. It is one draw call and its bounding sphere is 60 m
       * across, so the test can only ever cost time or be wrong. */
      frustumCulled={false}
    />
  );
}
