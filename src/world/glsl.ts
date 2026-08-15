/* Shared GLSL noise.
 *
 * Two audiences. The bakers in `bake.ts` render tiling PBR maps with it, and
 * those *must* wrap seamlessly, so every primitive takes an explicit lattice
 * period and hashes the wrapped cell index rather than the raw one. The
 * ground and bark shaders use the same functions in world space, where
 * wrapping is irrelevant and the period is just set absurdly high.
 *
 * TILING CONTRACT: whenever a caller scales `p`, it must scale the period by
 * exactly the same factor. Get it wrong and the map looks fine on its own and
 * seams the instant it repeats.
 *
 * The hashes go through three components with three unrelated multipliers.
 * The common two-component form — `p += dot(p, p.yx + k)` — adds the same
 * scalar to both components, so `x - y` survives the mixing step unchanged
 * and cells along a 45-degree diagonal stay correlated. Rendered, that lays a
 * faint woven cross-hatch over every surface that consumes it, at a fixed
 * pitch, which on bark and forest litter is exactly the artefact that makes a
 * texture read as procedural.
 */
export const NOISE = /* glsl */ `
float hash21(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
vec3 hash33(vec3 p){
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}

float pnoise(vec2 p, vec2 per){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 i0 = mod(i, per);
  vec2 i1 = mod(i + 1.0, per);
  float a = hash21(i0);
  float b = hash21(vec2(i1.x, i0.y));
  float c = hash21(vec2(i0.x, i1.y));
  float d = hash21(i1);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 2.0 - 1.0;
}

float pfbm(vec2 p, vec2 per, int oct){
  float s = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < 8; i++){
    if (i >= oct) break;
    s += a * pnoise(p, per);
    n += a;
    p *= 2.0; per *= 2.0; a *= 0.5;
  }
  return s / max(n, 1e-4);
}

/* Ridged fbm. |noise| inverted, so the zero crossings become creases.
 *
 * This is the shape of bark. A pine's outer bark splits under radial growth
 * pressure and the splits are *lines* — long, roughly parallel, meeting at
 * shallow junctions. A plain fbm has no lines in it at any frequency, which
 * is why fbm-only bark reads as noise on a cylinder however much of it you
 * stack up. */
float pridged(vec2 p, vec2 per, int oct){
  float s = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < 8; i++){
    if (i >= oct) break;
    s += a * (1.0 - abs(pnoise(p, per)));
    n += a;
    p *= 2.0; per *= 2.0; a *= 0.5;
  }
  return s / max(n, 1e-4);
}

/* x = distance to the nearest feature point, y = to the second nearest.
 * y - x is the cell border, which is what a crack is. */
vec2 pworley(vec2 p, vec2 per){
  vec2 i = floor(p), f = fract(p);
  float f1 = 9.0, f2 = 9.0;
  for (int y = -1; y <= 1; y++){
    for (int x = -1; x <= 1; x++){
      vec2 g = vec2(float(x), float(y));
      vec2 o = hash22(mod(i + g, per));
      float d = length(g + o - f);
      if (d < f1){ f2 = f1; f1 = d; }
      else if (d < f2){ f2 = d; }
    }
  }
  return vec2(f1, f2);
}

/* Cell id of the nearest feature point. Gives each bark plate, each pebble in
 * the tread and each fallen needle its own tone, which is the difference
 * between litter and a speckle pattern. */
float pworleyId(vec2 p, vec2 per){
  vec2 i = floor(p), f = fract(p);
  float f1 = 9.0; vec2 best = vec2(0.0);
  for (int y = -1; y <= 1; y++){
    for (int x = -1; x <= 1; x++){
      vec2 g = vec2(float(x), float(y));
      vec2 c = mod(i + g, per);
      vec2 o = hash22(c);
      float d = length(g + o - f);
      if (d < f1){ f1 = d; best = c; }
    }
  }
  return hash21(best + 3.77);
}

/* Cell borders with the jitter exposed and the owning cell reported.
 *
 * Bark plates are not round. A fully jittered Voronoi produces smoothly
 * curving borders; dropping the jitter towards zero straightens them into the
 * long angular runs that bark fissures actually are, without regimenting them
 * into a grid. The cell id is what lets the two sides of a fissure differ —
 * one plate has lifted and greyed and the other has not. */
vec3 worleyEdge(vec2 p, vec2 per, float jit){
  vec2 i = floor(p), f = fract(p);
  float f1 = 9.0, f2 = 9.0; vec2 best = vec2(0.0);
  for (int y = -1; y <= 1; y++){
    for (int x = -1; x <= 1; x++){
      vec2 g = vec2(float(x), float(y));
      vec2 c = mod(i + g, per);
      vec2 o = mix(vec2(0.5), hash22(c), jit);
      float d = length(g + o - f);
      if (d < f1){ f2 = f1; f1 = d; best = c; }
      else if (d < f2){ f2 = d; }
    }
  }
  return vec3(f1, f2, hash21(best + 3.77));
}

/* Directionally stretched fbm.
 *
 * Everything in this forest has a grain direction. Bark runs vertically,
 * needle litter lies down along the trail where boots have swept it, a fallen
 * log's rot runs along its length. Anisotropy is the cheapest way to say so
 * and the most commonly skipped: isotropic noise on a trunk is the single
 * most reliable tell that a bark texture was generated rather than
 * photographed. */
float pstretch(vec2 p, vec2 per, vec2 aniso, int oct){
  return pfbm(p * aniso, per * aniso, oct);
}

float unit(float x){ return x * 0.5 + 0.5; }
float sstep(float a, float b, float x){ return smoothstep(a, b, x); }
float contrast(float x, float k){
  x = clamp(x, 0.0, 1.0);
  return x <= 0.5 ? 0.5 * pow(2.0 * x, k) : 1.0 - 0.5 * pow(2.0 * (1.0 - x), k);
}
float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

/* World-space wrappers. The period is far larger than anything in this wood
 * ever reaches, so the wrap is unobservable. */
#define WPER vec2(4096.0)
float wfbm(vec2 p, int oct){ return pfbm(p, WPER, oct); }
float wnoise(vec2 p){ return pnoise(p, WPER); }
vec2  wworley(vec2 p){ return pworley(p, WPER); }
float wworleyId(vec2 p){ return pworleyId(p, WPER); }
vec3  wedge(vec2 p, float jit){ return worleyEdge(p, WPER, jit); }
`;
