// Drives the smooth display mesh from the coarse simulation nodes with moving least squares.
// Plain barycentric embedding shows the tet cage as creases in the highlights; MLS weights are
// smooth and reproduce any affine motion exactly, so highlights stay continuous as it deforms.

const KNN = 16;

function solve4(A, b) {
  // Symmetric 4x4 Gaussian elimination with pivoting, used only at bake time.
  const M = [
    [A[0], A[1], A[2], A[3], b[0]],
    [A[1], A[4], A[5], A[6], b[1]],
    [A[2], A[5], A[7], A[8], b[2]],
    [A[3], A[6], A[8], A[9], b[3]],
  ];
  for (let c = 0; c < 4; c++) {
    let piv = c;
    for (let r = c + 1; r < 4; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c][c] || 1e-20;
    for (let r = c + 1; r < 4; r++) {
      const f = M[r][c] / d;
      for (let k = c; k < 5; k++) M[r][k] -= f * M[c][k];
    }
  }
  const out = [0, 0, 0, 0];
  for (let r = 3; r >= 0; r--) {
    let v = M[r][4];
    for (let k = r + 1; k < 4; k++) v -= M[r][k] * out[k];
    out[r] = v / (M[r][r] || 1e-20);
  }
  return out;
}

export function bakeSkin(surfacePositions, nodePositions) {
  const nv = surfacePositions.length / 3, nn = nodePositions.length / 3;
  const ids = new Uint32Array(nv * KNN);
  const wts = new Float32Array(nv * KNN);
  const order = new Int32Array(nn);
  const dist = new Float64Array(nn);
  for (let v = 0; v < nv; v++) {
    const px = surfacePositions[v * 3], py = surfacePositions[v * 3 + 1], pz = surfacePositions[v * 3 + 2];
    for (let i = 0; i < nn; i++) {
      const dx = nodePositions[i * 3] - px, dy = nodePositions[i * 3 + 1] - py, dz = nodePositions[i * 3 + 2] - pz;
      dist[i] = dx * dx + dy * dy + dz * dz;
      order[i] = i;
    }
    // Partial selection of the KNN closest nodes.
    for (let k = 0; k < KNN; k++) {
      let best = k;
      for (let i = k + 1; i < nn; i++) if (dist[order[i]] < dist[order[best]]) best = i;
      const t = order[k]; order[k] = order[best]; order[best] = t;
    }
    const support = Math.sqrt(dist[order[KNN - 1]]) * 1.05;
    // Weighted normal equations for a linear basis [1, dx, dy, dz].
    const A = new Float64Array(10);
    const w = new Float64Array(KNN);
    const scale = 1 / support;
    const bases = [];
    for (let k = 0; k < KNN; k++) {
      const i = order[k];
      const bx = (nodePositions[i * 3] - px) * scale, by = (nodePositions[i * 3 + 1] - py) * scale, bz = (nodePositions[i * 3 + 2] - pz) * scale;
      const q = Math.min(Math.sqrt(bx * bx + by * by + bz * bz), 1);
      const wg = Math.pow(1 - q, 4) * (4 * q + 1); // Wendland C2 kernel
      w[k] = wg;
      bases.push([1, bx, by, bz]);
      const b = bases[k];
      A[0] += wg; A[1] += wg * b[1]; A[2] += wg * b[2]; A[3] += wg * b[3];
      A[4] += wg * b[1] * b[1]; A[5] += wg * b[1] * b[2]; A[6] += wg * b[1] * b[3];
      A[7] += wg * b[2] * b[2]; A[8] += wg * b[2] * b[3];
      A[9] += wg * b[3] * b[3];
    }
    // Tiny Tikhonov term keeps flat neighbourhoods (the base disc) well conditioned.
    A[0] += 1e-9; A[4] += 1e-7; A[7] += 1e-7; A[9] += 1e-7;
    // shape weights = w * b^T * A^-1 * e0
    const c = solve4(A, [1, 0, 0, 0]);
    for (let k = 0; k < KNN; k++) {
      const b = bases[k];
      ids[v * KNN + k] = order[k];
      wts[v * KNN + k] = w[k] * (c[0] + c[1] * b[1] + c[2] * b[2] + c[3] * b[3]);
    }
  }
  return { ids, wts, nv };
}

/** Evaluate node positions onto the surface, then recompute smooth area-weighted normals. */
export function applySkin(skin, nodes, index, outPos, outNormal) {
  const { ids, wts, nv } = skin;
  for (let v = 0; v < nv; v++) {
    let x = 0, y = 0, z = 0;
    const o = v * KNN;
    for (let k = 0; k < KNN; k++) {
      const i = ids[o + k] * 3, w = wts[o + k];
      x += nodes[i] * w; y += nodes[i + 1] * w; z += nodes[i + 2] * w;
    }
    outPos[v * 3] = x; outPos[v * 3 + 1] = y; outPos[v * 3 + 2] = z;
  }
  outNormal.fill(0);
  const P = outPos, N = outNormal;
  for (let f = 0, m = index.length; f < m; f += 3) {
    const a = index[f] * 3, b = index[f + 1] * 3, c = index[f + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    N[a] += nx; N[a + 1] += ny; N[a + 2] += nz;
    N[b] += nx; N[b + 1] += ny; N[b + 2] += nz;
    N[c] += nx; N[c + 1] += ny; N[c + 2] += nz;
  }
  for (let v = 0; v < nv; v++) {
    const i = v * 3;
    const l = 1 / (Math.hypot(N[i], N[i + 1], N[i + 2]) || 1);
    N[i] *= l; N[i + 1] *= l; N[i + 2] *= l;
  }
}
