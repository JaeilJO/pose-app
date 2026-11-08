import * as THREE from 'three';
import male from './assets/human-male.js';
import female from './assets/human-female.js';
import { Rig, boneDefsFromJoints } from './rig.js';
import { Loop } from './subdiv.js';

// Realistic mannequin figures from MakeHuman CC0 data (see tools/build_human.py).
export const MODELS = { male, female };
export const MODEL_NAMES = Object.keys(MODELS);

const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

function uniqueEdges(index) {
  const seen = new Set();
  const edges = [];
  for (let t = 0; t < index.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = index[t + k], b = index[t + ((k + 1) % 3)];
      const key = a < b ? a * 65536 + b : b * 65536 + a;
      if (!seen.has(key)) { seen.add(key); edges.push(a, b); }
    }
  }
  return Uint32Array.from(edges);
}

function vertexNormals(P, index) {
  const N = new Float32Array(P.length);
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t] * 3, b = index[t + 1] * 3, c = index[t + 2] * 3;
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

// Decoded buffers per model (decoding base64 is the slow part, so do it once).
const cache = new Map();
function decoded(data) {
  if (!cache.has(data)) {
    const deltas = {};
    for (const [name, ends] of Object.entries(data.shapes)) {
      deltas[name] = {};
      for (const [end, v] of Object.entries(ends)) {
        deltas[name][end] = { i: new Uint16Array(bytes(v.i).buffer), d: new Int16Array(bytes(v.d).buffer), j: v.j };
      }
    }
    const index = new Uint16Array(bytes(data.index).buffer);
    const base = new Float32Array(bytes(data.positions).buffer);
    const n = base.length / 3;
    // The body is drawn once-subdivided; the sculpt's surface detail is stored per subdivided vertex.
    const loop = new Loop(index, n);
    const skinIndex = bytes(data.skinIndex), skinWeight = bytes(data.skinWeight);
    const bones = data.bones.length;
    const dense = new Float32Array(n * bones);
    for (let i = 0; i < n; i++) for (let k = 0; k < 4; k++) dense[i * bones + skinIndex[i * 4 + k]] += skinWeight[i * 4 + k] / 255;
    const subW = loop.linear(dense, bones);
    const sIdx = new Uint8Array(loop.count * 4), sW = new Uint8Array(loop.count * 4);
    for (let i = 0; i < loop.count; i++) {
      const row = Array.from(subW.subarray(i * bones, (i + 1) * bones), (w, b) => [w, b]).sort((x, y) => y[0] - x[0]).slice(0, 4);
      const tot = row.reduce((t, r) => t + r[0], 0) || 1;
      const q = row.map(([w]) => Math.floor((255 * w) / tot));
      q[0] += 255 - q.reduce((t, v) => t + v, 0); // exact sum of 255
      row.forEach(([, b], k) => { sIdx[i * 4 + k] = b; sW[i * 4 + k] = q[k]; });
    }
    const toU8 = (f) => Uint8Array.from(f, (v) => Math.round(v));
    cache.set(data, {
      base,
      loop,
      index: loop.index,
      edges: uniqueEdges(loop.index),
      skinIndex: sIdx,
      skinWeight: sW,
      ao: toU8(loop.linear(Float32Array.from(bytes(data.ao)), 1)),
      soft: toU8(loop.linear(Float32Array.from(bytes(data.soft)), 3)),
      detail: new Int8Array(bytes(data.detail).buffer),
      deltas,
    });
  }
  return cache.get(data);
}

// Slider value -> weight of its low or high end shape.
function endWeight(v, b) {
  if (v < b - 1e-4) return ['lo', (b - v) / b];
  if (v > b + 1e-4) return ['hi', (v - b) / (1 - b)];
  return [null, 0];
}

/**
 * Body shape from slider values (0..1). Each slider blends toward the shape baked at its
 * low or high end: height, weight (body fat), muscle, and the body parts (chest, belly, ...).
 * Also returns how defined the muscles should look (lean + muscular = strong grooves).
 */
