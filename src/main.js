import { buildSurfaceMesh } from './shape.js';
import { bakeSkin, applySkin } from './skin.js';
import { Renderer, JELLY_COLORS } from './render.js';
import { shearFromIntensity } from './sim.js';
import { JellyAudio } from './audio.js';
import { WobbleDetector } from './wobble.js';

const $ = (id) => document.getElementById(id);
const canvas = $('view');

// ---- small matrix helpers -------------------------------------------------
const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

function mul4(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}
function invert4(m) {
  const a = Array.from(m), inv = new Array(16);
  inv[0] = a[5]*a[10]*a[15]-a[5]*a[11]*a[14]-a[9]*a[6]*a[15]+a[9]*a[7]*a[14]+a[13]*a[6]*a[11]-a[13]*a[7]*a[10];
  inv[4] = -a[4]*a[10]*a[15]+a[4]*a[11]*a[14]+a[8]*a[6]*a[15]-a[8]*a[7]*a[14]-a[12]*a[6]*a[11]+a[12]*a[7]*a[10];
  inv[8] = a[4]*a[9]*a[15]-a[4]*a[11]*a[13]-a[8]*a[5]*a[15]+a[8]*a[7]*a[13]+a[12]*a[5]*a[11]-a[12]*a[7]*a[9];
  inv[12] = -a[4]*a[9]*a[14]+a[4]*a[10]*a[13]+a[8]*a[5]*a[14]-a[8]*a[6]*a[13]-a[12]*a[5]*a[10]+a[12]*a[6]*a[9];
  inv[1] = -a[1]*a[10]*a[15]+a[1]*a[11]*a[14]+a[9]*a[2]*a[15]-a[9]*a[3]*a[14]-a[13]*a[2]*a[11]+a[13]*a[3]*a[10];
  inv[5] = a[0]*a[10]*a[15]-a[0]*a[11]*a[14]-a[8]*a[2]*a[15]+a[8]*a[3]*a[14]+a[12]*a[2]*a[11]-a[12]*a[3]*a[10];
  inv[9] = -a[0]*a[9]*a[15]+a[0]*a[11]*a[13]+a[8]*a[1]*a[15]-a[8]*a[3]*a[13]-a[12]*a[1]*a[11]+a[12]*a[3]*a[9];
  inv[13] = a[0]*a[9]*a[14]-a[0]*a[10]*a[13]-a[8]*a[1]*a[14]+a[8]*a[2]*a[13]+a[12]*a[1]*a[10]-a[12]*a[2]*a[9];
  inv[2] = a[1]*a[6]*a[15]-a[1]*a[7]*a[14]-a[5]*a[2]*a[15]+a[5]*a[3]*a[14]+a[13]*a[2]*a[7]-a[13]*a[3]*a[6];
  inv[6] = -a[0]*a[6]*a[15]+a[0]*a[7]*a[14]+a[4]*a[2]*a[15]-a[4]*a[3]*a[14]-a[12]*a[2]*a[7]+a[12]*a[3]*a[6];
  inv[10] = a[0]*a[5]*a[15]-a[0]*a[7]*a[13]-a[4]*a[1]*a[15]+a[4]*a[3]*a[13]+a[12]*a[1]*a[7]-a[12]*a[3]*a[5];
  inv[14] = -a[0]*a[5]*a[14]+a[0]*a[6]*a[13]+a[4]*a[1]*a[14]-a[4]*a[2]*a[13]-a[12]*a[1]*a[6]+a[12]*a[2]*a[5];
  inv[3] = -a[1]*a[6]*a[11]+a[1]*a[7]*a[10]+a[5]*a[2]*a[11]-a[5]*a[3]*a[10]-a[9]*a[2]*a[7]+a[9]*a[3]*a[6];
  inv[7] = a[0]*a[6]*a[11]-a[0]*a[7]*a[10]-a[4]*a[2]*a[11]+a[4]*a[3]*a[10]+a[8]*a[2]*a[7]-a[8]*a[3]*a[6];
  inv[11] = -a[0]*a[5]*a[11]+a[0]*a[7]*a[9]+a[4]*a[1]*a[11]-a[4]*a[3]*a[9]-a[8]*a[1]*a[7]+a[8]*a[3]*a[5];
  inv[15] = a[0]*a[5]*a[10]-a[0]*a[6]*a[9]-a[4]*a[1]*a[10]+a[4]*a[2]*a[9]+a[8]*a[1]*a[6]-a[8]*a[2]*a[5];
  const det = a[0]*inv[0]+a[1]*inv[4]+a[2]*inv[8]+a[3]*inv[12];
  const o = new Float32Array(16);
  for (let i = 0; i < 16; i++) o[i] = inv[i] / det;
  return o;
}

