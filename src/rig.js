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
const X = new THREE.Vector3(1, 0, 0);
const DOWN = new THREE.Vector3(0, -1, 0);

/**
 * World-space frame for a limb bone: local -Y runs along `u`. When the limb is bent,
 * local X is the hinge axis, oriented so the joint flexes the way our hinge limits expect
 * (elbows toward local +Z, knees toward local -Z). Straight limbs use the lateral axis.
 */
function limbFrame(u, l, kind) {
  const y = u.clone().normalize().negate();
  let x = null;
  if (l) {
    const h = new THREE.Vector3().crossVectors(u, l);
    if (h.length() > 0.08 * u.length() * l.length()) x = h.normalize();
  }
  if (!x) x = X.clone().addScaledVector(y, -X.dot(y)).normalize();
  let z = new THREE.Vector3().crossVectors(x, y);
  if (l) {
    const forward = l.dot(z);
    if ((kind === 'arm' && forward < 0) || (kind === 'leg' && forward > 0)) {
      x.negate();
      z = new THREE.Vector3().crossVectors(x, y);
    }
  }
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}

/** Rotate `parentQ` about its local X so local -Y points along `dir` (a pure hinge). */
function hingeTo(parentQ, dir) {
  const d = dir.clone().normalize().applyQuaternion(parentQ.clone().invert());
  const theta = Math.atan2(-d.z, -d.y);
  return parentQ.clone().multiply(new THREE.Quaternion().setFromAxisAngle(X, theta));
}

/** Bone definitions fitted to a body's joint positions (world, meters). */
export function boneDefsFromJoints(J) {
  const v = (k) => new THREE.Vector3(...J[k]);
  const world = {};
  const defs = [];
  const add = (name, parent, pos, q) => {
    world[name] = { p: pos, q };
    const pp = parent ? world[parent].p : new THREE.Vector3();
    const inv = parent ? world[parent].q.clone().invert() : new THREE.Quaternion();
    defs.push({
      name,
      parent,
      offset: pos.clone().sub(pp).applyQuaternion(inv).toArray(),
      quat: inv.clone().multiply(q).toArray(),
    });
  };
  const I = new THREE.Quaternion();
  add('hips', null, v('hips'), I);
  add('spine', 'hips', v('spine'), I);
  add('chest', 'spine', v('chest'), I);
  add('neck', 'chest', v('neck'), I);
  add('head', 'neck', v('head'), I);
  for (const s of ['L', 'R']) {
    const sh = v(`shoulder.${s}`), el = v(`elbow.${s}`), wr = v(`wrist.${s}`);
    const ua = limbFrame(el.clone().sub(sh), wr.clone().sub(el), 'arm');
    const fa = hingeTo(ua, wr.clone().sub(el));
    add(`upperArm.${s}`, 'chest', sh, ua);
    add(`foreArm.${s}`, `upperArm.${s}`, el, fa);
    add(`hand.${s}`, `foreArm.${s}`, wr, fa);
  }
  for (const s of ['L', 'R']) {
    const hp = v(`hip.${s}`), kn = v(`knee.${s}`), an = v(`ankle.${s}`);
    const th = limbFrame(kn.clone().sub(hp), null, 'leg');
    const sh = hingeTo(th, an.clone().sub(kn));
    add(`thigh.${s}`, 'hips', hp, th);
    add(`shin.${s}`, `thigh.${s}`, kn, sh);
    add(`foot.${s}`, `shin.${s}`, an, sh);
  }
  // Keep the canonical bone order (it is also the skin-weight order).
  return BONE_DEFS.map((d) => defs.find((x) => x.name === d.name));
}

export class Rig {
  constructor(defs = BONE_DEFS) {
    this.root = new THREE.Group();
    this.root.name = 'rig';
    this.bones = {};
    this.rest = {};
    for (const d of defs) {
      const b = new THREE.Bone();
      b.name = d.name;
      b.position.fromArray(d.offset);
      if (d.quat) b.quaternion.fromArray(d.quat);
      else if (d.rest) b.quaternion.setFromEuler(new THREE.Euler(...d.rest));
      (d.parent ? this.bones[d.parent] : this.root).add(b);
      this.bones[d.name] = b;
    }
    this.boneList = defs.map((d) => this.bones[d.name]);
    this.boneIndex = Object.fromEntries(defs.map((d, i) => [d.name, i]));
    this.captureRest();
    this.update();
  }

  /** Make the current pose the one Reset returns to. */
  captureRest() {
    for (const name in this.bones) {
      this.rest[name] = { p: this.bones[name].position.clone(), q: this.bones[name].quaternion.clone() };
    }
  }

  /** Swing a limb bone (in world space) so it points along `dir`. */
  aimWorld(name, dir) {
    const b = this.bones[name];
    const cur = DOWN.clone().applyQuaternion(this.worldQuat(name)).normalize();
    const r = new THREE.Quaternion().setFromUnitVectors(cur, dir.clone().normalize());
    this.setWorldQuat(name, this.worldQuat(name).premultiply(r));
    b.updateMatrixWorld(true);
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