export function shapeBody(data, values = {}) {
  const dec = decoded(data);
  const positions = Float32Array.from(dec.base);
  const joints = Object.fromEntries(Object.entries(data.joints).map(([k, v]) => [k, [...v]]));
  let definition = data.definition.base;
  let detail = data.detailScale.base;
  for (const [name, b] of Object.entries(data.shapeBase)) {
    const [end, w] = endWeight(values[name] ?? b, b);
    const delta = end && dec.deltas[name][end];
    if (!delta) continue;
    const s = w * data.deltaScale;
    const { i: idx, d } = delta;
    for (let k = 0; k < idx.length; k++) {
      const o = idx[k] * 3;
      positions[o] += d[k * 3] * s;
      positions[o + 1] += d[k * 3 + 1] * s;
      positions[o + 2] += d[k * 3 + 2] * s;
    }
    for (const k in delta.j) for (let c = 0; c < 3; c++) joints[k][c] += delta.j[k][c] * w;
    if (data.definition[name]) definition += data.definition[name][end] * w;
    if (data.detailScale[name]) detail += data.detailScale[name][end] * w;
  }
  return { positions, joints, definition: Math.min(1.3, Math.max(0, definition)), detail: Math.min(1.5, Math.max(0.15, detail)) };
}

// Vertex shading baked into colors: ambient occlusion (fixed) x grooves between muscles,
// measured on the current shape and deepened with muscle definition.
function shadeColors(dec, P, definition) {
  const n = P.length / 3;
  const N = vertexNormals(P, dec.index);
  const sum = new Float32Array(n * 3), cnt = new Float32Array(n), len = new Float32Array(n);
  const E = dec.edges;
  for (let e = 0; e < E.length; e += 2) {
    const a = E[e] * 3, b = E[e + 1] * 3;
    const l = Math.hypot(P[a] - P[b], P[a + 1] - P[b + 1], P[a + 2] - P[b + 2]);
    for (let c = 0; c < 3; c++) { sum[a + c] += P[b + c]; sum[b + c] += P[a + c]; }
    cnt[E[e]]++; cnt[E[e + 1]]++; len[E[e]] += l; len[E[e + 1]] += l;
  }
  let curv = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 3;
    let d = 0;
    for (let c = 0; c < 3; c++) d += (sum[o + c] / cnt[i] - P[o + c]) * N[o + c];
    curv[i] = d / (len[i] / cnt[i] + 1e-9); // > 0 in grooves
  }
  for (let pass = 0; pass < 4; pass++) {
    const acc = new Float32Array(n);
    for (let e = 0; e < E.length; e += 2) { acc[E[e]] += curv[E[e + 1]]; acc[E[e + 1]] += curv[E[e]]; }
    const next = new Float32Array(n);
    for (let i = 0; i < n; i++) next[i] = 0.5 * curv[i] + (0.5 * acc[i]) / cnt[i];
    curv = next;
  }
  const sorted = Float32Array.from(curv).sort();
  const p97 = sorted[Math.floor(n * 0.97)] + 1e-9;
  const strength = 0.1 + 0.18 * definition;
  const colors = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    const cav = 1 - strength * Math.min(1, Math.max(0, curv[i] / p97));
    const ao = dec.ao[i] / 255;
    const v = Math.round(255 * cav * (1 - 0.62 * Math.pow(1 - ao, 1.2)));
    colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = v;
  }
  return colors;
}

// Standing height (m) for a height-slider value. Offsets blend linearly, so each half is a straight line.
const heightCache = new Map();
function heightEnds(data) {
  if (!heightCache.has(data)) {
    const extent = (v) => {
      const p = shapeBody(data, { ...data.shapeBase, height: v }).positions;
      let lo = Infinity, hi = -Infinity;
      for (let i = 1; i < p.length; i += 3) { if (p[i] < lo) lo = p[i]; if (p[i] > hi) hi = p[i]; }
      return hi - lo;
    };
    heightCache.set(data, { lo: extent(0), mid: extent(data.shapeBase.height), hi: extent(1) });
  }
  return heightCache.get(data);
}
export function heightOf(data, v) {
  const e = heightEnds(data), b = data.shapeBase.height;
  return v <= b ? e.lo + (e.mid - e.lo) * (v / b) : e.mid + (e.hi - e.mid) * ((v - b) / (1 - b));
}
export function heightParam(data, meters) {
  const e = heightEnds(data), b = data.shapeBase.height;
  const v = meters <= e.mid ? b * (meters - e.lo) / (e.mid - e.lo) : b + (1 - b) * (meters - e.mid) / (e.hi - e.mid);
  return Math.min(1, Math.max(0, v));
}
// Realistic range for the slider (MakeHuman's own extremes reach 1.3–2.4 m).
export const HEIGHT_RANGE_CM = { male: [150, 205], female: [140, 195] };