// ---- camera ---------------------------------------------------------------
const orbit = { yaw: 0.62, pitch: 0.42, dist: 0.46 };
const target = [0, 0.028, 0];
const cam = {};
function updateCamera() {
  const cp = Math.cos(orbit.pitch), sp = Math.sin(orbit.pitch);
  const pos = [target[0] + orbit.dist * cp * Math.sin(orbit.yaw), target[1] + orbit.dist * sp, target[2] + orbit.dist * cp * Math.cos(orbit.yaw)];
  const f = norm(sub(target, pos));
  const r = norm(cross(f, [0, 1, 0]));
  const u = cross(r, f);
  const view = new Float32Array([
    r[0], u[0], -f[0], 0,
    r[1], u[1], -f[1], 0,
    r[2], u[2], -f[2], 0,
    -dot(r, pos), -dot(u, pos), dot(f, pos), 1,
  ]);
  const aspect = canvas.clientWidth / Math.max(canvas.clientHeight, 1);
  const fov = 34 * Math.PI / 180;
  const t = 1 / Math.tan(fov / 2);
  const near = 0.02, far = 6;
  const proj = new Float32Array([
    t / aspect, 0, 0, 0,
    0, t, 0, 0,
    0, 0, (far + near) / (near - far), -1,
    0, 0, 2 * far * near / (near - far), 0,
  ]);
  cam.pos = pos; cam.fwd = f; cam.right = r; cam.up = u;
  cam.vp = mul4(proj, view);
  cam.ivp = invert4(cam.vp);
  cam.tanH = 1 / t; cam.aspect = aspect;
}
function pointerRay(e) {
  const b = canvas.getBoundingClientRect();
  const nx = ((e.clientX - b.left) / b.width) * 2 - 1;
  const ny = 1 - ((e.clientY - b.top) / b.height) * 2;
  const d = norm([
    cam.fwd[0] + cam.right[0] * nx * cam.tanH * cam.aspect + cam.up[0] * ny * cam.tanH,
    cam.fwd[1] + cam.right[1] * nx * cam.tanH * cam.aspect + cam.up[1] * ny * cam.tanH,
    cam.fwd[2] + cam.right[2] * nx * cam.tanH * cam.aspect + cam.up[2] * ny * cam.tanH,
  ]);
  return { o: cam.pos, d };
}

// ---- sound ----------------------------------------------------------------
// Browsers only allow audio after a user gesture, so it starts on the first input.
let audio = null;
let muted = localStorage.getItem('jelly-muted') === '1';
let currentG = shearFromIntensity(0.55);
let tension = 0;
const wobble = new WobbleDetector();

function unlockAudio() {
  if (audio) { if (!document.hidden) audio.ctx.resume(); return; }
  // Sound is a bonus: if it can't start, the simulation carries on silently.
  try {
    audio = new JellyAudio(new AudioContext({ latencyHint: 'interactive' }));
    audio.setMuted(muted);
    audio.ctx.resume();
  } catch (err) {
    console.warn('Audio unavailable:', err);
    $('sound').hidden = true;
  }
}
window.addEventListener('pointerdown', unlockAudio, { capture: true });
window.addEventListener('keydown', unlockAudio, { capture: true });
// A hidden tab gets no physics frames, so the last motion level would otherwise hold forever.
document.addEventListener('visibilitychange', () => {
  if (!audio) return;
  if (document.hidden) audio.ctx.suspend(); else audio.ctx.resume();
});

function showMute() {
  $('sound').textContent = muted ? 'Sound off' : 'Sound on';
  $('sound').setAttribute('aria-pressed', String(!muted));
}
function toggleMute() {
  muted = !muted;
  localStorage.setItem('jelly-muted', muted ? '1' : '0');
  audio?.setMuted(muted);
  showMute();
}
showMute();
$('sound').addEventListener('click', toggleMute);

function bumpTable() {
  worker.postMessage({ t: 'bump' });
  audio?.bump();
}

// ---- setup ----------------------------------------------------------------
const surface = buildSurfaceMesh();
const pos = new Float32Array(surface.positions.length);
const nrm = new Float32Array(surface.positions.length);
let renderer, skin = null;
try {
  renderer = new Renderer(canvas, surface);
} catch (err) {
  $('error').textContent = err.message;
  $('error').hidden = false;
  throw err;
}

