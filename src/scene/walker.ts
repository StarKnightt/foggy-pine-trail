/* First-person walker.
 *
 * A person walking a soft trail at 1.15 m/s and looking around. No jump, no
 * sprint — the brief rules both out, and it is right to: the fog is calibrated
 * against the rate at which a walking pace hands over trees, and a run
 * arrives at them faster than the depth cue can resolve.
 *
 * Three things here need care and the rest is bookkeeping.
 *
 * ── The bob ───────────────────────────────────────────────────────────────
 *
 * A walk is read from the vertical rise and fall of the frame and the small
 * roll that goes with the weight transfer, and it is *not* a sine. The head
 * rises fast over the stance leg and falls slower, so the vertical term is
 * skewed by a second harmonic. Real head displacement while walking is about
 * 25 mm peak to peak at two steps a second.
 *
 * On soft ground it is smaller than on pavement, and this is one of the few
 * places where the surface actually changes the camera: duff and needle litter
 * absorb the heel strike, so the sharp bottom of the profile is rounded off
 * and the amplitude drops by roughly a fifth. That is why the numbers below
 * are under the ones a street walk uses.
 *
 * ── Following the ground ──────────────────────────────────────────────────
 *
 * The floor here is not flat anywhere — hummocks, a trail trough 85 mm deep,
 * and roots standing 45 mm proud across the path. Sampling the height field
 * straight into the eye position puts every one of those into the camera as a
 * step, and a root becomes a 45 mm jolt in one frame.
 *
 * What a body actually does is vault: the swing leg lifts over the obstacle
 * and the head arrives at the new height over about one step. So the raw
 * height goes through a one-pole lead — which rounds the corners at the top
 * and bottom of a step — and then a critically damped spring, which shapes the
 * rise and guarantees no overshoot. A camera that bobs up over a root and
 * settles back down reads as a stumble.
 *
 * Both are integrated in closed form rather than as Euler steps, because the
 * frame loop hands out deltas up to 50 ms and the capture harness drives it at
 * a fixed 1/30. An explicit integrator would give the interactive walk and the
 * captured one measurably different profiles from the same input.
 *
 * ── Staying on the trail ──────────────────────────────────────────────────
 *
 * The brief says no turns and no choices, so the walk is rails with slack: the
 * walker is free within about a metre of the centreline and is turned back
 * beyond it. Not a hard wall — a hard wall in a first-person camera reads as a
 * bug even when it is a design decision — but a spring that gets firm.
 */
import { DIMS } from '@/world/dims';
import { groundHeight } from '@/world/ground';
import { trail } from '@/world/trail';
import { standSpecs } from '@/world/forest';

export type Input = {
  forward: number;   // -1..1
  strafe: number;    // -1..1
};

/* Jump.
 *
 * Outside the brief, which asks for no jump, and added on request. Kept
 * physical rather than made springy, because the camera is the only thing the
 * viewer can feel and a game-feel jump — high, floaty, fast rise — would be
 * the most conspicuous non-photographic thing in the project the instant
 * anyone pressed the key.
 *
 * 0.42 m of clearance is a standing hop in boots on soft ground, which is what
 * this is; a running vertical leap is nearer 0.6 and this walker cannot run.
 * Real gravity, so the whole hop lasts 0.59 s and the fall is as fast as the
 * rise. Anything slower reads as low gravity, which is the usual tell.
 */
const JUMP_CLEARANCE = 0.42;
const GRAVITY = 9.81;
const JUMP_V0 = Math.sqrt(2 * GRAVITY * JUMP_CLEARANCE);

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;

/* Step length at walking pace on soft ground. Slightly shorter than the 0.70 m
 * of a pavement stride: people shorten up on an uneven surface. Cadence is
 * derived from this and the ground speed rather than being its own constant,
 * which is what guarantees the feet cannot slide relative to the ground at any
 * point in the acceleration ramp. */
const STEP_LEN = 0.66;

/* Where in the step the head is lowest, in radians after the footfall event.
 * The centre of mass keeps descending through heel strike and bottoms out in
 * double support, about a tenth of a step later. */
