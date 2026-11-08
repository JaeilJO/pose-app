import * as THREE from 'three';

const X_AXIS = new THREE.Vector3(1, 0, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
const IDENTITY = new THREE.Quaternion();

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Ball-joint limits as Euler ranges (radians, order YXZ) on the bone's local rotation.
// Rotating about +X tilts a bone's +Y toward +Z (forward).
export const LIMITS = {
  spine: { x: [-0.3, 0.8], y: [-0.5, 0.5], z: [-0.35, 0.35] },
  chest: { x: [-0.3, 0.6], y: [-0.5, 0.5], z: [-0.3, 0.3] },
  neck: { x: [-0.5, 0.7], y: [-1.1, 1.1], z: [-0.5, 0.5] },
  head: { x: [-0.4, 0.4], y: [-0.3, 0.3], z: [-0.3, 0.3] },
  'hand.L': { x: [-1.2, 1.2], y: [-0.6, 0.6], z: [-0.6, 0.6] },
  'hand.R': { x: [-1.2, 1.2], y: [-0.6, 0.6], z: [-0.6, 0.6] },
  'foot.L': { x: [-0.8, 0.9], y: [-0.35, 0.35], z: [-0.35, 0.35] },
  'foot.R': { x: [-0.8, 0.9], y: [-0.35, 0.35], z: [-0.35, 0.35] },
  'thigh.L': { x: [-2.1, 0.6], y: [-0.7, 0.7], z: [-0.4, 1.2] },
  'thigh.R': { x: [-2.1, 0.6], y: [-0.7, 0.7], z: [-1.2, 0.4] },
};

// Hinge joints rotate about local X only. Elbows flex forward (negative), knees backward (positive).
export const HINGES = {
  'foreArm.L': [-2.6, 0],
  'foreArm.R': [-2.6, 0],
  'shin.L': [0, 2.5],
  'shin.R': [0, 2.5],
};

const _e = new THREE.Euler();
const _d = new THREE.Vector3();

export function hingeAngle(bone) {
  _d.copy(DOWN).applyQuaternion(bone.quaternion);
  return Math.atan2(-_d.z, -_d.y);
}

// Pull a bone's local rotation back inside its limits.
export function clampBone(bone) {
  const h = HINGES[bone.name];
  if (h) {
    bone.quaternion.setFromAxisAngle(X_AXIS, clamp(hingeAngle(bone), h[0], h[1]));
    bone.updateMatrixWorld(true);
    return;
  }
  const L = LIMITS[bone.name];
  if (!L) return;
  _e.setFromQuaternion(bone.quaternion, 'YXZ');
  _e.x = clamp(_e.x, L.x[0], L.x[1]);
  _e.y = clamp(_e.y, L.y[0], L.y[1]);
  _e.z = clamp(_e.z, L.z[0], L.z[1]);
  bone.quaternion.setFromEuler(_e);
  bone.updateMatrixWorld(true);
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _to = new THREE.Vector3();
const _from = new THREE.Vector3();
const _vb = new THREE.Vector3();
const _vp = new THREE.Vector3();
const _cross = new THREE.Vector3();
const _q0 = new THREE.Quaternion();
const _r = new THREE.Quaternion();

/**
 * Analytic two-bone IK (shoulder-elbow-wrist or hip-knee-ankle).
 * Puts the end joint on `target` (or as close as the limb reaches) and turns
 * the middle joint toward the `pole` point. The lower bone stays a pure hinge.
 */
export function solveTwoBone(rig, upper, lower, end, target, pole, hingeSign) {
  const A = rig.bones[upper];
  const B = rig.bones[lower];
  const l1 = rig.length(lower);
  const l2 = rig.length(end);

  A.getWorldPosition(_a);
  const dist = _a.distanceTo(target);
  const d = clamp(dist, Math.abs(l1 - l2) + 1e-3, (l1 + l2) * 0.9995);

  // 1. Elbow/knee angle from the law of cosines.
  const cosInner = clamp((l1 * l1 + l2 * l2 - d * d) / (2 * l1 * l2), -1, 1);
  const bend = Math.PI - Math.acos(cosInner);
  B.quaternion.setFromAxisAngle(X_AXIS, hingeSign * bend);
  B.updateMatrixWorld(true);

  // 2. Swing the upper bone so the end joint points at the target.
  rig.worldPos(end, _c);
  _from.subVectors(_c, _a);
  _to.subVectors(target, _a);
  if (_from.lengthSq() < 1e-10 || _to.lengthSq() < 1e-10) return;
  _from.normalize();
  _to.normalize();
  A.getWorldQuaternion(_q0);
  _r.setFromUnitVectors(_from, _to);
  _q0.premultiply(_r);
  rig.setWorldQuat(upper, _q0);

  // 3. Twist about the limb axis so the middle joint faces the pole.
  B.getWorldPosition(_b);
  _vb.subVectors(_b, _a);
  _vb.addScaledVector(_to, -_vb.dot(_to));
  _vp.subVectors(pole, _a);
  _vp.addScaledVector(_to, -_vp.dot(_to));
  if (_vb.lengthSq() < 1e-8 || _vp.lengthSq() < 1e-8) return;
  const angle = Math.atan2(_cross.crossVectors(_vb, _vp).dot(_to), _vb.dot(_vp));
  _r.setFromAxisAngle(_to, angle);
  A.getWorldQuaternion(_q0);
  _q0.premultiply(_r);
  rig.setWorldQuat(upper, _q0);
}

const _p = new THREE.Vector3();
const _end = new THREE.Vector3();
const _rw = new THREE.Quaternion();

/**
 * One cyclic-coordinate-descent pass over a chain of joints (e.g. chest, spine).
 * Each joint turns part of the way toward bringing `getEnd()` onto `target`,
 * then is clamped to its limits.
 */
export function ccdPass(rig, joints, weights, getEnd, target) {
  for (let i = 0; i < joints.length; i++) {
    const name = joints[i];
    rig.worldPos(name, _p);
    getEnd(_end);
    _from.subVectors(_end, _p);
    _to.subVectors(target, _p);
    if (_from.lengthSq() < 1e-8 || _to.lengthSq() < 1e-8) continue;
    _from.normalize();
    _to.normalize();
    _r.setFromUnitVectors(_from, _to);
    _rw.slerpQuaternions(IDENTITY, _r, weights[i]);
    rig.worldQuat(name, _q0);
    _q0.premultiply(_rw);
    rig.setWorldQuat(name, _q0);
    clampBone(rig.bones[name]);
  }
}

const _g = new THREE.Vector3();

/** Rotate a bone so the grabbed point (bone-local) swings toward `target`. */
export function aimBone(rig, name, grabLocal, target) {
  rig.worldPos(name, _p);
  _g.copy(grabLocal);
  rig.bones[name].localToWorld(_g);
  _from.subVectors(_g, _p);
  _to.subVectors(target, _p);
  if (_from.length() < 0.02 || _to.length() < 0.02) return;
  _from.normalize();
  _to.normalize();
  _r.setFromUnitVectors(_from, _to);
  rig.worldQuat(name, _q0);
  _q0.premultiply(_r);
  rig.setWorldQuat(name, _q0);
  clampBone(rig.bones[name]);
}

const _ab = new THREE.Vector3();
/** Closest point on segment ab to p. */
export function closestOnSegment(p, a, b, out) {
  _ab.subVectors(b, a);
  const t = clamp(_ab.dot(out.subVectors(p, a)) / Math.max(_ab.lengthSq(), 1e-9), 0, 1);
  return out.copy(a).addScaledVector(_ab, t);
}
