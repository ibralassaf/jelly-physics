// WebGL2 renderer. Linear HDR pipeline:
//   1. Light-space pass: refract the key light through the surface onto the plate (caustics),
//      plus a shadow mask. Mipmaps of that map give soft shadow and contact occlusion.
//   2. Back-face pass: world normal and view depth of the far side of the jelly.
//   3. Background: analytic ray trace of the plate, table and room.
//   4. Jelly: per-pixel refraction through both interfaces, Beer-Lambert absorption, Fresnel,
//      internal reflection and forward scattering. Exit rays re-enter the same analytic scene.
//   5. Bloom, filmic tone map, FXAA.
import { PLATE } from './shape.js';

const IOR = '1.34'; // Abbe-measured for dilute gelatin; F0 is about 0.021

const COMMON = /* glsl */`
precision highp float;
precision highp sampler2D;
const float PI = 3.14159265;
const vec3 L_DIR = normalize(vec3(-0.48, 0.80, 0.36));
const vec3 L_RAD = vec3(7.2, 6.6, 5.8);   // window radiance, what highlights see
const vec3 E_KEY = vec3(2.35, 2.2, 2.0);  // irradiance the window delivers to a surface
const float PLATE_T = ${PLATE.thickness.toFixed(4)};
const float PLATE_F = ${PLATE.flatR.toFixed(4)};
const float PLATE_R = ${PLATE.outerR.toFixed(4)};
const float PLATE_H = ${PLATE.rimH.toFixed(4)};
const float TABLE_Y = ${PLATE.footY.toFixed(4)};
const float MAP_EXTENT = 0.34;
`;

