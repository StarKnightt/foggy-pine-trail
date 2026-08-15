/* System 7 — every number, and why it is that number.
 *
 * voices.ts knows how to make sounds and engine.ts knows how to wire them up;
 * neither invents a level, a frequency or an interval. They all live here, so
 * the offline tool measures the same constants the browser plays and a change
 * to the mix is one edit rather than three.
 *
 * The scene this serves is a foggy Pacific Northwest conifer trail at six in
 * the morning. Three facts about that dominate everything below.
 *
 *   Dawn is quiet. The brief says the absence of human sound *is* the design,
 *   and the corollary is that the absence of most natural sound is too. Every
 *   event schedule here has a mean gap measured in minutes, not seconds.
 *
 *   Fog and a saturated forest floor absorb. Excess attenuation through dense
 *   conifer foliage runs 0.1-0.3 dB/m at 4 kHz before ground absorption is
 *   counted, against roughly 0.02 dB/m for clear dry air. Anything distant is
 *   therefore not merely quieter but markedly duller, and reverberation tails
 *   are short. That is `fogCutoffHz` and the RT60s in `IR`, and it is the cue
 *   that makes the scene sound close and intimate instead of open.
 *
 *   Conifer needles do not rustle, they hiss. A broadleaf canopy makes
 *   impulsive clatter with a spectrum peaking around 1 kHz; a needle canopy
 *   makes a smooth, sibilant, continuous noise with far more energy above
 *   3 kHz and no clatter in it at all. `WIND` is built entirely around that
 *   difference, and tools/audio.mjs asserts the spectral centroid that proves
 *   it.
 */

/* Per-buffer sample rates.
 *
 * Deliberately not one global rate. An AudioBuffer carries its own rate and
 * the context resamples on playback, so a band whose content stops at 1.2 kHz
 * has no business being stored at 44.1 kHz — that is four megabytes of
 * arithmetic and memory spent on empty spectrum. The rule applied here is the
 * lowest rate whose Nyquist clears the band's top corner by an octave, so the
 * design filters land where they were asked for rather than where bilinear
 * warping puts them near Nyquist.
 */
export const SR = {
  bough: 8000,
  needle: 16000,
  sibilance: 32000,
  near: 32000,
  stream: 16000,
  drip: 32000,
  /* 32 kHz, not 44.1. A Pacific wren's song tops out under 8 kHz and every
   * other voice here is lower, so the extra 12 kHz of Nyquist is 1.2 MB of
   * empty spectrum — the wren alone was the single largest thing in the bank
   * at the higher rate. */
  bird: 32000,
  step: 24000,
  crack: 24000,
  /* Offline only. Every rate above is a real playback rate — an
   * AudioBufferSourceNode resamples whatever it is handed — but ConvolverNode
   * is specified to reject a buffer whose rate differs from the context's, so
   * the engine renders the IR at ctx.sampleRate instead. `forestIR` derives its
   * delays and filters from the rate it is given, so this is a rate for
   * tools/audio.mjs to measure at, not a property of the response. */
  ir: 24000,
} as const;

/**
 * How much of a frame the bake may take.
 *
 * The bank is about nine megabytes of straight-line arithmetic and it is baked
 * on the click that also takes pointer lock — the worst possible moment for a
 * long frame. Every stage is queued and one runs per frame, and the three
 * generators big enough to blow a frame on their own yield at chunk boundaries
 * so the engine can stop partway.
 *
 * 4 ms against a 30 fps budget of 33 leaves the scene the great majority of the
 * frame. The whole bank then takes about a second and a half of walking to
 * arrive, in an order chosen so that what is missing is always the least
 * missed thing.
 */
export const BAKE = {
  budgetMs: 4,
  /** Samples between yields. A power of two so the test is a mask, small enough
   *  that one chunk of the densest bed is a fraction of the budget, large
   *  enough that the generator machinery is not the cost. */
  chunk: 4096,
} as const;