// Colour changes only update the optical material; the simulation and sound carry on.
const colorButtons = [...document.querySelectorAll('[data-color]')];
function selectColor(name) {
  renderer.setColor(name);
  document.documentElement.style.setProperty('--accent', JELLY_COLORS[name].accent);
  for (const button of colorButtons) button.setAttribute('aria-pressed', String(button.dataset.color === name));
}
for (const button of colorButtons) {
  button.style.setProperty('--swatch', JELLY_COLORS[button.dataset.color].accent);
  button.addEventListener('click', () => selectColor(button.dataset.color));
  // Space activates a focused colour button instead of the table-bump shortcut.
  button.addEventListener('keydown', (e) => { if (e.code === 'Space') e.stopPropagation(); });
}
selectColor('red');

const worker = new Worker('./src/worker.js', { type: 'module' });
worker.onerror = (e) => { $('error').textContent = `Physics worker failed: ${e.message}`; $('error').hidden = false; };
let waiting = false;
let latest = null;
let stats = null;
let loadAvg = 0, simRate = 1;

worker.onmessage = ({ data: d }) => {
  if (d.t === 'ready') {
    stats = d.stats;
    skin = bakeSkin(surface.positions, d.rest);
    latest = d.rest;
    applySkin(skin, latest, surface.index, pos, nrm);
    renderer.updateMesh(pos, nrm);
    $('stats').textContent = `${stats.tets.toLocaleString()} tets · ${stats.nodes.toLocaleString()} nodes · ${stats.hz} Hz · ${(stats.mass * 1000).toFixed(0)} g`;
    $('loading').hidden = true;
    pushSlider();
  } else if (d.t === 'x') {
    latest = d.x;
    waiting = false;
    loadAvg += (d.busyMs - loadAvg) * 0.05;
    if (lastDt > 0) simRate += (Math.min(d.simulated / lastDt, 1) - simRate) * 0.05;
    meshDirty = true;
    tension = d.tension;
    const level = wobble.update(d.vel, Math.max(lastDt, 1 / 240), currentG);
    if (audio) {
      if (level > 0) audio.blub(level, currentG);
      audio.setMotion(Math.hypot(d.vel[0], d.vel[1], d.vel[2]), d.tension, currentG);
      audio.peel(d.peels);
    }
  }
};
let meshDirty = false;
let lastDt = 0;

// ---- slider ---------------------------------------------------------------
const slider = $('intensity');
function pushSlider() {
  const s = slider.value / 100;
  const G = shearFromIntensity(s);
  currentG = G;
  worker.postMessage({ t: 'shear', s });
  $('modulus').textContent = G >= 1000 ? `${(G / 1000).toFixed(1)} kPa` : `${G.toFixed(0)} Pa`;
  // f = 0.098 sqrt(G) is the fit to the ring-down measured in test/validate.mjs.
  $('freq').textContent = `~${(0.098 * Math.sqrt(G)).toFixed(1)} Hz`;
  slider.style.setProperty('--p', `${slider.value}%`);
}
slider.addEventListener('input', pushSlider);
$('bump').addEventListener('click', bumpTable);
$('reset').addEventListener('click', () => worker.postMessage({ t: 'reset' }));
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') { e.preventDefault(); bumpTable(); }
  if (e.key === 'm' || e.key === 'M') toggleMute();
  if (e.key === 'r' || e.key === 'R') worker.postMessage({ t: 'reset' });
});

// ---- picking --------------------------------------------------------------
function raycast(ray) {
  const idx = surface.index;
  const o = ray.o, d = ray.d;
  let best = Infinity;
  for (let f = 0; f < idx.length; f += 3) {
    const a = idx[f] * 3, b = idx[f + 1] * 3, c = idx[f + 2] * 3;
    const e1x = pos[b] - pos[a], e1y = pos[b + 1] - pos[a + 1], e1z = pos[b + 2] - pos[a + 2];
    const e2x = pos[c] - pos[a], e2y = pos[c + 1] - pos[a + 1], e2z = pos[c + 2] - pos[a + 2];
    const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (det > -1e-14 && det < 1e-14) continue;
    const inv = 1 / det;
    const tx = o[0] - pos[a], ty = o[1] - pos[a + 1], tz = o[2] - pos[a + 2];
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < 0 || u > 1) continue;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
    if (v < 0 || u + v > 1) continue;
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (t > 0 && t < best) best = t;
  }
  return best === Infinity ? null : [o[0] + d[0] * best, o[1] + d[1] * best, o[2] + d[2] * best];
}

// ---- pointer --------------------------------------------------------------
let drag = null;
const CLICK_PX = 5;