const SCENE = /* glsl */`
uniform sampler2D uLightMap;
uniform vec3 uJellyCenter;
uniform vec3 uJellyRadii;

float hash21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1, 0)), f.x), mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + 11.7; a *= 0.5; } return s; }

// A dim room with one tall paned window: its shape is what you read in wet highlights.
vec3 env(vec3 d) {
  float up = d.y * 0.5 + 0.5;
  vec3 c = mix(vec3(0.19, 0.15, 0.12), vec3(0.62, 0.60, 0.58), smoothstep(0.30, 0.95, up));
  vec3 z = L_DIR;
  vec3 x = normalize(cross(vec3(0, 1, 0), z));
  vec3 y = cross(z, x);
  float dz = dot(d, z);
  if (dz > 0.0) {
    vec2 q = vec2(dot(d, x), dot(d, y)) / dz;
    vec2 a = abs(q);
    float rect = smoothstep(0.34, 0.325, a.x) * smoothstep(0.50, 0.485, a.y);
    float bars = smoothstep(0.012, 0.018, abs(q.x)) * smoothstep(0.012, 0.018, abs(q.y - 0.02));
    c += rect * bars * L_RAD * 3.4;
  }
  // Large soft fill opposite the window so the shaded side still has a shape to reflect.
  float fill = smoothstep(0.55, 0.95, dot(d, normalize(vec3(0.72, 0.42, 0.55))));
  c += fill * vec3(0.55, 0.62, 0.74) * 0.75;
  return c;
}

float sdSeg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}
float smin(float a, float b, float k) { float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0); return mix(b, a, h) - k * h * (1.0 - h); }
float sdPlate(vec3 p) {
  vec2 q = vec2(length(p.xz), p.y);
  float t = PLATE_T;
  float d = sdSeg(q, vec2(0.0, -t), vec2(PLATE_F, -t));
  d = smin(d, sdSeg(q, vec2(PLATE_F, -t), vec2(PLATE_R, PLATE_H - t)), 0.006);
  d = min(d, sdSeg(q, vec2(PLATE_F * 0.72, -2.2 * t), vec2(PLATE_F * 0.72, TABLE_Y + t)));
  return d - t;
}
vec3 plateNormal(vec3 p) {
  const vec2 e = vec2(0.0005, 0);
  return normalize(vec3(sdPlate(p + e.xyy) - sdPlate(p - e.xyy), sdPlate(p + e.yxy) - sdPlate(p - e.yxy), sdPlate(p + e.yyx) - sdPlate(p - e.yyx)));
}

vec2 mapUV(vec3 p) { return p.xz / (2.0 * MAP_EXTENT) + 0.5; }

float jellyOcclusion(vec3 ro, vec3 rd) {
  vec3 c = uJellyCenter, r = uJellyRadii;
  vec3 oc = (ro - c) / r, dd = rd / r;
  float a = dot(dd, dd), b = dot(oc, dd), cc = dot(oc, oc) - 1.0;
  float h = b * b - a * cc;
  if (h < 0.0) return 0.0;
  float t = (-b - sqrt(h)) / a;
  return t > 0.0 ? 1.0 : 0.0;
}

vec3 tint(vec3 sigma, float d) { return exp(-sigma * d); }
uniform vec3 uSigma;

vec3 shadeSurface(vec3 p, vec3 n, vec3 rd, vec3 albedo, float gloss, float spec) {
  vec2 uv = mapUV(p);
  // A window is a large source, so the penumbra widens: blend two mip levels of the mask.
  float mask = mix(textureLod(uLightMap, uv, 2.5).a, textureLod(uLightMap, uv, 4.2).a, 0.45);
  // Low mips are blocky under bilinear filtering; a small tent of taps hides the texel grid.
  float aoWide = 0.0, aoMid = 0.0;
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.7854;
    vec2 o = vec2(cos(a), sin(a));
    aoWide += textureLod(uLightMap, uv + o * 0.030, 5.0).a;
    aoMid += textureLod(uLightMap, uv + o * 0.010, 3.5).a;
  }
  aoWide /= 8.0; aoMid /= 8.0;
  vec3 caustic = textureLod(uLightMap, uv, 0.8).rgb;
  float ndl = max(dot(n, L_DIR), 0.0);
  float direct = 1.0 - smoothstep(0.03, 0.92, mask);
  // Light that scattered forward through the gel still arrives inside the shadow, stained red.
  vec3 stained = (exp(-uSigma * 0.035) * 0.42 + 0.06) * (1.0 - direct);
  vec3 lit = E_KEY * ndl * (direct + stained) + caustic * E_KEY * ndl;
  float ao = 1.0 - 0.62 * smoothstep(0.0, 0.85, aoMid) - 0.22 * smoothstep(0.0, 0.7, aoWide);
  vec3 amb = mix(vec3(0.20, 0.17, 0.15), vec3(0.60, 0.60, 0.62), n.y * 0.5 + 0.5) * ao;
  // Red light bleeding out of the jelly into the glaze near its foot.
  amb += exp(-uSigma * 0.03) * vec3(0.5, 0.45, 0.45) * smoothstep(0.0, 0.8, aoMid) * (1.0 - mask) * 0.25;
  vec3 col = albedo * (lit + amb) / PI;
  vec3 r = reflect(rd, n);
  float f = spec + (1.0 - spec) * pow(clamp(1.0 + dot(rd, n), 0.0, 1.0), 5.0);
  vec3 refl = env(r);
  if (gloss < 0.5) { refl = mix(refl, vec3(dot(refl, vec3(0.33))) * 0.5 + 0.1, 0.75); f *= 0.45; }
  float occ = jellyOcclusion(p + n * 1e-3, r);
  if (occ > 0.0) refl = mix(refl, exp(-uSigma * 0.05) * vec3(0.9), 0.85);
  return col + refl * f * ao;
}

// Traces the room from any ray, including rays leaving the jelly.
vec3 scene(vec3 ro, vec3 rd) {
  vec3 hitP; bool hitPlate = false;
  float tEnd = 1e6;
  if (rd.y < -1e-4) tEnd = (TABLE_Y - ro.y) / rd.y;
  // Bounding cylinder/box for the plate.
  float tMin = 0.0, tMax = min(tEnd, 3.0);
  vec2 box = vec2(PLATE_R + 0.01);
  vec3 inv = 1.0 / (rd + vec3(1e-6));
  vec3 lo = (vec3(-box.x, TABLE_Y - 0.002, -box.x) - ro) * inv;
  vec3 hi = (vec3(box.x, PLATE_H + 0.004, box.x) - ro) * inv;
  vec3 a = min(lo, hi), b = max(lo, hi);
  tMin = max(max(a.x, a.y), max(a.z, 0.0));
  float tB = min(min(b.x, b.y), b.z);
  if (tMin < tB) {
    float t = tMin;
    float limit = min(tB, tMax);
    for (int i = 0; i < 32 && t < limit; i++) {
      vec3 p = ro + rd * t;
      float d = sdPlate(p);
      if (d < 0.00025) { hitPlate = true; hitP = p; break; }
      t += d * 0.95;
    }
  }
  if (hitPlate) {
    vec3 n = plateNormal(hitP);
    return shadeSurface(hitP, n, rd, vec3(0.86, 0.84, 0.80), 1.0, 0.045);
  }
  if (rd.y < -1e-4 && tEnd > 0.0) {
    vec3 p = ro + rd * tEnd;
    float dist = length(p.xz);
    // Walnut grain: stretched noise warped along the board.
    float warp = fbm(p.xz * vec2(1.4, 6.0));
    float w = fbm(p.xz * vec2(2.4, 34.0) + vec2(warp * 1.3, warp * 0.6));
    float rings = 0.5 + 0.5 * sin((p.z + warp * 0.05) * 165.0 + w * 9.0);
    vec3 wood = mix(vec3(0.040, 0.020, 0.011), vec3(0.128, 0.066, 0.036), rings * rings * 0.45 + w * 0.55);
    // Pores: fine dark dashes running with the grain.
    float pores = smoothstep(0.70, 0.84, vnoise(p.xz * vec2(38.0, 900.0)));
    wood *= 1.0 - 0.38 * pores;
    vec3 n = vec3(0, 1, 0);
    // Plate's own soft shadow on the table.
    vec2 off = p.xz - L_DIR.xz * ((0.0 - TABLE_Y) / L_DIR.y);
    float plateS = 1.0 - smoothstep(PLATE_R - 0.018, PLATE_R + 0.022, length(off));
    float contact = 1.0 - smoothstep(PLATE_R * 0.86, PLATE_R * 1.16, dist);
    vec3 col = shadeSurface(p, n, rd, wood, 0.0, 0.035);
    col *= (1.0 - 0.62 * plateS) * (1.0 - 0.45 * contact);
    // The table recedes into a dim room instead of ending at a horizon.
    float fade = smoothstep(0.38, 1.25, dist);
    return mix(col, vec3(0.030, 0.024, 0.021), fade);
  }
  return mix(vec3(0.030, 0.024, 0.021), env(rd), smoothstep(0.0, 0.45, rd.y));
}
`;

