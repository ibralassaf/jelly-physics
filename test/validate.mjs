// Headless physics validation. Prints measured numbers, exits non-zero on any failed check.
//   node test/validate.mjs
import { buildTetMesh } from '../src/tetmesh.js';
import { Jelly, shearFromIntensity } from '../src/sim.js';
import { H } from '../src/shape.js';
import { WobbleDetector } from '../src/wobble.js';

const mesh = buildTetMesh();
const fails = [];
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); if (!ok) fails.push(name); };

const n = mesh.positions.length / 3, m = mesh.tets.length / 4;
const probe = new Jelly(mesh, { shear: 2000 });
const V0 = probe.totalVolume();
let massTotal = 0; for (let i = 0; i < n; i++) massTotal += probe.mass[i];
console.log(`mesh: ${n} nodes, ${m} tets, V=${(V0 * 1e6).toFixed(0)} ml, mass=${massTotal.toFixed(3)} kg, base area/node=${(probe.nodeArea * 1e4).toFixed(2)} cm2`);
let minV = Infinity; for (let e = 0; e < m; e++) minV = Math.min(minV, probe.vol[e]);
check('tet quality', minV > 0, `min tet volume ${(minV * 1e9).toFixed(1)} mm3, mean ${(V0 / m * 1e9).toFixed(1)} mm3`);

const topNodes = [];
for (let i = 0; i < n; i++) if (mesh.positions[i * 3 + 1] > H * 0.75) topNodes.push(i);
const topAvg = (j, a) => { let s = 0; for (const i of topNodes) s += j.x[i * 3 + a]; return s / topNodes.length; };
const topHeight = (j) => { let y = 0; for (let i = 0; i < n; i++) y = Math.max(y, j.x[i * 3 + 1]); return y; };

function settle(j, seconds = 2.5) { j.step(seconds); return j; }

// Bump sideways and record the top: zero crossings of the detrended signal give frequency,
// the envelope gives decay. Detrending matters because the body may creep slightly on the plate.
function ringdown(j, seconds) {
  j.startBump(0);
  j.step(0.2);
  const dt = 1 / 240, raw = [];
  for (let t = 0; t < seconds; t += dt) { j.step(dt); raw.push(topAvg(j, 0)); }
  const tail = raw.slice(raw.length >> 1);
  const mean = tail.reduce((a, b) => a + b, 0) / tail.length;
  const tr = raw.map((v) => v - mean);
  const crossings = [], peaks = [];
  for (let i = 1; i < tr.length; i++) if (tr[i - 1] < 0 && tr[i] >= 0) crossings.push(i * dt);
  for (let i = 2; i < tr.length; i++) {
    const a = Math.abs(tr[i - 2]), b = Math.abs(tr[i - 1]), c = Math.abs(tr[i]);
    if (b >= a && b > c && Math.sign(tr[i - 1]) === Math.sign(tr[i])) peaks.push({ t: (i - 1) * dt, a: b });
  }
  // DFT peak from 0.5 to 20 Hz. More robust than crossings when several modes ring at once.
  let f = 0, best = 0;
  for (let q = 0.5; q <= 20; q += 0.02) {
    let re = 0, im = 0;
    for (let i = 0; i < tr.length; i++) { const a = 2 * Math.PI * q * i * dt; re += tr[i] * Math.cos(a); im += tr[i] * Math.sin(a); }
    const p = re * re + im * im;
    if (p > best) { best = p; f = q; }
  }
  const peak0 = peaks.length ? Math.max(...peaks.slice(0, 3).map((p) => p.a)) : 0;
  const start = peaks.findIndex((p) => p.a === peak0);
  const end = peaks.findIndex((p, i) => i > start && p.a < peak0 * 0.1);
  const t10 = end >= 0 ? peaks[end].t - peaks[start].t : Infinity;
  const zeta = t10 < Infinity && f > 0 ? Math.log(10) / (2 * Math.PI * f * t10) : NaN;
  return { f, peak0, t10, zeta };
}

