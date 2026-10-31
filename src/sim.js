// Soft-body solver. Everything is SI: metres, kilograms, seconds, pascals.
//
//  Elasticity : Stable Neo-Hookean (Smith et al. 2018) in the constraint form of
//               Macklin & Mueller 2021, with the deviatoric and hydrostatic constraints of
//               each tet solved as a coupled 2x2 system so the rest pose has zero stress.
//  Integration: XPBD with small steps (Macklin et al. 2019), symmetric Gauss-Seidel.
//  Damping    : objective Kelvin-Voigt shear viscosity, sigma = 2 eta dev(sym(Fdot F^-1)).
//               No velocity scaling anywhere, so rigid motion is never damped.
//  Volume     : one global constraint over the boundary keeps total volume exact, compensating
//               the softening a single XPBD sweep causes in the stiff bulk term.
//  Contact    : plate height-field with Coulomb friction, plus a rate-independent adhesive
//               bond that can peel and re-form (gelatin really does stick to glazed ceramic).
import { plateHeight, PLATE, PLATE_RIM_SLOPE } from './shape.js';

export const DEFAULTS = {
  density: 1030,         // kg/m^3, water-based gel
  // Per-element bulk stiffness. Must stay low enough relative to 1/h^2 for the single Newton step
  // on det(F) not to overshoot at large strain (test/diagnose.mjs shows the chaos if it's not).
  // Scales with G to hold nu >= ~0.44; true incompressibility comes from volumeModulus below.
  bulkMin: 45e3,         // Pa
  bulkPerShear: 16,
  volumeModulus: 1.2e6,  // Pa, whole-body compliant volume constraint
  viscosity: 2.0,        // Pa s, measured gelatin SLS fits sit around 1.5-3.5
  gravity: -9.81,
  substepHz: 960,
  sweeps: 1,
  muStatic: 0.30,
  muDynamic: 0.22,
  adhesionShear: 200,    // Pa, wet gelatin on glass slip threshold
  adhesionTensile: 150,  // Pa
  slideThreshold: 0.6,   // fraction of adhesionShear that survives while sliding (wet gel keeps a yield stress)
  rebondSeconds: 0.4,
  maxGrabForce: 9,       // N, hard ceiling of a finger pull
};

/** Slider mapping. s=0 firm gummy, s=1 barely-set panna cotta. Log-scale in shear modulus. */
export const G_FIRM = 6000, G_SOFT = 300;
export const shearFromIntensity = (s) => G_FIRM * Math.pow(G_SOFT / G_FIRM, s);

