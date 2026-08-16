# The brief

This project was built from a single prompt, reproduced below verbatim. Nothing
in it was written after the fact.

Where the finished build departs from the brief, it is because the owner asked
for the change during the build. Those departures are listed at the bottom.

---

## Foggy Pine Trail — Gauntlet Prompt

I want you to build a first-person walkable foggy pine forest trail. Pacific
Northwest, early morning, dense fog. It should look like a real photograph taken
on a phone camera at 6AM on a misty trail in Oregon or Washington state. Not
stylized. Not low-poly. Not a game. A photograph.

The player walks forward slowly down a narrow dirt trail through dense pine
forest. No turns, no choices. Just a straight walk through fog and trees.

Do this in Three.js. Zero external assets. Every texture, every mesh, every
light, every sound must be generated procedurally in code. No downloaded images,
no HDRIs, no audio files.

### What the trail needs

**The trees:** tall straight pine trunks, dark bark texture with vertical crack
patterns, branches starting high up. Dense placement on both sides of the trail.
Vary the height, thickness, and slight lean of each tree. Some dead trees leaning
against others. Fallen logs across the forest floor. The trees are the walls of
this scene — they should feel like you're walking through a corridor of wood.

**The trail:** narrow dirt path, maybe 3 feet wide. Muddy brown with embedded
rocks and roots crossing it. Slight ruts from foot traffic. Pine needles
scattered everywhere. The trail should curve very gently so you can't see too far
ahead — the fog does the rest.

**The fog:** this is the hero of the entire scene. Dense volumetric fog that
limits visibility to maybe 30-40 meters. Trees in the distance fade into
white-gray nothingness. The fog should have layers — thicker near the ground,
slightly thinner above head height. Light diffuses through the fog creating a
soft even glow with no hard shadows. The fog is what makes this scene
photorealistic. If the fog looks real, everything looks real.

**The ground:** forest floor covered in pine needles, dead leaves, small ferns,
moss on rocks. Not flat — gentle undulation. Roots from nearby trees breaking
through the surface. A few small rocks and fallen branches scattered around.

**Vegetation:** ferns growing along the trail edges. Moss covering the base of
tree trunks and rocks. Some low bushes. A few mushrooms on fallen logs. The
undergrowth should be dense near the ground but open above waist height — you can
see through the trunks but not through the base.

**Lighting:**
- Soft diffused morning light filtering through fog — no direct sunlight, no hard shadows
- Everything lit by ambient sky light scattered through the fog
- Slightly warmer light where the fog is thinnest (above the canopy)
- Cool blue-gray tones in the deep fog
- Occasional subtle god rays where light barely breaks through the canopy and catches the fog
- The trail ahead should glow slightly brighter than the surrounding forest because it's more open to the sky

**Sound:**
- Birds in the distance (not constant, occasional calls)
- Soft wind through pine needles (the signature sound)
- Footsteps on dirt and pine needles as you walk
- A distant stream or water dripping
- Occasional crack of a branch in the forest (ambient, not scary)
- Complete absence of human-made sounds — that silence IS the sound design

**Atmosphere:**
- Dense fog everywhere — this is 80% of the photorealism
- Moisture in the air — everything looks slightly damp
- Pine needles and leaves occasionally drifting down slowly
- Subtle depth of field — things very close to camera slightly soft
- Film grain for that phone camera feel
- Muted color palette — dark greens, browns, grays, white fog. No bright colors anywhere
- The feeling of being completely alone in nature at dawn

### How to build this

Work on ONE system at a time in this exact order. Do NOT fan out multiple
sub-agents in parallel. Build each system sequentially:

1. Trail geometry — dirt path with rocks, roots, pine needles, gentle curve
2. Trees — tall pine trunks with bark texture, varied placement, dead trees, fallen logs
3. Fog — dense volumetric fog with layers, distance fade, visibility limit. THIS IS THE MOST IMPORTANT SYSTEM. Spend the most time here.
4. Ground cover — ferns, moss, undergrowth, mushrooms, forest floor debris
5. Lighting — soft diffused ambient, no hard shadows, subtle god rays through fog
6. Atmospheric particles — falling pine needles, floating dust/pollen catching the light
7. Sound design — procedural birds, wind through pines, footsteps, distant water
8. Post-processing — film grain, vignette, depth of field, muted color grading

