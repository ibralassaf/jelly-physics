// Turns the simulated motion of the jelly's top into one event per real oscillation.
// No audio here, so test/validate.mjs can run it against the actual solver.

const MIN_SPEED = 0.004;  // m/s; slower than this is not an audible wobble
const FULL_SPEED = 0.25;  // m/s; the swing speed that plays at full level

/** The wobble rate for a shear modulus, from the fit in test/validate.mjs. */
export const wobbleHz = (G) => 0.098 * Math.sqrt(G);

export class WobbleDetector {
  constructor() {
    this.axis = [1, 0, 0];
    this.peak = 0;
    this.armed = false;
    this.sinceFire = 1e9;
  }

  /** Feed the mean velocity of the top. Returns a loudness in (0, 1] when a cycle completes. */
  update(v, dt, G) {
    this.sinceFire += dt;
    const speed = Math.hypot(v[0], v[1], v[2]);
    const a = this.axis;
    if (speed > MIN_SPEED * 0.5) {
      // Follow the swing direction, treating both ends of the swing as the same axis.
      const sign = v[0] * a[0] + v[1] * a[1] + v[2] * a[2] < 0 ? -1 : 1;
      const k = Math.min(dt / 0.25, 1);
      const nx = a[0] + (sign * v[0] / speed - a[0]) * k;
      const ny = a[1] + (sign * v[1] / speed - a[1]) * k;
      const nz = a[2] + (sign * v[2] / speed - a[2]) * k;
      const l = Math.hypot(nx, ny, nz) || 1;
      a[0] = nx / l; a[1] = ny / l; a[2] = nz / l;
    }
    const s = v[0] * a[0] + v[1] * a[1] + v[2] * a[2];
    this.peak = Math.max(this.peak, Math.abs(s));

    // Hysteresis scales with the swing, so small tremors can't retrigger inside a big cycle.
    const hysteresis = Math.max(MIN_SPEED, this.peak * 0.15);
    if (s < -hysteresis) this.armed = true;
    if (this.armed && s > hysteresis * 0.25 && this.sinceFire > 0.55 / wobbleHz(G)) {
      const level = Math.min(Math.pow(this.peak / FULL_SPEED, 0.7), 1);
      this.armed = false;
      this.peak = 0;
      this.sinceFire = 0;
      return level;
    }
    // Let the remembered peak fade, so loudness follows the decay of the ring-down.
    this.peak *= Math.exp(-dt / 0.5);
    return 0;
  }
}