// Rest stress: with gravity off, the rest pose must stay exactly the rest pose.
{
  const j = new Jelly(mesh, { shear: 2000, gravity: 0 });
  j.step(0.5);
  let maxD = 0;
  for (let i = 0; i < n * 3; i++) maxD = Math.max(maxD, Math.abs(j.x[i] - j.rest[i]));
  check('zero rest stress', maxD < 1e-6, `max drift ${(maxD * 1e6).toFixed(3)} um after 0.5 s`);
}

// Viscosity must be objective: a rigid velocity field, in a rotated pose, must feel exactly zero
// viscous force. Any non-objective damping (velocity scaling, using Fdot alone) fails this hard.
{
  const j = new Jelly(mesh, { shear: 2000, gravity: 0, viscosity: 2 });
  const c = Math.cos(0.9), s = Math.sin(0.9);
  for (let i = 0; i < n; i++) {
    const x = j.rest[i * 3], y = j.rest[i * 3 + 1], z = j.rest[i * 3 + 2];
    j.x[i * 3] = c * x + s * z; j.x[i * 3 + 1] = y; j.x[i * 3 + 2] = -s * x + c * z;
    j.v[i * 3] = 3 * j.x[i * 3 + 2]; j.v[i * 3 + 1] = 0.5; j.v[i * 3 + 2] = -3 * j.x[i * 3];
  }
  const before = j.v.slice();
  j.applyViscosity();
  let maxDv = 0;
  for (let i = 0; i < n * 3; i++) maxDv = Math.max(maxDv, Math.abs(j.v[i] - before[i]));
  check('viscosity objective', maxDv < 1e-9, `max velocity change ${maxDv.toExponential(2)} m/s under rigid motion`);
}
// A free spin must not gain energy, the failure mode that produced chaos in early versions.
{
  const j = new Jelly(mesh, { shear: 2000, gravity: 0, viscosity: 0 });
  for (let i = 0; i < n; i++) {
    j.x[i * 3 + 1] += 0.5;
    j.bonded[i] = 0;
    const x = j.x[i * 3], z = j.x[i * 3 + 2];
    j.v[i * 3] = -z * 8; j.v[i * 3 + 2] = x * 8;
  }
  const E0 = j.kineticEnergy();
  j.step(0.25);
  const ratio = j.kineticEnergy() / E0;
  check('no energy injection', ratio < 1.02, `KE ratio ${ratio.toFixed(4)} after a free spin`);
}

// Sag, volume conservation and frequency across the slider.
const results = [];
for (const s of [0, 0.25, 0.5, 0.75, 1]) {
  const G = shearFromIntensity(s);
  const j = settle(new Jelly(mesh, { shear: G }), 6);
  const y0 = topHeight(j);
  const sag = 1 - y0 / H;
  const vol = j.totalVolume() / V0 - 1;
  const inv = j.invertedCount();
  const KE = j.kineticEnergy();
  const { f, peak0, t10, zeta } = ringdown(j, 6);
  results.push({ s, G, sag, vol, inv, f, peak0, t10, zeta, KE });
  check(`slider ${s}: healthy`, j.isHealthy(), '');
}
console.log('\n s     G(Pa)    sag%   dV%     inverted   f(Hz)  f/sqrtG   amp(mm)  t10%(s)  zeta');
for (const r of results) {
  console.log(`${r.s.toFixed(2)}  ${r.G.toFixed(0).padStart(6)}  ${(r.sag * 100).toFixed(1).padStart(5)}  ${(r.vol * 100).toFixed(2).padStart(5)}  ${String(r.inv).padStart(8)}  ${r.f.toFixed(2).padStart(6)}  ${(r.f / Math.sqrt(r.G)).toFixed(4)}  ${(r.peak0 * 1000).toFixed(1).padStart(6)}  ${r.t10.toFixed(2).padStart(6)}  ${r.zeta.toFixed(3)}`);
}
console.log('');
for (const r of results) {
  check(`volume s=${r.s}`, Math.abs(r.vol) < 0.01, `dV ${(r.vol * 100).toFixed(2)}%`);
  check(`no inverted s=${r.s}`, r.inv === 0, `${r.inv} tets`);
}
const firm = results[0], soft = results[results.length - 1];
check('sag sensible at firm end', firm.sag < 0.05, `${(firm.sag * 100).toFixed(1)}%`);
check('still stands at soft end', soft.sag < 0.45, `${(soft.sag * 100).toFixed(1)}%`);
// f ~ sqrt(G/rho)/L: linear elasticity says f/sqrt(G) is constant for small motion.
const ratio = (results[0].f / Math.sqrt(results[0].G)) / (results[2].f / Math.sqrt(results[2].G));
check('frequency scales with sqrt(G)', Math.abs(ratio - 1) < 0.2, `ratio firm/mid of f/sqrt(G) = ${ratio.toFixed(3)}`);