For each system: build it, then spawn ONE separate sub-agent as a harsh visual
critic. The critic should compare the result against real photographs of foggy
Pacific Northwest forest trails (search "foggy pine trail oregon" or "misty
forest trail pacific northwest photography"). Rate whether it looks like a real
photo taken on a phone. If it doesn't, keep iterating before moving to the next
system. The critic must never be the same agent that built it. It should only see
the rendered output, not the code.

Loop on each system until the critic says it genuinely looks like a real foggy
forest photograph, not a render. Then move to the next system.

### The test

Screenshot the final result. Show it to someone without context. If they think
it's a photo before they realize it's a browser, you're done. If they immediately
think "3D render" or "game," keep going.

### Tech constraints

- Next.js App Router, React, TypeScript, Tailwind CSS, Three.js via React Three Fiber
- Zero external assets. Every texture is procedural (noise, patterns, gradients)
- Target 30+ FPS on a mid-range GPU (RTX 4060 level)
- First-person slow walk, no sprint, no jump
- Mouse look, WASD movement
- The walk is short — one forest trail section, maybe 30-45 seconds of walking

The single most important visual: FOG. Dense, layered, realistic fog that eats
the trees in the distance and diffuses all light into a soft glow. If the fog
looks real, the whole scene looks real. Everything else is secondary to the fog.

Don't stop until walking this trail feels like watching a GoPro video from
someone's morning hike in Olympic National Park.

### Reference and inspiration

Previous projects that set the quality bar:
- `jungle-trail` (photorealistic jungle — THIS IS YOUR PRIMARY REFERENCE. Study how it built dense vegetation, ground cover, and atmosphere. The foggy pine trail is the same formula in a different biome.)
- `night-street` (golden hour city street — study the lighting and atmosphere systems)

Study these for procedural geometry, vegetation, lighting, fog, post-processing,
and performance patterns. The jungle trail project is the direct ancestor of this
build. Same formula, different biome. Copy its architecture, adapt its vegetation
system for pines instead of tropical plants, and replace its canopy light with
fog diffusion.

---

## Where the build departs from the brief

Each of these was requested by the owner during the build, and each is a
deliberate override rather than a miss.

**Free roam.** The brief says "no turns, no choices". The walker was on rails
within a metre of the centreline for most of the build; it now permits about 30 m
of wandering into the stand, with a hard backstop at 35 m and trunk collision
throughout. The corridor composition the brief describes is still what the scene
is designed and judged around.

**A jump.** The brief says "no sprint, no jump". Space gives a 0.42 m hop over
0.575 s under real gravity — a standing hop in boots, deliberately not a
game-feel jump, because low gravity is the fastest way to break a photographic
read.

**No film grain.** The brief asks for it. It was built, measured against real
photographs, and then switched off on request. The constants are zeroed rather
than deleted and the tuned values are recorded at the site, so it is three
numbers to restore.

**No vignette.** Same story. It was also the term the project's critic could not
measure reliably — corner-minus-centre came out sign-inconsistent across
framings, because whichever trunk occupied a corner dominated the result.

**No volumetric raymarch.** The brief's phrase "volumetric fog" suggests one. The
critic judged, from the pixels, that a march would buy only lateral density
patchiness — sixth on its defect list — since the scene has no sun and therefore
no light shafts. That patchiness was obtained instead by modulating the existing
fog with 3D noise, for a fraction of the cost. The fog is a shader-chunk model
with a genuine height integral, not a raymarch.

**Parallel sub-agents, twice.** The brief says not to fan out. Sound design was
built alongside the visual systems, and later the undergrowth alongside a tree
fix, both under strict file ownership. Every visual system that had to be judged
against the one before it was still built strictly in order.
