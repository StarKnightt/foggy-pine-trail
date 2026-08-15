'use client';

/* The wood.
 *
 * ── One material, three surfaces, four attributes ─────────────────────────
 *
 * Everything made of wood in this scene — living boles, standing snags, hung-up
 * leaners, fallen logs, nurse logs, branch stubs, the sticks in the litter — is
 * one material and one geometry family, blended between three baked sets by two
 * per-vertex weights. That is not a saving, it is the only arrangement that
 * produces the objects the brief asks for. "Logs in every stage from freshly
 * down to a moss-covered nurse log collapsing into the duff" is a *continuum*,
 * and a continuum modelled as three materials has two hard boundaries in it
 * where a real floor has none — a log whose butt still has bark on it and whose
 * middle is bare silver wood with moss over the top is one object with three
 * appearances, and it cannot be assembled out of three objects.
 *
 * Nine texture fetches per shaded fragment, which is the cost, and it is paid
 * on the largest opaque mass in the frame. It measured free: see the note on
 * frame rate at the bottom of this file.
 *
 * ── The occlusion attribute, and why it is not a tint ─────────────────────
 *
 * `aOcc` carries every piece of authored shadowing in the system: the metre of
 * bole nearest the litter, the grooves between the spur roots, the crotch above
 * a branch stub, the whole underside of a fallen log, the contact line where a
 * stick meets the duff. It is routed into `ambientOcclusion` — the same variable
 * three's own AO map feeds — and *not* into `diffuseColor`.
 *
 * That distinction is the single most expensive lesson System 1 recorded and
 * this system exists partly because of it. `TrailProps.tsx` writes its contact
 * crease as `diffuseColor.rgb *= mix(1.0, 0.22, vContact)`, which cannot work:
 * a dielectric under a bright fog dome returns roughly 4% of the sky as
 * specular whatever its albedo is, so a piece darkened only in diffuse has a
 * floor at about luma 42 that no amount of further darkening will get past. The
 * audit's finding that a 10x albedo cut moved the sticks "visually not at all"
 * is exactly that floor, and it is why the loose deadwood was withdrawn rather
 * than fixed. Occlusion attenuates diffuse and specular together and is the only
 * channel that does.
 *
 * ── Culling ───────────────────────────────────────────────────────────────
 *
 * jungle-trail buckets its plants into tiles and distance-culls the tiles, and
 * that half of its scheme is kept here for the same reason: one mesh spanning
 * the world has a bounding sphere the size of the world, is never frustum
 * rejected, and submits the half of the forest behind the camera every frame.
 * What is not kept is the instancing and the near/far LOD split — see the header
 * of `forest.ts` for why a repeated trunk silhouette is the one economy this
 * particular scene cannot afford.
 */
import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { buildForest } from '@/world/forest';
import { bakeTrees, CANOPY, BARK } from './treeMaterials';
import { bakeImage, bakeSurface, type SurfaceSet } from '@/world/bake';

/* Tile centre distance past which a bucket is not submitted.
 *
 * The fog reaches 2% contrast at 36 m and the tiles are 20 m across, so a tile
 * whose centre is 52 m out can still have a corner at 38 m — which is the range
 * at which a trunk contributes a barely-perceptible darkening and is worth
 * having, because the alternative is a visible edge where the wall of wood
 * stops. Past that there is provably nothing: a black object at 52 m returns
 * 0.02% contrast against the fog, which is a fifth of a display level. */
const CULL = 52;