const FULL_VS = /* glsl */`#version 300 es
out vec2 vUv;
void main() { vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); vUv = p; gl_Position = vec4(p * 2.0 - 1.0, 0, 1); }
`;

const BG_FS = /* glsl */`#version 300 es
${COMMON}
in vec2 vUv; out vec4 o;
uniform mat4 uInvVP; uniform vec3 uCam;
${SCENE}
void main() {
  vec4 q = uInvVP * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 rd = normalize(q.xyz / q.w - uCam);
  o = vec4(scene(uCam, rd), 1.0);
}`;

const CAUSTIC_VS = /* glsl */`#version 300 es
${COMMON}
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
uniform float uMode;
out vec3 vOld; out vec3 vNew; out float vFacing; out float vPath;
void main() {
  vec3 N = normalize(aNormal);
  vec3 lightDir = -L_DIR;
  // Straight-line footprint on the well plane: the shadow.
  vec3 straight = aPos + lightDir * (aPos.y / max(L_DIR.y, 0.05));
  // Refracted path to the plate: where the energy actually lands.
  vec3 r = refract(lightDir, N, 1.0 / ${IOR});
  float tR = aPos.y / max(-r.y, 0.05);
  vec3 bent = aPos + r * tR;
  vFacing = dot(N, L_DIR);
  vPath = tR;
  vOld = straight;
  vNew = bent;
  vec3 target = uMode < 0.5 ? straight : bent;
  gl_Position = vec4(target.xz / MAP_EXTENT, 0.0, 1.0);
}`;

