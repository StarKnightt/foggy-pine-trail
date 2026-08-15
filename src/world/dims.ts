/* Every dimension in the scene, in metres, in one place.
 *
 * The brief is specific about scale in a way that matters more here than it
 * would in an open landscape: a trail "maybe 3 feet wide" walled by trees is a
 * corridor, and a corridor reads wrong the moment any one of its dimensions
 * drifts. If the trail is four metres wide it is a fire road; if the trees
 * start branching at three metres it is a Christmas tree farm. Both failures
 * are invisible in isolation and obvious in the frame.
 *
 * So the numbers are here and they are sourced. Anything that needs one imports
 * it rather than typing it, which is the only thing that has ever kept a set of
 * constants like this consistent across eight systems.
 */
export const DIMS = {
  /* ── The walk ─────────────────────────────────────────────────────────── */

  /* 1.62 m is the eye height of an adult of average height. Worth stating
   * because it is the single number the viewer calibrates everything else
   * against: fern height, log diameter and how far up a trunk the first branch
   * sits are all read relative to it without anyone noticing they are doing
   * it. */
  eyeHeight: 1.62,

  /* A hiker's unhurried pace on a soft trail. The brief asks for a slow walk
   * and 1.15 m/s is the low end of a normal one — slow enough that the fog has
   * time to hand over trees at the rate the depth cue wants, fast enough that
   * nobody reads it as slow motion. */
  walkSpeed: 1.15,

  /* Trail length. At 1.15 m/s this is ~42 s end to end, inside the brief's
   * 30-45 s. */
  trailLength: 48,

  /* ── The trail ────────────────────────────────────────────────────────── */

  /* Three feet, as the brief says — and the cross-section that gets you there
   * matters as much as the number.
   *
   * A boot-worn trail is a *bench*, not a channel: a level base you can put a
   * foot down flat on, then a short steep rise into the undisturbed duff. So
   * the width is spent as `trailFlat` of level base plus `trailBank` of climb,
   * and `trailHalf` is their sum. 54 cm of flat and 86 cm of tread overall,
   * which measures out at three feet in the frame.
   *
   * The previous shape here was a single 1.24 m cosine trough with a 1.4 m berm
   * over it, giving 2.8 m of visibly disturbed ground — from eye height that
   * read as a two-metre drainage ditch and dragged the apparent scale of
   * everything else with it, because a viewer calibrates pebbles and roots
   * against the trail rather than the other way round. */
  trailFlat: 0.27,
  trailBank: 0.16,
  trailHalf: 0.43,
  trailEdge: 0.56,

  /* How far the tread is cut into the *mineral soil* below the duff — the height
   * of the bank at each edge, not a depth at the centre, now that the base is
   * level. Getting this to zero is the single thing that makes a path read as a
   * texture painted on flat ground rather than as a path.
   *
   * 45 mm rather than the 85 mm that shipped, because this is not the whole
   * step. Scraping the litter mat off contributes its own 3-5 cm, so the two
   * were compounding: `crossSection()` measured 18-23 cm of relief at every
   * station off a nominal 85 mm. A duff trail is mostly mat removal with a
   * shallow cut underneath, so the budget belongs in that order. Total relief
   * from tread centre to undisturbed floor now measures under 12 cm. */
  trailDepth: 0.045,

  /* Dish across the level base. A bench is not perfectly flat — it holds water
   * in the middle — but 20 mm across 54 cm is a 4% cross-slope and that is the
   * whole budget. Any more and the V comes back. Together with the ruts this
   * measures 2.5-3.5 cm of relief across the base, which is the range a real
   * bench holds. */
  trailDish: 0.020,

  /* ── The forest ───────────────────────────────────────────────────────── */

  /* Half-width of the strip of world that gets built at all. Past this the fog
   * is total, so there is nothing to see and no reason to pay for it. */
  worldHalf: 44,

  /* How far behind and ahead of the walk the world extends. The walk starts at
   * z = 0 and runs to -trailLength. */
  zMin: -68,
  zMax: 16,
} as const;

export type Dims = typeof DIMS;
