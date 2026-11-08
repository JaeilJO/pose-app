import * as THREE from 'three';

// Skeleton in meters. The figure faces +Z, so its left side is +X.
// `offset` = joint position in the parent's local space.
// Every limb bone points down its local -Y axis in rest pose.
export const BONE_DEFS = [
  { name: 'hips', parent: null, offset: [0, 0.95, 0] },
  { name: 'spine', parent: 'hips', offset: [0, 0.1, 0] },
  { name: 'chest', parent: 'spine', offset: [0, 0.18, 0] },
  { name: 'neck', parent: 'chest', offset: [0, 0.22, 0] },
  { name: 'head', parent: 'neck', offset: [0, 0.1, 0] },
  { name: 'upperArm.L', parent: 'chest', offset: [0.18, 0.18, 0], rest: [0, 0, 0.18] },
  { name: 'foreArm.L', parent: 'upperArm.L', offset: [0, -0.28, 0], rest: [-0.12, 0, 0] },
  { name: 'hand.L', parent: 'foreArm.L', offset: [0, -0.26, 0] },
  { name: 'upperArm.R', parent: 'chest', offset: [-0.18, 0.18, 0], rest: [0, 0, -0.18] },
  { name: 'foreArm.R', parent: 'upperArm.R', offset: [0, -0.28, 0], rest: [-0.12, 0, 0] },
  { name: 'hand.R', parent: 'foreArm.R', offset: [0, -0.26, 0] },
  { name: 'thigh.L', parent: 'hips', offset: [0.1, -0.05, 0] },
  { name: 'shin.L', parent: 'thigh.L', offset: [0, -0.43, 0] },
  { name: 'foot.L', parent: 'shin.L', offset: [0, -0.42, 0] },
  { name: 'thigh.R', parent: 'hips', offset: [-0.1, -0.05, 0] },
  { name: 'shin.R', parent: 'thigh.R', offset: [0, -0.43, 0] },
  { name: 'foot.R', parent: 'shin.R', offset: [0, -0.42, 0] },
];

const _q = new THREE.Quaternion();

export class Rig {
  constructor() {
    this.root = new THREE.Group();
    this.root.name = 'rig';
    this.bones = {};
    this.rest = {};
    for (const d of BONE_DEFS) {
      const b = new THREE.Object3D();
      b.name = d.name;
      b.position.fromArray(d.offset);
      if (d.rest) b.quaternion.setFromEuler(new THREE.Euler(...d.rest));
      (d.parent ? this.bones[d.parent] : this.root).add(b);
      this.bones[d.name] = b;
      this.rest[d.name] = { p: b.position.clone(), q: b.quaternion.clone() };
    }
    this.update();
  }

  update() {
    this.root.updateMatrixWorld(true);
  }

  reset() {
    for (const name in this.bones) {
      this.bones[name].position.copy(this.rest[name].p);
      this.bones[name].quaternion.copy(this.rest[name].q);
    }
    this.update();
  }

  length(name) {
    return this.bones[name].position.length();
  }

  // World position of a point given in a bone's local space.
  worldPoint(name, local, out = new THREE.Vector3()) {
    const b = this.bones[name];
    b.updateWorldMatrix(true, false);
    out.set(local[0], local[1], local[2]);
    return b.localToWorld(out);
  }

  worldPos(name, out = new THREE.Vector3()) {
    return this.bones[name].getWorldPosition(out);
  }

  worldQuat(name, out = new THREE.Quaternion()) {
    return this.bones[name].getWorldQuaternion(out);
  }

  setWorldQuat(name, q) {
    const b = this.bones[name];
    b.parent.getWorldQuaternion(_q);
    b.quaternion.copy(_q.invert().multiply(q)).normalize();
    b.updateMatrixWorld(true);
  }

  snapshot() {
    const q = {};
    for (const name in this.bones) q[name] = this.bones[name].quaternion.toArray();
    return { hips: this.bones.hips.position.toArray(), q };
  }

  restore(s) {
    this.bones.hips.position.fromArray(s.hips);
    for (const name in s.q) this.bones[name].quaternion.fromArray(s.q[name]);
    this.update();
  }
}
