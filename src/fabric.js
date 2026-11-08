import * as THREE from 'three';

// What makes a surface read as cloth: seams and hems with stitching, a knit/weave texture and heathered
// colour, a soft sheen, wrinkles even at rest, darker fold valleys, and edges with some thickness.

// ---------- small 3D value noise (deterministic) ----------
function hash(x, y, z) {
  let h = (x * 374761393 + y * 668265263 + z * 1274126177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
export function noise3(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  let out = 0;
  for (let dz = 0; dz < 2; dz++) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
    const wt = (dx ? u : 1 - u) * (dy ? v : 1 - v) * (dz ? w : 1 - w);
    out += wt * hash(xi + dx, yi + dy, zi + dz);
  }
  return out;
}

// geodesic-ish distance over the mesh from seed vertices (Bellman-Ford over edges, capped)
function distanceFrom(X, E, seeds, cap) {
  const n = X.length / 3;
  const d = new Float32Array(n).fill(cap);
  for (const s of seeds) d[s] = 0;
  const L = new Float32Array(E.length / 2);
  for (let e = 0; e < L.length; e++) {
    const a = E[e * 2] * 3, b = E[e * 2 + 1] * 3;
    L[e] = Math.hypot(X[a] - X[b], X[a + 1] - X[b + 1], X[a + 2] - X[b + 2]);
  }
  for (let it = 0; it < 40; it++) {
    let changed = false;
    for (let e = 0; e < L.length; e++) {
      const a = E[e * 2], b = E[e * 2 + 1];
      if (d[a] + L[e] < d[b]) { d[b] = d[a] + L[e]; changed = true; }
      if (d[b] + L[e] < d[a]) { d[a] = d[b] + L[e]; changed = true; }
    }
    if (!changed) break;
  }
  return d;
}

function edgeList(T) {
  const seen = new Set();
  const out = [];
  for (let t = 0; t < T.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = T[t + k], b = T[t + ((k + 1) % 3)];
      const key = a < b ? a * 1e6 + b : b * 1e6 + a;
      if (!seen.has(key)) { seen.add(key); out.push(a, b); }
    }
  }
  return Uint32Array.from(out);
}

function borderVerts(T) {
  const count = new Map();
  for (let t = 0; t < T.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = T[t + k], b = T[t + ((k + 1) % 3)];
      const key = a < b ? a * 1e6 + b : b * 1e6 + a;
      count.set(key, (count.get(key) || 0) + 1);
    }
  }
  const out = new Set();
  for (const [key, c] of count) if (c === 1) { out.add(Math.floor(key / 1e6)); out.add(key % 1e6); }
  return [...out];
}

/**
 * Seam/hem distances and rest wrinkles for a fitted garment (bind-space positions X, refined mesh).
 * Returns { seam: Float32Array(n*2) [distance to nearest seam, distance to nearest hem], h0 }.
 */
