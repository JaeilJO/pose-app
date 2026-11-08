import * as THREE from 'three';
import male from './assets/human-male.js';
import female from './assets/human-female.js';
import { Rig, boneDefsFromJoints } from './rig.js';

// Realistic mannequin figures from MakeHuman CC0 data (see tools/build_human.py).
export const MODELS = { male, female };
export const MODEL_NAMES = Object.keys(MODELS);

const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

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
    // unique edges, for the groove (cavity) shading that follows the body shape
    const seen = new Set();
    const edges = [];
    for (let t = 0; t < index.length; t += 3) {
      for (let k = 0; k < 3; k++) {
        const a = index[t + k], b = index[t + ((k + 1) % 3)];
        const key = a < b ? a * 65536 + b : b * 65536 + a;
        if (!seen.has(key)) { seen.add(key); edges.push(a, b); }
      }
    }
    cache.set(data, {
      base: new Float32Array(bytes(data.positions).buffer),
      index,
      edges: Uint16Array.from(edges),
      skinIndex: bytes(data.skinIndex),
      skinWeight: bytes(data.skinWeight),
      ao: bytes(data.ao),
      soft: bytes(data.soft),
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
  }
  return { positions, joints, definition: Math.min(1.3, Math.max(0, definition)) };
}

// Vertex shading baked into colors: ambient occlusion (fixed) x grooves between muscles,
// measured on the current shape and deepened with muscle definition.
function shadeColors(dec, P, definition) {
  const n = P.length / 3;
  const N = new Float32Array(n * 3);
  const idx = dec.index;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const o of [a, b, c]) { N[o] += nx; N[o + 1] += ny; N[o + 2] += nz; }
  }
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
    const nl = Math.hypot(N[o], N[o + 1], N[o + 2]) || 1;
    let d = 0;
    for (let c = 0; c < 3; c++) d += (sum[o + c] / cnt[i] - P[o + c]) * (N[o + c] / nl);
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
  const strength = 0.16 + 0.34 * definition;
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
  g.setAttribute('position', new THREE.BufferAttribute(shaped.positions, 3));
  g.setIndex(new THREE.BufferAttribute(dec.index, 1));
  g.setAttribute('skinIndex', new THREE.BufferAttribute(dec.skinIndex, 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(dec.skinWeight, 4, true));
  // AO (baked) x grooves between muscles (measured on this shape, deeper when lean and muscular).
  g.setAttribute('color', new THREE.BufferAttribute(shadeColors(dec, shaped.positions, shaped.definition), 3, true));
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

  standingPose(rig);
  // Put the soles on the floor.
  mesh.computeBoundingBox();
  rig.bones.hips.position.y -= mesh.boundingBox.min.y;
  rig.update();
  rig.captureRest();

  // No ink outline: form reads from light and AO, like a studio maquette.
  mesh.computeBoundingBox();
  return { mesh, material, outline: null, height: mesh.boundingBox.max.y };
}

function standingPose(rig) {
  for (const s of ['L', 'R']) {
    const side = s === 'L' ? 1 : -1;
    rig.aimWorld(`upperArm.${s}`, new THREE.Vector3(side * 0.2, -1, 0.02));
    rig.bones[`foreArm.${s}`].quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.22);
    rig.aimWorld(`thigh.${s}`, new THREE.Vector3(side * 0.03, -1, 0));
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
