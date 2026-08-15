/* System 7 — when things happen.
 *
 * Kept separate from both the generators and the graph, and pure, for one
 * reason: the offline renderer in tools/audio.mjs has to produce the same walk
 * the browser does. A scheduler living inside the engine could only be checked
 * by listening to a live session, and "is this forest too busy" is exactly the
 * kind of question that wants a count rather than an opinion.
 *
 * Every wait here is exponential. A uniform jitter around a mean still has a
 * mean the ear finds inside a minute, and the whole point of this scene is
 * that the listener can never tell whether anything is about to happen.
 */
import { type Rng, TAU, makeRng, rrange, expRand } from './dsp';
import { BIRDS, BIRD_NAMES, BIRD_BUS, WATER, CRACK, type BirdName } from './design';

/** Where an event is, relative to the listener, in metres and radians. */
export type Placement = {
  /** Bearing, 0 dead ahead, increasing to the right. */
  az: number;
  dist: number;
  elev: number;
};

export type BirdEvent = Placement & {
  time: number;
  species: BirdName;
  variant: number;
  gainDb: number;
  /** Small playback-rate jitter, so the same variant never lands twice at the
   *  same pitch even when the bout repeats it. */
  rate: number;
};

const range2 = (rng: Rng, r: readonly [number, number]): number => rrange(rng, r[0], r[1]);

/**
 * Bird calls, thought about in bouts rather than in calls.
 *
 * Real birds repeat locally and are silent globally: a bird calls a few times
 * from one perch with irregular gaps, then says nothing for minutes. A per-call
 * timer, however well jittered, gets both halves of that wrong — it produces a
 * forest with a constant low chatter, which is a summer afternoon and not a
 * winter dawn.
 *
 * One position per bout, drawn when the bout starts. A bird that teleports
 * between its own calls is more jarring than any synthesis flaw in the calls
 * themselves.
 *
 * `densityScale` below 1 compresses the quiets. Nothing in the scene uses it;
 * the offline renderer does, so a sixty-second WAV can demonstrate all four
 * species without waiting out ten minutes of correct silence.
 */
export function makeBirdScheduler(seed: number, densityScale = 1): { next(): BirdEvent } {
  const rng = makeRng(seed);
  type S = { name: BirdName; tNext: number; boutLeft: number; az: number; dist: number; elev: number };

  /* One species is planted early and the rest start on a full exponential.
   * Without this, better than half of all forty-five-second walks contain no
   * bird at all, and past a certain point silence stops being read as sparse
   * and starts being read as a broken audio system. */
  const planted = Math.floor(rng() * BIRD_NAMES.length);
  const state: S[] = BIRD_NAMES.map((name, i) => ({
    name,
    tNext: i === planted
      ? range2(rng, BIRD_BUS.firstAt)
      : expRand(rng, BIRDS[name].meanQuiet * densityScale),
    boutLeft: 0, az: 0, dist: 0, elev: 0,
  }));

  return {
    next(): BirdEvent {
      let s = state[0];
      for (const c of state) if (c.tNext < s.tNext) s = c;
      const sp = BIRDS[s.name];

      if (s.boutLeft <= 0) {
        s.boutLeft = sp.bout[0] + Math.floor(rng() * (sp.bout[1] - sp.bout[0] + 1));
        s.az = rng() * TAU;
        s.dist = range2(rng, sp.dist);
        s.elev = range2(rng, sp.elev);
      }

      const ev: BirdEvent = {
        time: s.tNext,
        species: s.name,
        variant: Math.floor(rng() * sp.variants),
        az: s.az, dist: s.dist, elev: s.elev,
        gainDb: sp.gainDb + rrange(rng, -2.5, 0),
        rate: rrange(rng, 0.965, 1.035),
      };
      s.boutLeft--;
      s.tNext += s.boutLeft > 0
        ? range2(rng, sp.gap)
        : expRand(rng, sp.meanQuiet * densityScale);
      return ev;
    },
  };
}

export type DripEvent = Placement & { time: number; site: number; variant: number; gainDb: number; rate: number };

/**
 * Condensation dripping off the needles, from a small number of fixed points.
 *
 * Sites rather than one global process, because that is what produces
 * clustering: a needle tip that has just shed a drop is not going to shed
 * another for a while, but a different tip might at any moment. Three
 * independent exponentials interleave into something that has runs and gaps in
 * it, where one process at three times the rate would sound metronomic.
 *
 * The sites move with the listener. They are meant to be "the branches just
 * above and beside you", and those change as you walk; nailing them to world
 * coordinates would make the walker pass through a small permanent rain shower
 * and then leave it behind.
 */
export function makeDripScheduler(seed: number): { next(): DripEvent } {
  const rng = makeRng(seed);
  const sites = Array.from({ length: WATER.dripSites }, () => ({
    tNext: expRand(rng, WATER.dripMeanSec) * 0.5,
    az: rng() * TAU,
    dist: range2(rng, WATER.dripDist),
    elev: range2(rng, WATER.dripElev),
  }));

  return {
    next(): DripEvent {
      let k = 0;
      for (let i = 1; i < sites.length; i++) if (sites[i].tNext < sites[k].tNext) k = i;
      const s = sites[k];
      const ev: DripEvent = {
        time: s.tNext, site: k,
        variant: Math.floor(rng() * WATER.dripVariants),
        az: s.az, dist: s.dist, elev: s.elev,
        gainDb: rrange(rng, -7, 0),
        rate: rrange(rng, 0.88, 1.14),
      };
      s.tNext += expRand(rng, WATER.dripMeanSec);
      /* The site drifts a little between drops. A branch overhead is a region,
       * not a point, and a drip that returns to exactly the same azimuth four
       * times is a speaker rather than a forest. */
      s.az += rrange(rng, -0.5, 0.5);
      s.dist = Math.max(WATER.dripDist[0], Math.min(WATER.dripDist[1], s.dist + rrange(rng, -0.6, 0.6)));
      return ev;
    },
  };
}

export type CrackEvent = Placement & { time: number; variant: number; gainDb: number; rate: number };

/** A limb letting go. Most walks get none; that is the intended frequency. */
export function makeCrackScheduler(seed: number, densityScale = 1): { next(): CrackEvent } {
  const rng = makeRng(seed);
  let t = range2(rng, CRACK.firstAt) * densityScale;
  return {
    next(): CrackEvent {
      const ev: CrackEvent = {
        time: t,
        variant: Math.floor(rng() * CRACK.variants),
        az: rng() * TAU,
        dist: range2(rng, CRACK.dist),
        elev: range2(rng, CRACK.elev),
        gainDb: rrange(rng, -4, 0),
        rate: rrange(rng, 0.9, 1.1),
      };
      t += expRand(rng, CRACK.meanQuiet * densityScale);
      return ev;
    },
  };
}