const BOB_TROUGH = 0.70;
/** The waveform's own minimum, solved off the expression below. */
const WALK_W_MIN = -1.10;

const GROUND_TAU = 0.055;
const GROUND_W = 17;

/* How far off the trail the walker may wander.
 *
 * The brief asks for rails — "no turns, no choices" — and the corridor is what
 * makes the trees read as walls, so the *composition* this project is judged
 * on is still the one from the path. This is an explicit owner override to let
 * the wood be explored, not a change of intent.
 *
 * 30 m of slack against a world built to `DIMS.worldHalf` (44 m), with the
 * hard backstop at 35. The gap between them matters: past about 35 m the
 * placement thins toward the world edge, and past 44 there is no ground at
 * all. The backstop is what guarantees the black-screen failure cannot return
 * however the spring is tuned.
 */
const ROAM = 30;
const ROAM_HARD = 35;

/* Trunk collision.
 *
 * `forest.ts` already refuses to plant a stem on the path, but it clears
 * against the *trail* — `trailHalf + 0.30 + r0 * (1 + flare)` — and the trail
 * is 0.43 m of half-width while the walker is allowed a metre of lateral
 * slack. On a big fir with a wide flare the bole surface can therefore stand
 * inside the region the walker is permitted to occupy, and with no collision
 * anywhere in the project the camera walks into the cylinder and out the far
 * side. Front faces are culled from within, so what you see is the inside of
 * the bark: unmistakably a rendering, and the single worst thing that can
 * happen to a scene whose entire claim is that it looks photographed.
 *
 * Solved here rather than by widening the clearance in `forest.ts`, because
 * the clearance rule is about where a tree can *grow* and this is about where
 * a body can *go*. Widening it enough to cover the slack would push the near
 * boles a metre further out on both sides and open the corridor the trees
 * exist to close.
 *
 * BODY is the shoulder radius the camera carries. Deliberately small: a real
 * person brushes past a trunk with a few centimetres to spare, and an
 * over-large capsule reads as an invisible wall standing off the wood.
 */
const BODY = 0.26;

/* Only the stems that can ever be reached matter. The walker is held within
 * 3.5 m of the centreline by the backstop, so a tree eight metres into the
 * wood is not a collider — and testing every one of four hundred stems per
 * frame to discover that would be the most expensive thing in `update()`. */
type Bole = { x: number; z: number; r: number };
let boles: Bole[] | null = null;

function nearBoles(): Bole[] {
  if (boles) return boles;
  const tr = trail();
  boles = [];
  for (const t of standSpecs()) {
    /* Every stem the walker can physically reach, which since free roam means
     * the whole corridor plus a margin. This was 6 m when the walk was on
     * rails, and leaving it there would have been the exact shape of bug this
     * project keeps producing: a guard that was correct when it was written,
     * silently wrong after a constant somewhere else moved, and invisible
     * until somebody walks into a tree. */
    if (tr.distance(t.x, t.z) > ROAM + 6) continue;
    /* The flare multiplier lives inside `forest.ts`'s species table and is not
     * exported, so the radius is reconstructed conservatively rather than
     * read. Erring wide costs a few centimetres of clearance that nobody can
     * see; erring narrow puts the camera back inside the bark, which is the
     * failure this exists to prevent. */
    boles.push({ x: t.x, z: t.z, r: t.r0 * 1.95 + BODY });
  }
  return boles;
}

export class Walker {
  x = 0;
  z = 0;
  yaw = 0;
  pitch = 0;
  /** Gait phase in radians; one step is PI. */
  phase = 0;
  /** Smoothed ground speed. */
  speed = 0;

  eye = { x: 0, y: DIMS.eyeHeight as number, z: 0 };
  roll = 0;

  groundY = 0;
  groundV = 0;
  private groundLead = 0;

  /** Set once per footfall with 0 or 1 for the foot. System 7 listens. */
  onFootstep: ((foot: number) => void) | null = null;
  private lastStep = 0;

