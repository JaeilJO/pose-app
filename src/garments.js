import * as THREE from 'three';
import { Loop } from './subdiv.js';
import { tailor, tailorSkirt, fabricMaterial } from './fabric.js';

// Clothes cut from the body itself, so they fit every body shape:
// - fitted pieces (pants, shorts, t-shirt, tank top) are the body surface of a region, lifted off the skin;
// - the skirt is a tube from the waist that wraps the hips and both thighs and flares toward the hem.
// Each piece follows the skeleton (same skin weights as the body underneath) and is then relaxed as cloth:
// it keeps its own lengths, so where a joint bends it buckles into folds; it is held at the waistband and
// cuffs, pulled down by gravity, and pushed out of the body by the collision spheres.

export const GARMENTS = {
  // ease: how far the cloth stands off the skin; drape: how straight a top falls from the chest (0..1)
  tshirt: { slot: 'top', color: 0x8393a8, thickness: 0.011, ease: 0.022, drape: 0.85, sleeves: 0.55 },
  tank: { slot: 'top', color: 0xa3abb5, thickness: 0.008, ease: 0.013, drape: 0.6, sleeves: 0 },
  pants: { slot: 'bottom', color: 0x3d4450, thickness: 0.012, ease: 0.018, length: 'ankle', hem: 0.075 },
  shorts: { slot: 'bottom', color: 0x4d5562, thickness: 0.013, ease: 0.02, length: 'thigh', hem: 0.09 },
  skirt: { slot: 'bottom', color: 0x5d4b60, length: 0.52 },
};

const CFG = globalThis.CLOTH_CFG || { sub: 2, iter: 4, pull: 0.004, slide: 0.4, damp: 0.97, stretch: 0.1, give: 0.08, compress: 0.45, gravity: 0.35, floor: 0.15 };

function vertexNormals(P, T) {
  const N = new Float32Array(P.length);
  for (let t = 0; t < T.length; t += 3) {
    const a = T[t] * 3, b = T[t + 1] * 3, c = T[t + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const o of [a, b, c]) { N[o] += nx; N[o + 1] += ny; N[o + 2] += nz; }
  }
  for (let i = 0; i < N.length; i += 3) {
    const l = Math.hypot(N[i], N[i + 1], N[i + 2]) || 1;
    N[i] /= l; N[i + 1] /= l; N[i + 2] /= l;
  }
  return N;
}

function edgesOf(T) {
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

// edge distance (in rings) from the open borders of a triangle set
function borderRings(T, n, maxRing) {
  const count = new Map();
  for (let t = 0; t < T.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = T[t + k], b = T[t + ((k + 1) % 3)];
      const key = a < b ? a * 1e6 + b : b * 1e6 + a;
      count.set(key, (count.get(key) || 0) + 1);
    }
  }
  const ring = new Int32Array(n).fill(maxRing + 1);
  for (const [key, c] of count) if (c === 1) { ring[Math.floor(key / 1e6)] = 0; ring[key % 1e6] = 0; }
  const E = edgesOf(T);
  for (let r = 1; r <= maxRing; r++) {
    for (let e = 0; e < E.length; e += 2) {
      const a = E[e], b = E[e + 1];
      if (ring[a] === r - 1 && ring[b] > r) ring[b] = r;
      if (ring[b] === r - 1 && ring[a] > r) ring[a] = r;
    }
  }
  return ring;
}

function borderNeighbours(T, n) {
  const count = new Map();
  for (let t = 0; t < T.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = T[t + k], b = T[t + ((k + 1) % 3)];
      const key = a < b ? a * 1e6 + b : b * 1e6 + a;
      count.set(key, (count.get(key) || 0) + 1);
    }
  }
  const nb = new Int32Array(n * 2).fill(-1);
  for (const [key, c] of count) {
    if (c !== 1) continue;
    const a = Math.floor(key / 1e6), b = key % 1e6;
    nb[a * 2 + (nb[a * 2] < 0 ? 0 : 1)] = b;
    nb[b * 2 + (nb[b * 2] < 0 ? 0 : 1)] = a;
  }
  return nb;
}

// Clean, straight openings: each near-planar border loop (waistband, hems, cuffs) is flattened onto its
// plane, and the cloth next to it is kept on the garment's side of that plane (no saw-tooth edges).
function trimOpenings(X, m, bnb, ring, E) {
  const seen = new Uint8Array(m);
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < m; i++) { cx += X[i * 3]; cy += X[i * 3 + 1]; cz += X[i * 3 + 2]; }
  cx /= m; cy /= m; cz /= m;
  for (let s0 = 0; s0 < m; s0++) {
    if (bnb[s0 * 2] < 0 || seen[s0]) continue;
    const loop = [];
    let prev = -1, cur = s0;
    while (cur >= 0 && !seen[cur]) {
      seen[cur] = 1;
      loop.push(cur);
      const nx = bnb[cur * 2] !== prev ? bnb[cur * 2] : bnb[cur * 2 + 1];
      prev = cur;
      cur = nx;
    }
    if (loop.length < 8) continue;
    const c = [0, 0, 0];
    for (const i of loop) for (let k = 0; k < 3; k++) c[k] += X[i * 3 + k] / loop.length;
    const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (const i of loop) for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) C[a][b] += (X[i * 3 + a] - c[a]) * (X[i * 3 + b] - c[b]);
    // smallest eigenvector by inverse power iteration on (C + eps I)
    const inv = invert3(C.map((r, a) => r.map((v, b) => v + (a === b ? 1e-9 : 0))));
    let nv = [0.3, 1, 0.2];
    for (let it = 0; it < 30; it++) {
      const t = [0, 1, 2].map((a) => inv[a][0] * nv[0] + inv[a][1] * nv[1] + inv[a][2] * nv[2]);
      const l = Math.hypot(...t);
      nv = t.map((v) => v / l);
    }
    const spread = loop.reduce((acc, i) => acc + Math.abs((X[i * 3] - c[0]) * nv[0] + (X[i * 3 + 1] - c[1]) * nv[1] + (X[i * 3 + 2] - c[2]) * nv[2]), 0) / loop.length;
    if (spread > 0.012) continue; // not a flat opening (armhole, neckline): leave it
    // outward = away from the garment
    const toG = [cx - c[0], cy - c[1], cz - c[2]];
    if (toG[0] * nv[0] + toG[1] * nv[1] + toG[2] * nv[2] > 0) nv = nv.map((v) => -v);
    const sd = (i) => (X[i * 3] - c[0]) * nv[0] + (X[i * 3 + 1] - c[1]) * nv[1] + (X[i * 3 + 2] - c[2]) * nv[2];
    for (const i of loop) { const d = sd(i); for (let k = 0; k < 3; k++) X[i * 3 + k] -= d * nv[k]; }
    // neighbours within 3 rings of this loop stay behind the plane
    const near = new Map(loop.map((i) => [i, 0]));
    for (let r = 1; r <= 3; r++) {
      for (let e = 0; e < E.length; e += 2) {
        const a = E[e], b = E[e + 1];
        if (near.get(a) === r - 1 && !near.has(b)) near.set(b, r);
        else if (near.get(b) === r - 1 && !near.has(a)) near.set(a, r);
      }
    }
    for (const [i, r] of near) {
      if (r === 0) continue;
      const lim = -0.006 * r, d = sd(i);
      if (d > lim) for (let k = 0; k < 3; k++) X[i * 3 + k] -= (d - lim) * nv[k];
    }
  }
}

