// Isolates sources of energy injection: traces height, kinetic energy and volume over time.
import { buildTetMesh } from '../src/tetmesh.js';
import { Jelly } from '../src/sim.js';
import { H } from '../src/shape.js';

const mesh = buildTetMesh();
const n = mesh.positions.length / 3;

function trace(label, opts, setup) {
  const j = new Jelly(mesh, { shear: 634, ...opts });
  if (opts.noVolume) j.solveVolume = () => {};
  if (setup) setup(j);
  const V0 = j.totalVolume();
  const rows = [];
  for (let t = 0; t < 8; t += 1) {
    let maxKE = 0;
    for (let k = 0; k < 20; k++) { j.step(0.05); maxKE = Math.max(maxKE, j.kineticEnergy()); }
    let top = 0, rad = 0, bonded = 0;
    for (let i = 0; i < n; i++) {
      top = Math.max(top, j.x[i * 3 + 1]);
      rad = Math.max(rad, Math.hypot(j.x[i * 3], j.x[i * 3 + 2]));
      bonded += j.bonded[i];
    }
    rows.push(`${(top / H * 100).toFixed(1)}%/${(rad * 1000).toFixed(0)}mm/${(maxKE * 1000).toFixed(2)}mJ/${((j.totalVolume() / V0 - 1) * 100).toFixed(2)}%/b${bonded}`);
  }
  console.log(`${label}\n  ${rows.join('  ')}`);
}

console.log('each column: top height as % of rest / max radius / peak KE in the last second / volume change / bonded nodes');
trace('G=6000', { shear: 6000 });
trace('G=2000', { shear: 2000 });
trace('G=634', {});
trace('G=300', { shear: 300 });
trace('G=634 no viscosity', { viscosity: 0 });
trace('G=634 at 1920 Hz (reference)', { substepHz: 1920 });
trace('G=300 at 1920 Hz (reference)', { shear: 300, substepHz: 1920 });
