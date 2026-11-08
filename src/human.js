import * as THREE from 'three';
import male from './assets/human-male.js';
import female from './assets/human-female.js';
import { Rig, boneDefsFromJoints } from './rig.js';
import { addOutline } from './body.js';

// Realistic, faceless figures from MakeHuman CC0 data (see tools/build_human.py).
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
      for (const [end, v] of Object.entries(ends)) deltas[name][end] = { d: new Int16Array(bytes(v.d).buffer), j: v.j };
    }
    const cav = bytes(data.cavity);
    const colors = new Uint8Array(cav.length * 3);
    for (let i = 0; i < cav.length; i++) colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = cav[i];
    cache.set(data, {
      base: new Float32Array(bytes(data.positions).buffer),
      index: new Uint16Array(bytes(data.index).buffer),
      skinIndex: bytes(data.skinIndex),
      skinWeight: bytes(data.skinWeight),
      colors,
      deltas,
    });
  }
  return cache.get(data);
}

/**
 * Body shape from slider values (0..1 for height, weight = body fat, muscle).
 * Each slider blends toward the shape baked at its low or high end.
 */
export function shapeBody(data, values = {}) {
  const dec = decoded(data);
  const positions = Float32Array.from(dec.base);
  const joints = Object.fromEntries(Object.entries(data.joints).map(([k, v]) => [k, [...v]]));
  for (const [name, b] of Object.entries(data.shapeBase)) {
    const v = values[name] ?? b;
    let end = null;
    let w = 0;
    if (v < b - 1e-4) { end = 'lo'; w = (b - v) / b; }
    else if (v > b + 1e-4) { end = 'hi'; w = (v - b) / (1 - b); }
    const delta = end && dec.deltas[name][end];
    if (!delta) continue;
    const s = w * data.deltaScale;
    for (let i = 0; i < positions.length; i++) positions[i] += delta.d[i] * s;
    for (const k in joints) for (let c = 0; c < 3; c++) joints[k][c] += delta.j[k][c] * w;
  }
  return { positions, joints };
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
  // Grooves between muscles are pre-darkened (cavity map baked in tools/build_human.py).
  g.setAttribute('color', new THREE.BufferAttribute(dec.colors, 3, true));
  g.computeVertexNormals();

  const material = new THREE.MeshPhysicalMaterial({
    color: 0xd8d8d6,
    vertexColors: true,
    roughness: 0.55,
    metalness: 0,
    clearcoat: 0.15,
    clearcoatRoughness: 0.5,
    sheen: 0.3,
    sheenRoughness: 0.7,
    sheenColor: new THREE.Color(0xffffff),
  });

  // Bind in the source pose (arms out, elbows bent), then move to a relaxed standing pose.
  rig.update();
  const mesh = new THREE.SkinnedMesh(g, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
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

  const outline = addOutline(mesh, []);
  mesh.computeBoundingBox();
  return { mesh, material, outline, height: mesh.boundingBox.max.y };
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