function invert3(M) {
  const [a, b, c] = M[0], [d, e, f] = M[1], [g, h, k] = M[2];
  const A = e * k - f * h, B = -(d * k - f * g), Cc = d * h - e * g;
  const det = a * A + b * B + c * Cc;
  return [
    [A / det, -(b * k - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * k - c * g) / det, -(a * f - c * d) / det],
    [Cc / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ];
}

// one Loop subdivision of a garment: smooth positions, blended skin weights and soft-tissue weights
function refine(cut, bonesCount) {
  const { X, index, skinIndex, skinWeight, soft } = cut;
  const n = X.length / 3;
  const loop = new Loop(index, n);
  const dense = new Float32Array(n * bonesCount);
  for (let i = 0; i < n; i++) for (let k = 0; k < 4; k++) dense[i * bonesCount + skinIndex[i * 4 + k]] += skinWeight[i * 4 + k] / 255;
  const W = loop.linear(dense, bonesCount);
  const N = loop.count;
  const sIdx = new Uint8Array(N * 4), sW = new Uint8Array(N * 4);
  for (let i = 0; i < N; i++) {
    const row = Array.from(W.subarray(i * bonesCount, (i + 1) * bonesCount), (w, b) => [w, b]).sort((p, q) => q[0] - p[0]).slice(0, 4);
    const tot = row.reduce((t, r) => t + r[0], 0) || 1;
    const q = row.map(([w]) => Math.floor((255 * w) / tot));
    q[0] += 255 - q.reduce((t, v) => t + v, 0);
    row.forEach(([, b], k) => { sIdx[i * 4 + k] = b; sW[i * 4 + k] = q[k]; });
  }
  const sSoft = Uint8Array.from(loop.linear(Float32Array.from(soft), 3), (v) => Math.round(v));
  return { X: loop.positions(X), index: Uint32Array.from(loop.index), skinIndex: sIdx, skinWeight: sW, soft: sSoft };
}

function largestComponent(T, n) {
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let t = 0; t < T.length; t += 3) {
    const a = find(T[t]);
    parent[find(T[t + 1])] = a;
    parent[find(T[t + 2])] = a;
  }
  const size = new Map();
  for (let t = 0; t < T.length; t += 3) { const r = find(T[t]); size.set(r, (size.get(r) || 0) + 1); }
  const best = [...size.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const out = [];
  for (let t = 0; t < T.length; t += 3) if (find(T[t]) === best) out.push(T[t], T[t + 1], T[t + 2]);
  return out;
}

/** Geometry and per-vertex data of a garment, in the body's bind pose. */
// The skin with bumps smaller than about sigma (nipples, veins, the navel rim) averaged away: each point
// moves along its normal to the area-weighted Gaussian mean height of the skin around it.
function debump(P, T, N, sigma) {
  const n = P.length / 3;
  const area = new Float32Array(n);
  for (let t = 0; t < T.length; t += 3) {
    const a = T[t] * 3, b = T[t + 1] * 3, c = T[t + 2] * 3;
    const u = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]];
    const v = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
    const A = Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 6;
    area[T[t]] += A; area[T[t + 1]] += A; area[T[t + 2]] += A;
  }
  const R = 2.5 * sigma;
  const key = (x, y, z) => `${Math.floor(x / R)},${Math.floor(y / R)},${Math.floor(z / R)}`;
  const grid = new Map();
  for (let i = 0; i < n; i++) {
    const k = key(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  }
  const out = Float32Array.from(P);
  const s2 = 2 * sigma * sigma;
  for (let i = 0; i < n; i++) {
    const o = i * 3;
    const gx = Math.floor(P[o] / R), gy = Math.floor(P[o + 1] / R), gz = Math.floor(P[o + 2] / R);
    let h = 0, W = 0;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const cell = grid.get(`${gx + dx},${gy + dy},${gz + dz}`);
      if (!cell) continue;
      for (const j of cell) {
        const q = j * 3;
        if (N[o] * N[q] + N[o + 1] * N[q + 1] + N[o + 2] * N[q + 2] < 0.5) continue; // other side of a fold
        const ex = P[q] - P[o], ey = P[q + 1] - P[o + 1], ez = P[q + 2] - P[o + 2];
        const d2 = ex * ex + ey * ey + ez * ez;
        if (d2 > R * R) continue;
        const w = area[j] * Math.exp(-d2 / s2);
        h += w * (ex * N[o] + ey * N[o + 1] + ez * N[o + 2]);
        W += w;
      }
    }
    if (W > 0) for (let c = 0; c < 3; c++) out[o + c] += (h / W) * N[o + c];
  }
  return out;
}

// Cotangent weights of the edges E of a triangle mesh (clamped at zero): a Laplacian with these weights
// approximates the surface's mean curvature whatever the triangle sizes, so a dense patch of small triangles
// relaxes like the rest of the cloth instead of standing out.
function cotanWeights(P, T, E) {
  const at = new Map();
  for (let e = 0; e < E.length; e += 2) at.set(E[e] < E[e + 1] ? E[e] * 1e6 + E[e + 1] : E[e + 1] * 1e6 + E[e], e / 2);
  const w = new Float32Array(E.length / 2);
  for (let t = 0; t < T.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const o = T[t + k], a = T[t + ((k + 1) % 3)], b = T[t + ((k + 2) % 3)];
      const u = [P[a * 3] - P[o * 3], P[a * 3 + 1] - P[o * 3 + 1], P[a * 3 + 2] - P[o * 3 + 2]];
      const v = [P[b * 3] - P[o * 3], P[b * 3 + 1] - P[o * 3 + 1], P[b * 3 + 2] - P[o * 3 + 2]];
      const dot = u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
      const cr = Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
      w[at.get(a < b ? a * 1e6 + b : b * 1e6 + a)] += (0.5 * dot) / Math.max(cr, 1e-12);
    }
  }
  for (let e = 0; e < w.length; e++) w[e] = Math.max(w[e], 0.02);
  return w;
}