/** One seed for the whole bank; every layer derives from it by a fixed offset. */
export const SEED = 0x9f0661;

/* ── 1. Wind through pine needles — the hero ─────────────────────────────── */

/**
 * Loop lengths, and the lengths are the point.
 *
 * 13.31, 11.17, 8.93 and 12.79 seconds share no useful common factor, so the
 * four beds do not return to the same relative phase for hours. A walk is
 * forty-odd seconds; the requirement is only that nothing re-aligns inside it,
 * and this clears that by four orders of magnitude. Each is also read from two
 * different offsets for the two channels, which decorrelates left from right
 * without a second buffer.
 *
 * They are not round numbers for the same reason: 12 and 8 would beat at 24 s,
 * which is inside a walk.
 */
export const WIND = {
  /** The bough band: air moving over branches and the crown as a mass. Always
   *  present, even in the lulls, because a forest is never acoustically still. */
  boughSec: 13.31,
  boughHz: 620,
  boughQ: 0.42,

  /** The needle band proper. This is the body of the signature sound. */
  needleSec: 11.17,
  needleHz: 2350,
  needleQ: 0.40,

  /** Fine sibilance. Only a real gust reaches this, which is what gives the
   *  surge its shape: a gust does not just get louder, it gets brighter. */
  sibilanceSec: 8.93,
  sibilanceLoHz: 4200,
  sibilanceHiHz: 11500,

  /** Understory within a few metres — salal, huckleberry, hemlock saplings.
   *  Undamped by distance, so this is the brightest thing in the mix and the
   *  layer that makes the fog reading work: near is crisp, overhead is dull. */
  nearSec: 12.79,
  nearLoHz: 1600,
  nearHiHz: 9000,

  /**
   * Vortex shedding, and the reason this does not sound like a noise generator.
   *
   * A needle is a cylinder about a millimetre across, and flow past a cylinder
   * sheds vortices at f = St·U/d with a Strouhal number near 0.2 — 400 Hz at
   * 2 m/s, 1.6 kHz at 8. A whole crown has millions of needles at every
   * diameter and every local velocity, so this never becomes a tone; what it
   * becomes is a spectrum with faint structure in it rather than a perfectly
   * smooth one. Six narrow peaks scattered through the needle band reproduce
   * that. Removing them leaves something that measures identically on octave
   * bands and is instantly recognisable as filtered noise.
   */
  aeolian: { count: 6, loHz: 900, hiHz: 5200, q: 5.5, db: 4.5 },

  /**
   * Slow spatial fluctuation baked into each band, in hertz and depth.
   *
   * Every patch of the canopy sees a slightly different, slowly varying
   * velocity, so at the ear a steady wind still breathes at a few hertz. Each
   * band gets its own modulator channel on purpose: if the bands pump together
   * the whole layer reads as one filter with an LFO on it, and the illusion of
   * a volume of needles collapses.
   *
   * Two rates rather than one, because a single rate is an LFO no matter how
   * slow it is. The depth is what the measurement is on: a bed whose 100 ms
   * envelope varies by under 3 dB has no breathing left in it and is tape hiss,
   * which is exactly what the first version of this measured at (1.0-2.1 dB).
   *
   * This is emphatically *not* the ~40 Hz grain gating used for broadleaf
   * rustle. Gating at that rate produces discrete dry collisions, which is
   * what a maple does and what a fir does not.
   */
  breatheHz: 1.9,
  breatheHz2: 5.3,
  breatheDepth: 0.42,

  /** Seconds the right channel lags the left. A gust crosses a canopy at
   *  roughly the wind speed; 0.45 s is a few metres of crown, and it is what
   *  turns "both ears get louder" into "something passed overhead". */
  lagSec: 0.45,
  /** And the understory, which is closer, so the crossing is quicker. */
  nearLagSec: 0.22,

  /**
   * Buffer levels before the runtime gust gain, dBFS RMS.
   *
   * These are not four equal beds with a filter on each; the spread between
   * them is where the signature lives. Nine decibels of separation between the
   * bough band and the needle band is what puts the layer's measured spectral
   * centroid at 3.4 kHz instead of the 1.0 kHz the first balance produced —
   * and 1.0 kHz is a broadleaf wood, which is the one thing this must not be.
   */
  boughDb: -27,
  needleDb: -18,
  sibilanceDb: -16,
  nearDb: -17,

  busDb: 0,
} as const;