export class Jelly {
  constructor(mesh, opts = {}) {
    this.p = { ...DEFAULTS, ...opts };
    const n = mesh.positions.length / 3;
    const m = mesh.tets.length / 4;
    this.n = n;
    this.m = m;
    this.tets = mesh.tets;
    this.rest = mesh.positions.slice();
    this.x = mesh.positions.slice();
    this.prev = new Float64Array(n * 3);
    this.v = new Float64Array(n * 3);
    this.w = new Float64Array(n);
    this.mass = new Float64Array(n);
    this.B = new Float64Array(m * 9);      // Dm^-1, column-major-free: rows r,c
    this.vol = new Float64Array(m);
    this.lamD = new Float64Array(m);
    this.lamH = new Float64Array(m);
    this.bonded = new Uint8Array(n);
    this.isBase = new Uint8Array(n);
    this.bondAge = new Float32Array(n);
    this.badList = new Int32Array(m);
    this.badCount = 0;
    this.kv = new Float64Array(m);         // per-tet implicit dashpot coefficient
    this.h = 1 / this.p.substepHz;
    this.flip = false;
    this.ax = 0; this.az = 0;              // bump acceleration (non-inertial plate frame)
    this.bump = null;
    this.grab = null;
    this.simTime = 0;

    const { x, tets } = this;
    for (let e = 0; e < m; e++) {
      const a = tets[e * 4], b = tets[e * 4 + 1], c = tets[e * 4 + 2], d = tets[e * 4 + 3];
      const m00 = x[b * 3] - x[a * 3], m10 = x[b * 3 + 1] - x[a * 3 + 1], m20 = x[b * 3 + 2] - x[a * 3 + 2];
      const m01 = x[c * 3] - x[a * 3], m11 = x[c * 3 + 1] - x[a * 3 + 1], m21 = x[c * 3 + 2] - x[a * 3 + 2];
      const m02 = x[d * 3] - x[a * 3], m12 = x[d * 3 + 1] - x[a * 3 + 1], m22 = x[d * 3 + 2] - x[a * 3 + 2];
      const det = m00 * (m11 * m22 - m12 * m21) - m01 * (m10 * m22 - m12 * m20) + m02 * (m10 * m21 - m11 * m20);
      const inv = 1 / det;
      const B = this.B, o = e * 9;
      B[o] = (m11 * m22 - m12 * m21) * inv;  B[o + 1] = (m02 * m21 - m01 * m22) * inv; B[o + 2] = (m01 * m12 - m02 * m11) * inv;
      B[o + 3] = (m12 * m20 - m10 * m22) * inv; B[o + 4] = (m00 * m22 - m02 * m20) * inv; B[o + 5] = (m02 * m10 - m00 * m12) * inv;
      B[o + 6] = (m10 * m21 - m11 * m20) * inv; B[o + 7] = (m01 * m20 - m00 * m21) * inv; B[o + 8] = (m00 * m11 - m01 * m10) * inv;
      const V = det / 6;
      this.vol[e] = V;
      const mNode = (this.p.density * V) / 4;
      this.mass[a] += mNode; this.mass[b] += mNode; this.mass[c] += mNode; this.mass[d] += mNode;
    }
    // Boundary nodes touching only a sliver can carry almost no mass, which would set the stable
    // step for the whole body. Floor them at a fraction of the median, conserving total mass.
    {
      const sorted = Array.from(this.mass).sort((a, b) => a - b);
      const floor = sorted[n >> 1] * 0.3;
      let before = 0, after = 0;
      for (let i = 0; i < n; i++) { before += this.mass[i]; this.mass[i] = Math.max(this.mass[i], floor); after += this.mass[i]; }
      for (let i = 0; i < n; i++) this.mass[i] *= before / after;
    }
    this.buildBoundary();
    let baseCount = 0;
    for (let i = 0; i < n; i++) {
      this.w[i] = 1 / this.mass[i];
      if (this.rest[i * 3 + 1] < 1e-6) { baseCount++; this.bonded[i] = 1; this.isBase[i] = 1; }
    }
    // Viscosity stiffness of each element relative to the nodes it moves. Dividing the viscous
    // impulse by (1 + 2 kv) is a local implicit solve, so tiny boundary nodes can't go unstable.
    for (let e = 0; e < m; e++) {
      const o = e * 9, B = this.B;
      const g1 = B[o] * B[o] + B[o + 1] * B[o + 1] + B[o + 2] * B[o + 2];
      const g2 = B[o + 3] * B[o + 3] + B[o + 4] * B[o + 4] + B[o + 5] * B[o + 5];
      const g3 = B[o + 6] * B[o + 6] + B[o + 7] * B[o + 7] + B[o + 8] * B[o + 8];
      const g0x = B[o] + B[o + 3] + B[o + 6], g0y = B[o + 1] + B[o + 4] + B[o + 7], g0z = B[o + 2] + B[o + 5] + B[o + 8];
      const g0 = g0x * g0x + g0y * g0y + g0z * g0z;
      this.kv[e] = this.h * this.p.viscosity * this.vol[e] *
        (this.w[tets[e * 4]] * g0 + this.w[tets[e * 4 + 1]] * g1 + this.w[tets[e * 4 + 2]] * g2 + this.w[tets[e * 4 + 3]] * g3);
    }
    // Tributary footprint per base node, used to turn contact stresses into forces.
    let maxR2 = 0;
    for (let i = 0; i < n; i++) if (this.rest[i * 3 + 1] < 1e-6) {
      maxR2 = Math.max(maxR2, this.rest[i * 3] ** 2 + this.rest[i * 3 + 2] ** 2);
    }
    this.nodeArea = (Math.PI * maxR2) / Math.max(baseCount, 1);
    this.setShear(opts.shear ?? shearFromIntensity(0.5));
  }

  /** Outward-oriented boundary triangles, for the whole-body volume constraint. */
  buildBoundary() {
    const { tets } = this;
    const faces = new Map();
    const F = [[1, 2, 3], [0, 3, 2], [0, 1, 3], [0, 2, 1]];
    for (let e = 0; e < this.m; e++) {
      for (const f of F) {
        const t = [tets[e * 4 + f[0]], tets[e * 4 + f[1]], tets[e * 4 + f[2]]];
        const key = [...t].sort((a, b) => a - b).join('_');
        if (faces.has(key)) faces.set(key, null); else faces.set(key, t);
      }
    }
    const list = [];
    for (const t of faces.values()) if (t) list.push(t[0], t[2], t[1]);
    this.bFaces = new Uint32Array(list);
    this.gradV = new Float64Array(this.n * 3);
    this.bNodes = new Uint32Array([...new Set(list)]);
    this.V0 = this.surfaceVolume();
  }

  /** Volume from the boundary by the divergence theorem; fills gradV as a side effect. */
  surfaceVolume() {
    const { x, bFaces, gradV, bNodes } = this;
    for (let k = 0; k < bNodes.length; k++) {
      const i = bNodes[k] * 3;
      gradV[i] = 0; gradV[i + 1] = 0; gradV[i + 2] = 0;
    }
    let V = 0;
    for (let f = 0; f < bFaces.length; f += 3) {
      const a = bFaces[f] * 3, b = bFaces[f + 1] * 3, c = bFaces[f + 2] * 3;
      const ax = x[a], ay = x[a + 1], az = x[a + 2];
      const bx = x[b], by = x[b + 1], bz = x[b + 2];
      const cx = x[c], cy = x[c + 1], cz = x[c + 2];
      const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
      const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
      const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      V += (ax * nx + ay * ny + az * nz) / 6;
      const gx = nx / 6, gy = ny / 6, gz = nz / 6;
      gradV[a] += gx; gradV[a + 1] += gy; gradV[a + 2] += gz;
      gradV[b] += gx; gradV[b + 1] += gy; gradV[b + 2] += gz;
      gradV[c] += gx; gradV[c + 1] += gy; gradV[c + 2] += gz;
    }
    return V;
  }