  /** Height above the ground, and its rate. Zero whenever the feet are down. */
  airY = 0;
  private airV = 0;

  /**
   * Leave the ground, if it is there to leave.
   *
   * Gated on `airY` rather than on a flag, so a jump cannot be queued mid-air
   * and cannot double up on the frame a landing resolves.
   */
  jump() {
    if (this.airY > 0 || this.airV !== 0) return;
    this.airV = JUMP_V0;
  }

  private headX = 0;
  private headZ = -1;

  constructor() {
    const p = trail().walkAt(0);
    this.x = p.x;
    this.z = p.z;
    this.yaw = Math.atan2(-p.tx, -p.tz);
    this.snapGround();
  }

  snapGround() {
    this.groundY = this.groundLead = groundHeight(this.x, this.z);
    this.groundV = 0;
  }

  /** Progress along the walk, 0 at the start and 1 at the end. */
  get progress(): number {
    return clamp(-this.z / DIMS.trailLength, 0, 1);
  }

  /**
   * Put the walker at normalised progress `u`, facing down the trail.
   *
   * Used by the capture harness. It resolves the ground with no transition,
   * because a teleport that leaves the spring mid-flight photographs a camera
   * that is still falling.
   */
  placeAt(u: number) {
    const p = trail().walkAt(clamp(u, 0, 1));
    this.x = p.x;
    this.z = p.z;
    this.yaw = Math.atan2(-p.tx, -p.tz);
    this.snapGround();
    this.advanceGait(0);
    return this;
  }

  update(dt: number, input: Input): void {
    const cos = Math.cos(this.yaw), sin = Math.sin(this.yaw);
    // -Z is forward when yaw is zero.
    let vx = -sin * input.forward + cos * input.strafe;
    let vz = -cos * input.forward - sin * input.strafe;
    const len = Math.hypot(vx, vz);

    /* Let go of the key and the body keeps its heading while the pace runs
     * out. Multiplying the translation by an input that has just gone to zero
     * turns a modelled deceleration into a dead stop in one frame, and the
     * gait then takes two more steps on the spot. */
    if (len > 1e-4) {
      vx /= len; vz /= len;
      this.headX = vx; this.headZ = vz;
    } else {
      vx = this.headX; vz = this.headZ;
    }

    const target = len > 1e-4 ? DIMS.walkSpeed : 0;
    this.speed += (target - this.speed) * Math.min(1, dt * (target > this.speed ? 6 : 9));

    this.x += vx * this.speed * dt;
    this.z += vz * this.speed * dt;

    /* Back onto the trail. Free within SLACK of the centreline, then a
     * restoring pull that ramps in over the next half metre — firm enough that
     * nobody walks into the trees, soft enough that it never feels like a
     * collision.
     *
     * `(tz, -tx) * sign(side)` is the unit vector pointing from the walker
     * *towards* the centreline, which is worth deriving rather than trusting,
     * because getting it backwards does not read as a weak spring. It reads as
     * the floor giving way. The first version of this subtracted that vector
     * instead of adding it and scaled the step by `dist`, so every frame spent
     * off the trail pushed the walker further off it and multiplied the next
     * frame's push by the distance it had just gained. Strafing was the only
     * input that could start it, and once started it accelerated the camera out
     * past the ground mesh in under a second — to a viewer, sliding sideways
     * into blackness.
     *
     * The derivation: the trail's own `side` is the tangent-cross-offset, and
     * because the nearest point on a polyline is a perpendicular projection,
     * the offset is purely normal and `|side| == dist`. So the offset itself is
     * `-side * (tz, -tx)`, and the unit vector back to the centreline is the
     * negative of that over dist, which is `sign(side) * (tz, -tx)`.
     *
     * Clamped so a correction can never carry the walker past the slack
     * boundary it is aiming for. An overshoot here would put the walker on the
     * far side, flip the sign, and set up the same oscillation in the other
     * direction — the failure above, wearing a different hat.
     */
    const t = trail().at(this.x, this.z);
    if (t.dist > ROAM) {
      /* Over a 2.5 m ramp rather than the 0.5 m the rails used. At walking
       * pace a half-metre ramp against a 30 m boundary arrives as a wall —
       * the walker crosses it in under half a second and the spring goes from
       * nothing to full inside that. Turning someone back over two and a half
       * metres reads as deciding not to go further. */
      const ramp = Math.min(1, (t.dist - ROAM) / 2.5);
      const step = Math.min(ramp * dt * 2.6 * t.dist, t.dist - ROAM);
      this.x += t.tz * Math.sign(t.side) * step;
      this.z += -t.tx * Math.sign(t.side) * step;
    }

    /* A hard backstop, independent of everything above.
     *
     * The spring is a feel mechanism and it is allowed to be soft; this is a
     * guarantee, and it exists because the consequence of leaving the built
     * world is not a bad-looking frame but an entirely black one. There is no
     * ground mesh past `worldHalf` and no fog dome interior to see, so a walker
     * that escapes gets no visual feedback about what happened or which way is
     * back. Whatever the spring does or fails to do, this clamp holds.
     */
    const t2 = trail().at(this.x, this.z);
    if (t2.dist > ROAM_HARD) {
      const over = t2.dist - ROAM_HARD;
      this.x += t2.tz * Math.sign(t2.side) * over;
      this.z += -t2.tx * Math.sign(t2.side) * over;
    }

    /* Out of any bole, last, so nothing downstream can push the body back in.
     *
     * Order matters and it is the reverse of the obvious one. The trail spring
     * runs first and is soft, so where a trunk overlaps the corridor the two
     * reach an equilibrium a few centimetres off the bark rather than fighting
     * — the spring pulls in, the trunk pushes out, and the walker slides along
     * the bole instead of sticking to it. Resolving the trunk first and then
     * springing would let the spring put the body straight back inside the
     * wood on the same frame.
     *
     * Depenetration along the surface normal only, with no restitution, so a
     * glancing approach converts into a slide and a square-on approach simply
     * stops. Anything springier reads as being shoved by the tree.
     */
    for (const b of nearBoles()) {
      const dx = this.x - b.x, dz = this.z - b.z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= b.r * b.r || d2 < 1e-9) continue;
      const d = Math.sqrt(d2);
      const push = b.r - d;
      this.x += (dx / d) * push;
      this.z += (dz / d) * push;
    }