const CAUSTIC_FS = /* glsl */`#version 300 es
${COMMON}
in vec3 vOld; in vec3 vNew; in float vFacing; in float vPath;
uniform float uMode; uniform vec3 uSigma;
out vec4 o;
void main() {
  if (vFacing <= 0.0) discard;
  if (uMode < 0.5) { o = vec4(0, 0, 0, 1); return; }
  // Energy conservation: brightness is the ratio of the unrefracted to refracted footprint.
  float oldA = length(dFdx(vOld.xz)) * length(dFdy(vOld.xz));
  float newA = length(dFdx(vNew.xz)) * length(dFdy(vNew.xz));
  float gain = clamp(oldA / max(newA, 1e-12), 0.0, 6.0);
  vec3 T = exp(-uSigma * clamp(vPath, 0.0, 0.2));
  float fresnelT = 1.0 - (0.021 + 0.979 * pow(1.0 - clamp(vFacing, 0.0, 1.0), 5.0));
  o = vec4(T * gain * fresnelT, 0.0);
}`;

const MESH_VS = /* glsl */`#version 300 es
${COMMON}
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
uniform mat4 uVP;
out vec3 vPos; out vec3 vN;
void main() { vPos = aPos; vN = aNormal; gl_Position = uVP * vec4(aPos, 1.0); }`;

const BACK_FS = /* glsl */`#version 300 es
${COMMON}
in vec3 vPos; in vec3 vN;
uniform vec3 uCam; uniform vec3 uFwd;
out vec4 o;
void main() { o = vec4(normalize(vN), dot(vPos - uCam, uFwd)); }`;

const JELLY_FS = /* glsl */`#version 300 es
${COMMON}
in vec3 vPos; in vec3 vN;
out vec4 o;
uniform mat4 uVP; uniform vec3 uCam; uniform vec3 uFwd; uniform sampler2D uBack; uniform vec2 uRes;
${SCENE}

// Marches the refracted ray through the depth of the far surface until it passes through it.
bool traceToBack(vec3 ro, vec3 rd, out vec3 hit, out vec3 nb, out float dist) {
  const float maxLen = 0.20;
  const int STEPS = 22;
  float prevT = 0.0, t = 0.0;
  float dt = maxLen / float(STEPS);
  bool found = false;
  for (int i = 0; i < STEPS; i++) {
    t += dt;
    vec3 p = ro + rd * t;
    vec4 c = uVP * vec4(p, 1.0);
    vec2 uv = c.xy / c.w * 0.5 + 0.5;
    vec4 b = texture(uBack, uv);
    float z = dot(p - uCam, uFwd);
    if (b.a <= 0.0 || z >= b.a) { found = true; break; }
    prevT = t;
  }
  if (!found) { hit = ro + rd * t; nb = rd; dist = t; return false; }
  float lo = prevT, hi = t;
  for (int i = 0; i < 6; i++) {
    float m = 0.5 * (lo + hi);
    vec3 p = ro + rd * m;
    vec4 c = uVP * vec4(p, 1.0);
    vec2 uv = c.xy / c.w * 0.5 + 0.5;
    vec4 b = texture(uBack, uv);
    float z = dot(p - uCam, uFwd);
    if (b.a <= 0.0 || z >= b.a) hi = m; else lo = m;
  }
  hit = ro + rd * lo;
  vec4 c = uVP * vec4(hit, 1.0);
  vec4 b = texture(uBack, c.xy / c.w * 0.5 + 0.5);
  nb = b.a > 0.0 ? normalize(b.xyz) : rd;
  dist = lo;
  return true;
}

void main() {
  vec3 N = normalize(vN);
  vec3 V = normalize(vPos - uCam);
  if (dot(N, V) > 0.0) N = normalize(N - 2.0 * dot(N, V) * V * 0.5);
  float eta = 1.0 / ${IOR};
  float cosI = clamp(-dot(V, N), 0.0, 1.0);
  float F0 = 0.021;
  float F = F0 + (1.0 - F0) * pow(1.0 - cosI, 5.0);

  vec3 R = reflect(V, N);
  vec3 refl = env(R);
  // Grazing reflections that point at the plate should see the plate, not the sky.
  if (R.y < 0.0) refl = scene(vPos + N * 1e-3, R);

  vec3 inside = refract(V, N, eta);
  vec3 hit, nb; float d;
  traceToBack(vPos - N * 1e-4, inside, hit, nb, d);
  d = max(d, 0.0);

  vec3 T = exp(-uSigma * d);
  vec3 outDir = refract(inside, -nb, 1.0 / eta);
  vec3 transmitted;
  if (dot(outDir, outDir) < 0.01) {
    // Total internal reflection: bounce once, then leave through the far wall.
    vec3 r2 = reflect(inside, -nb);
    vec3 h2, n2; float d2;
    traceToBack(hit - nb * 1e-3, r2, h2, n2, d2);
    vec3 out2 = refract(r2, -n2, 1.0 / eta);
    if (dot(out2, out2) < 0.01) out2 = r2;
    transmitted = scene(h2 + out2 * 1e-3, out2) * exp(-uSigma * max(d2, 0.0));
  } else {
    float cB = clamp(dot(outDir, nb), 0.0, 1.0);
    float Fb = F0 + (1.0 - F0) * pow(1.0 - cB, 5.0);
    vec3 r2 = reflect(inside, -nb);
    vec3 internal = env(r2) * exp(-uSigma * d * 1.2);
    transmitted = mix(scene(hit + outDir * 1e-3, outDir), internal, Fb);
  }

  // Forward in-scattering: faint protein haze that lights up under the window. Attenuate with
  // distance to the light using the local view thickness as a proxy.
  vec3 sigmaS = vec3(1.3, 1.1, 1.1);
  float g = 0.6;
  float mu = dot(inside, L_DIR);
  float phase = (1.0 - g * g) / (4.0 * PI * pow(max(1.0 + g * g - 2.0 * g * mu, 1e-3), 1.5));
  vec3 extinct = uSigma + sigmaS;
  vec3 inscatter = sigmaS / extinct * (1.0 - exp(-extinct * d)) * (L_RAD * phase * exp(-uSigma * d * 0.45) + vec3(0.62, 0.34, 0.34) * 0.55);

  vec3 c = (1.0 - F) * (transmitted * T + inscatter) + F * refl;
  o = vec4(c, 1.0);
}`;

