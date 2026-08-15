/* The hour, as numbers.
 *
 * 6am in early autumn on the Olympic Peninsula, heavy ground fog, complete
 * overcast above it. Everything downstream — fog colour, sky light, exposure,
 * the grade — reads from here, so the hour can be moved without hunting for
 * the eleven places that assumed it.
 *
 * ── The light there actually is ───────────────────────────────────────────
 *
 * This is the unusual part of the scene and it is worth being exact, because
 * getting it wrong is what makes a fog render look like a grey filter over a
 * sunny one.
 *
 * There is no sun. Not "a weak sun" — the cloud deck is thick, the fog under
 * it is thicker, and by the time light reaches the forest floor it has been
 * scattered so many times that it arrives from every direction at once. The
 * consequences are specific:
 *
 *   No shadows. Not soft shadows: none. Any directional light with a shadow
 *   map in this scene is wrong, and the standard instinct to "add a weak sun
 *   for shape" is exactly what produces a render that reads as a game with the
 *   fog slider up.
 *
 *   The source is a sphere, not a hemisphere. This is the correction that
 *   matters most and the one this file got wrong for a whole revision. A clear
 *   overcast sky is a luminous hemisphere over a dark floor, and a hemisphere
 *   light is its exact analytic integral. Fog is not that. The scattering air
 *   *surrounds* the surface: a point on the trail is sitting inside the light
 *   source, and light reaches it from the sides and from below — off the
 *   glowing air along every shallow downward sightline — as well as from
 *   above. That is the physical reason fog is shadowless, and the reason a
 *   forest floor in fog does not go black. Modelled as a hemisphere light with
 *   a duff-reflectance ground colour, the up-to-down ratio comes out around
 *   ten to one and the floor renders at a twelfth of the value a camera
 *   records. Modelled as a full sphere of glowing air it comes out nearer
 *   three to one, which is what the reference photographs show.
 *
 *   There is still a gradient, and it is still the only shape information in
 *   the frame — upward-facing surfaces are brighter, because the air above is
 *   lit by the deck and the air below is looking at wet ground. It is just far
 *   weaker than a hemisphere light makes it, and every bit of remaining shape
 *   has to come from occlusion instead.
 *
 *   The air is brighter than anything solid in it. Illuminated fog at this
 *   density has a radiance well above the reflectance of wet bark, which is
 *   why every tree is a silhouette and why the frame's contrast runs from dark
 *   objects up to bright air rather than the other way round. If the trees are
 *   ever lighter than the fog behind them, something upstream is wrong.
 *
 * ── Colour ────────────────────────────────────────────────────────────────
 *
 * Fog scatters short wavelengths slightly more than long ones, but droplet fog
 * is nearly achromatic — droplets are large compared with visible wavelengths,
 * so it is Mie and not Rayleigh, and the classic "blue distance" of a clear-air
 * mountain haze is largely absent. What is present:
 *
 *   a cool cast overall, because the source is an overcast sky at about
 *   7000 K rather than a sun at 5500 K;
 *   a slight warm lift near the top of the fog layer, because the cloud deck
 *   is thinnest there and a little more of the sky's own light gets through;
 *   a green cast in the near field only, from light bouncing off the foliage,
 *   which is the one thing that keeps the scene from being monochrome.
 */
import * as THREE from 'three';

/* Radiance of the fog at saturation — the colour a distant tree converges on,
 * and therefore the brightest thing in the frame.
 *
 * Slightly above 1.0 because this is scene-linear radiance headed for a tone
 * curve, not a display value. Fog in a photograph clips towards white; fog in
 * a linear render has to be *given* enough radiance to be rolled off, or the
 * tone map lands it in the upper midtones and the result is the grey soup that
 * every underexposed fog render looks like. */
export const FOG_RADIANCE = new THREE.Color(0.470, 0.508, 0.545);

/* Above the canopy the deck is thinner and marginally warmer. Used by the
 * height term in the fog and by the sky light's upper colour. */
export const FOG_HIGH = new THREE.Color(0.585, 0.605, 0.615);

/* Down in the layer, where the fog is densest and least lit. Cooler and
 * darker; this is the colour the trail floor's air converges on. */
export const FOG_LOW = new THREE.Color(0.352, 0.392, 0.436);

/* What a surface sees looking straight down.
 *
 * Not the ground's reflectance. A downward sightline from anything standing on
 * the floor is a short path through glowing air onto wet duff, and the sum of
 * the two is about a sixth of the horizon rather than the twelfth that duff
 * reflectance alone would give. This single number is most of the difference
 * between a floor that renders at RGB 25 and one that renders at RGB 80, and
 * it is the term a hemisphere light has no way to express: its ground colour
 * multiplies the *whole* lower hemisphere uniformly, whereas the real thing is
 * dark straight down and nearly as bright as the horizon just below it.
 */
export const FOG_NADIR = new THREE.Color(0.082, 0.080, 0.074);