  /** Near-incompressibility as a compliant whole-body constraint: a uniform pressure on the
   *  boundary, conserving linear and angular momentum because gradV sums to zero on a closed mesh. */
  solveVolume() {
    const { x, w, gradV, bNodes } = this;
    const V = this.surfaceVolume();
    const C = V - this.V0;
    let denom = Math.abs(this.V0) / (this.p.volumeModulus * this.h * this.h); // compliance term
    if (!Number.isFinite(denom)) return;
    for (let k = 0; k < bNodes.length; k++) {
      const n = bNodes[k], i = n * 3;
      denom += w[n] * (gradV[i] * gradV[i] + gradV[i + 1] * gradV[i + 1] + gradV[i + 2] * gradV[i + 2]);
    }
    if (denom < 1e-30) return;
    const lam = -C / denom;
    for (let k = 0; k < bNodes.length; k++) {
      const n = bNodes[k], i = n * 3, s = w[n] * lam;
      x[i] += s * gradV[i]; x[i + 1] += s * gradV[i + 1]; x[i + 2] += s * gradV[i + 2];
    }
  }

  setShear(G) {
    this.G = G;
    const K = Math.max(this.p.bulkMin, this.p.bulkPerShear * G);
    // Lamé first parameter from K and G; Macklin's energy uses lambda_hat = lambda + mu so that
    // the linearisation about rest recovers the correct small-strain moduli.
    const lambda = K - (2 / 3) * G;
    this.lamHat = lambda + G;
    this.gamma = 1 + G / this.lamHat;
  }

  totalVolume() {
    const { x, tets } = this;
    let V = 0;
    for (let e = 0; e < this.m; e++) {
      const a = tets[e * 4] * 3, b = tets[e * 4 + 1] * 3, c = tets[e * 4 + 2] * 3, d = tets[e * 4 + 3] * 3;
      const ux = x[b] - x[a], uy = x[b + 1] - x[a + 1], uz = x[b + 2] - x[a + 2];
      const vx = x[c] - x[a], vy = x[c + 1] - x[a + 1], vz = x[c + 2] - x[a + 2];
      const wx = x[d] - x[a], wy = x[d + 1] - x[a + 1], wz = x[d + 2] - x[a + 2];
      V += (ux * (vy * wz - vz * wy) - uy * (vx * wz - vz * wx) + uz * (vx * wy - vy * wx)) / 6;
    }
    return V;
  }

  invertedCount() {
    const { x, tets } = this;
    let c = 0;
    for (let e = 0; e < this.m; e++) {
      const a = tets[e * 4] * 3, b = tets[e * 4 + 1] * 3, cc = tets[e * 4 + 2] * 3, d = tets[e * 4 + 3] * 3;
      const ux = x[b] - x[a], uy = x[b + 1] - x[a + 1], uz = x[b + 2] - x[a + 2];
      const vx = x[cc] - x[a], vy = x[cc + 1] - x[a + 1], vz = x[cc + 2] - x[a + 2];
      const wx = x[d] - x[a], wy = x[d + 1] - x[a + 1], wz = x[d + 2] - x[a + 2];
      if (ux * (vy * wz - vz * wy) - uy * (vx * wz - vz * wx) + uz * (vx * wy - vy * wx) <= 0) c++;
    }
    return c;
  }

  kineticEnergy() {
    let E = 0;
    for (let i = 0; i < this.n; i++) {
      const vx = this.v[i * 3], vy = this.v[i * 3 + 1], vz = this.v[i * 3 + 2];
      E += 0.5 * this.mass[i] * (vx * vx + vy * vy + vz * vz);
    }
    return E;
  }