export function cutGarment(kind, body) {
  const def = GARMENTS[kind];
  const { P, T, joints: J, bones, skinIndex, skinWeight, soft } = body;
  const n = P.length / 3;
  const B = (name) => bones.indexOf(name);
  const dom = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    let b = 0;
    for (let k = 1; k < 4; k++) if (skinWeight[i * 4 + k] > skinWeight[i * 4 + b]) b = k;
    dom[i] = skinIndex[i * 4 + b];
  }
  const y = (i) => P[i * 3 + 1];
  const waistY = J.hips[1] + 0.55 * (J.spine[1] - J.hips[1]);
  if (kind === 'skirt') return skirt(def, body, dom, waistY);

  const set = new Set();
  const isAny = (i, names) => names.some((nm) => dom[i] === B(nm));
  for (let i = 0; i < n; i++) {
    if (def.slot === 'bottom') {
      if (!isAny(i, ['hips', 'spine', 'thigh.L', 'thigh.R', 'shin.L', 'shin.R', 'foot.L', 'foot.R'])) continue;
      if (y(i) > waistY) continue;
      const stop = def.length === 'ankle'
        ? J['ankle.L'][1] + 0.05
        : J['knee.L'][1] + 0.55 * (J['hip.L'][1] - J['knee.L'][1]) * 0.5;
      if (y(i) < stop) continue;
      set.add(i);
    } else {
      const neckY = J.neck[1] - 0.03;
      const bottomY = waistY - 0.07;
      if (y(i) > neckY || y(i) < bottomY) continue;
      if (isAny(i, ['hips', 'spine', 'chest'])) { set.add(i); continue; }
      if (def.sleeves > 0) {
        for (const s of ['L', 'R']) {
          if (dom[i] !== B(`upperArm.${s}`)) continue;
          const sh = J[`shoulder.${s}`], el = J[`elbow.${s}`];
          const ax = [el[0] - sh[0], el[1] - sh[1], el[2] - sh[2]];
          const len = Math.hypot(...ax);
          const t = ((P[i * 3] - sh[0]) * ax[0] + (P[i * 3 + 1] - sh[1]) * ax[1] + (P[i * 3 + 2] - sh[2]) * ax[2]) / (len * len);
          if (t < def.sleeves) set.add(i);
        }
      }
    }
  }
  let tris = [];
  for (let t = 0; t < T.length; t += 3) if (set.has(T[t]) && set.has(T[t + 1]) && set.has(T[t + 2])) tris.push(t / 3);
  // keep one piece
  const flat = [];
  for (const t of tris) flat.push(T[t * 3], T[t * 3 + 1], T[t * 3 + 2]);
  const kept = largestComponent(flat, n);
  const keptSet = new Set();
  for (let k = 0; k < kept.length; k += 3) keptSet.add(`${kept[k]},${kept[k + 1]},${kept[k + 2]}`);
  tris = tris.filter((t) => keptSet.has(`${T[t * 3]},${T[t * 3 + 1]},${T[t * 3 + 2]}`));

  // compact
  const map = new Int32Array(n).fill(-1);
  const src = [];
  const idx = new Uint32Array(tris.length * 3);
  tris.forEach((t, k) => {
    for (let c = 0; c < 3; c++) {
      const v = T[t * 3 + c];
      if (map[v] < 0) { map[v] = src.length; src.push(v); }
      idx[k * 3 + c] = map[v];
    }
  });
  const m = src.length;
  const ring = borderRings(idx, m, 3);
  const bnb = borderNeighbours(idx, m);
  const E = edgesOf(idx);
  const deg = new Float32Array(m);
  for (let e = 0; e < E.length; e++) deg[E[e]]++;
  // the ease is measured from a smoothed body, so small bumps (nipples, veins, muscle edges) never print through.
  // Smoothing moves points only along a smoothed normal field, so every point stays over its own patch of skin.
  const P0 = new Float32Array(m * 3);
  for (let i = 0; i < m; i++) for (let c = 0; c < 3; c++) P0[i * 3 + c] = P[src[i] * 3 + c];
  let NS = vertexNormals(P0, idx);
  for (let it = 0; it < 8; it++) { // smooth the normal field
    const acc = new Float32Array(m * 3);
    for (let e = 0; e < E.length; e += 2) {
      const a = E[e] * 3, b = E[e + 1] * 3;
      for (let c = 0; c < 3; c++) { acc[a + c] += NS[b + c]; acc[b + c] += NS[a + c]; }
    }
    for (let i = 0; i < m; i++) {
      const o = i * 3;
      for (let c = 0; c < 3; c++) NS[o + c] += 0.5 * (acc[o + c] / deg[i] - NS[o + c]);
      const l = Math.hypot(NS[o], NS[o + 1], NS[o + 2]) || 1;
      NS[o] /= l; NS[o + 1] /= l; NS[o + 2] /= l;
    }
  }
  // PS: the body with its hollows filled (smoothed over a few centimetres), PR: the body without small sharp
  // bumps. Mesh (uniform) smoothing would keep a bump made of a dense cluster of tiny triangles (the nipples
  // are) and even grow one, so both average over skin by distance, weighted by area: size counts, not vertices.
  const PR = debump(P0, idx, NS, 0.01);
  const PS = debump(P0, idx, NS, 0.025);
  // and the cloth moves along the normals of that smooth surface (a dense patch keeps its own fan of normals
  // through mesh smoothing, which would push its points sideways)
  NS = vertexNormals(PS, idx);
  const NB = new Float32Array(P.length);
  for (let i = 0; i < m; i++) for (let c = 0; c < 3; c++) NB[src[i] * 3 + c] = NS[i * 3 + c];
  // lift off the skin: snug at the waistband and cuffs, looser elsewhere
  const X = new Float32Array(m * 3);
  const lift = new Float32Array(m);
  const hemY = J.chest[1] - 0.05;
  for (let i = 0; i < m; i++) {
    const yy = P[src[i] * 3 + 1];
    // only the waistband and the neckline hug the body; hems and cuffs stand off it a little
    const snug = ring[i] <= 1 && (def.slot === 'top' ? yy > hemY + 0.15 : yy > J.hips[1]);
    lift[i] = snug ? 0.008 : def.ease + (def.slot === 'bottom' && ring[i] <= 1 ? 0.004 : 0);
    for (let c = 0; c < 3; c++) X[i * 3 + c] = PR[i * 3 + c] + NS[i * 3 + c] * lift[i];
  }
  for (let it = 0; it < 12; it++) { // straighten the cut edges (waistband, cuffs, neckline)
    const Y = Float32Array.from(X);
    for (let i = 0; i < m; i++) {
      if (bnb[i * 2] < 0) continue;
      const a = bnb[i * 2] * 3, b = bnb[i * 2 + 1] * 3;
      for (let c = 0; c < 3; c++) X[i * 3 + c] = 0.5 * Y[i * 3 + c] + 0.25 * (Y[a + c] + Y[b + c]);
    }
  }
  trimOpenings(X, m, bnb, ring, E);
  // Drape: the cloth is a membrane over the body, not a skin. Smoothing with a floor (skin + ease) keeps it
  // off convex parts and lets it span the hollows: between the pecs, under the bust, the small of the back,
  // the seat. Body detail (muscle grooves) no longer shows through.
  const floor = (i) => {
    const o = src[i] * 3;
    const hs = (X[i * 3] - PS[i * 3]) * NB[o] + (X[i * 3 + 1] - PS[i * 3 + 1]) * NB[o + 1] + (X[i * 3 + 2] - PS[i * 3 + 2]) * NB[o + 2];
    const hp = (X[i * 3] - PR[i * 3]) * NB[o] + (X[i * 3 + 1] - PR[i * 3 + 1]) * NB[o + 1] + (X[i * 3 + 2] - PR[i * 3 + 2]) * NB[o + 2];
    const need = Math.max(lift[i] - hs, Math.min(0.007, lift[i]) - hp);
    if (need > 0) for (let c = 0; c < 3; c++) X[i * 3 + c] += need * NB[o + c];
  };
  const W = cotanWeights(P0, idx, E);
  const wsum = new Float32Array(m);
  for (let e = 0; e < E.length; e += 2) { wsum[E[e]] += W[e / 2]; wsum[E[e + 1]] += W[e / 2]; }
  const tension = (its) => {
    for (let it = 0; it < its; it++) {
      const acc = new Float32Array(m * 3);
      for (let e = 0; e < E.length; e += 2) {
        const a = E[e] * 3, b = E[e + 1] * 3, w = W[e / 2];
        for (let c = 0; c < 3; c++) { acc[a + c] += w * X[b + c]; acc[b + c] += w * X[a + c]; }
      }
      for (let i = 0; i < m; i++) {
        if (ring[i] === 0) continue;
        // move only along the (smoothed) normal: no tangential drift, so each point stays over its patch of skin
        const o = i * 3;
        const d = (acc[o] / wsum[i] - X[o]) * NS[o] + (acc[o + 1] / wsum[i] - X[o + 1]) * NS[o + 1] + (acc[o + 2] / wsum[i] - X[o + 2]) * NS[o + 2];
        for (let c = 0; c < 3; c++) X[o + c] += 0.5 * d * NS[o + c];
        floor(i);
      }
    }
  };
  for (let i = 0; i < m; i++) floor(i); // openings too
  tension(150);
  if (def.drape) hang(X, src, m, def, J, P, dom, B, ring);
  tension(4);
  if (def.hem) { looseLegs(X, src, m, def, J, P, E, deg, ring); tension(3); }
  const sIdx = new Uint8Array(m * 4), sW = new Uint8Array(m * 4), sSoft = new Uint8Array(m * 3);
  for (let i = 0; i < m; i++) {
    sIdx.set(skinIndex.subarray(src[i] * 4, src[i] * 4 + 4), i * 4);
    sW.set(skinWeight.subarray(src[i] * 4, src[i] * 4 + 4), i * 4);
    sSoft.set(soft.subarray(src[i] * 3, src[i] * 3 + 3), i * 3);
  }
  // simulate one level finer than the body, so folds have room to form
  const fine = refine({ X, index: idx, skinIndex: sIdx, skinWeight: sW, soft: sSoft }, bones.length);
  const nf = fine.X.length / 3;
  const fr = borderRings(fine.index, nf, 4);
  const pull = new Float32Array(nf);
  for (let i = 0; i < nf; i++) pull[i] = [1, 0.5, 0.15, 0.04][fr[i]] ?? CFG.pull;
  // around the waist a bottom stays close to the body, so a top can always cover it
  const ceil = new Float32Array(nf).fill(def.slot === 'top' ? 0.025 : 0.03); // and no fold stands out more than this
  const hipY = 0.5 * (J['hip.L'][1] + J['hip.R'][1]);
  if (def.slot === 'bottom') {
    for (let i = 0; i < nf; i++) {
      const x = fine.X[i * 3], y = fine.X[i * 3 + 1];
      if (y > J.hips[1] - 0.04) ceil[i] = 0.003;
      else if (Math.abs(x) < 0.08 && y > hipY - 0.16) ceil[i] = 0.006; // the crotch folds flat, not into a flap
    }
  }
  if (def.slot === 'bottom') { // trouser hems may ride up the leg
    for (let i = 0; i < nf; i++) if (fr[i] <= 1 && fine.X[i * 3 + 1] < J.hips[1] - 0.1) pull[i] = [0.25, 0.12][fr[i]];
  }
  if (def.slot === 'top') { // a top's hem hangs free
    for (let i = 0; i < nf; i++) if (fr[i] <= 3 && fine.X[i * 3 + 1] < hemY) pull[i] = [0.06, 0.03, 0.015, 0.01][fr[i]];
  }
  // body triangles hidden under the garment (not too near its openings, where you can look in)
  // (measured in centimetres from the openings, not in mesh rings: the body mesh is coarse in places)
  const fromEdge = new Float32Array(m).fill(1);
  for (let i = 0; i < m; i++) if (ring[i] === 0) fromEdge[i] = 0;
  for (let it = 0; it < 30; it++) {
    for (let e = 0; e < E.length; e += 2) {
      const a = E[e], b = E[e + 1];
      const l = Math.hypot(X[a * 3] - X[b * 3], X[a * 3 + 1] - X[b * 3 + 1], X[a * 3 + 2] - X[b * 3 + 2]);
      if (fromEdge[a] + l < fromEdge[b]) fromEdge[b] = fromEdge[a] + l;
      if (fromEdge[b] + l < fromEdge[a]) fromEdge[a] = fromEdge[b] + l;
    }
  }
  const inner = new Set();
  for (let i = 0; i < m; i++) if (fromEdge[i] > 0.025) inner.add(src[i]);
  const hidden = new Uint8Array(T.length / 3);
  for (let t = 0; t < T.length; t += 3) if (inner.has(T[t]) && inner.has(T[t + 1]) && inner.has(T[t + 2])) hidden[t / 3] = 1;
  const { seam, h0 } = tailor(kind, def, fine.X, fine.index, fine.skinIndex, fine.skinWeight, bones, J);
  return { kind, def, ...fine, pull, ceil, gravity: CFG.gravity, hidden, seam, h0 };
}