export function createHumanRig(data = male, shaped = shapeBody(data)) {
  return new Rig(boneDefsFromJoints(shaped.joints));
}

export function buildHuman(rig, data = male, shaped = shapeBody(data)) {
  const dec = decoded(data);
  const g = new THREE.BufferGeometry();
  // subdivide once, then push each vertex along its normal by the sculpt's surface detail
  const P = dec.loop.positions(shaped.positions);
  const N = vertexNormals(P, dec.index);
  const s = data.detailStep * shaped.detail;
  for (let i = 0; i < dec.detail.length; i++) {
    const h = dec.detail[i] * s;
    P[i * 3] += h * N[i * 3]; P[i * 3 + 1] += h * N[i * 3 + 1]; P[i * 3 + 2] += h * N[i * 3 + 2];
  }
  g.setAttribute('position', new THREE.BufferAttribute(P, 3));
  g.setIndex(new THREE.BufferAttribute(dec.index, 1));
  g.setAttribute('skinIndex', new THREE.BufferAttribute(dec.skinIndex, 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(dec.skinWeight, 4, true));
  // AO (baked) x grooves between muscles (measured on this shape, deeper when lean and muscular).
  g.setAttribute('color', new THREE.BufferAttribute(shadeColors(dec, P, 0.6 * shaped.detail + shaped.definition), 3, true));
  g.setAttribute('soft', new THREE.BufferAttribute(dec.soft, 3, true));
  g.computeVertexNormals();

  // Matte sculpting clay: soft highlights, a little velvet on the edges; AO and grooves come from vertex colors.
  const material = new THREE.MeshPhysicalMaterial({
    color: 0xcdcac5,
    vertexColors: true,
    roughness: 0.62,
    metalness: 0,
    sheen: 0.35,
    sheenRoughness: 0.55,
    sheenColor: new THREE.Color(0xf4f2ee),
  });

  // Soft tissue (breasts, belly) is pushed by the jiggle simulation after skinning.
  const softUniform = { value: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] };
  const withSoft = (m) => {
    m.onBeforeCompile = (shader) => {
      shader.uniforms.softOffset = softUniform;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec3 soft;\nuniform vec3 softOffset[3];')
        .replace('#include <skinning_vertex>', '#include <skinning_vertex>\n\ttransformed += soft.x * softOffset[0] + soft.y * softOffset[1] + soft.z * softOffset[2];');
    };
    m.customProgramCacheKey = () => 'soft-tissue';
    return m;
  };
  withSoft(material);

  // Bind in the source pose (arms out, elbows bent), then move to a relaxed standing pose.
  rig.update();
  const mesh = new THREE.SkinnedMesh(g, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.customDepthMaterial = withSoft(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }));
  mesh.userData.softOffset = softUniform.value;
  mesh.frustumCulled = false;
  rig.root.add(mesh);
  mesh.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(rig.boneList));

  standingPose(rig, armSpread(rig, mesh, dec));
  // Put the soles on the floor.
  mesh.computeBoundingBox();
  rig.bones.hips.position.y -= mesh.boundingBox.min.y;
  rig.update();
  rig.captureRest();

  // No ink outline: form reads from light and AO, like a studio maquette.
  mesh.computeBoundingBox();
  return { mesh, material, outline: null, height: mesh.boundingBox.max.y };
}