export function Trees() {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);

  const built = useMemo(() => {
    const t0 = performance.now();
    const forest = buildForest();
    const tBuild = performance.now() - t0;
    const tex = bakeTrees(gl);
    const canopyTex = bakeImage(gl, CANOPY, { size: 512, srgb: true, anisotropy: 8 });

    /* ── Wood ─────────────────────────────────────────────────────────── */

    const wood = new THREE.MeshStandardMaterial({
      /* Bark goes in the standard slots, which is what makes three define
       * USE_MAP, USE_NORMALMAP, USE_ROUGHNESSMAP and USE_AOMAP and therefore
       * what makes the four chunks below exist to be replaced. The other two
       * sets arrive as extra uniforms. */
      map: tex.bark.map,
      normalMap: tex.bark.normalMap,
      roughnessMap: tex.bark.ormMap,
      aoMap: tex.bark.ormMap,
      roughness: 1,
      metalness: 0,
      /* Pushed past physical for the same reason the ground's is: a uniform sky
       * through fog produces no shading gradient across a bump, so the normal
       * map is the only thing standing between a bole and a flat brown column.
       * Less than the ground's 1.35, because the bark's own relief is already
       * 5 cm where the duff's is 2 mm and doubling that reads as embossing. */
      normalScale: new THREE.Vector2(1.15, 1.15),
      aoMapIntensity: 1,
      dithering: true,
    });

    /* The snag and moss sets are not material slots, so nothing outside the
     * shader can find them — including the capture harness, whose job is to
     * answer "what is actually in that texture" without trusting the picture. */
    wood.userData.maps = tex;

    const mossUv = tex.bark.patch / tex.moss.patch;

    wood.onBeforeCompile = (shader) => {
      wood.userData.shader = shader;
      shader.uniforms.uSnagMap = { value: tex.snag.map };
      shader.uniforms.uSnagNormal = { value: tex.snag.normalMap };
      shader.uniforms.uSnagOrm = { value: tex.snag.ormMap };
      shader.uniforms.uMossMap = { value: tex.moss.map };
      shader.uniforms.uMossNormal = { value: tex.moss.normalMap };
      shader.uniforms.uMossOrm = { value: tex.moss.ormMap };
      shader.uniforms.uMossUv = { value: mossUv };

      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
attribute float aTone;
attribute float aWeather;
attribute float aMoss;
attribute float aOcc;
varying float vTone;
varying float vWeather;
varying float vMoss;
varying float vOcc;
varying vec3 vWoodWorld;`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
vTone = aTone;
vWeather = aWeather;
vMoss = aMoss;
vOcc = aOcc;
vWoodWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;`,
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
uniform sampler2D uSnagMap;
uniform sampler2D uSnagNormal;
uniform sampler2D uSnagOrm;
/* Set in map_fragment, which three runs before every chunk that reads it; see
 * the note there for why the moss mask cannot be the raw vertex attribute. */
float gMossK;
uniform sampler2D uMossMap;
uniform sampler2D uMossNormal;
uniform sampler2D uMossOrm;
uniform float uMossUv;
varying float vTone;
varying float vWeather;
varying float vMoss;
varying float vOcc;
varying vec3 vWoodWorld;

float wh21( vec2 p ){ return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453123 ); }
float wvn( vec2 p ){
  vec2 i = floor( p ), f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( wh21( i ), wh21( i + vec2( 1.0, 0.0 ) ), f.x ),
              mix( wh21( i + vec2( 0.0, 1.0 ) ), wh21( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
}

/* Breaks the 1.4 m tile.
 *
 * The bark map repeats every 1.4 m and a bole is fifteen metres of it, so the
 * repeat lands ten times inside one silhouette. That is worse here than it is on
 * the ground, because a trunk is a narrow vertical object and a periodic pattern
 * running up a narrow vertical object is read as a *stack* — the eye finds the
 * beat immediately. A slow world-space modulation of value keyed off height and
 * horizontal position gives the bole a tonal structure at a scale the tile has
 * no answer for, and it costs three noise lookups. */
float woodStretch(){
  return smoothstep( 0.15, 0.85,
    wvn( vec2( vWoodWorld.y * 0.31, vWoodWorld.x * 0.19 + vWoodWorld.z * 0.23 ) ) * 0.62
  + wvn( vec2( vWoodWorld.y * 0.94 + 5.1, vWoodWorld.x * 0.5 - vWoodWorld.z * 0.4 ) ) * 0.38 );
}`,
        )
        .replace(
          '#include <map_fragment>',
          `{
  vec4 bk = texture2D( map, vMapUv );
  vec4 sn = texture2D( uSnagMap, vMapUv );
  vec4 mo = texture2D( uMossMap, vMapUv * uMossUv );
  /* The moss set is the props' one, baked for a cushion carpet in a hollow
   * between stones. A curtain of Isothecium on the weather side of a trunk is
   * the same organism in a much better lit place — it is up off the floor, it is
   * on a vertical face, and nothing is dropping litter on it — so it sits a
   * clear step lighter and yellower than floor moss and a clear step lighter
   * than the bark under it. Without the lift it arrived at almost exactly bark
   * luminance: the attribute was measured non-zero over 8% of the wood and three
   * consecutive captures still had no green anywhere on a bole, because a
   * correct mask into an indistinguishable colour is invisible. */
  mo.rgb *= 1.35;

  /* The mask's edge is rebuilt here, against the bark's own furrows, because
   * the vertex attribute physically cannot carry one.
   *
   * aMoss is written per vertex in forest.ts from a few angular harmonics,
   * and a bole's rings are fifteen degrees apart in azimuth and the best part
   * of a metre apart vertically. Nothing finer than that can exist in the
   * attribute, so whatever the harmonics say, what arrives on the bark is a
   * smooth field with one boundary — and the review's report of the hero bole
   * in 78.png is exactly the shape of that limit: "a hard-edged green field
   * covering the left half with an abrupt vertical boundary", roller-painted.
   * Adding higher harmonics upstream cannot fix it; above about eight cycles
   * they alias on the ring and below that they are still a smooth curve.
   *
   * The one thing that does have furrow-scale structure at this point in the
   * pipeline is the bark map. Real trunk moss is not a wash over a bark face:
   * it holds in the furrows, where water runs and stands and where the ridge
   * either side shelters it, and it is scoured off the ridge crowns. So the
   * linearly interpolated attribute is re-thresholded against the bark's own
   * occlusion channel, which is high on a ridge back and low in a fissure. The
   * gradient band the interpolation leaves across each vertex edge is what the
   * threshold bites on, and it comes out as a ragged margin that follows the
   * furrows — which is both what the reference photographs show and the only
   * fuzzy edge available for free. */
  float bkAo = texture2D( aoMap, vMapUv ).r;
  float furrow = 1.0 - bkAo;
  gMossK = smoothstep( 0.74 - 0.62 * furrow, 1.06 - 0.62 * furrow,
                       vMoss * 1.30 + 0.16 * furrow );
  float mossK = gMossK;
  vec4 c = mix( mix( bk, sn, vWeather ), mo, mossK );

  /* Per-piece tone. One bake serves six hundred stems and every piece of dead
   * wood on the floor, and without this they are all the same tree — which
   * nothing in a forest is, and which the eye picks up the instant twenty of
   * them are in frame at once. The range is wide because the render compresses
   * it: measured on the ground, a 3:1 authored albedo ratio arrives as 1.4:1,
   * because the fog dome contributes a near-constant specular term and AgX
   * compresses the midtones on top of it. */
  c.rgb *= mix( 0.70, 1.34, vTone );

  /* And the same again at a scale the texture tile cannot reach. Weaker on moss,
   * which has its own patch structure and does not need a second one. */
  c.rgb *= mix( 0.82, 1.16, woodStretch() ) * ( 1.0 - 0.4 * gMossK ) + 0.4 * gMossK;

  diffuseColor *= c;
}`,
        )
        /* One tangent frame for all three, which is valid only because the
         * three uv sets are the same set scaled — a rotated one would need its
         * own frame and would light the moss as though the sky had moved. */
        .replace(
          '#include <normal_fragment_maps>',
          `{
  mat3 tbnW = getTangentFrame( - vViewPosition, normal, vNormalMapUv );
  vec3 nb = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
  vec3 ns = texture2D( uSnagNormal, vNormalMapUv ).xyz * 2.0 - 1.0;
  vec3 nm = texture2D( uMossNormal, vNormalMapUv * uMossUv ).xyz * 2.0 - 1.0;
  vec3 mapN = mix( mix( nb, ns, vWeather ), nm, gMossK );
  mapN.xy *= normalScale;
  normal = normalize( tbnW * mapN );
}`,
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `float roughnessFactor = roughness;
{
  float rb = texture2D( roughnessMap, vRoughnessMapUv ).g;
  float rs = texture2D( uSnagOrm, vRoughnessMapUv ).g;
  float rm = texture2D( uMossOrm, vRoughnessMapUv * uMossUv ).g;
  roughnessFactor *= mix( mix( rb, rs, vWeather ), rm, gMossK );
}`,
        )
        .replace(
          '#include <aomap_fragment>',
          `{
  float ab = texture2D( aoMap, vAoMapUv ).r;
  float as = texture2D( uSnagOrm, vAoMapUv ).r;
  /* The moss set is baked for the forest floor, where it is the top surface and
   * sees the whole dome. On a bole it is a patch on a vertical in a closed
   * stand, so its own occlusion arrives about twice as open as the bark it
   * replaces and every patch read as a light spot rather than a dark green one. */
  float am = texture2D( uMossOrm, vAoMapUv * uMossUv ).r * 0.58;
  float ambientOcclusion = mix( mix( ab, as, vWeather ), am, gMossK );

  /* The authored occlusion, and this is the line the whole system turns on.
   *
   * Everything the geometry knows and the texture cannot — that this vertex is
   * 8 cm above the litter, or on the underside of a log, or in the crotch above
   * a branch stub, or in the groove between two spur roots — arrives here and
   * nowhere else. Routing it into diffuseColor instead, which is what System 1's
   * props do, leaves the specular term untouched and puts a floor under the
   * darkest value a piece of wood can reach; that floor is why the loose
   * deadwood was withdrawn from System 1 rather than corrected. */
  /* Moss is the one thing here that is not in a cavity.
   *
   * The occlusion attribute is authored for the wood surface — the metre of
   * bole nearest the litter, the groove between two spur roots, the underside
   * of a log — and a
   * moss cushion growing in exactly those places is standing *proud* of them by
   * two or three centimetres and sees a good deal more sky than the bark it is
   * attached to. Applying the wood's occlusion to it unchanged is what buried
   * the moss at the base of every trunk in the wood: it was masked correctly,
   * lifted correctly, and then multiplied by 0.34 for being where moss grows. */
  /* 0.18, down from 0.55, and the map's own occlusion pulled towards the bark's.
   *
   * The lift is real — a cushion stands two or three centimetres proud of the
   * bark it grows on and sees more sky than the groove it is sitting in — but at
   * 0.55 it stopped being a correction and became the brightest term on a trunk.
   * A 3x crop of a redcedar found a pale plume four metres up the bole that
   * survived deleting moss from the albedo mix entirely, which is what put the
   * blame here: the moss was not colouring the bark, it was *exposing* it, and
   * the result was a soft-edged silver smear on the one class of object in this
   * scene that had just been darkened on purpose. Moss should read as a hue
   * against the wood, not as a hole in its occlusion. */
  ambientOcclusion *= mix( vOcc, mix( vOcc, 1.0, 0.18 ), gMossK );

  ambientOcclusion = ( ambientOcclusion - 1.0 ) * aoMapIntensity + 1.0;
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
    /* Three keys its program cache on this string, and without it an edit to
     * the patch above silently reuses the old shader across a hot reload. */
    wood.customProgramCacheKey = () => 'tree-wood-2';

    /* ── Canopy ───────────────────────────────────────────────────────── */

    const canopy = new THREE.MeshStandardMaterial({
      map: canopyTex,
      /* The map is in the AO slot only so that three defines USE_AOMAP and the
       * chunk below exists to be replaced; the texture itself is not read
       * there. Occlusion on a canopy sheet is a property of where it sits in
       * the crown, which is geometry, not texture. */
      aoMap: canopyTex,
      transparent: false,
      alphaTest: 0.38,
      roughness: 1,
      metalness: 0,
      /* Double-sided because a sheet twenty metres up is seen from below and the
       * builder makes no attempt to orient it — three flips the normal on back
       * faces, so a two-sided sheet is lit correctly from either side and a
       * one-sided one is black from half the frame. */
      side: THREE.DoubleSide,
      dithering: true,
    });

    canopy.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
attribute float aOcc;
attribute float aTone;
varying float vOcc;
varying float vTone;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
vOcc = aOcc;
vTone = aTone;`);

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
varying float vOcc;
varying float vTone;`)
        .replace('#include <map_fragment>', `#include <map_fragment>
diffuseColor.rgb *= mix( 0.72, 1.30, vTone );
{
  /* Coverage preservation across the mip chain, and without it the canopy
   * thins out with distance instead of thickening.
   *
   * An alpha *test* is a per-texel yes/no against a map that mipping has
   * averaged. A shoot two texels wide at level zero is one texel at half alpha
   * at level one and a quarter texel at a quarter alpha at level two, so it
   * fails the 0.38 cut somewhere around the third mip and simply disappears —
   * and because that happens to different shoots at different moments it
   * disappears as speckle, which is the halftone dot pattern the review found
   * on the larger blades. The mass loss is the worse half: a crown at forty
   * metres was drawing perhaps a third of the coverage it draws at ten, so the
   * far canopy was systematically too open.
   *
   * The standard answer is alpha-to-coverage, which turns the cut into a
   * multisample coverage mask and is what the SpeedTree and Three.js foliage
   * literature both reach for. It is not available here: the renderer runs
   * antialias off whenever the post pipeline is active, so a material flag
   * would work in one configuration and silently do nothing in the other,
   * which is precisely the class of inert term this project keeps finding.
   *
   * So the coverage is restored analytically instead. The footprint in texels
   * comes off the UV derivatives; alpha is pushed up towards one in proportion
   * to it, which is the continuous form of the per-LOD alpha scalar the
   * offline tools bake. At mip zero the term is exactly the identity. */
  vec2 ft = fwidth( vMapUv ) * 512.0;
  float lod = clamp( log2( max( max( ft.x, ft.y ), 1.0 ) ) / 5.0, 0.0, 1.0 );
  diffuseColor.a = clamp( diffuseColor.a * ( 1.0 + 2.6 * lod ), 0.0, 1.0 );
}`)
        .replace('#include <aomap_fragment>', `{
  /* A needle mass three metres deep sees no sky at all from inside it, and the
   * only thing that can say so is the geometry. Without this the roof renders
   * as a uniform grey lace and the frame that looks up has no depth in it. */
  float ambientOcclusion = ( vOcc - 1.0 ) * aoMapIntensity + 1.0;
  reflectedLight.indirectDiffuse *= ambientOcclusion;
  #if defined( USE_ENVMAP ) && defined( STANDARD )
    float dotNV = saturate( dot( geometryNormal, geometryViewDir ) );
    reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNV, ambientOcclusion, material.roughness );
  #endif
}`);
    };
    canopy.customProgramCacheKey = () => 'tree-canopy-2';

    return {
      forest, wood, canopy, tBuild,
      dispose() {
        for (const t of forest.tiles) {
          t.wood?.dispose();
          t.canopy?.dispose();
        }
        wood.dispose();
        canopy.dispose();
        canopyTex.dispose();
        tex.dispose();
      },
    };
  }, [gl]);

  useEffect(() => built.dispose, [built]);

  /* Published for the harness rather than logged. A count in a console line is
   * gone by the time anyone reads the capture; this is readable from
   * `tools/px.mjs` alongside the draw call and triangle numbers it comes from. */
  useEffect(() => {
    scene.userData.forest = { ...built.forest.counts, buildMs: +built.tBuild.toFixed(0) };
    return () => { delete scene.userData.forest; };
  }, [scene, built]);

  /* The differencing hook.
   *
   * "Code that looks right and does nothing is the defining failure mode of this
   * project" — System 1 found four inert or degenerate paths by changing a
   * constant and checking that pixels actually moved. Doing that by hand costs
   * an edit, a reload and a capture per term, which for a surface with a dozen
   * terms in it is most of an hour and is therefore not done.
   *
   * This makes it a single command. `tools/live.mjs` takes the bark body,
   * substitutes one term out of it, re-bakes, swaps the new set into the live
   * material and measures how many pixels of the delivered frame moved. A term
   * that cannot change the frame reports zero and is either dead or invisible,
   * and both of those are worth knowing before anyone argues about its value.
   *
   * Dev only, and it hands out the real `SurfaceSet` so the tool can put the
   * original back rather than leaving a mutated build behind. */
  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return;
    const mat = built.wood;
    const orig = (mat.userData.maps as { bark: SurfaceSet }).bark;
    let temp: SurfaceSet | null = null;
    const apply = (s: SurfaceSet) => {
      mat.map = s.map;
      mat.normalMap = s.normalMap;
      mat.roughnessMap = s.ormMap;
      mat.aoMap = s.ormMap;
      mat.needsUpdate = true;
    };
    scene.userData.barkProbe = {
      body: BARK,
      swap(body: string) {
        temp?.dispose();
        temp = bakeSurface(gl, body, { size: 1024, patch: 1.4, bump: 0.050, anisotropy: 16 });
        apply(temp);
      },
      restore() {
        apply(orig);
        temp?.dispose();
        temp = null;
      },
    };
    return () => {
      apply(orig);
      temp?.dispose();
      delete scene.userData.barkProbe;
    };
  }, [scene, gl, built]);

  /* Attribute statistics, which answer the other half of the same question.
   *
   * A bake term can be alive and the attribute that gates it dead, and the frame
   * looks identical either way. `aMoss` in particular went through a whole
   * revision at a mean of 0.24 — non-zero everywhere, high nowhere, and
   * therefore invisible — and the only way to see that is to look at the
   * distribution rather than at the picture. */
  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return;
    scene.userData.woodAttrs = () => {
      const out: Record<string, { min: number; max: number; mean: number; over: number }> = {};
      for (const name of ['aTone', 'aWeather', 'aMoss', 'aOcc']) {
        let lo = Infinity, hi = -Infinity, sum = 0, n = 0, over = 0;
        for (const t of built.forest.tiles) {
          const a = t.wood?.getAttribute(name);
          if (!a) continue;
          const arr = a.array as Float32Array;
          for (let i = 0; i < arr.length; i++) {
            const v = arr[i];
            if (v < lo) lo = v;
            if (v > hi) hi = v;
            sum += v; n++;
            if (v > 0.5) over++;
          }
        }
        out[name] = {
          min: +lo.toFixed(4), max: +hi.toFixed(4),
          mean: +(sum / Math.max(1, n)).toFixed(4),
          over: +((100 * over) / Math.max(1, n)).toFixed(1),
        };
      }
      return out;
    };
    return () => { delete scene.userData.woodAttrs; };
  }, [scene, built]);

  const groups = useRef<(THREE.Group | null)[]>([]);

  useFrame(({ camera }) => {
    const cx = camera.position.x, cz = camera.position.z;
    for (let i = 0; i < built.forest.tiles.length; i++) {
      const g = groups.current[i];
      if (!g) continue;
      const t = built.forest.tiles[i];
      const dx = t.cx - cx, dz = t.cz - cz;
      g.visible = dx * dx + dz * dz < CULL * CULL;
    }
  });

  return (
    <>
      {built.forest.tiles.map((t, i) => (
        <group key={i} ref={(g) => { groups.current[i] = g; }}>
          {t.wood && <mesh geometry={t.wood} material={built.wood} />}
          {t.canopy && <mesh geometry={t.canopy} material={built.canopy} />}
        </group>
      ))}
    </>
  );
}
