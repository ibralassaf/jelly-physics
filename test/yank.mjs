// Focused look at elements left inverted after violent handling.
import { buildTetMesh } from '../src/tetmesh.js';
import { Jelly, shearFromIntensity } from '../src/sim.js';

const mesh = buildTetMesh();
const n = mesh.positions.length / 3;
for (const s of [0, 0.55, 1]) {
  const j = new Jelly(mesh, { shear: shearFromIntensity(s) });
  j.step(1);
  let top = 0; for (let i = 0; i < n; i++) if (j.x[i * 3 + 1] > j.x[top * 3 + 1]) top = i;
  j.startGrab([j.x[top * 3], j.x[top * 3 + 1], j.x[top * 3 + 2]]);
  for (const t of [[0.08, 0.14, 0], [-0.08, 0.2, 0.05], [0, 0.02, -0.08], [0.1, 0.1, 0.1]]) { j.moveGrab(t); j.step(0.35); }
  const during = j.invertedCount();
  j.endGrab();
  const counts = [];
  for (let k = 0; k < 6; k++) { j.step(0.5); counts.push(j.invertedCount()); }
  const out = [];
  const { x, tets } = j;
  for (let e = 0; e < j.m; e++) {
    const a = tets[e * 4] * 3, b = tets[e * 4 + 1] * 3, c = tets[e * 4 + 2] * 3, d = tets[e * 4 + 3] * 3;
    const u = [x[b] - x[a], x[b + 1] - x[a + 1], x[b + 2] - x[a + 2]];
    const v = [x[c] - x[a], x[c + 1] - x[a + 1], x[c + 2] - x[a + 2]];
    const w = [x[d] - x[a], x[d + 1] - x[a + 1], x[d + 2] - x[a + 2]];
    const det = u[0] * (v[1] * w[2] - v[2] * w[1]) - u[1] * (v[0] * w[2] - v[2] * w[0]) + u[2] * (v[0] * w[1] - v[1] * w[0]);
    const J = det / 6 / j.vol[e];
    if (J <= 0) {
      const ys = [a, b, c, d].map((q) => (x[q + 1] * 1000).toFixed(1));
      const restY = [a, b, c, d].map((q) => (j.rest[q + 1] * 1000).toFixed(1));
      out.push(`J=${J.toFixed(3)} y=[${ys}] restY=[${restY}] restV=${(j.vol[e] * 1e9).toFixed(0)}mm3`);
    }
  }
  console.log(`s=${s} during=${during} after 0.5..3s: ${counts.join(',')}`);
  out.slice(0, 8).forEach((l) => console.log('   ' + l));
}
