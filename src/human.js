import * as THREE from 'three';
import male from './assets/human-male.js';
import female from './assets/human-female.js';
import { Rig, boneDefsFromJoints } from './rig.js';
import { addOutline } from './body.js';

// Realistic, faceless figures from MakeHuman CC0 data (see tools/build_human.py).
export const MODELS = { male, female };
export const MODEL_NAMES = Object.keys(MODELS);

const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

export function createHumanRig(data = male) {
  return new Rig(boneDefsFromJoints(data.joints));
}

export function buildHuman(rig, data = male) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(bytes(data.positions).buffer), 3));
  g.setIndex(new THREE.BufferAttribute(new Uint16Array(bytes(data.index).buffer), 1));
  g.setAttribute('skinIndex', new THREE.BufferAttribute(bytes(data.skinIndex), 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(bytes(data.skinWeight), 4, true));
  // Grooves between muscles are pre-darkened (cavity map baked in tools/build_human.py).
  const cav = bytes(data.cavity);
  const colors = new Uint8Array(cav.length * 3);
  for (let i = 0; i < cav.length; i++) colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = cav[i];
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3, true));
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
  return { mesh, material, outline };
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