// Convergence: halving the time step must not change the measured frequency much.
{
  const G = 2000;
  const measure = (hz, sweeps) => {
    const j = new Jelly(mesh, { shear: G, substepHz: hz, sweeps });
    j.step(2.5);
    const sag = 1 - topHeight(j) / H;
    return { ...ringdown(j, 3), sag };
  };
  const a = measure(960, 1), b = measure(1920, 2);
  console.log(`convergence: 960Hz x1 f=${a.f.toFixed(2)}Hz sag=${(a.sag*100).toFixed(1)}% zeta=${a.zeta.toFixed(3)} | 1920Hz x2 f=${b.f.toFixed(2)}Hz sag=${(b.sag*100).toFixed(1)}% zeta=${b.zeta.toFixed(3)}`);
  check('time-step convergence of frequency', Math.abs(a.f / b.f - 1) < 0.12, `${((a.f / b.f - 1) * 100).toFixed(1)}% difference`);
}

// Rough handling: yank hard at every slider end, nothing may blow up.
for (const s of [0, 1]) {
  const j = settle(new Jelly(mesh, { shear: shearFromIntensity(s) }), 1);
  let top = 0; for (let i = 0; i < n; i++) if (j.x[i * 3 + 1] > j.x[top * 3 + 1]) top = i;
  j.startGrab([j.x[top * 3], j.x[top * 3 + 1], j.x[top * 3 + 2]]);
  const seq = [[0.08, 0.14, 0], [-0.08, 0.2, 0.05], [0, 0.02, -0.08], [0.1, 0.1, 0.1]];
  let maxV = 0;
  for (const t of seq) {
    j.moveGrab(t); j.step(0.35);
    for (let i = 0; i < j.n * 3; i++) maxV = Math.max(maxV, Math.abs(j.v[i]));
  }
  const invDuring = j.invertedCount();
  const force = j.grab.force;
  j.endGrab();
  j.step(2.5);
  check(`yank s=${s} stable`, j.isHealthy() && maxV < 30, `max |v| ${maxV.toFixed(1)} m/s, inverted during ${invDuring}, force ${force.toFixed(1)} N`);
  check(`yank s=${s} recovers`, j.invertedCount() === 0, `${j.invertedCount()} inverted after 2.5 s`);
}

// Settled body must look still: frame-to-frame node motion well under a pixel at 1080p.
for (const s of [0, 1]) {
  const j = settle(new Jelly(mesh, { shear: shearFromIntensity(s) }), 5);
  const a = j.x.slice();
  j.step(1 / 60);
  let maxD = 0;
  for (let i = 0; i < n; i++) maxD = Math.max(maxD, Math.hypot(j.x[i * 3] - a[i * 3], j.x[i * 3 + 1] - a[i * 3 + 1], j.x[i * 3 + 2] - a[i * 3 + 2]));
  check(`rest jitter s=${s}`, maxD < 2e-4, `${(maxD * 1e6).toFixed(0)} um per frame at worst node`);
}