  /** One sweep over all elements. Hot loop: no allocation, flat scalars only. */
  solveElastic() {
    const { x, w, tets, B, vol, lamD, lamH, badList } = this;
    let badCount = 0;
    const m = this.m, h2 = this.h * this.h;
    const G = this.G, L = this.lamHat, gamma = this.gamma;
    const start = this.flip ? m - 1 : 0, end = this.flip ? -1 : m, step = this.flip ? -1 : 1;
    for (let e = start; e !== end; e += step) {
      const i4 = e * 4, o = e * 9;
      const a = tets[i4] * 3, b = tets[i4 + 1] * 3, c = tets[i4 + 2] * 3, d = tets[i4 + 3] * 3;
      const ax = x[a], ay = x[a + 1], az = x[a + 2];
      const d1x = x[b] - ax, d1y = x[b + 1] - ay, d1z = x[b + 2] - az;
      const d2x = x[c] - ax, d2y = x[c + 1] - ay, d2z = x[c + 2] - az;
      const d3x = x[d] - ax, d3y = x[d + 1] - ay, d3z = x[d + 2] - az;
      const B00 = B[o], B01 = B[o + 1], B02 = B[o + 2];
      const B10 = B[o + 3], B11 = B[o + 4], B12 = B[o + 5];
      const B20 = B[o + 6], B21 = B[o + 7], B22 = B[o + 8];

      // F = Ds * B, stored by columns f1,f2,f3.
      const f1x = d1x * B00 + d2x * B10 + d3x * B20, f1y = d1y * B00 + d2y * B10 + d3y * B20, f1z = d1z * B00 + d2z * B10 + d3z * B20;
      const f2x = d1x * B01 + d2x * B11 + d3x * B21, f2y = d1y * B01 + d2y * B11 + d3y * B21, f2z = d1z * B01 + d2z * B11 + d3z * B21;
      const f3x = d1x * B02 + d2x * B12 + d3x * B22, f3y = d1y * B02 + d2y * B12 + d3y * B22, f3z = d1z * B02 + d2z * B12 + d3z * B22;

      const trFtF = f1x * f1x + f1y * f1y + f1z * f1z + f2x * f2x + f2y * f2y + f2z * f2z + f3x * f3x + f3y * f3y + f3z * f3z;
      const CD = Math.sqrt(trFtF) + 1e-12;
      const iCD = 1 / CD;

      // Cofactor matrix = d(det F)/dF.
      const c1x = f2y * f3z - f2z * f3y, c1y = f2z * f3x - f2x * f3z, c1z = f2x * f3y - f2y * f3x;
      const c2x = f3y * f1z - f3z * f1y, c2y = f3z * f1x - f3x * f1z, c2z = f3x * f1y - f3y * f1x;
      const c3x = f1y * f2z - f1z * f2y, c3y = f1z * f2x - f1x * f2z, c3z = f1x * f2y - f1y * f2x;
      const J = f1x * c1x + f1y * c1y + f1z * c1z;
      const CH = J - gamma;
      if (J < 0.03) badList[badCount++] = e;

      // Node gradients: dC/dx_i = (dC/dF) B^T, column i of the product.
      const gD1x = (f1x * B00 + f2x * B01 + f3x * B02) * iCD, gD1y = (f1y * B00 + f2y * B01 + f3y * B02) * iCD, gD1z = (f1z * B00 + f2z * B01 + f3z * B02) * iCD;
      const gD2x = (f1x * B10 + f2x * B11 + f3x * B12) * iCD, gD2y = (f1y * B10 + f2y * B11 + f3y * B12) * iCD, gD2z = (f1z * B10 + f2z * B11 + f3z * B12) * iCD;
      const gD3x = (f1x * B20 + f2x * B21 + f3x * B22) * iCD, gD3y = (f1y * B20 + f2y * B21 + f3y * B22) * iCD, gD3z = (f1z * B20 + f2z * B21 + f3z * B22) * iCD;
      const gD0x = -gD1x - gD2x - gD3x, gD0y = -gD1y - gD2y - gD3y, gD0z = -gD1z - gD2z - gD3z;

      const gH1x = c1x * B00 + c2x * B01 + c3x * B02, gH1y = c1y * B00 + c2y * B01 + c3y * B02, gH1z = c1z * B00 + c2z * B01 + c3z * B02;
      const gH2x = c1x * B10 + c2x * B11 + c3x * B12, gH2y = c1y * B10 + c2y * B11 + c3y * B12, gH2z = c1z * B10 + c2z * B11 + c3z * B12;
      const gH3x = c1x * B20 + c2x * B21 + c3x * B22, gH3y = c1y * B20 + c2y * B21 + c3y * B22, gH3z = c1z * B20 + c2z * B21 + c3z * B22;
      const gH0x = -gH1x - gH2x - gH3x, gH0y = -gH1y - gH2y - gH3y, gH0z = -gH1z - gH2z - gH3z;

      const ia = tets[i4], ib = tets[i4 + 1], ic = tets[i4 + 2], id = tets[i4 + 3];
      const wa = w[ia], wb = w[ib], wc = w[ic], wd = w[id];
      const aDD = wa * (gD0x * gD0x + gD0y * gD0y + gD0z * gD0z) + wb * (gD1x * gD1x + gD1y * gD1y + gD1z * gD1z)
                + wc * (gD2x * gD2x + gD2y * gD2y + gD2z * gD2z) + wd * (gD3x * gD3x + gD3y * gD3y + gD3z * gD3z);
      const aHH = wa * (gH0x * gH0x + gH0y * gH0y + gH0z * gH0z) + wb * (gH1x * gH1x + gH1y * gH1y + gH1z * gH1z)
                + wc * (gH2x * gH2x + gH2y * gH2y + gH2z * gH2z) + wd * (gH3x * gH3x + gH3y * gH3y + gH3z * gH3z);
      const aDH = wa * (gD0x * gH0x + gD0y * gH0y + gD0z * gH0z) + wb * (gD1x * gH1x + gD1y * gH1y + gD1z * gH1z)
                + wc * (gD2x * gH2x + gD2y * gH2y + gD2z * gH2z) + wd * (gD3x * gH3x + gD3y * gH3y + gD3z * gH3z);

      const V = vol[e];
      const atD = 1 / (G * V * h2), atH = 1 / (L * V * h2);
      const A = aDD + atD, Bm = aDH, D = aHH + atH;
      const r1 = -CD - atD * lamD[e], r2 = -CH - atH * lamH[e];
      const idet = 1 / (A * D - Bm * Bm);
      const dD = (D * r1 - Bm * r2) * idet;
      const dH = (A * r2 - Bm * r1) * idet;
      lamD[e] += dD;
      lamH[e] += dH;

      x[a] += wa * (gD0x * dD + gH0x * dH); x[a + 1] += wa * (gD0y * dD + gH0y * dH); x[a + 2] += wa * (gD0z * dD + gH0z * dH);
      x[b] += wb * (gD1x * dD + gH1x * dH); x[b + 1] += wb * (gD1y * dD + gH1y * dH); x[b + 2] += wb * (gD1z * dD + gH1z * dH);
      x[c] += wc * (gD2x * dD + gH2x * dH); x[c + 1] += wc * (gD2y * dD + gH2y * dH); x[c + 2] += wc * (gD2z * dD + gH2z * dH);
      x[d] += wd * (gD3x * dD + gH3x * dH); x[d + 1] += wd * (gD3y * dD + gH3y * dH); x[d + 2] += wd * (gD3z * dD + gH3z * dH);
    }
    this.badCount = badCount;
  }