export function tailor(kind, def, X, T, skinIndex, skinWeight, bones, J) {
  const n = X.length / 3;
  const E = edgeList(T);
  const B = (name) => bones.indexOf(name);
  const dom = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    let b = 0;
    for (let k = 1; k < 4; k++) if (skinWeight[i * 4 + k] > skinWeight[i * 4 + b]) b = k;
    dom[i] = skinIndex[i * 4 + b];
  }
  const trunk = new Set(['hips', 'spine', 'chest', 'neck'].map(B));
  const arm = new Set(['upperArm.L', 'upperArm.R', 'foreArm.L', 'foreArm.R'].map(B));
  const leg = { L: new Set(['thigh.L', 'shin.L', 'foot.L'].map(B)), R: new Set(['thigh.R', 'shin.R', 'foot.R'].map(B)) };
  const hem = distanceFrom(X, E, borderVerts(T), 0.2);

  // centre of each part per 2 cm slab, for side seams and fold angles
  const slab = (y) => Math.round(y * 50);
  const centres = (sel) => {
    const lo = new Map(), hi = new Map(), xs = new Map();
    for (let i = 0; i < n; i++) {
      if (!sel(i)) continue;
      const k = slab(X[i * 3 + 1]);
      lo.set(k, Math.min(lo.get(k) ?? Infinity, X[i * 3 + 2]));
      hi.set(k, Math.max(hi.get(k) ?? -Infinity, X[i * 3 + 2]));
      const a = xs.get(k) || [0, 0];
      a[0] += X[i * 3]; a[1]++;
      xs.set(k, a);
    }
    return (y) => {
      let k = slab(y);
      for (let s = 0; s < 10 && !lo.has(k); s++) k += k > 0 ? -1 : 1;
      if (!lo.has(k)) return [0, 0];
      return [xs.get(k)[0] / xs.get(k)[1], (lo.get(k) + hi.get(k)) / 2];
    };
  };
  const cTrunk = centres((i) => trunk.has(dom[i]));
  const cLeg = { L: centres((i) => leg.L.has(dom[i])), R: centres((i) => leg.R.has(dom[i])) };

  // armhole seam: where sleeve meets body
  const armhole = [];
  for (let e = 0; e < E.length; e += 2) {
    const a = E[e], b = E[e + 1];
    if (arm.has(dom[a]) !== arm.has(dom[b])) armhole.push(a, b);
  }
  const dArm = armhole.length ? distanceFrom(X, E, armhole, 0.2) : new Float32Array(n).fill(0.2);

  const seam = new Float32Array(n * 2);
  const h0 = new Float32Array(n);
  const yb = J.chest[1];
  const wr = def.wrinkle ?? 1;
  for (let i = 0; i < n; i++) {
    const x = X[i * 3], y = X[i * 3 + 1], z = X[i * 3 + 2];
    let s = dArm[i];
    let theta = 0, part = 'other';
    if (trunk.has(dom[i])) {
      const [, cz] = cTrunk(y);
      s = Math.min(s, Math.abs(z - cz)); // side seams (and over the shoulders)
      if (def.slot === 'bottom') s = Math.min(s, Math.abs(x)); // centre front/back seam of trousers
      theta = Math.atan2(z - cz, x);
      part = 'trunk';
    } else {
      const side = x > 0 ? 'L' : 'R';
      if (leg[side].has(dom[i])) {
        const [cx, cz] = cLeg[side](y);
        s = Math.min(s, Math.abs(z - cz)); // outer and inner leg seams
        theta = Math.atan2(z - cz, x - cx);
        part = 'leg';
      } else if (arm.has(dom[i])) {
        part = 'sleeve';
      }
    }
    seam[i * 2] = s;
    seam[i * 2 + 1] = hem[i];

    // ---- wrinkles the garment has even standing still ----
    const nz = noise3(x * 9, y * 9, z * 9), nz2 = noise3(x * 23 + 5, y * 23, z * 23);
    let h = 0;
    if (part === 'trunk' && def.slot === 'top' && y < yb) {
      // soft vertical folds hanging from the chest, deeper toward the hem
      const t = Math.min(1, (yb - y) / 0.25);
      h += 0.0045 * wr * t * (0.5 + 0.5 * Math.sin(theta * 7 + 4 * nz)) * (0.5 + nz2);
    }
    if (part === 'trunk' && def.slot === 'bottom' && hem[i] < 0.07 && y > J.hips[1] - 0.05) {
      // fabric gathered under the waistband
      h += 0.0022 * wr * (1 - hem[i] / 0.07) * (0.5 + 0.5 * Math.sin(theta * 22 + 3 * nz));
    }
    if (part === 'leg') {
      // vertical folds down the leg
      h += 0.003 * wr * (0.5 + 0.5 * Math.sin(theta * 5 + 5 * nz)) * (0.4 + nz2);
      // the "break": fabric piling up above a long trouser hem
      if (def.length === 'ankle' && y < J['knee.L'][1] - 0.1 && hem[i] < 0.16) {
        const t = 1 - hem[i] / 0.16;
        h += 0.0075 * wr * t * (0.5 + 0.5 * Math.sin(y * 70 + theta * 1.3 + 4 * nz));
      }
    }
    if (part === 'sleeve') h += 0.0035 * wr * (0.4 + 0.6 * nz) * (0.5 + 0.5 * Math.sin(y * 60 + x * 40 + 5 * nz2));
    if (hem[i] < 0.006) h *= hem[i] / 0.006; // hems and cuffs lie smooth
    h0[i] = h;
  }
  return { seam, h0 };
}

