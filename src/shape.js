// Rest geometry of the jelly: a fluted dome (classic moulded dessert) in SI units,
// plus the plate profile. Everything downstream (tet mesh, render mesh) derives from here.

export const H = 0.075;       // height, m
export const R0 = 0.06;       // base radius, m
const FLUTES = 8;
const FLUTE_AMP = 0.085;
const FILLET = 0.006;         // rounded bottom edge, m

export const PLATE = {
  thickness: 0.003,           // half-thickness of ceramic shell
  flatR: 0.105,               // flat well radius
  outerR: 0.145,              // rim radius
  rimH: 0.016,                // rim rise above the well
  footY: -0.014,              // table height relative to the well surface
};

/** Height of the plate's top surface at a horizontal radius. Physics and renderer agree on this. */
export function plateHeight(r) {
  if (r <= PLATE.flatR) return 0;
  const t = (r - PLATE.flatR) / (PLATE.outerR - PLATE.flatR);
  return PLATE.rimH * t;
}
export const PLATE_RIM_SLOPE = PLATE.rimH / (PLATE.outerR - PLATE.flatR);

function profileRadius(y) {
  const t = Math.min(Math.max(y / H, 0), 1);
  const p = 3.2;
  let r = R0 * Math.pow(Math.max(1 - Math.pow(t, p), 0), 1 / p) * (1 - 0.1 * t);
  if (y < FILLET) {
    const d = FILLET - y;
    r -= FILLET - Math.sqrt(Math.max(FILLET * FILLET - d * d, 0));
  }
  return r;
}

function fluteFactor(y, theta) {
  const t = Math.min(Math.max(y / H, 0), 1);
  const e0 = Math.min(t / 0.08, 1);
  const e1 = Math.min(Math.max((0.92 - t) / 0.4, 0), 1);
  const a = FLUTE_AMP * (e0 * e0 * (3 - 2 * e0)) * (e1 * e1 * (3 - 2 * e1));
  return 1 + a * Math.cos(FLUTES * theta);
}

export function surfaceRadius(y, theta) {
  return profileRadius(y) * fluteFactor(y, theta);
}

export function isInside(x, y, z) {
  if (y < 0 || y > H) return false;
  return Math.hypot(x, z) <= surfaceRadius(y, Math.atan2(z, x));
}

/** Project a point onto the surface along a ray from the body's interior. */
export function projectToSurface(p) {
  if (p[1] <= 1e-9) {
    const th = Math.atan2(p[2], p[0]);
    const r = surfaceRadius(0, th);
    return [r * Math.cos(th), 0, r * Math.sin(th)];
  }
  const c = [0, 0.4 * H, 0];
  const d = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
  let lo = 0, hi = 4;
  for (let i = 0; i < 40; i++) {
    const m = 0.5 * (lo + hi);
    if (isInside(c[0] + d[0] * m, c[1] + d[1] * m, c[2] + d[2] * m)) lo = m;
    else hi = m;
  }
  return [c[0] + d[0] * lo, c[1] + d[1] * lo, c[2] + d[2] * lo];
}

/** Closed, smooth, high-resolution display mesh in the rest pose. */
export function buildSurfaceMesh(nTheta = 192, nSide = 88, nBase = 14) {
  const positions = [];
  const index = [];
  const rows = [];
  const ringAt = (fn) => {
    const start = positions.length / 3;
    for (let j = 0; j < nTheta; j++) {
      const th = (j / nTheta) * Math.PI * 2;
      const [r, y] = fn(th);
      positions.push(r * Math.cos(th), y, r * Math.sin(th));
    }
    rows.push(start);
  };
  positions.push(0, 0, 0); // bottom pole
  for (let i = 1; i <= nBase; i++) {
    const s = i / nBase;
    ringAt((th) => [surfaceRadius(0, th) * s, 0]);
  }
  for (let i = 1; i < nSide; i++) {
    // Sine spacing packs rows near the bottom fillet and the top pole.
    const yEdge = FILLET * 1.2;
    let y;
    const frac = i / nSide;
    if (frac < 0.14) y = yEdge * Math.sin((frac / 0.14) * Math.PI * 0.5);
    else y = yEdge + (H - yEdge) * Math.sin(((frac - 0.14) / 0.86) * Math.PI * 0.5);
    ringAt((th) => [surfaceRadius(y, th), y]);
  }
  const top = positions.length / 3;
  positions.push(0, H, 0);

  // Bottom fan: faces down (-Y).
  for (let j = 0; j < nTheta; j++) {
    const j1 = (j + 1) % nTheta;
    index.push(0, rows[0] + j, rows[0] + j1);
  }
  // Rings: outward-facing quads.
  for (let r = 0; r + 1 < rows.length; r++) {
    const a = rows[r], b = rows[r + 1];
    for (let j = 0; j < nTheta; j++) {
      const j1 = (j + 1) % nTheta;
      index.push(a + j, b + j, a + j1, a + j1, b + j, b + j1);
    }
  }
  // Top fan.
  const last = rows[rows.length - 1];
  for (let j = 0; j < nTheta; j++) {
    const j1 = (j + 1) % nTheta;
    index.push(last + j, top, last + j1);
  }
  return { positions: new Float32Array(positions), index: new Uint32Array(index) };
}