  /** Flat or inverted tets have a vanishing cof(F), so the constraints above can't unfold them.
   *  Pull those few elements toward a rigidly placed copy of their rest shape. The frame is
   *  built with Gram-Schmidt from the two longest edges of F, so it's right-handed by
   *  construction even when F itself is singular or reflected. */
  repairInverted() {
    const { x, rest, tets, B, badList } = this;
    for (let q = 0; q < this.badCount; q++) {
      const e = badList[q], o = e * 9, i4 = e * 4;
      const ids = [tets[i4], tets[i4 + 1], tets[i4 + 2], tets[i4 + 3]];
      const a = ids[0] * 3, b = ids[1] * 3, c = ids[2] * 3, d = ids[3] * 3;
      const col = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
      for (let r = 0; r < 3; r++) {
        const e1 = x[b + r] - x[a + r], e2 = x[c + r] - x[a + r], e3 = x[d + r] - x[a + r];
        col[0][r] = e1 * B[o] + e2 * B[o + 3] + e3 * B[o + 6];
        col[1][r] = e1 * B[o + 1] + e2 * B[o + 4] + e3 * B[o + 7];
        col[2][r] = e1 * B[o + 2] + e2 * B[o + 5] + e3 * B[o + 8];
      }
      const len = col.map((v) => Math.hypot(v[0], v[1], v[2]));
      const idx = [0, 1, 2].sort((p, r) => len[r] - len[p]);
      const [ia, ib, ic] = idx;
      if (len[ia] < 1e-9) continue;
      const u = col[ia].map((v) => v / len[ia]);
      const dp = col[ib][0] * u[0] + col[ib][1] * u[1] + col[ib][2] * u[2];
      let v = [col[ib][0] - dp * u[0], col[ib][1] - dp * u[1], col[ib][2] - dp * u[2]];
      const lv = Math.hypot(v[0], v[1], v[2]);
      if (lv < 1e-9) {
        // F is rank one: any perpendicular will do.
        v = Math.abs(u[0]) < 0.9 ? [0, -u[2], u[1]] : [-u[2], 0, u[0]];
        const l2 = Math.hypot(v[0], v[1], v[2]);
        v = v.map((t) => t / l2);
      } else v = v.map((t) => t / lv);
      const w = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      // Sign of the permutation (ia, ib, ic) decides the handedness of the third column.
      const parity = ((ib - ia + 3) % 3 === 1) ? 1 : -1;
      const R = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
      for (let r = 0; r < 3; r++) { R[ia][r] = u[r]; R[ib][r] = v[r]; R[ic][r] = parity * w[r]; }
      let cx = 0, cy = 0, cz = 0, Cx = 0, Cy = 0, Cz = 0;
      for (const n of ids) {
        cx += x[n * 3] / 4; cy += x[n * 3 + 1] / 4; cz += x[n * 3 + 2] / 4;
        Cx += rest[n * 3] / 4; Cy += rest[n * 3 + 1] / 4; Cz += rest[n * 3 + 2] / 4;
      }
      for (const n of ids) {
        const X = rest[n * 3] - Cx, Y = rest[n * 3 + 1] - Cy, Z = rest[n * 3 + 2] - Cz;
        const tx = cx + R[0][0] * X + R[1][0] * Y + R[2][0] * Z;
        const ty = cy + R[0][1] * X + R[1][1] * Y + R[2][1] * Z;
        const tz = cz + R[0][2] * X + R[1][2] * Y + R[2][2] * Z;
        x[n * 3] += 0.25 * (tx - x[n * 3]);
        x[n * 3 + 1] += 0.25 * (ty - x[n * 3 + 1]);
        x[n * 3 + 2] += 0.25 * (tz - x[n * 3 + 2]);
      }
    }
  }