/**
 * Gust strength at time t, 0..1. Shared verbatim by the engine and the tool.
 *
 * Three incommensurate rates. The 74-second term is weather — whether the next
 * minute has any wind in it at all. The 21-second term is the gust itself, and
 * it is the one the brief's "building and dying over 10-30 seconds" is asking
 * for. The 8.3-second term stops the gust from being a smooth hump, which no
 * real one is.
 *
 * The final power curve is what makes it a dawn rather than an afternoon. A
 * raw sum of smooth noise spends most of its time near the middle; raising it
 * to 1.45 pushes the distribution down so the layer is *usually* in a lull and
 * occasionally surges, which is the asymmetry the ear reads as calm weather.
 */
export function gustEnvelope(g: (t: number, k?: number) => number, t: number): number {
  const v = 0.30 * g(t / 74, 11) + 0.44 * g(t / 21, 12) + 0.26 * g(t / 8.3, 13);
  const x = v * 0.5 + 0.5;
  return Math.pow(x < 0 ? 0 : x > 1 ? 1 : x, 1.45);
}

/**
 * How the four wind beds balance against gust strength.
 *
 * The shape of this function is the whole difference between wind and a fader.
 * Aerodynamic surface noise grows roughly as U^6 in power, and its spectrum
 * shifts upward in proportion to U, so a stronger gust is disproportionately
 * *brighter* as well as louder. The exponents below encode that: the bough
 * band is nearly constant, the needle band grows, and sibilance is thresholded
 * so it only exists once the wind is genuinely moving.
 *
 * The understory is thresholded hardest. Small stiff shrubs a metre off the
 * ground sit in the canopy's wind shadow and do not move at all until a gust
 * reaches the floor, which is why a forest gust arrives overhead first and
 * then, a beat later, beside you.
 */
export function windBalance(g: number): { bough: number; needle: number; sibilance: number; near: number } {
  const s = (e0: number, e1: number, x: number): number => {
    const t = x < e0 ? 0 : x > e1 ? 1 : (x - e0) / (e1 - e0);
    return t * t * (3 - 2 * t);
  };
  return {
    bough: 0.32 + 0.50 * g,
    needle: 0.34 + 0.66 * Math.pow(s(0.05, 0.85, g), 1.15),
    sibilance: 0.10 + 0.90 * Math.pow(s(0.10, 0.88, g), 1.5),
    near: Math.pow(s(0.20, 0.95, g), 1.5),
  };
}

/* ── 2. Distance, fog and air ────────────────────────────────────────────── */

/**
 * The corner of the per-source distance lowpass, in hertz. One second-order
 * section — twelve decibels an octave — and the curve is fitted to that slope,
 * not chosen for it.
 *
 * This is the single function that makes distance sound like distance rather
 * than like a volume knob, and here it is doing double duty as the fog.
 *
 * The physical quantity being modelled is excess attenuation: everything lost
 * on the way that is not the inverse-distance spreading the panner already
 * applies. Clear dry air costs about 0.02 dB/m at 4 kHz. Dense saturated
 * conifer foliage with fog in it runs an order of magnitude higher, and 0.35
 * dB/m at 4 kHz is the figure this is fitted to — the top of the published
 * range for dense evergreen stands, which is what a fog-soaked old-growth
 * corridor is.
 *
 * Fitting that to a Butterworth pair gives corners of roughly 5.6 kHz at five
 * metres and 800 Hz at ninety, which is the exponential below. The first
 * attempt used a 14 m scale length, and it was wrong by a wide margin: it put
 * a varied thrush at forty metres forty-eight decibels down in its own
 * passband, which is not distance, it is a closed door. Distance has to remove
 * the top of a sound while leaving the sound.
 *
 * The 6 kHz ceiling matters as much as the slope. Even a source at arm's
 * length is heard through saturated air, so no *event* in this scene is ever
 * fully open at the top — while the near understory wind, which is not a point
 * source and does not go through this, reaches 9 kHz. That difference between
 * the two is the fog, expressed as the only thing a listener can detect it by.
 */