/* Fog density and the shape of the falloff, as the coefficients in
 * exp(-(d*k)^n).
 *
 * The visibility is the brief's and is exact. "Visibility" in meteorology is
 * the range at which a black object against the horizon falls to 2% contrast,
 * so whatever n is, k is fixed by (d_vis * k)^n = ln(50).
 *
 * ── n was 2 and is now 3.6, and this is the correction the fog forced ─────
 *
 * n = 2 is what three's FogExp2 computes and it was inherited without
 * argument. It survived only because the mix was happening in the wrong
 * colour space. `fog.ts` moved the mix from display values to scene radiance,
 * which is right — three includes `fog_fragment` after the tone map, and
 * mixing there understates the haze by about a factor of five over dark
 * subjects — and moving it exposed what n = 2 actually says: 4.7% airlight at
 * four metres, which under this exposure renders a black object at 72 out of
 * 255. Measured, not estimated. The near field went milky and the ground and
 * bark work, which is all inside ten metres, went with it.
 *
 * The reference photographs are unambiguous about this. In every one of them
 * the near trunks are within a few counts of black against near-white air,
 * the middle distance is a clean mid grey, and the transition between the two
 * happens over a short span rather than as a gradual wash. That is a
 * falloff much steeper than quadratic.
 *
 * There is a physical reading for it and it is worth having, because n is
 * otherwise a taste knob. Contrast in fog does not decay as exp(-sigma*d) at
 * short range: fog droplets are large compared with the wavelength and scatter
 * strongly forward, so light deflected out of the sightline over a short path
 * is largely scattered back into it, and the *image* survives much further
 * than single-scattering extinction predicts. The apparent extinction
 * approaches the true one only once the path is long enough for the small
 * angles to accumulate. A super-quadratic contrast law is the cheap
 * closed-form stand-in for that.
 *
 * 3.6 was chosen by sweeping it and reading two numbers off tools/fog.mjs, not
 * by eye. A black object then runs 2 / 13 / 42 / 78 / 109 / 155 / 189 at
 * 4 / 6 / 9 / 11 / 14 / 19 / 29 m, so the whole legible part of the transition
 * falls between six and twenty-two metres, which is the span the trail and the
 * near stand occupy.
 *
 * The other number is what the surfaces have left to say inside it. The tool's
 * `dev` column — beauty minus an all-black render, so purely the surface's own
 * contribution over the air — runs 45 / 38 / 25 / 15 / 8 at 4 / 6 / 9 / 11 / 14 m
 * here, against 44 / 41 / 32 / 20 / 12 at n = 4 and 43 / 31 / 18 / 11 / 6 at
 * n = 3.2. n = 4 keeps slightly more of the ground and bark work but puts
 * literally no air in the first six metres, which the brief's "dense" will not
 * carry; n = 3.2 costs a third of the mid-field texture to buy a veil at four
 * metres that measures six counts. 3.6 is where both are acceptable.
 *
 * `?fog=p2.0` overrides it for a sweep without a rebuild.
 */
export const FOG_VISIBILITY = 36;
export const FOG_FALLOFF = 3.6;
export const FOG_DENSITY = Math.log(50) ** (1 / FOG_FALLOFF) / FOG_VISIBILITY;

/* Scale height of the fog layer, metres.
 *
 * The brief asks for fog that is thicker near the ground and thinner above
 * head height, which is radiation fog: it forms by the ground cooling
 * overnight, so it is densest in the first couple of metres and has a distinct
 * top. A sightline above the eye should carry less optical depth than a level
 * one, enough that the trunk tops fade less than their bases and the eye reads
 * a *layer*.
 *
 * It was 9 m, and 9 m is shallower than the trees, which is what made it wrong.
 * The consequence only became visible once the canopy was dense enough to
 * measure: at a ninth of a neper per metre there is essentially no fog above
 * 25 m, so a crown 40 m out received almost no airlight and `up.png` came out
 * with luma *decreasing* with distance — nearest crowns at p50 = 90, far crowns
 * at 39 — while every other framing in the project correctly gets paler with
 * range. A frame that contradicts the fog everywhere else in the set is worse
 * than a frame with no fog in it.
 *
 * 22 m puts the layer top above the canopy rather than through the middle of
 * it, which is also the honest reading of the brief: under a closed stand the
 * air is well mixed to the canopy top because that is where the radiative
 * surface actually is, not the ground. Measured, it takes `up.png` from median
 * 57 to 87 and from 1.7% to 5.1% of pixels above luma 180 against a 4-7%
 * reference target, and it costs the eye-level framings 1.5 points of the same
 * statistic — 8.5% to 10.0% at stop 60, still inside the 7-13% reference band —
 * because a level sightline has almost no vertical extent for this term to act
 * on.
 */
export const FOG_SCALE_HEIGHT = 22.0;

/* Exposure into the tone curve.
 *
 * The previous value here, 0.86, came from an argument that a phone meter is
 * fooled by a large bright uniform field and lands the fog "a little under
 * middle grey, around 0.38-0.45 of full scale". That is wrong, and wrong in a
 * way that ruined every frame: it confuses the *scene* being metered down with
 * the *fog* being metered down. A phone metering a foggy trail does put the
 * average near middle grey, but the average of that frame is the dark floor and
 * the dark trunks, so the fog itself ends up high — 0.72-0.82 of full scale,
 * often clipping. Look at any handheld fog photograph: the air is nearly white.
 *
 * So this number is set by solving backwards through AgX. Landing the fog at
 * 190/255 display requires about 0.74 linear at the tone curve's input, and the
 * fog's scene radiance is 0.47, hence 1.57. What falls out of that is the whole
 * point: a surface of albedo 0.08 under this dome then lands at RGB 77 and one
 * of albedo 0.12 at RGB 94, which is exactly the band real foggy-forest floors
 * occupy. At 0.86 the same surfaces landed at 24 and 30 and the frame held
 * seven stops between the ground at arm's length and the air, which no camera
 * has ever recorded.
 */
export const EXPOSURE = 1.57;