  /** Objective Kelvin-Voigt viscosity, applied explicitly at velocity level. */
  applyViscosity() {
    const { x, v, w, tets, B, vol, kv } = this;
    const eta = this.p.viscosity, h = this.h;
    if (eta <= 0) return;
    for (let e = 0; e < this.m; e++) {
      const i4 = e * 4, o = e * 9;
      const ia = tets[i4], ib = tets[i4 + 1], ic = tets[i4 + 2], id = tets[i4 + 3];
      const a = ia * 3, b = ib * 3, c = ic * 3, d = id * 3;
      const B00 = B[o], B01 = B[o + 1], B02 = B[o + 2], B10 = B[o + 3], B11 = B[o + 4], B12 = B[o + 5], B20 = B[o + 6], B21 = B[o + 7], B22 = B[o + 8];
      const d1x = x[b] - x[a], d1y = x[b + 1] - x[a + 1], d1z = x[b + 2] - x[a + 2];
      const d2x = x[c] - x[a], d2y = x[c + 1] - x[a + 1], d2z = x[c + 2] - x[a + 2];
      const d3x = x[d] - x[a], d3y = x[d + 1] - x[a + 1], d3z = x[d + 2] - x[a + 2];
      const f1x = d1x * B00 + d2x * B10 + d3x * B20, f1y = d1y * B00 + d2y * B10 + d3y * B20, f1z = d1z * B00 + d2z * B10 + d3z * B20;
      const f2x = d1x * B01 + d2x * B11 + d3x * B21, f2y = d1y * B01 + d2y * B11 + d3y * B21, f2z = d1z * B01 + d2z * B11 + d3z * B21;
      const f3x = d1x * B02 + d2x * B12 + d3x * B22, f3y = d1y * B02 + d2y * B12 + d3y * B22, f3z = d1z * B02 + d2z * B12 + d3z * B22;
      const c1x = f2y * f3z - f2z * f3y, c1y = f2z * f3x - f2x * f3z, c1z = f2x * f3y - f2y * f3x;
      const c2x = f3y * f1z - f3z * f1y, c2y = f3z * f1x - f3x * f1z, c2z = f3x * f1y - f3y * f1x;
      const c3x = f1y * f2z - f1z * f2y, c3y = f1z * f2x - f1x * f2z, c3z = f1x * f2y - f1y * f2x;
      const J = f1x * c1x + f1y * c1y + f1z * c1z;
      if (J < 0.25) continue; // Too degenerate for F^-1 to be meaningful; elastic solve recovers it.
      const iJ = 1 / J;

      const v1x = v[b] - v[a], v1y = v[b + 1] - v[a + 1], v1z = v[b + 2] - v[a + 2];
      const v2x = v[c] - v[a], v2y = v[c + 1] - v[a + 1], v2z = v[c + 2] - v[a + 2];
      const v3x = v[d] - v[a], v3y = v[d + 1] - v[a + 1], v3z = v[d + 2] - v[a + 2];
      // Fdot columns.
      const g1x = v1x * B00 + v2x * B10 + v3x * B20, g1y = v1y * B00 + v2y * B10 + v3y * B20, g1z = v1z * B00 + v2z * B10 + v3z * B20;
      const g2x = v1x * B01 + v2x * B11 + v3x * B21, g2y = v1y * B01 + v2y * B11 + v3y * B21, g2z = v1z * B01 + v2z * B11 + v3z * B21;
      const g3x = v1x * B02 + v2x * B12 + v3x * B22, g3y = v1y * B02 + v2y * B12 + v3y * B22, g3z = v1z * B02 + v2z * B12 + v3z * B22;
      // L = Fdot F^-1 = Fdot cof^T / J. Rows of F^-1 are the cofactor columns / J.
      const L00 = (g1x * c1x + g2x * c2x + g3x * c3x) * iJ, L01 = (g1x * c1y + g2x * c2y + g3x * c3y) * iJ, L02 = (g1x * c1z + g2x * c2z + g3x * c3z) * iJ;
      const L10 = (g1y * c1x + g2y * c2x + g3y * c3x) * iJ, L11 = (g1y * c1y + g2y * c2y + g3y * c3y) * iJ, L12 = (g1y * c1z + g2y * c2z + g3y * c3z) * iJ;
      const L20 = (g1z * c1x + g2z * c2x + g3z * c3x) * iJ, L21 = (g1z * c1y + g2z * c2y + g3z * c3y) * iJ, L22 = (g1z * c1z + g2z * c2z + g3z * c3z) * iJ;
      const tr3 = (L00 + L11 + L22) / 3;
      const k = 2 * eta;
      const s00 = k * (L00 - tr3), s11 = k * (L11 - tr3), s22 = k * (L22 - tr3);
      const s01 = eta * (L01 + L10), s02 = eta * (L02 + L20), s12 = eta * (L12 + L21);
      // First Piola stress P = sigma * cof(F); columns:
      const p1x = s00 * c1x + s01 * c1y + s02 * c1z, p1y = s01 * c1x + s11 * c1y + s12 * c1z, p1z = s02 * c1x + s12 * c1y + s22 * c1z;
      const p2x = s00 * c2x + s01 * c2y + s02 * c2z, p2y = s01 * c2x + s11 * c2y + s12 * c2z, p2z = s02 * c2x + s12 * c2y + s22 * c2z;
      const p3x = s00 * c3x + s01 * c3y + s02 * c3z, p3y = s01 * c3x + s11 * c3y + s12 * c3z, p3z = s02 * c3x + s12 * c3y + s22 * c3z;
      const Vh = (-vol[e] * h) / (1 + 2 * kv[e]);
      const i1x = (p1x * B00 + p2x * B01 + p3x * B02) * Vh, i1y = (p1y * B00 + p2y * B01 + p3y * B02) * Vh, i1z = (p1z * B00 + p2z * B01 + p3z * B02) * Vh;
      const i2x = (p1x * B10 + p2x * B11 + p3x * B12) * Vh, i2y = (p1y * B10 + p2y * B11 + p3y * B12) * Vh, i2z = (p1z * B10 + p2z * B11 + p3z * B12) * Vh;
      const i3x = (p1x * B20 + p2x * B21 + p3x * B22) * Vh, i3y = (p1y * B20 + p2y * B21 + p3y * B22) * Vh, i3z = (p1z * B20 + p2z * B21 + p3z * B22) * Vh;
      const wa = w[ia], wb = w[ib], wc = w[ic], wd = w[id];
      v[a] -= wa * (i1x + i2x + i3x); v[a + 1] -= wa * (i1y + i2y + i3y); v[a + 2] -= wa * (i1z + i2z + i3z);
      v[b] += wb * i1x; v[b + 1] += wb * i1y; v[b + 2] += wb * i1z;
      v[c] += wc * i2x; v[c + 1] += wc * i2y; v[c + 2] += wc * i2z;
      v[d] += wd * i3x; v[d + 1] += wd * i3y; v[d + 2] += wd * i3z;
    }
  }