export function fogCutoffHz(d: number): number {
  const v = 6000 * Math.exp(-d / 48);
  return v < 600 ? 600 : v > 6000 ? 6000 : v;
}

export const PANNER = {
  distanceModel: 'inverse' as const,
  refDistance: 2.5,
  rolloffFactor: 1.25,
  maxDistance: 200,
  panningModel: 'equalpower' as const,
  /** Retuning a corner that tracks walking pace sixty times a second is waste. */
  filterEveryFrames: 6,
  filterGlide: 0.10,
} as const;

/* ── 3. Birds ────────────────────────────────────────────────────────────── */

/**
 * Four voices of a wet Pacific conifer forest at first light, and the schedule
 * is more important than any of them.
 *
 * `meanQuiet` is the mean of an exponential wait in seconds. These are minutes
 * long, and they are supposed to be: the walk is forty-five seconds and the
 * expected number of bird events in it is under two. A listener who walks the
 * trail twice and hears different birds, or none, has had the intended
 * experience. Filling the space would be the failure.
 *
 * `firstAt` breaks that rule exactly once. An unseeded exponential schedule
 * leaves a bit over half of all walks with no bird at all, and a scene that
 * silent stops reading as sparse and starts reading as broken. One bird is
 * planted in the first twenty seconds and the process is memoryless from there.
 *
 * `dist` is in metres and does most of the characterisation, because
 * fogCutoffHz above turns it into timbre. The raven is at ninety metres not to
 * make it quiet but to make it dull.
 *
 * `gainDb` is a *source* level referred to the panner's 2.5 m reference
 * distance, not a mix fader, and that is why several of them are large and
 * positive. A raven two and a half metres away is one of the loudest animals
 * in the forest; the +12 dB below is the price of it still being audible after
 * ninety metres of inverse-square and 0.35 dB/m of wet needles. These four
 * numbers were solved backwards from the measured "as heard" levels in
 * tools/audio.mjs section 4 rather than dialled by ear, which is the only way
 * to set them when nobody involved can hear the result.
 */
export const BIRDS = {
  wren: {
    /* Pacific wren: five to eight seconds of rapid bubbling trills and buzzes,
     * the loudest bird per gram in the forest. One song per bout — it is long
     * enough to be an event by itself. */
    variants: 2, meanQuiet: 200, bout: [1, 2] as const, gap: [7, 16] as const,
    dist: [11, 26] as const, elev: [1.2, 3.0] as const, gainDb: 5,
  },
  thrush: {
    /* Varied thrush: one long buzzy whistle on a single pitch, then a long
     * pause, then another at a different pitch. The most characteristic sound
     * of this forest type and the one worth getting right. Four variants
     * because the pitch changes between notes and playback-rate shifting a
     * 1.4-second note far enough to hear also shortens it audibly. */
    variants: 4, meanQuiet: 125, bout: [2, 4] as const, gap: [5.5, 13] as const,
    dist: [26, 58] as const, elev: [6, 15] as const, gainDb: 6,
  },
  chickadee: {
    /* Chestnut-backed chickadee: hoarse and quick, and the only one that ever
     * sounds close. Working the understory, so low and near. */
    variants: 3, meanQuiet: 110, bout: [2, 5] as const, gap: [1.4, 3.8] as const,
    dist: [7, 20] as const, elev: [1.5, 6] as const, gainDb: 3,
  },
  raven: {
    /* Common raven, and it is a long way off. Rendered with its full harmonic
     * stack and then handed to fogCutoffHz at ninety metres, which is what
     * turns a harsh croak into the hollow distant note this scene wants. */
    variants: 2, meanQuiet: 320, bout: [1, 3] as const, gap: [0.55, 1.15] as const,
    dist: [70, 120] as const, elev: [10, 22] as const, gainDb: 12,
  },
} as const;

