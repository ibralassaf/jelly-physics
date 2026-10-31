// Physics runs here so rendering and input never block a substep.
import { buildTetMesh } from './tetmesh.js';
import { Jelly, shearFromIntensity } from './sim.js';

const mesh = buildTetMesh();
const jelly = new Jelly(mesh, { shear: shearFromIntensity(0.55) });
let debt = 0;
let pokeUntil = 0;

function publish(busyMs, simulated) {
  const x = new Float32Array(jelly.n * 3);
  for (let i = 0; i < x.length; i++) x[i] = jelly.x[i];
  postMessage({
    t: 'x', x, busyMs, simulated,
    force: jelly.grab ? jelly.grab.force : 0,
  }, [x.buffer]);
}

postMessage({
  t: 'ready',
  rest: new Float32Array(jelly.rest),
  stats: { nodes: jelly.n, tets: jelly.m, hz: jelly.p.substepHz, mass: jelly.mass.reduce((a, b) => a + b, 0) },
});

onmessage = ({ data: d }) => {
  switch (d.t) {
    case 'frame': {
      const t0 = performance.now();
      // Never fall into a death spiral: at most 25 ms of sim per frame, the excess becomes slow-mo.
      debt = Math.min(debt + d.dt, 0.025);
      const h = jelly.h;
      let done = 0;
      const budgetMs = 22;
      while (debt >= h && performance.now() - t0 < budgetMs) {
        jelly.substep();
        debt -= h;
        done += h;
        if (pokeUntil && jelly.simTime > pokeUntil) { jelly.endGrab(); pokeUntil = 0; }
      }
      if (debt >= h) debt = 0;
      if (!jelly.isHealthy()) jelly.reset();
      publish(performance.now() - t0, done);
      break;
    }
    case 'shear': jelly.setShear(shearFromIntensity(d.s)); break;
    case 'grab': pokeUntil = 0; jelly.startGrab(d.p, d.radius); break;
    case 'move': jelly.moveGrab(d.p); break;
    case 'release': if (!pokeUntil) jelly.endGrab(); break;
    case 'poke': {
      // A quick fingertip tap: press in along the view ray, then let go.
      if (jelly.startGrab(d.p, 0.018, 0.018)) {
        jelly.moveGrab([d.p[0] + d.dir[0] * 0.024, d.p[1] + d.dir[1] * 0.024, d.p[2] + d.dir[2] * 0.024]);
        pokeUntil = jelly.simTime + 0.075;
      }
      break;
    }
    case 'bump': jelly.startBump(Math.random() * Math.PI * 2); break;
    case 'reset': jelly.reset(); break;
  }
};