// A top falls from the widest part of the chest (bust, pecs, shoulder blades) instead of following the
// waist in: below the chest each column of cloth keeps (drape x) the chest's radius around the torso axis.
function hang(X, src, m, def, J, P, dom, B, ring) {
  const trunk = new Set(['hips', 'spine', 'chest'].map(B));
  const yb = J.chest[1];
  const BINS = 48;
  let cz = 0, cnt = 0;
  for (let i = 0; i < m; i++) if (trunk.has(dom[src[i]]) && Math.abs(X[i * 3 + 1] - yb) < 0.03) { cz += X[i * 3 + 2]; cnt++; }
  cz /= cnt || 1;
  const bin = (x, z) => Math.floor(((Math.atan2(z - cz, x) + Math.PI) / (2 * Math.PI)) * BINS) % BINS;
  const Rmax = new Float32Array(BINS);
  for (let i = 0; i < m; i++) {
    if (!trunk.has(dom[src[i]])) continue;
    const x = X[i * 3], y = X[i * 3 + 1], z = X[i * 3 + 2];
    if (y < yb - 0.08 || y > yb + 0.04) continue;
    const k = bin(x, z);
    Rmax[k] = Math.max(Rmax[k], Math.hypot(x, z - cz));
  }
  for (let it = 0; it < 2; it++) { // fill and soften the profile
    const c = Float32Array.from(Rmax);
    for (let k = 0; k < BINS; k++) Rmax[k] = Math.max(c[k], 0.5 * (c[(k + 1) % BINS] + c[(k + BINS - 1) % BINS]));
  }
  for (let i = 0; i < m; i++) {
    if (!trunk.has(dom[src[i]])) continue;
    const x = X[i * 3], y = X[i * 3 + 1], z = X[i * 3 + 2];
    if (y >= yb) continue;
    const t = Math.min(1, (yb - y) / 0.08);
    const blend = t * t * (3 - 2 * t);
    const r = Math.hypot(x, z - cz);
    const R = Rmax[bin(x, z)];
    if (r >= R || r < 1e-6) continue;
    const f = 1 + (blend * def.drape * (R - r)) / r; // fill (drape x) the hollow below the chest
    X[i * 3] = x * f;
    X[i * 3 + 2] = cz + (z - cz) * f;
  }
}

// Trouser legs hang from the seat and thigh instead of hugging knee and calf: below the crotch each leg
// is pushed out to a tube that narrows from the thigh to the hem.
function looseLegs(X, src, m, def, J, P, E, deg, ring) {
  for (const s of ['L', 'R']) {
    const a = J[`hip.${s}`], b = J[`ankle.${s}`];
    const ax = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const len = Math.hypot(...ax);
    ax[0] /= len; ax[1] /= len; ax[2] /= len;
    const crotch = 0.14; // fraction of hip-ankle where the legs separate
    const side = s === 'L' ? 1 : -1;
    const info = [];
    const top = [];
    for (let i = 0; i < m; i++) {
      if (side * X[i * 3] <= 0.005) continue;
      const v = [X[i * 3] - a[0], X[i * 3 + 1] - a[1], X[i * 3 + 2] - a[2]];
      const t = (v[0] * ax[0] + v[1] * ax[1] + v[2] * ax[2]) / len;
      if (t < crotch) continue;
      const u = [v[0] - ax[0] * t * len, v[1] - ax[1] * t * len, v[2] - ax[2] * t * len];
      const d = Math.hypot(...u);
      if (t < crotch + 0.08) top.push(d);
      info.push([i, t, u, d]);
    }
    top.sort((p, q) => p - q);
    const rTop = top[Math.floor(top.length * 0.5)] || def.hem;
    for (const [i, t, u, d] of info) {
      const f = Math.min(1, (t - crotch) / (1 - crotch));
      const R = rTop * (1 - f) + def.hem * f;
      const blend = Math.min(1, (t - crotch) / 0.06); // ease in below the crotch
      const nd = d + Math.min(0.035, Math.max(0, R - d)) * blend; // never more than 3.5 cm of ease
      if (d > 1e-6) for (let c = 0; c < 3; c++) X[i * 3 + c] += (u[c] / d) * (nd - d);
    }
  }
  for (let it = 0; it < 3; it++) { // blend the seam
    const acc = new Float32Array(m * 3);
    for (let e = 0; e < E.length; e += 2) {
      const p = E[e] * 3, q = E[e + 1] * 3;
      for (let c = 0; c < 3; c++) { acc[p + c] += X[q + c]; acc[q + c] += X[p + c]; }
    }
    for (let i = 0; i < m; i++) if (ring[i] > 0) for (let c = 0; c < 3; c++) X[i * 3 + c] += 0.3 * (acc[i * 3 + c] / deg[i] - X[i * 3 + c]);
  }
}