const POST_FS = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uHdr; uniform float uExposure;
vec3 aces(vec3 x) {
  // Narkowicz ACES fit.
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
void main() {
  vec3 c = texture(uHdr, vUv).rgb;
  vec3 bloom = vec3(0);
  float wsum = 0.0;
  for (int i = 2; i < 7; i++) {
    float w = 1.0 / float(i);
    vec3 s = textureLod(uHdr, vUv, float(i)).rgb;
    bloom += max(s - 1.1, 0.0) * w;
    wsum += w;
  }
  c += 0.32 * bloom / wsum;
  vec2 q = vUv - 0.5;
  c *= 1.0 - 0.42 * dot(q, q);
  c = aces(c * uExposure);
  c = pow(c, vec3(1.0 / 2.2));
  // Fine dither: 8-bit banding on the dark background is very visible otherwise.
  float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  o = vec4(c + (n - 0.5) / 255.0, dot(c, vec3(0.299, 0.587, 0.114)));
}`;

const FXAA_FS = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uTex; uniform vec2 uTexel;
void main() {
  vec4 cc = texture(uTex, vUv);
  float lM = cc.a;
  float lNW = texture(uTex, vUv + vec2(-1, -1) * uTexel).a;
  float lNE = texture(uTex, vUv + vec2( 1, -1) * uTexel).a;
  float lSW = texture(uTex, vUv + vec2(-1,  1) * uTexel).a;
  float lSE = texture(uTex, vUv + vec2( 1,  1) * uTexel).a;
  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  if (lMax - lMin < max(0.04, lMax * 0.1)) { o = vec4(cc.rgb, 1); return; }
  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
  float red = max((lNW + lNE + lSW + lSE) * 0.03125, 0.0078);
  float rcp = 1.0 / (min(abs(dir.x), abs(dir.y)) + red);
  dir = clamp(dir * rcp, -8.0, 8.0) * uTexel;
  vec3 a = 0.5 * (texture(uTex, vUv + dir * (1.0 / 3.0 - 0.5)).rgb + texture(uTex, vUv + dir * (2.0 / 3.0 - 0.5)).rgb);
  vec3 b = a * 0.5 + 0.25 * (texture(uTex, vUv - dir * 0.5).rgb + texture(uTex, vUv + dir * 0.5).rgb);
  float lB = dot(b, vec3(0.299, 0.587, 0.114));
  o = vec4((lB < lMin || lB > lMax) ? a : b, 1);
}`;

function compile(gl, vs, fs, name) {
  const mk = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`${name}: ${gl.getShaderInfoLog(s)}`);
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`${name}: ${gl.getProgramInfoLog(p)}`);
  const cache = {};
  return {
    use() { gl.useProgram(p); },
    u(n) { if (!(n in cache)) cache[n] = gl.getUniformLocation(p, n); return cache[n]; },
  };
}