  solveContact() {
    const { x, prev, bonded, bondAge } = this;
    const h = this.h, h2 = h * h;
    const A = this.nodeArea;
    const P = this.p;
    const adhT = P.adhesionTensile * A * h2;   // impulse*h budget per substep
    const adhS = P.adhesionShear * A * h2;
    for (let i = 0; i < this.n; i++) {
      const i3 = i * 3;
      const px = x[i3], pz = x[i3 + 2];
      const r = Math.hypot(px, pz);
      const surf = plateHeight(r);
      const gap = x[i3 + 1] - surf;
      if (gap > 0) {
        if (bonded[i]) {
          // Adhesive tension: tries to keep the bond closed, peels if it can't.
          if (gap * this.mass[i] > adhT) { bonded[i] = 0; bondAge[i] = 0; }
          else x[i3 + 1] -= gap;
        } else bondAge[i] = 0;
        if (gap > 2e-4) continue;
      }

      // Normal response (height-field normal is +Y in the well, tilted on the rim).
      let nx = 0, ny = 1, nz = 0;
      if (r > PLATE.flatR) {
        const s = PLATE_RIM_SLOPE, l = 1 / Math.hypot(1, s);
        nx = (-s * px / r) * l; ny = l; nz = (-s * pz / r) * l;
      }
      const pen = gap < 0 ? -gap * ny : 0;
      if (pen > 0) { x[i3] += nx * pen; x[i3 + 1] += ny * pen; x[i3 + 2] += nz * pen; }
      const lamN = pen * this.mass[i];

      // Friction on the tangential displacement of this substep.
      const dx = x[i3] - prev[i3], dy = x[i3 + 1] - prev[i3 + 1], dz = x[i3 + 2] - prev[i3 + 2];
      const dn = dx * nx + dy * ny + dz * nz;
      const tx = dx - dn * nx, ty = dy - dn * ny, tz = dz - dn * nz;
      const tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
      const slideY = this.isBase[i] ? adhS * P.slideThreshold : 0;
      const limit = P.muStatic * lamN + (bonded[i] ? adhS : slideY);
      const lamT = tl * this.mass[i];
      if (lamT <= limit) {
        x[i3] -= tx; x[i3 + 1] -= ty; x[i3 + 2] -= tz;
        // Only the moulded base re-adheres. Material from higher up that gets pressed against the
        // plate must stay free to lift off again, or flattened elements get glued down for good.
        if (!bonded[i] && this.isBase[i]) {
          bondAge[i] += h;
          if (bondAge[i] > P.rebondSeconds) bonded[i] = 1;
        }
      } else {
        // Slipping: the bond is gone and only dynamic Coulomb friction remains.
        bonded[i] = 0; bondAge[i] = 0;
        const f = Math.min((P.muDynamic * lamN + slideY) / lamT, 1);
        x[i3] -= tx * f; x[i3 + 1] -= ty * f; x[i3 + 2] -= tz * f;
      }
    }
  }