// A skirt: rings from the waist down, wrapping hips and both thighs, flaring toward the hem.
function skirt(def, body, dom, waistY) {
  const { P, T, joints: J, bones } = body;
  const n = P.length / 3;
  const ids = new Set(['hips', 'spine', 'thigh.L', 'thigh.R'].map((b) => bones.indexOf(b)));
  const R = 22, M = 72;
  const hemY = waistY - def.length;
  const X = new Float32Array(R * M * 3);
  let cx = 0, cz = 0, cnt = 0;
  for (let i = 0; i < n; i++) if (ids.has(dom[i]) && Math.abs(P[i * 3 + 1] - waistY) < 0.03) { cx += P[i * 3]; cz += P[i * 3 + 2]; cnt++; }
  cx /= cnt; cz /= cnt;
  let prev = null;
  const minRad = new Float32Array(R * M);
  const crotchY = 0.5 * (J['hip.L'][1] + J['hip.R'][1]) - 0.16; // down past the seat
  for (let r = 0; r < R; r++) {
    const yy = waistY + (hemY - waistY) * (r / (R - 1));
    const rad = new Float32Array(M).fill(0.08);
    for (let i = 0; i < n; i++) {
      if (!ids.has(dom[i]) || Math.abs(P[i * 3 + 1] - yy) > 0.025) continue;
      const dx = P[i * 3] - cx, dz = P[i * 3 + 2] - cz;
      const k = Math.round(((Math.atan2(dz, dx) + Math.PI) / (2 * Math.PI)) * M) % M;
      rad[k] = Math.max(rad[k], Math.hypot(dx, dz));
    }
    // smooth around the ring, then never narrower than the ring above (+ a little flare)
    for (let it = 0; it < 3; it++) {
      const c = Float32Array.from(rad);
      for (let k = 0; k < M; k++) rad[k] = Math.max(c[k], 0.5 * (c[(k + M - 1) % M] + c[(k + 1) % M]));
    }
    for (let k = 0; k < M; k++) {
      if (yy > crotchY) minRad[r * M + k] = rad[k] + 0.013; // hips and seat: never inside these
      rad[k] += r === 0 ? 0.006 : 0.012;
      if (prev) rad[k] = Math.max(rad[k], prev[k] + 0.004);
      const a = (k / M) * 2 * Math.PI - Math.PI;
      X.set([cx + Math.cos(a) * rad[k], yy, cz + Math.sin(a) * rad[k]], (r * M + k) * 3);
    }
    prev = rad;
  }
  const idx = [];
  for (let r = 0; r < R - 1; r++) {
    for (let k = 0; k < M; k++) {
      const a = r * M + k, b = r * M + ((k + 1) % M), c = (r + 1) * M + k, d = (r + 1) * M + ((k + 1) % M);
      idx.push(a, c, b, b, c, d);
    }
  }
  const N = R * M;
  const sIdx = new Uint8Array(N * 4), sW = new Uint8Array(N * 4), pull = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    sIdx[i * 4] = bones.indexOf('hips');
    sW[i * 4] = 255;
    const r = Math.floor(i / M);
    pull[i] = r === 0 ? 1 : r === 1 ? 0.3 : 0;
  }
  // the body under the skirt's hip section (hips, seat, tops of the thighs) is never seen: hide it
  const hidden = new Uint8Array(T.length / 3);
  const under = (i) => ids.has(dom[i]) && P[i * 3 + 1] < waistY - 0.03 && P[i * 3 + 1] > crotchY + 0.03;
  for (let t = 0; t < T.length; t += 3) if (under(T[t]) && under(T[t + 1]) && under(T[t + 2])) hidden[t / 3] = 1;
  const { seam, h0 } = tailorSkirt(X, R, M, [cx, cz]);
  return { kind: 'skirt', def, X, index: Uint32Array.from(idx), skinIndex: sIdx, skinWeight: sW, soft: new Uint8Array(N * 3), pull, gravity: 1, hidden, minRad, axis: [cx, cz], seam, h0 };
}