canvas.addEventListener('pointerdown', (e) => {
  try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic or already-released pointer */ }
  updateCamera();
  const ray = pointerRay(e);
  const hit = e.button === 0 && skin ? raycast(ray) : null;
  if (hit) {
    drag = { kind: 'jelly', hit, t0: performance.now(), x0: e.clientX, y0: e.clientY, grabbed: false, dir: ray.d, plane: cam.fwd.slice() };
    canvas.style.cursor = 'grabbing';
    $('hint').classList.add('gone');
  } else {
    drag = { kind: 'orbit', x: e.clientX, y: e.clientY };
    canvas.style.cursor = 'move';
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (!drag) {
    if (skin && e.pointerType === 'mouse') {
      const now = performance.now();
      if (now - lastHover > 50) {
        lastHover = now;
        canvas.style.cursor = raycast(pointerRay(e)) ? 'grab' : 'default';
      }
    }
    return;
  }
  if (drag.kind === 'orbit') {
    orbit.yaw -= (e.clientX - drag.x) * 0.006;
    orbit.pitch = Math.min(1.35, Math.max(0.1, orbit.pitch + (e.clientY - drag.y) * 0.005));
    drag.x = e.clientX; drag.y = e.clientY;
    return;
  }
  const moved = Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0);
  if (!drag.grabbed && moved > CLICK_PX) {
    drag.grabbed = true;
    worker.postMessage({ t: 'grab', p: drag.hit, radius: 0.024 });
    audio?.grab();
  }
  if (drag.grabbed) {
    // Slide the handle on the camera-facing plane through the original hit.
    const ray = pointerRay(e);
    const denom = dot(ray.d, drag.plane);
    if (Math.abs(denom) > 1e-5) {
      const t = dot(sub(drag.hit, ray.o), drag.plane) / denom;
      const p = [ray.o[0] + ray.d[0] * t, ray.o[1] + ray.d[1] * t, ray.o[2] + ray.d[2] * t];
      // The finger can't push through the plate.
      p[1] = Math.max(p[1], 0.002);
      worker.postMessage({ t: 'move', p });
    }
  }
});
let lastHover = 0;

function endDrag(e) {
  if (!drag) return;
  if (drag.kind === 'jelly') {
    if (drag.grabbed) {
      worker.postMessage({ t: 'release' });
      audio?.release(tension, currentG);
    }
    else if (performance.now() - drag.t0 < 600 && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) <= CLICK_PX) {
      worker.postMessage({ t: 'poke', p: drag.hit, dir: drag.dir });
      audio?.poke(currentG);
    }
  }
  drag = null;
  canvas.style.cursor = 'default';
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  orbit.dist = Math.min(0.9, Math.max(0.22, orbit.dist * Math.exp(e.deltaY * 0.0009)));
}, { passive: false });

// ---- main loop ------------------------------------------------------------
let last = performance.now();
let fpsAvg = 60, slowFrames = 0;
function frame(now) {
  requestAnimationFrame(frame);
  tick(now);
}
function tick(now) {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  fpsAvg += ((dt > 0 ? 1 / dt : 60) - fpsAvg) * 0.05;

  if (skin && !waiting) {
    waiting = true;
    lastDt = dt;
    worker.postMessage({ t: 'frame', dt });
  }
  if (skin && meshDirty && latest) {
    meshDirty = false;
    applySkin(skin, latest, surface.index, pos, nrm);
    renderer.updateMesh(pos, nrm);
  }

  // Trade resolution for frame rate rather than letting the wobble stutter.
  if (fpsAvg < 40) slowFrames++; else slowFrames = 0;
  if (slowFrames > 90 && renderer.scale > 0.6) {
    renderer.setScale(Math.max(renderer.scale * 0.8, 0.6));
    slowFrames = 0;
    fpsAvg = 60;
  }

  updateCamera();
  renderer.resize();
  renderer.render(cam);
  $('perf').textContent = `${fpsAvg.toFixed(0)} fps · physics ${loadAvg.toFixed(1)} ms${simRate < 0.95 ? ` · slow-mo ${(simRate * 100).toFixed(0)}%` : ''}`;
}
requestAnimationFrame(frame);

// Handles for automated checks.
// `drive` runs real frames from a timer, for automated checks where rAF is paused (hidden tabs).
const drive = (ms) => new Promise((done) => {
  const t0 = performance.now();
  const id = setInterval(() => {
    tick(performance.now());
    if (performance.now() - t0 > ms) { clearInterval(id); done(); }
  }, 16);
});
window.__jelly = { worker, orbit, renderer, drive, get audio() { return audio; }, get pos() { return pos; }, get fps() { return fpsAvg; }, get load() { return loadAvg; }, get simRate() { return simRate; }, get scale() { return renderer.scale; } };