export type BirdName = keyof typeof BIRDS;
export const BIRD_NAMES = ['wren', 'thrush', 'chickadee', 'raven'] as const;

export const BIRD_BUS = { busDb: -8, sendDb: -9, firstAt: [8, 20] as const } as const;

/* ── 4. Footsteps ────────────────────────────────────────────────────────── */

/**
 * Two surfaces, because a walker on a boot-worn trail is never on one of them.
 * The tread is compacted mineral soil, damp at dawn; six inches either side is
 * needle duff several years deep. A foot placed anywhere near the edge gets
 * some of each.
 *
 * These are not one sound filtered two ways. Duff is a soft compression with a
 * dense crackle cluster of needle and twig fracture over the top; damp dirt is
 * a lower, duller thud with almost no fracture and a short grit scuff as the
 * sole rolls. Crossfading them by `surface` gives the intermediate placements,
 * which is what the runtime does.
 */
export const STEPS = {
  variants: 6,
  seconds: 0.34,
  /** Peak level per event, dBFS. Loud relative to the beds: these are at the
   *  listener's own feet and are the only near-field sound in the scene. */
  peakDb: -8,
  busDb: -13,
  /** Small, because fog and duff between them leave a footstep almost no tail.
   *  A step with an audible room on it would undo the whole fog reading. */
  sendDb: -19,
  /** Playback-rate jitter. Two steps a second is the fastest repetition in the
   *  scene and the one where a repeated buffer is most obvious. */
  rate: [0.93, 1.07] as const,
  /** Per-foot level trim: nobody's gait is symmetric, and a perfectly even one
   *  is audible as a machine within a dozen steps. */
  footDb: [0, -1.4] as const,
} as const;

/**
 * Which surface a footfall lands on, 0 = damp dirt tread, 1 = needle duff.
 *
 * Driven by smooth noise over step count rather than over time, so it does not
 * drift while the walker is standing still. The bias toward the middle is
 * deliberate: most steps on a narrow trail catch a bit of both, and pure duff
 * only happens when the walker has genuinely wandered off the tread.
 */