export class Garment {
  /**
   * @param cut       cutGarment(...)
   * @param bodyMesh  the bound body SkinnedMesh (bones, bone inverses, soft-tissue offsets)
   * @param collider  the body's Collider (spheres), built in the rest pose
   */
  constructor(cut, bodyMesh, collider, rig) {
    Object.assign(this, cut);
    this.body = bodyMesh;
    this.collider = collider;
    const n = (this.n = this.X.length / 3);
    this.pos = new Float32Array(n * 3);
    this.prev = new Float32Array(n * 3);
    this.target = new Float32Array(n * 3);
    this.lastTarget = new Float32Array(n * 3);
    this.M = bodyMesh.skeleton.bones.map(() => new THREE.Matrix4());
    // the cloth's natural lengths are those of the fitted shape on the body standing at rest
    const pose = rig.snapshot();
    rig.reset();
    rig.update();
    this.computeTargets();
    rig.restore(pose);
    rig.update();
    const R = this.target;
    this.edges = edgesOf(this.index);
    this.rest = new Float32Array(this.edges.length / 2);
    for (let e = 0; e < this.rest.length; e++) {
      const a = this.edges[e * 2] * 3, b = this.edges[e * 2 + 1] * 3;
      this.rest[e] = Math.hypot(R[a] - R[b], R[a + 1] - R[b + 1], R[a + 2] - R[b + 2]);
    }
    if (this.kind === 'skirt') this.addSkirtBends();
    this.loop = new Loop(this.index, n);
    const g = new THREE.BufferGeometry();
    const count = this.loop.count;
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(count * 3).fill(1), 3));
    g.setAttribute('restPos', new THREE.BufferAttribute(this.loop.positions(this.X), 3));
    g.setAttribute('seamInfo', new THREE.BufferAttribute(this.loop.linear(this.seam, 2), 2));
    g.setIndex(new THREE.BufferAttribute(this.loop.index, 1));
    this.material = fabricMaterial(this.def.color);
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.dispEdges = edgesOf(this.loop.index);
    this.buildHemStrip(g);
    this.awake = 0;
    this.ready = false;
  }

  // skirts get "bend" links across two rows/columns so they hang in soft folds instead of crumpling
  addSkirtBends() {
    const M = 72, R = this.n / M;
    const extra = [], rest = [];
    for (let r = 0; r < R; r++) for (let k = 0; k < M; k++) {
      const a = r * M + k;
      const pairs = [[a, r * M + ((k + 2) % M)]];
      if (r + 2 < R) pairs.push([a, (r + 2) * M + k]);
      for (const [p, q] of pairs) {
        extra.push(p, q);
        const T = this.target;
        rest.push(Math.hypot(T[p * 3] - T[q * 3], T[p * 3 + 1] - T[q * 3 + 1], T[p * 3 + 2] - T[q * 3 + 2]));
      }
    }
    this.bendStart = this.rest.length;
    this.edges = Uint32Array.from([...this.edges, ...extra]);
    this.rest = Float32Array.from([...this.rest, ...rest]);
  }

  // where the garment would be if it were glued to the body (skinning + soft-tissue jiggle)
  computeTargets() {
    const bones = this.body.skeleton.bones, inv = this.body.skeleton.boneInverses;
    bones.forEach((b, k) => this.M[k].multiplyMatrices(b.matrixWorld, inv[k]));
    const so = this.body.userData.softOffset;
    const X = this.X, out = this.target, si = this.skinIndex, sw = this.skinWeight, soft = this.soft;
    for (let i = 0; i < this.n; i++) {
      let x = X[i * 3], y = X[i * 3 + 1], z = X[i * 3 + 2];
      if (so) for (let s = 0; s < 3; s++) { const w = soft[i * 3 + s] / 255; if (w) { x += so[s].x * w; y += so[s].y * w; z += so[s].z * w; } }
      let ox = 0, oy = 0, oz = 0;
      for (let k = 0; k < 4; k++) {
        const w = sw[i * 4 + k] / 255;
        if (!w) continue;
        const e = this.M[si[i * 4 + k]].elements;
        ox += w * (e[0] * x + e[4] * y + e[8] * z + e[12]);
        oy += w * (e[1] * x + e[5] * y + e[9] * z + e[13]);
        oz += w * (e[2] * x + e[6] * y + e[10] * z + e[14]);
      }
      out[i * 3] = ox; out[i * 3 + 1] = oy; out[i * 3 + 2] = oz;
    }
    if (this.kind !== 'skirt') {
      this.targetN = vertexNormals(out, this.index);
      // where the body folds deeply (hip crease when sitting, inside of the elbow) the cloth just follows
      // the body into the crease; folds form where it is only moderately compressed
      if (this.rest) {
        const E = this.edges, L = this.rest, ne = this.bendStart ?? L.length;
        const sum = this.cmpSum || (this.cmpSum = new Float32Array(this.n));
        const cnt = this.cmpCnt || (this.cmpCnt = new Float32Array(this.n));
        sum.fill(0); cnt.fill(0);
        for (let e = 0; e < ne; e++) {
          const a = E[e * 2], b = E[e * 2 + 1];
          const r = Math.hypot(out[a * 3] - out[b * 3], out[a * 3 + 1] - out[b * 3 + 1], out[a * 3 + 2] - out[b * 3 + 2]) / L[e];
          sum[a] += r; sum[b] += r; cnt[a]++; cnt[b]++;
        }
        const ex = this.extraPull || (this.extraPull = new Float32Array(this.n));
        for (let i = 0; i < this.n; i++) {
          const c = sum[i] / cnt[i];
          const t = Math.min(1, Math.max(0, (0.86 - c) / 0.2));
          ex[i] = 0.5 * t * t * (3 - 2 * t);
        }
      }
    }
    else {
      this.hipsM = this.M[si[0]]; // skirts ride on the hips bone only
      this.hipsInv = (this.hipsInv || new THREE.Matrix4()).copy(this.hipsM).invert();
    }
  }

  // collision spheres each vertex may touch (nearby ones in the rest pose; all leg/hip spheres for skirts)
  buildCandidates() {
    const C = this.collider;
    C.updateWorld();
    const S = C.spheres, W = C.world;
    this.cand = [];
    const skirtSet = S.map((s, j) => j).filter((j) => S[j].group.startsWith('leg'));
    this.skirtSet = Int32Array.from(skirtSet);
    // fitted pieces: their own skin is handled by the floor constraint; spheres keep out the *other*
    // limbs (an arm against the shirt, the other leg against a trouser leg, a hand on the hip)
    const groups = (globalThis.CLOTH_GROUPS || 'arm,leg').split(',');
    const limb = S.map((s, j) => j).filter((j) => groups.some((gname) => S[j].group.startsWith(gname)));
    for (let i = 0; i < this.n; i++) {
      if (this.kind === 'skirt' || this.pull[i] >= 1) { this.cand.push([]); continue; }
      const own = new Set();
      for (let k = 0; k < 4; k++) if (this.skinWeight[i * 4 + k] > 40) own.add(this.skinIndex[i * 4 + k]);
      const x = this.target[i * 3], y = this.target[i * 3 + 1], z = this.target[i * 3 + 2];
      const near = [];
      for (const j of limb) {
        if (own.has(S[j].bone)) continue;
        const d = Math.hypot(x - W[j].x, y - W[j].y, z - W[j].z) - ((S[j].rs ?? S[j].r) + 0.008);
        if (d > 0.004 && d < 0.08) near.push([d, j]); // touching already at rest = part of a joint
      }
      near.sort((a, b) => a[0] - b[0]);
      this.cand.push(near.slice(0, 8).map((p) => p[1]));
    }
    this.candStart = new Int32Array(this.n + 1);
    this.cand.forEach((c, i) => { this.candStart[i + 1] = this.candStart[i] + c.length; });
    this.candFlat = Int32Array.from(this.cand.flat());
  }

  // ---- fitted garments: the cloth rides on the body; folds are heights along the normal ----
  // Each vertex sits at (fitted point + h * normal), h >= 0. Where the body pose squeezes the cloth
  // shorter than its natural length, neighbouring heights are pushed apart until the edge length is
  // restored: the excess fabric buckles outward into folds, as much as there is excess and no more.
  // The cloth can never sink into the body or slide off the part it covers.
  initHeights() {
    const n = this.n;
    this.h = new Float32Array(n);
    let x = 12345;
    this.seed = Float32Array.from({ length: n }, () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return (x / 0x7fffffff) * 0.0004; });
    // neighbour lists for smoothing
    const deg = new Uint16Array(n);
    const E = this.edges, ne = this.bendStart ?? this.rest.length;
    for (let e = 0; e < ne; e++) { deg[E[e * 2]]++; deg[E[e * 2 + 1]]++; }
    this.deg = deg;
  }

  relaxFolds(iterations) {
    const n = this.n, h = this.h, T = this.target, N = this.targetN, E = this.edges, L = this.rest;
    const ne = this.bendStart ?? L.length;
    const ceil = this.ceil, pull = this.pull, seed = this.seed, h0 = this.h0;
    const acc = this._acc || (this._acc = new Float32Array(n));
    for (let it = 0; it < iterations; it++) {
      for (let e = 0; e < ne; e++) {
        const a = E[e * 2], b = E[e * 2 + 1];
        const oa = a * 3, ob = b * 3;
        const ha = h[a] + seed[a] + h0[a], hb = h[b] + seed[b] + h0[b];
        const dx = T[ob] + hb * N[ob] - T[oa] - ha * N[oa];
        const dy = T[ob + 1] + hb * N[ob + 1] - T[oa + 1] - ha * N[oa + 1];
        const dz = T[ob + 2] + hb * N[ob + 2] - T[oa + 2] - ha * N[oa + 2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-9;
        const C = d - L[e];
        if (C >= 0) continue; // only squeezed fabric buckles
        const ga = -(dx * N[oa] + dy * N[oa + 1] + dz * N[oa + 2]) / d;
        const gb = (dx * N[ob] + dy * N[ob + 1] + dz * N[ob + 2]) / d;
        const wa = pull[a] >= 1 ? 0 : 1, wb = pull[b] >= 1 ? 0 : 1;
        const w = wa * ga * ga + wb * gb * gb;
        if (w < 1e-6) continue;
        const k = (-0.5 * C) / w;
        h[a] += wa * k * ga;
        h[b] += wb * k * gb;
      }
      // folds a few vertices wide, never into the body, never taller than allowed
      acc.fill(0);
      for (let e = 0; e < ne; e++) { const a = E[e * 2], b = E[e * 2 + 1]; acc[a] += h[b]; acc[b] += h[a]; }
      for (let i = 0; i < n; i++) {
        let v = h[i] + 0.45 * (acc[i] / this.deg[i] - h[i]);
        v *= 0.995; // unsqueezed fabric smooths back out
        h[i] = pull[i] >= 1 ? 0 : Math.min(ceil[i], Math.max(0, v));
      }
    }
    const pos = this.pos;
    for (let i = 0; i < n; i++) {
      const o = i * 3, hh = h[i] + h0[i];
      pos[o] = T[o] + hh * N[o]; pos[o + 1] = T[o + 1] + hh * N[o + 1]; pos[o + 2] = T[o + 2] + hh * N[o + 2];
    }
  }

  reset() {
    this.body.updateMatrixWorld(true);
    this.computeTargets();
    if (this.targetN) {
      if (!this.h) this.initHeights();
      this.h.fill(0);
      this.relaxFolds(40);
      this.lastTarget.set(this.target);
      this.awake = 0;
      this.ready = true;
      this.writeGeometry();
      return;
    }
    if (!this.cand) this.buildCandidates();
    this.pos.set(this.target);
    this.prev.set(this.target);
    this.lastTarget.set(this.target);
    this.awake = 90;
    this.ready = true;
    this.settle(40);
    this.writeGeometry();
  }

  settle(frames) {
    for (let f = 0; f < frames; f++) this.step(1 / 60);
  }

  update(dt) {
    if (!this.ready) { this.reset(); return; }
    this.computeTargets();
    let moved = 0;
    for (let i = 0; i < this.target.length; i++) moved = Math.max(moved, Math.abs(this.target[i] - this.lastTarget[i]));
    this.lastTarget.set(this.target);
    if (moved > 2e-4) this.awake = 90; // keep simulating a while after the body stops
    if (this.targetN) { // fitted: follow the body every frame it moves, settle the folds a bit longer
      if (moved > 1e-5) this.awake = Math.max(this.awake, 20);
      if (this.awake <= 0) return;
      this.awake--;
      this.relaxFolds(6);
      this.writeGeometry();
      return;
    }
    if (this.awake <= 0) return;
    this.awake--;
    this.step(Math.min(dt, 1 / 30));
    this.writeGeometry();
  }

  step(dt) {
    const SUB = CFG.sub, ITER = CFG.iter;
    const h = dt / SUB;
    const pos = this.pos, prev = this.prev, tgt = this.target, pull = this.pull;
    const E = this.edges, L = this.rest, n = this.n;
    const S = this.collider.spheres, W = this.collider.world;
    this.collider.updateWorld();
    const cx = new Float32Array(S.length), cy = new Float32Array(S.length), cz = new Float32Array(S.length), cr = new Float32Array(S.length);
    const grow = this.kind === 'skirt' ? 0.01 : 0.008;
    for (let j = 0; j < S.length; j++) { cx[j] = W[j].x; cy[j] = W[j].y; cz[j] = W[j].z; cr[j] = (S[j].rs ?? S[j].r) + grow; }
    let cs = this.candStart, cf = this.candFlat;
    if (this.kind === 'skirt') {
      // broad phase: spheres near the skirt this frame, tested against every skirt vertex
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      for (let i = 0; i < pos.length; i += 3) {
        x0 = Math.min(x0, pos[i]); x1 = Math.max(x1, pos[i]);
        y0 = Math.min(y0, pos[i + 1]); y1 = Math.max(y1, pos[i + 1]);
        z0 = Math.min(z0, pos[i + 2]); z1 = Math.max(z1, pos[i + 2]);
      }
      const near = [];
      for (const j of this.skirtSet) {
        const r = cr[j] + 0.05;
        if (cx[j] + r > x0 && cx[j] - r < x1 && cy[j] + r > y0 && cy[j] - r < y1 && cz[j] + r > z0 && cz[j] - r < z1) near.push(j);
      }
      cf = Int32Array.from(near);
      cs = { length: 0 };
      this._skirtNear = cf;
    }
    const g = -9.81 * this.gravity * h * h;
    const damp = CFG.damp;
    const bendFrom = this.bendStart ?? Infinity;
    const ne = E.length / 2;
    const exE = this.extraPull;
    const tn = this.targetN, floorD = CFG.floor * (this.def.thickness || 0);
    for (let s = 0; s < SUB; s++) {
      for (let i = 0; i < n * 3; i += 3) {
        const vx = (pos[i] - prev[i]) * damp, vy = (pos[i + 1] - prev[i + 1]) * damp, vz = (pos[i + 2] - prev[i + 2]) * damp;
        prev[i] = pos[i]; prev[i + 1] = pos[i + 1]; prev[i + 2] = pos[i + 2];
        pos[i] += vx; pos[i + 1] += vy + g; pos[i + 2] += vz;
      }
      for (let it = 0; it < ITER; it++) {
        if (tn) {
          // cloth clings to the skin (friction): it hardly slides along the body, but is free to lift
          // off it, so a compressed patch folds outward
          const ks = CFG.slide;
          const ex = this.extraPull;
          for (let i = 0; i < n; i++) {
            const o = i * 3, k = ex ? Math.max(pull[i], ex[i]) : pull[i];
            const dx = tgt[o] - pos[o], dy = tgt[o + 1] - pos[o + 1], dz = tgt[o + 2] - pos[o + 2];
            const dn = dx * tn[o] + dy * tn[o + 1] + dz * tn[o + 2];
            const kt = Math.max(k, ks);
            pos[o] += kt * (dx - dn * tn[o]) + k * dn * tn[o];
            pos[o + 1] += kt * (dy - dn * tn[o + 1]) + k * dn * tn[o + 1];
            pos[o + 2] += kt * (dz - dn * tn[o + 2]) + k * dn * tn[o + 2];
          }
        } else {
          for (let i = 0; i < n; i++) {
            const k = pull[i];
            const o = i * 3;
            pos[o] += k * (tgt[o] - pos[o]); pos[o + 1] += k * (tgt[o + 1] - pos[o + 1]); pos[o + 2] += k * (tgt[o + 2] - pos[o + 2]);
          }
        }
        for (let e = 0; e < ne; e++) {
          const ia = E[e * 2], ib = E[e * 2 + 1];
          const wa = pull[ia] >= 1 ? 0 : 1, wb = pull[ib] >= 1 ? 0 : 1;
          if (!wa && !wb) continue;
          const a = ia * 3, b = ib * 3;
          const dx = pos[b] - pos[a], dy = pos[b + 1] - pos[a + 1], dz = pos[b + 2] - pos[a + 2];
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-9;
          const bend = e >= bendFrom;
          // cloth hardly stretches, but gives way when pushed together (so it folds)
          let rest = L[e], stiff;
          if (d > rest) {
            if (bend) stiff = 0.25;
            else if (this.kind === 'skirt') stiff = 1;
            else { rest *= 1 + CFG.give; if (d <= rest) continue; stiff = CFG.stretch; } // knit gives a little, then resists
          } else stiff = bend ? 0.05 : exE ? CFG.compress * Math.max(0, 1 - exE[ia] - exE[ib]) : CFG.compress; // deep creases just crumple
          const c = (stiff * (d - rest)) / d / (wa + wb);
          pos[a] += dx * c * wa; pos[a + 1] += dy * c * wa; pos[a + 2] += dz * c * wa;
          pos[b] -= dx * c * wb; pos[b + 1] -= dy * c * wb; pos[b + 2] -= dz * c * wb;
        }
        if (!CFG.nocol && (this.kind === 'skirt' || it % 2 === 1 || it === ITER - 1)) {
          // out of the body: spheres sit a bit inside the skin, so they are grown back to it plus a margin
          const sk = this.kind === 'skirt';
          for (let i = 0; i < n; i++) {
            const o = i * 3;
            if (pull[i] >= 1) continue;
            const q0 = sk ? 0 : cs[i], q1 = sk ? cf.length : cs[i + 1];
            for (let q = q0; q < q1; q++) {
              const j = cf[q];
              const r = cr[j];
              const dx = pos[o] - cx[j], dy = pos[o + 1] - cy[j], dz = pos[o + 2] - cz[j];
              const d2 = dx * dx + dy * dy + dz * dz;
              if (d2 >= r * r) continue;
              const d = Math.sqrt(d2) || 1e-9;
              const f = (r - d) / d;
              pos[o] += dx * f; pos[o + 1] += dy * f; pos[o + 2] += dz * f;
            }
          }
        }
        if (this.minRad) {
          // around the hips and seat the skirt stays outside the body's rest outline (in the hips' frame)
          const Mh = this.hipsM.elements, Mi = this.hipsInv.elements, [ax, az] = this.axis, mr = this.minRad;
          for (let i = 0; i < n; i++) {
            if (!mr[i] || pull[i] >= 1) continue;
            const o = i * 3, x = pos[o], y = pos[o + 1], z = pos[o + 2];
            const lx = Mi[0] * x + Mi[4] * y + Mi[8] * z + Mi[12] - ax;
            const ly = Mi[1] * x + Mi[5] * y + Mi[9] * z + Mi[13];
            const lz = Mi[2] * x + Mi[6] * y + Mi[10] * z + Mi[14] - az;
            const rr = Math.hypot(lx, lz);
            if (rr >= mr[i] || rr < 1e-6) continue;
            const f = mr[i] / rr, nx = lx * f + ax, nz = lz * f + az;
            pos[o] = Mh[0] * nx + Mh[4] * ly + Mh[8] * nz + Mh[12];
            pos[o + 1] = Mh[1] * nx + Mh[5] * ly + Mh[9] * nz + Mh[13];
            pos[o + 2] = Mh[2] * nx + Mh[6] * ly + Mh[10] * nz + Mh[14];
          }
        }
        if (tn && !CFG.nofloor) {
          // never below the fitted shape (the skin plus a little): the body cannot show through
          for (let i = 0; i < n; i++) {
            const o = i * 3;
            const hgt = (pos[o] - tgt[o]) * tn[o] + (pos[o + 1] - tgt[o + 1]) * tn[o + 1] + (pos[o + 2] - tgt[o + 2]) * tn[o + 2];
            if (hgt < -floorD) { const f = -floorD - hgt; pos[o] += f * tn[o]; pos[o + 1] += f * tn[o + 1]; pos[o + 2] += f * tn[o + 2]; }
            else if (this.ceil && hgt > this.ceil[i]) { const f = this.ceil[i] - hgt; pos[o] += f * tn[o]; pos[o + 1] += f * tn[o + 1]; pos[o + 2] += f * tn[o + 2]; }
          }
        }
      }
    }
  }

  // Edges with thickness: a thin band turned in along every opening (hems, cuffs, neckline, waistband).
  buildHemStrip(g) {
    const T = this.loop.index;
    const count = new Map();
    for (let t = 0; t < T.length; t += 3) {
      for (let k = 0; k < 3; k++) {
        const a = T[t + k], b = T[t + ((k + 1) % 3)];
        const key = a < b ? a * 1e6 + b : b * 1e6 + a;
        count.set(key, (count.get(key) || 0) + (a < b ? 1 : 2) * 10 + 1); // remember direction
      }
    }
    const edges = [];
    for (const [key, c] of count) {
      if (c % 10 !== 1) continue;
      const a = Math.floor(key / 1e6), b = key % 1e6;
      edges.push(Math.floor(c / 10) === 1 ? [a, b] : [b, a]);
    }
    this.hemVerts = [...new Set(edges.flat())];
    const slot = new Map(this.hemVerts.map((v, k) => [v, k]));
    const B = this.hemVerts.length;
    const idx = [];
    for (const [a, b] of edges) {
      const ia = slot.get(a), ib = slot.get(b);
      idx.push(ia, ib, B + ib, ia, B + ib, B + ia);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(B * 6), 3));
    sg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(B * 6).fill(0.82), 3));
    const rp = g.attributes.restPos.array, sp = new Float32Array(B * 6);
    this.hemVerts.forEach((v, k) => { for (let c = 0; c < 3; c++) { sp[k * 3 + c] = rp[v * 3 + c]; sp[(B + k) * 3 + c] = rp[v * 3 + c]; } });
    sg.setAttribute('restPos', new THREE.BufferAttribute(sp, 3));
    sg.setAttribute('seamInfo', new THREE.BufferAttribute(new Float32Array(B * 4).fill(0.2), 2));
    sg.setIndex(idx);
    this.hemStrip = new THREE.Mesh(sg, this.material);
    this.hemStrip.castShadow = true;
    this.hemStrip.frustumCulled = false;
    this.mesh.add(this.hemStrip);
  }

  writeGeometry() {
    const g = this.mesh.geometry;
    const P = this.loop.positions(this.pos);
    g.attributes.position.array.set(P);
    g.attributes.position.needsUpdate = true;
    g.computeVertexNormals();
    const N = g.attributes.normal.array;
    // fold valleys are darker (light does not reach in), crests a touch lighter
    const n = P.length / 3, E = this.dispEdges;
    const sum = this._sum || (this._sum = new Float32Array(n * 3));
    const cnt = this._cnt || (this._cnt = new Float32Array(n));
    const len = this._len || (this._len = new Float32Array(n));
    sum.fill(0); cnt.fill(0); len.fill(0);
    for (let e = 0; e < E.length; e += 2) {
      const a = E[e] * 3, b = E[e + 1] * 3;
      const l = Math.hypot(P[a] - P[b], P[a + 1] - P[b + 1], P[a + 2] - P[b + 2]);
      sum[a] += P[b]; sum[a + 1] += P[b + 1]; sum[a + 2] += P[b + 2];
      sum[b] += P[a]; sum[b + 1] += P[a + 1]; sum[b + 2] += P[a + 2];
      cnt[E[e]]++; cnt[E[e + 1]]++; len[E[e]] += l; len[E[e + 1]] += l;
    }
    const col = g.attributes.color.array;
    for (let i = 0; i < n; i++) {
      const o = i * 3, c = cnt[i] || 1;
      const k = ((sum[o] / c - P[o]) * N[o] + (sum[o + 1] / c - P[o + 1]) * N[o + 1] + (sum[o + 2] / c - P[o + 2]) * N[o + 2]) / (len[i] / c + 1e-9);
      const v = k > 0 ? 1 - 0.55 * Math.min(1, k / 0.25) : 1 + 0.06 * Math.min(1, -k / 0.25);
      col[o] = col[o + 1] = col[o + 2] = v;
    }
    g.attributes.color.needsUpdate = true;
    // hem band: from the edge, turned in by the fabric's thickness
    const sp = this.hemStrip.geometry.attributes.position.array;
    const B = this.hemVerts.length, th = 0.003;
    this.hemVerts.forEach((v, k) => {
      const o = v * 3;
      for (let c = 0; c < 3; c++) { sp[k * 3 + c] = P[o + c]; sp[(B + k) * 3 + c] = P[o + c] - N[o + c] * th; }
    });
    this.hemStrip.geometry.attributes.position.needsUpdate = true;
    this.hemStrip.geometry.computeVertexNormals();
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.hemStrip.geometry.dispose();
    this.material.dispose();
  }
}