// How far out the arms hang: the hands should clear the hips and thighs by STAND.gap, whatever the build
// (broad lats, wide hips, body fat). Measured on the skinned arm against the trunk's width at each height.
function armSpread(rig, mesh, dec) {
  const P = mesh.geometry.attributes.position.array;
  const si = dec.skinIndex, sw = dec.skinWeight;
  const n = P.length / 3;
  const B = rig.boneList.map((b) => b.name);
  const trunk = new Set(['hips', 'spine', 'chest', 'thigh.L', 'thigh.R'].map((b) => B.indexOf(b)));
  const armL = new Set(['foreArm.L', 'hand.L'].map((b) => B.indexOf(b)));
  const dom = (i) => { let b = 0; for (let k = 1; k < 4; k++) if (sw[i * 4 + k] > sw[i * 4 + b]) b = k; return si[i * 4 + b]; };
  rig.update();
  const sh = rig.worldPos('upperArm.L');
  // trunk half-width (left side) per 1 cm of height, in the bind pose
  const y0 = -1.5, bins = new Float32Array(400).fill(-1);
  const arm = [];
  for (let i = 0; i < n; i++) {
    const d = dom(i), x = P[i * 3], y = P[i * 3 + 1];
    if (trunk.has(d) && x > 0) { const k = Math.floor((y - y0) * 100); if (k >= 0 && k < 400) bins[k] = Math.max(bins[k], x); }
    else if (armL.has(d) && i % 2 === 0) arm.push(i); // forearm and hand: they pass the waist, hips and thighs
  }
  const inv = mesh.skeleton.boneInverses, bones = mesh.skeleton.bones;
  const M = bones.map(() => new THREE.Matrix4()), v = new THREE.Vector3(), acc = new THREE.Vector3(), t = new THREE.Vector3();
  const gapAt = (a) => {
    standingPose(rig, a);
    rig.update();
    bones.forEach((b, k) => M[k].multiplyMatrices(b.matrixWorld, inv[k]));
    let gap = Infinity;
    for (const i of arm) {
      v.fromArray(P, i * 3);
      acc.set(0, 0, 0);
      for (let k = 0; k < 4; k++) { const w = sw[i * 4 + k] / 255; if (w) acc.addScaledVector(t.copy(v).applyMatrix4(M[si[i * 4 + k]]), w); }
      const b = Math.floor((acc.y - y0) * 100);
      if (b >= 0 && b < 400 && bins[b] > 0) gap = Math.min(gap, acc.x - bins[b]);
    }
    return gap;
  };
  // the gap grows almost linearly with the spread: two probes and one correction
  let a0 = 0.02, a1 = 0.25, g0 = gapAt(a0), g1 = gapAt(a1);
  let a = a0 + ((STAND.gap - g0) * (a1 - a0)) / (g1 - g0 || 1e-6);
  a = Math.min(0.35, Math.max(0.0, a));
  const g = gapAt(a);
  a = Math.min(0.35, Math.max(0.0, a + ((STAND.gap - g) * (a1 - a0)) / (g1 - g0 || 1e-6)));
  return a;
}

// Relaxed standing pose. Limbs get a full orientation (not just a direction), so every body stands the
// same way however its source sculpt held its arms: hinge axis = the body's left-right axis, which makes
// elbows point back, knees point forward and the palms face the thighs.
const STAND = globalThis.STAND_CFG || { armFwd: 0.03, elbow: -0.3, legOut: 0.035, handTwist: 0, handFlex: 0, gap: 0.022 };
function setLimb(rig, name, dir) {
  const y = dir.clone().normalize().negate();
  const x = new THREE.Vector3(1, 0, 0).addScaledVector(y, -y.x).normalize();
  const z = new THREE.Vector3().crossVectors(x, y);
  rig.setWorldQuat(name, new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z)));
  rig.bones[name].updateMatrixWorld(true);
}
function standingPose(rig, armOut = 0.12) {
  for (const s of ['L', 'R']) {
    const side = s === 'L' ? 1 : -1;
    setLimb(rig, `upperArm.${s}`, new THREE.Vector3(side * armOut, -1, STAND.armFwd));
    rig.bones[`foreArm.${s}`].quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), STAND.elbow);
    rig.bones[`foreArm.${s}`].updateMatrixWorld(true);
    // hand: turn about the forearm (palm toward the thigh) and relax the wrist
    const h = rig.bones[`hand.${s}`];
    h.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), side * STAND.handTwist))
      .premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), STAND.handFlex));
    setLimb(rig, `thigh.${s}`, new THREE.Vector3(side * STAND.legOut, -1, 0));
    rig.bones[`shin.${s}`].quaternion.identity();
  }
  rig.update();
}

/**
 * Copy a pose between two rigs of different proportions: every bone gets the same
 * rotation away from its standing pose; the hips keep their height relative to leg length.
 */
export function transferPose(from, to) {
  const restWorld = (rig) => {
    const saved = rig.snapshot();
    rig.reset();
    const q = Object.fromEntries(Object.keys(rig.bones).map((n) => [n, rig.worldQuat(n)]));
    const hipsY = rig.bones.hips.position.y;
    rig.restore(saved);
    return { q, hipsY };
  };
  const a = restWorld(from);
  const b = restWorld(to);
  for (const bone of to.boneList) {
    const n = bone.name;
    const delta = from.worldQuat(n).multiply(a.q[n].clone().invert());
    to.setWorldQuat(n, delta.multiply(b.q[n]));
  }
  to.bones.hips.position.copy(from.bones.hips.position).multiplyScalar(b.hipsY / a.hipsY);
  to.update();
}
