// Volumetric mesh: J1 (reflected Kuhn) lattice clipped to the shape, boundary snapped to the
// surface. The y=0 lattice layer gives a perfectly flat base that sits on the plate.
import { H, R0, isInside, projectToSurface } from './shape.js';

const PERMS = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];

function tetVolume(p, a, b, c, d) {
  const ax = p[a * 3], ay = p[a * 3 + 1], az = p[a * 3 + 2];
  const ux = p[b * 3] - ax, uy = p[b * 3 + 1] - ay, uz = p[b * 3 + 2] - az;
  const vx = p[c * 3] - ax, vy = p[c * 3 + 1] - ay, vz = p[c * 3 + 2] - az;
  const wx = p[d * 3] - ax, wy = p[d * 3 + 1] - ay, wz = p[d * 3 + 2] - az;
  return (ux * (vy * wz - vz * wy) - uy * (vx * wz - vz * wx) + uz * (vx * wy - vy * wx)) / 6;
}

export function buildTetMesh(dx = 0.0085) {
  const nx = Math.ceil((R0 * 1.15) / dx);
  const ny = Math.ceil((H * 1.05) / dx);
  const idOf = new Map();
  const pos = [];
  const node = (i, j, k) => {
    const key = (i + 1000) * 4000000 + j * 2000 + (k + 1000);
    let id = idOf.get(key);
    if (id === undefined) {
      id = pos.length / 3;
      pos.push(i * dx, j * dx, k * dx);
      idOf.set(key, id);
    }
    return id;
  };

  let tets = [];
  for (let k = -nx; k < nx; k++) for (let j = 0; j < ny; j++) for (let i = -nx; i < nx; i++) {
    // Reflect each cell by coordinate parity, which makes neighbouring faces conform.
    const rx = i & 1, ry = j & 1, rz = k & 1;
    const corner = (b) => node(i + (b[0] ^ rx), j + (b[1] ^ ry), k + (b[2] ^ rz));
    for (const perm of PERMS) {
      const b = [0, 0, 0];
      const ids = [corner(b)];
      for (let s = 0; s < 3; s++) {
        b[perm[s]] = 1;
        ids.push(corner(b));
      }
      let cx = 0, cy = 0, cz = 0;
      for (const id of ids) { cx += pos[id * 3] / 4; cy += pos[id * 3 + 1] / 4; cz += pos[id * 3 + 2] / 4; }
      if (isInside(cx, cy, cz)) tets.push(ids);
    }
  }

  // Boundary faces identify the nodes to snap.
  const boundaryNodes = (ts) => {
    const faces = new Map();
    const F = [[1, 2, 3], [0, 3, 2], [0, 1, 3], [0, 2, 1]];
    for (const t of ts) for (const f of F) {
      const ids = [t[f[0]], t[f[1]], t[f[2]]].sort((a, b) => a - b);
      const key = ids.join('_');
      faces.set(key, (faces.get(key) || 0) + 1);
    }
    const set = new Set();
    for (const [key, c] of faces) if (c === 1) key.split('_').forEach((s) => set.add(+s));
    return set;
  };

  const boundary = boundaryNodes(tets);
  for (const id of boundary) {
    const y = pos[id * 3 + 1];
    // Interior nodes of the flat base stay put; only its rim is pulled to the outline.
    if (y <= 1e-9) {
      const rNode = Math.hypot(pos[id * 3], pos[id * 3 + 2]);
      if (rNode < R0 * 0.82) continue;
    }
    const q = projectToSurface([pos[id * 3], y, pos[id * 3 + 2]]);
    pos[id * 3] = q[0]; pos[id * 3 + 1] = q[1]; pos[id * 3 + 2] = q[2];
  }

  // Relax interior nodes so snapping doesn't leave crushed elements behind.
  const neighbours = new Map();
  for (const t of tets) for (const a of t) for (const b of t) if (a !== b) {
    if (!neighbours.has(a)) neighbours.set(a, new Set());
    neighbours.get(a).add(b);
  }
  for (let it = 0; it < 6; it++) for (const [id, ns] of neighbours) {
    if (boundary.has(id) || pos[id * 3 + 1] <= 1e-9) continue;
    let sx = 0, sy = 0, sz = 0;
    for (const n of ns) { sx += pos[n * 3]; sy += pos[n * 3 + 1]; sz += pos[n * 3 + 2]; }
    const c = ns.size;
    pos[id * 3] += 0.5 * (sx / c - pos[id * 3]);
    pos[id * 3 + 1] += 0.5 * (sy / c - pos[id * 3 + 1]);
    pos[id * 3 + 2] += 0.5 * (sz / c - pos[id * 3 + 2]);
  }

  // Fix orientation and drop slivers.
  const minVol = 0.03 * dx * dx * dx;
  tets = tets.map((t) => (tetVolume(pos, t[0], t[1], t[2], t[3]) < 0 ? [t[0], t[2], t[1], t[3]] : t))
    .filter((t) => tetVolume(pos, t[0], t[1], t[2], t[3]) > minVol);

  // Compact nodes, then sort spatially for cache-friendly sweeps.
  const used = [...new Set(tets.flat())];
  used.sort((a, b) => pos[a * 3 + 1] - pos[b * 3 + 1] || pos[a * 3] - pos[b * 3] || pos[a * 3 + 2] - pos[b * 3 + 2]);
  const remap = new Map(used.map((id, i) => [id, i]));
  const positions = new Float64Array(used.length * 3);
  used.forEach((id, i) => {
    positions[i * 3] = pos[id * 3]; positions[i * 3 + 1] = pos[id * 3 + 1]; positions[i * 3 + 2] = pos[id * 3 + 2];
  });
  const flat = tets.map((t) => t.map((n) => remap.get(n)));
  flat.sort((a, b) => Math.min(...a) - Math.min(...b));
  const indices = new Uint32Array(flat.flat());

  return { positions, tets: indices, dx };
}