// Sound: one event per real oscillation, fading with the ring-down, and silence at rest.
// Speed is measured the way src/worker.js does it, from movement across each 60 Hz frame.
for (const s of [0, 0.25, 0.5, 0.55, 0.75, 1]) {
  const G = shearFromIntensity(s);
  const j = settle(new Jelly(mesh, { shear: G }), 9);
  const det = new WobbleDetector();
  const dt = 1 / 60;
  const topMean = () => {
    const p = [0, 0, 0];
    for (const i of topNodes) { p[0] += j.x[i * 3]; p[1] += j.x[i * 3 + 1]; p[2] += j.x[i * 3 + 2]; }
    return p.map((c) => c / topNodes.length);
  };
  let last = topMean();
  let maxSpeed = 0;
  const run = (seconds) => {
    const levels = [];
    maxSpeed = 0;
    for (let t = 0; t < seconds; t += dt) {
      j.step(dt);
      const now = topMean();
      const v = [(now[0] - last[0]) / dt, (now[1] - last[1]) / dt, (now[2] - last[2]) / dt];
      last = now;
      maxSpeed = Math.max(maxSpeed, Math.hypot(v[0], v[1], v[2]));
      const level = det.update(v, dt, G);
      if (level > 0) levels.push(level);
    }
    return levels;
  };
  const peels0 = j.peelCount;
  const idle = run(3);
  check(`sound silent at rest s=${s}`, idle.length === 0 && j.peelCount === peels0 && maxSpeed < 0.002, `${idle.length} blubs, ${j.peelCount - peels0} peels in 3 s; top speed ${(maxSpeed * 1000).toFixed(3)} mm/s vs 4 mm/s threshold`);
  j.startBump(0);
  const ring = run(1.5);
  const expected = 0.098 * Math.sqrt(G) * 1.5;
  check(`sound tracks wobble s=${s}`, ring.length >= expected * 0.55 && ring.length <= expected * 1.45, `${ring.length} blubs in 1.5 s, oscillation predicts ${expected.toFixed(1)}; levels ${ring.map((l) => l.toFixed(2)).join(' ')}`);
  const later = run(6);
  const tail = run(3);
  check(`sound dies away s=${s}`, tail.length === 0, `${later.length} more blubs, then ${tail.length} in the last 3 s`);
}
// Pulling hard enough must actually peel the base, or the sticky ticks would never play.
{
  const j = settle(new Jelly(mesh, { shear: shearFromIntensity(0.5) }), 3);
  let top = 0; for (let i = 0; i < n; i++) if (j.x[i * 3 + 1] > j.x[top * 3 + 1]) top = i;
  const before = j.peelCount;
  j.startGrab([j.x[top * 3], j.x[top * 3 + 1], j.x[top * 3 + 2]]);
  j.moveGrab([0.12, 0.16, 0]);
  j.step(0.8);
  check('hard pull peels the base', j.peelCount > before, `${j.peelCount - before} bonds broken`);
}

// Throughput, the number that decides whether real time is possible.
{
  const j = new Jelly(mesh, { shear: 2000 });
  j.step(0.5);
  const t0 = performance.now();
  const steps = 960;
  for (let i = 0; i < steps; i++) j.substep();
  const ms = (performance.now() - t0) / steps;
  const budget = 1000 / 960;
  // Shared CI runners take about twice as long as a desktop, so CI only catches serious slowdowns.
  const limit = process.env.CI ? 2 : 0.75;
  check('faster than real time', ms < budget * limit, `${ms.toFixed(3)} ms per substep vs ${budget.toFixed(3)} ms budget (${(ms / budget * 100).toFixed(0)}% of a core, limit ${(limit * 100).toFixed(0)}%)`);
}

console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall checks passed');
process.exit(fails.length ? 1 : 0);