export function stepSurface(g: (t: number, k?: number) => number, stepIndex: number): number {
  const v = 0.5 + 0.55 * g(stepIndex / 6.3, 21) + 0.20 * g(stepIndex / 2.1, 22);
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/* ── 5. Water ────────────────────────────────────────────────────────────── */

/**
 * A stream somewhere off the trail, and condensation dripping off the needles.
 *
 * The stream is placed in the world rather than following the listener, so it
 * grows and fades across the walk the way a real one beside a trail does. At
 * these distances through this fog it has no chirps or babble left in it at
 * all — those are near-field detail that thirty metres of wet forest removes
 * completely — so it is a filtered wash and nothing else. Adding babble to a
 * distant stream is the standard way to make it sound like a small one nearby.
 *
 * The drips are the opposite: near-field, discrete, resonant, and the most
 * specifically-this-place sound available. Fog condensing on needles and
 * falling on litter is what a Pacific conifer forest does all morning. They
 * come from three fixed points near the trail, each on its own long
 * exponential, so drips cluster the way real ones do instead of arriving on a
 * timer.
 */
export const WATER = {
  streamSec: 14.63,
  streamLoHz: 170,
  streamHiHz: 2100,
  streamDb: -14,
  /** World position of the stream, metres. The walk runs from z = 0 to z = -48
   *  along the trail, so this sits a little past halfway and well off to the
   *  west — closest approach about 19 m, which through fogCutoffHz is 2.3 kHz
   *  of corner: audible, placed, and unmistakably far away. */
  streamAt: [-18, 0.4, -27] as const,
  streamBusDb: -4,

  dripVariants: 5,
  dripSeconds: 0.26,
  dripPeakDb: -11,
  dripBusDb: -10,
  dripSendDb: -14,
  /** Three sites, each waiting this long on average between drips. Together
   *  that is a drip every seven or eight seconds — frequent enough to be a
   *  texture, sparse enough that each one is a separate small event. */
  dripSites: 3,
  dripMeanSec: 22,
  dripDist: [1.4, 5.5] as const,
  dripElev: [0.05, 0.4] as const,
} as const;

/* ── 6. Branch cracks ────────────────────────────────────────────────────── */

/**
 * A limb letting go somewhere out in the trees. Rare, distant, and explicitly
 * not a scare: the reverb send is generous and the distance filter is doing
 * most of the work, so what arrives is a soft woody knock with a tail rather
 * than a snap.
 *
 * A mean of a hundred and ten seconds means most walks get none and some get
 * one. That is the correct frequency for this event; anything more often turns
 * the forest into a haunted house.
 */
export const CRACK = {
  variants: 3,
  seconds: 0.62,
  peakDb: -7,
  busDb: 4,
  sendDb: -4,
  meanQuiet: 110,
  firstAt: [30, 90] as const,
  dist: [22, 55] as const,
  elev: [2, 9] as const,
} as const;

/* ── 7. The room ─────────────────────────────────────────────────────────── */

/**
 * The impulse response, and it is short on purpose.
 *
 * A dense wet conifer stand in fog is close to an anechoic chamber made of
 * plants. Trunks give a handful of real early reflections within the first
 * fifty milliseconds, and then the energy is gone: needles are an excellent
 * broadband absorber, saturated duff reflects almost nothing, and fog droplets
 * scatter what is left. There is no late field worth the name.
 *
 * So the RT60s are short and steeply frequency-dependent — 0.52 s at the
 * bottom, 0.14 s at the top. Highs vanishing four times faster than lows is
 * what a listener reads as "damp", and getting it wrong in the other direction
 * is the single most common way a forest ambience ends up sounding like a
 * cathedral with birds in it.
 */
export const IR = {
  seconds: 0.62,
  /** Trunks close enough to return a first reflection, in metres. The trail is
   *  a corridor about three feet wide walled by stems, so these are near. */
  earlyDistances: [2.6, 3.9, 5.4, 7.1, 9.8, 13.5] as const,
  rtLowSec: 0.52,
  rtMidSec: 0.30,
  rtHighSec: 0.14,
  /** Corners of the three decay bands. */
  crossLoHz: 320,
  crossHiHz: 2400,
  energyDb: -6,
  returnDb: -10,
} as const;

/* ── Master ──────────────────────────────────────────────────────────────── */

export const MASTER = {
  gainDb: -4,
  fadeInSec: 2.4,
  /* Rumble hygiene rather than voicing. Nothing in this scene has any business
   * below 35 Hz — the lowest intentional content is a footfall thump near 55 —
   * and several sources here are lowpassed noise, which passes DC along with
   * everything else. Summed across eight wind sources that is a measurable
   * offset eating headroom for nothing. */
  highpassHz: 35,
  limiter: {
    thresholdDb: -6,
    knee: 6,
    ratio: 12,
    attack: 0.004,
    release: 0.18,
  },
} as const;

/** Ceiling every one-shot buffer is held under, so summed events cannot clip. */
export const PEAK_DB = -1.5;