    /* The built world, not the walk.
     *
     * `zMin`/`zMax` and `worldHalf` are where the ground mesh actually stops,
     * and with free roam the walker can now reach all three. The two-metre
     * inset keeps the body off the rim, where the terrain's last row of quads
     * meets nothing and the camera can see under the edge of the world. */
    this.x = clamp(this.x, -DIMS.worldHalf + 2, DIMS.worldHalf - 2);
    this.z = clamp(this.z, DIMS.zMin + 2, DIMS.zMax - 2);

    this.advanceGait(dt);
  }

  /** Run the gait forward with no wall-clock time passing, for the harness. */
  warp(seconds: number, step = 1 / 60) {
    for (let t = 0; t < seconds; t += step) this.advanceGait(step);
  }

  private followGround(dt: number) {
    if (dt <= 0) return;
    const raw = groundHeight(this.x, this.z);
    this.groundLead += (raw - this.groundLead) * (1 - Math.exp(-dt / GROUND_TAU));

    const w = GROUND_W;
    const e = Math.exp(-w * dt);
    const c1 = this.groundY - this.groundLead;
    const c2 = this.groundV + w * c1;
    const s = c1 + c2 * dt;
    this.groundY = s * e + this.groundLead;
    this.groundV = (c2 - w * s) * e;
  }

  private advanceGait(dt: number) {
    this.followGround(dt);

    /* Ballistic, and integrated before the gait so the airborne test below
     * sees this frame's state rather than last frame's. */
    const airborne = this.airY > 0 || this.airV !== 0;
    if (airborne && dt > 0) {
      this.airV -= GRAVITY * dt;
      this.airY += this.airV * dt;
      if (this.airY <= 0) {
        this.airY = 0;
        this.airV = 0;
        /* Landing is a footfall, and the audio bank already has the sound. It
         * is reported as the foot that was *not* the last one to strike, so a
         * hop does not play the same variant twice in a row. */
        this.lastStep += 1;
        this.onFootstep?.(this.lastStep & 1);
      }
    }

    /* The gait stops in the air. Feet that keep striding while the body is
     * off the ground is the oldest tell in first-person movement, and here it
     * would also fire the footstep bank against nothing. */
    const cadence = airborne ? 0 : Math.PI * (this.speed / STEP_LEN);
    this.phase += cadence * dt;
    if (this.phase > Math.PI * 2) this.phase -= Math.PI * 2;

    const steps = Math.floor(this.phase / Math.PI);
    if (steps !== this.lastStep) {
      this.lastStep = steps;
      this.onFootstep?.(steps & 1);
    }

    /* Smoothstepped rather than clamped. A bare clamp has a corner at each
     * end, and a corner in a term that multiplies the bob is a step in the
     * head's vertical velocity the instant the pace crosses it — invisible at
     * 30 Hz and unmistakable when the capture harness samples harder. */
    const ease = (u: number) => u * u * (3 - 2 * u);
    const walkU = ease(clamp(this.speed / DIMS.walkSpeed, 0, 1));

    /* 21 mm peak to peak, against 25 on pavement. Soft ground absorbs part of
     * the heel strike and the head does not travel as far. */
    const ampY = 0.0105 * walkU;
    const ampX = 0.0165 * walkU;
    const ampR = 0.0072 * walkU;

    const p2 = this.phase * 2;
    const uW = p2 - BOB_TROUGH + WALK_W_MIN;
    /* Inverted pendulum: fast rise over the stance leg, slower fall. The
     * second harmonic is what skews it; a pure sine reads as a float. The
     * 0.22 weight is lower than a pavement walk's 0.28 because the litter
     * damps the sharp part of the profile. */
    const bobY = (Math.sin(uW) + 0.22 * Math.sin(uW * 2 - 0.7)) * ampY;

    // Lateral sway is at half the vertical rate — one sway per stride.
    const sway = Math.sin(this.phase) * ampX;
    this.roll = -Math.sin(this.phase) * ampR;

    /* A slow drift that is not tied to the gait at all.
     *
     * A person walking a trail does not hold a heading to the milliradian, and
     * a camera that does reads as being on a dolly. Two incommensurate periods
     * so it never repeats, and small: about a third of a degree, which is
     * below the threshold at which anyone can name it and above the one at
     * which its absence is felt.
     */
    const drift = this.phase * 0.37;
    const dYaw = Math.sin(drift * 0.61) * 0.0042 + Math.sin(drift * 0.23 + 1.7) * 0.0031;
    const dPitch = Math.sin(drift * 0.44 + 0.4) * 0.0026;

    const cos = Math.cos(this.yaw + dYaw), sin = Math.sin(this.yaw + dYaw);
    this.eye.x = this.x + cos * sway;
    /* The bob is suppressed in the air rather than simply added to. It is a
     * model of the body vaulting over a stance leg, and there is no stance leg
     * in flight — leaving it running would put a two-per-second oscillation on
     * top of a parabola and read as a stumble at the apex. */
    const grounded = 1 - Math.min(1, this.airY / 0.10);
    this.eye.y = this.groundY + DIMS.eyeHeight + bobY * grounded + this.airY;
    this.eye.z = this.z - sin * sway;
    this.driftYaw = dYaw;
    this.driftPitch = dPitch;
  }

  /** Handheld drift, applied on top of the look angles by the rig. */
  driftYaw = 0;
  driftPitch = 0;

  look(dx: number, dy: number, sensitivity = 0.0022) {
    this.yaw -= dx * sensitivity;
    this.pitch = clamp(this.pitch - dy * sensitivity, -1.25, 1.05);
  }
}

export { lerp };