export class Renderer {
  constructor(canvas, surface) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('EXT_color_buffer_float is not available.');
    gl.getExtension('OES_texture_float_linear');
    this.gl = gl;
    this.canvas = canvas;
    this.count = surface.index.length;
    this.scale = Math.min(window.devicePixelRatio || 1, 2);

    this.bg = compile(gl, FULL_VS, BG_FS, 'background');
    this.caustic = compile(gl, CAUSTIC_VS, CAUSTIC_FS, 'caustic');
    this.back = compile(gl, MESH_VS, BACK_FS, 'back');
    this.jelly = compile(gl, MESH_VS, JELLY_FS, 'jelly');
    this.post = compile(gl, FULL_VS, POST_FS, 'post');
    this.fxaa = compile(gl, FULL_VS, FXAA_FS, 'fxaa');

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.posBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, surface.positions.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    this.nrmBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.nrmBuf);
    gl.bufferData(gl.ARRAY_BUFFER, surface.positions.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, surface.index, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.emptyVao = gl.createVertexArray();

    this.lightMap = this.makeTarget(1024, 1024, gl.RGBA16F, gl.HALF_FLOAT, { mips: true });
    this.sigma = [3.6, 58, 42];   // absorption per metre (raspberry), linear RGB
    this.resize();
    gl.bindVertexArray(null);
  }

  makeTarget(w, h, internal, type, { mips = false, depth = false, filter = null } = {}) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, mips ? Math.floor(Math.log2(Math.max(w, h))) + 1 : 1, internal, w, h);
    const f = filter ?? gl.LINEAR;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    let rb = null;
    if (depth) {
      rb = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT32F, w, h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb);
    }
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`framebuffer incomplete: ${status}`);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fb, rb, w, h, mips };
  }

  freeTarget(t) {
    if (!t) return;
    const gl = this.gl;
    gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb);
    if (t.rb) gl.deleteRenderbuffer(t.rb);
  }

  resize() {
    const gl = this.gl;
    const w = Math.max(1, Math.round(this.canvas.clientWidth * this.scale));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * this.scale));
    if (this.w === w && this.h === h) return;
    this.w = w; this.h = h;
    this.canvas.width = w; this.canvas.height = h;
    this.freeTarget(this.backT); this.freeTarget(this.hdrT); this.freeTarget(this.ldrT);
    // Depth precision matters for the march, so the back pass is 32-bit float and unfiltered.
    this.backT = this.makeTarget(w, h, gl.RGBA32F, gl.FLOAT, { depth: true, filter: gl.NEAREST });
    this.hdrT = this.makeTarget(w, h, gl.RGBA16F, gl.HALF_FLOAT, { depth: true, mips: true });
    this.ldrT = this.makeTarget(w, h, gl.RGBA8, gl.UNSIGNED_BYTE);
  }

  /** Lower resolution if the GPU can't hold frame rate. */
  setScale(s) { this.scale = s; this.resize(); }

  updateMesh(pos, normal) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, pos);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.nrmBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, normal);
    // Bounding ellipsoid for plate reflections, from the current pose.
    let cx = 0, cy = 0, cz = 0, n = pos.length / 3;
    let maxY = 0, maxR = 0;
    for (let i = 0; i < n; i += 7) { cx += pos[i * 3]; cz += pos[i * 3 + 2]; }
    const c = 7 / n;
    cx *= c; cz *= c;
    for (let i = 0; i < n; i += 7) {
      maxY = Math.max(maxY, pos[i * 3 + 1]);
      maxR = Math.max(maxR, Math.hypot(pos[i * 3] - cx, pos[i * 3 + 2] - cz));
    }
    cy = maxY * 0.35;
    this.jc = [cx, cy, cz];
    this.jr = [maxR, maxY * 0.75, maxR];
  }

  bindSceneUniforms(p, cam) {
    const gl = this.gl;
    gl.uniformMatrix4fv(p.u('uVP'), false, cam.vp);
    gl.uniformMatrix4fv(p.u('uInvVP'), false, cam.ivp);
    gl.uniform3fv(p.u('uCam'), cam.pos);
    gl.uniform3fv(p.u('uFwd'), cam.fwd);
    gl.uniform3fv(p.u('uSigma'), this.sigma);
    gl.uniform3fv(p.u('uJellyCenter'), this.jc || [0, 0.03, 0]);
    gl.uniform3fv(p.u('uJellyRadii'), this.jr || [0.06, 0.06, 0.06]);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lightMap.tex);
    gl.uniform1i(p.u('uLightMap'), 1);
  }

  render(cam) {
    const gl = this.gl;
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);

    // 1. Light-space map. Rasterise both projections; each covers the plate once.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.lightMap.fb);
    gl.viewport(0, 0, this.lightMap.w, this.lightMap.h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindVertexArray(this.vao);
    const cp = this.caustic;
    cp.use();
    gl.uniform3fv(cp.u('uSigma'), this.sigma);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.colorMask(false, false, false, true);
    gl.uniform1f(cp.u('uMode'), 0);
    gl.blendEquation(gl.MAX);
    gl.drawElements(gl.TRIANGLES, this.count, gl.UNSIGNED_INT, 0);
    gl.blendEquation(gl.FUNC_ADD);
    gl.colorMask(true, true, true, false);
    gl.uniform1f(cp.u('uMode'), 1);
    gl.drawElements(gl.TRIANGLES, this.count, gl.UNSIGNED_INT, 0);
    gl.colorMask(true, true, true, true);
    gl.disable(gl.BLEND);
    gl.bindTexture(gl.TEXTURE_2D, this.lightMap.tex);
    gl.generateMipmap(gl.TEXTURE_2D);

    // 2. Far surface: keep the deepest fragment.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.backT.fb);
    gl.viewport(0, 0, this.w, this.h);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.clearDepth(1);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.GREATER);
    this.back.use();
    gl.uniformMatrix4fv(this.back.u('uVP'), false, cam.vp);
    gl.uniform3fv(this.back.u('uCam'), cam.pos);
    gl.uniform3fv(this.back.u('uFwd'), cam.fwd);
    gl.drawElements(gl.TRIANGLES, this.count, gl.UNSIGNED_INT, 0);
    gl.depthFunc(gl.LESS);
    gl.disable(gl.DEPTH_TEST);

    // 3. Background.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.hdrT.fb);
    gl.viewport(0, 0, this.w, this.h);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.bindVertexArray(this.emptyVao);
    this.bg.use();
    this.bindSceneUniforms(this.bg, cam);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // 4. Jelly, front surface only.
    gl.enable(gl.DEPTH_TEST);
    gl.bindVertexArray(this.vao);
    const jp = this.jelly;
    jp.use();
    this.bindSceneUniforms(jp, cam);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.backT.tex);
    gl.uniform1i(jp.u('uBack'), 2);
    gl.uniform2f(jp.u('uRes'), this.w, this.h);
    gl.drawElements(gl.TRIANGLES, this.count, gl.UNSIGNED_INT, 0);
    gl.disable(gl.DEPTH_TEST);

    gl.bindVertexArray(this.emptyVao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.hdrT.tex);
    gl.generateMipmap(gl.TEXTURE_2D);

    // 5. Tone map into LDR (luma in alpha for FXAA), then FXAA to screen.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.ldrT.fb);
    this.post.use();
    gl.uniform1i(this.post.u('uHdr'), 0);
    gl.uniform1f(this.post.u('uExposure'), 1.05);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.w, this.h);
    this.fxaa.use();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.ldrT.tex);
    gl.uniform1i(this.fxaa.u('uTex'), 0);
    gl.uniform2f(this.fxaa.u('uTexel'), 1 / this.w, 1 / this.h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