  solveGrab() {
    const g = this.grab;
    if (!g) return;
    const { x, w } = this;
    const h2 = this.h * this.h;
    // Handle follows the cursor through a short low-pass, like a finger with some inertia.
    const a = 1 - Math.exp(-this.h / g.tau);
    g.pos[0] += (g.target[0] - g.pos[0]) * a;
    g.pos[1] += (g.target[1] - g.pos[1]) * a;
    g.pos[2] += (g.target[2] - g.pos[2]) * a;
    // Compute the unclamped correction and the force it implies, then scale to the limit.
    const fmax = g.maxForce;
    let total = 0;
    const N = g.nodes.length;
    const s = g.scratch;
    for (let k = 0; k < N; k++) {
      const i = g.nodes[k], i3 = i * 3;
      const cx = g.pos[0] + g.off[k * 3] - x[i3];
      const cy = g.pos[1] + g.off[k * 3 + 1] - x[i3 + 1];
      const cz = g.pos[2] + g.off[k * 3 + 2] - x[i3 + 2];
      const ks = g.stiff * g.weight[k];
      const at = 1 / (ks * h2);
      const f = w[i] / (w[i] + at);
      s[k * 3] = cx * f; s[k * 3 + 1] = cy * f; s[k * 3 + 2] = cz * f;
      total += (Math.hypot(cx, cy, cz) * f * this.mass[i]) / h2;
    }
    const scale = total > fmax ? fmax / total : 1;
    g.force = Math.min(total, fmax);
    for (let k = 0; k < N; k++) {
      const i3 = g.nodes[k] * 3;
      x[i3] += s[k * 3] * scale; x[i3 + 1] += s[k * 3 + 1] * scale; x[i3 + 2] += s[k * 3 + 2] * scale;
    }
  }

  substep() {
    const { x, v, prev, lamD, lamH } = this;
    const h = this.h, g = this.p.gravity;
    let ax = 0, az = 0;
    if (this.bump) {
      const b = this.bump;
      const t = this.simTime - b.t0;
      if (t < b.T) {
        // Plate displacement D sin^2(pi t/T), so plate-frame fictitious acceleration is -x''.
        const accel = b.D * (2 * Math.PI * Math.PI / (b.T * b.T)) * Math.cos(2 * Math.PI * t / b.T);
        ax = -accel * b.dirX; az = -accel * b.dirZ;
      } else this.bump = null;
    }
    for (let i = 0; i < this.n; i++) {
      const i3 = i * 3;
      v[i3] += h * ax; v[i3 + 1] += h * g; v[i3 + 2] += h * az;
      prev[i3] = x[i3]; prev[i3 + 1] = x[i3 + 1]; prev[i3 + 2] = x[i3 + 2];
      x[i3] += h * v[i3]; x[i3 + 1] += h * v[i3 + 1]; x[i3 + 2] += h * v[i3 + 2];
    }
    lamD.fill(0); lamH.fill(0);
    for (let it = 0; it < this.p.sweeps; it++) {
      this.solveElastic();
      if (this.badCount) this.repairInverted();
      this.flip = !this.flip;
      this.solveVolume();
      this.solveGrab();
      this.solveContact();
    }
    const ih = 1 / h;
    for (let i = 0, N = this.n * 3; i < N; i++) v[i] = (x[i] - prev[i]) * ih;
    this.applyViscosity();
    this.simTime += h;
  }

  step(dt) {
    const n = Math.round(dt / this.h);
    for (let i = 0; i < n; i++) this.substep();
  }

  isHealthy() {
    for (let i = 0, N = this.n * 3; i < N; i++) {
      if (!Number.isFinite(this.x[i]) || Math.abs(this.x[i]) > 5) return false;
    }
    return true;
  }

  reset() {
    this.x.set(this.rest);
    this.v.fill(0);
    this.grab = null;
    this.bump = null;
    for (let i = 0; i < this.n; i++) { this.bonded[i] = this.rest[i * 3 + 1] < 1e-6 ? 1 : 0; this.bondAge[i] = 0; }
  }

  /** Pinch a soft patch of surface material around a hit point. */
  startGrab(p, radius = 0.024, tau = 0.012) {
    const nodes = [], weight = [], off = [];
    const { x } = this;
    const r2 = radius * radius;
    let sum = 0;
    for (let i = 0; i < this.n; i++) {
      const dx = x[i * 3] - p[0], dy = x[i * 3 + 1] - p[1], dz = x[i * 3 + 2] - p[2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < r2) {
        const q = 1 - d2 / r2;
        const wg = q * q;
        nodes.push(i); weight.push(wg); off.push(dx, dy, dz);
        sum += wg;
      }
    }
    if (!nodes.length) return false;
    for (let k = 0; k < weight.length; k++) weight[k] /= sum;
    // Force ceiling tracks the material: stress under the patch can't exceed ~2.2 G of strain,
    // so a soft jelly gets pulled far by little force while a firm one needs real effort.
    const area = Math.PI * radius * radius;
    this.grab = {
      nodes, weight: new Float64Array(weight), off: new Float64Array(off),
      scratch: new Float64Array(nodes.length * 3),
      pos: [p[0], p[1], p[2]], target: [p[0], p[1], p[2]],
      tau, stiff: 3000, force: 0,
      maxForce: Math.min(this.p.maxGrabForce, 2.2 * this.G * area),
    };
    return true;
  }
  moveGrab(t) { if (this.grab) { this.grab.target[0] = t[0]; this.grab.target[1] = t[1]; this.grab.target[2] = t[2]; } }
  endGrab() { this.grab = null; }

  startBump(dirAngle, D = 0.004, T = 0.16) {
    this.bump = { t0: this.simTime, T, D, dirX: Math.cos(dirAngle), dirZ: Math.sin(dirAngle) };
  }
}