/** Seam/hem distances for the skirt (rows of M vertices from the waist down). */
export function tailorSkirt(X, R, M, axis) {
  const n = R * M;
  const seam = new Float32Array(n * 2);
  const row = Math.abs(X[1] - X[(R - 1) * M * 3 + 1]) / (R - 1);
  for (let r = 0; r < R; r++) {
    for (let k = 0; k < M; k++) {
      const i = r * M + k;
      const x = X[i * 3] - axis[0], z = X[i * 3 + 2] - axis[1];
      seam[i * 2] = z < 0 ? Math.abs(x) : 0.2; // centre back seam
      seam[i * 2 + 1] = Math.min(r, R - 1 - r) * row; // waistband and hem
    }
  }
  return { seam, h0: new Float32Array(n) };
}

// ---------- material ----------
const GLSL = /* glsl */ `
float fhash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float fnoise(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(fhash(i + vec3(0, 0, 0)), fhash(i + vec3(1, 0, 0)), f.x), mix(fhash(i + vec3(0, 1, 0)), fhash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(fhash(i + vec3(0, 0, 1)), fhash(i + vec3(1, 0, 1)), f.x), mix(fhash(i + vec3(0, 1, 1)), fhash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
// dashed stitch line at distance d0 from a seam/hem
float stitch(float d, float d0, vec3 p) {
  float line = 1.0 - smoothstep(0.0005, 0.0011, abs(d - d0));
  float dash = smoothstep(0.25, 0.35, fract(dot(p, vec3(97.0, 131.0, 113.0)) * 1.6)) * (1.0 - smoothstep(0.75, 0.85, fract(dot(p, vec3(97.0, 131.0, 113.0)) * 1.6)));
  return line * dash;
}
// relief of the cloth in metres: knit + seams (groove) + hems (turned-up band)
float fabricHeight(vec3 p, vec2 s) {
  float k = sin(p.x * 1500.0 + p.y * 900.0) * sin(p.y * 1500.0 - p.z * 900.0);
  float aa = clamp(1.0 - 300.0 * length(fwidth(p)), 0.0, 1.0); // fade the knit before it aliases
  float h = 0.00008 * k * aa;
  h -= 0.0006 * exp(-pow(s.x / 0.0016, 2.0));
  h += 0.0004 * smoothstep(0.024, 0.02, s.y) - 0.0003 * exp(-pow((s.y - 0.022) / 0.0012, 2.0));
  h += 0.0003 * smoothstep(0.004, 0.0, s.y) * -1.0;
  return h;
}
vec3 fabricPerturb(vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float faceDir) {
  vec3 sx = dFdx(surf_pos), sy = dFdy(surf_pos);
  vec3 R1 = cross(sy, surf_norm), R2 = cross(surf_norm, sx);
  float det = dot(sx, R1) * faceDir;
  vec3 grad = sign(det) * (dHdxy.x * R1 + dHdxy.y * R2);
  return normalize(abs(det) * surf_norm - grad);
}
`;

export function fabricMaterial(color) {
  const base = new THREE.Color(color);
  const m = new THREE.MeshPhysicalMaterial({
    color: base,
    roughness: 0.93,
    metalness: 0,
    sheen: 1,
    sheenRoughness: 0.55,
    sheenColor: base.clone().lerp(new THREE.Color(0xffffff), 0.45),
    vertexColors: true,
    side: THREE.DoubleSide,
  });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 restPos;\nattribute vec2 seamInfo;\nvarying vec3 vRest;\nvarying vec2 vSeam;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRest = restPos;\nvSeam = seamInfo;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vRest;\nvarying vec2 vSeam;\n${GLSL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
      {
        float heather = 0.93 + 0.07 * fnoise(vRest * 220.0) + 0.04 * (fnoise(vRest * 35.0) - 0.5);
        float st = max(stitch(vSeam.x, 0.0045, vRest), max(stitch(vSeam.y, 0.017, vRest), stitch(vSeam.y, 0.023, vRest)));
        diffuseColor.rgb *= heather * (1.0 - 0.28 * st) * (1.0 - 0.12 * exp(-pow(vSeam.x / 0.0015, 2.0)));
      }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
      {
        float H = fabricHeight(vRest, vSeam);
        normal = fabricPerturb(-vViewPosition, normal, vec2(dFdx(H), dFdy(H)), faceDirection);
      }`);
  };
  m.customProgramCacheKey = () => 'fabric-v1';
  return m;
}
