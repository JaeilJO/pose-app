import * as THREE from 'three';
import { solveTwoBone, ccdPass, aimBone, clampBone, closestOnSegment, clamp } from './ik.js';

// Draggable control points. `handle` = where the dot sits, in the end bone's local space.
export const EFFECTORS = {
  'hand.L': { kind: 'arm', side: 1, upper: 'upperArm.L', lower: 'foreArm.L', end: 'hand.L', handle: [0, -0.08, 0] },
  'hand.R': { kind: 'arm', side: -1, upper: 'upperArm.R', lower: 'foreArm.R', end: 'hand.R', handle: [0, -0.08, 0] },
  'foot.L': { kind: 'leg', side: 1, upper: 'thigh.L', lower: 'shin.L', end: 'foot.L', handle: [0, -0.02, 0.07] },
  'foot.R': { kind: 'leg', side: -1, upper: 'thigh.R', lower: 'shin.R', end: 'foot.R', handle: [0, -0.02, 0.07] },
  head: { kind: 'head', end: 'head', handle: [0, 0.1, 0.01] },
  hips: { kind: 'hips', end: 'hips', handle: [0, 0, 0] },
};
export const EFFECTOR_NAMES = Object.keys(EFFECTORS);
const LIMBS = ['hand.L', 'hand.R', 'foot.L', 'foot.R'];

// Which pinned limb a bone belongs to (grabbing that bone frees the pin).
const CHAIN_OWNER = {
  'upperArm.L': 'hand.L', 'foreArm.L': 'hand.L',
  'upperArm.R': 'hand.R', 'foreArm.R': 'hand.R',
  'thigh.L': 'foot.L', 'shin.L': 'foot.L',
  'thigh.R': 'foot.R', 'shin.R': 'foot.R',
};

const DEFAULT_PINS = { 'hand.L': false, 'hand.R': false, 'foot.L': true, 'foot.R': true, head: false, hips: false };

const UP = new THREE.Vector3(0, 1, 0);
const FWD = new THREE.Vector3(0, 0, 1);
const RIGHT = new THREE.Vector3(1, 0, 0);
const IDENTITY = new THREE.Quaternion();

const MIN_HIPS_Y = 0.22;
const TORSO_RADIUS = 0.17;

export class Poser {
  constructor(rig) {
    this.rig = rig;
    this.armReach = rig.length('foreArm.L') + rig.length('hand.L');
    this.legReach = rig.length('shin.L') + rig.length('foot.L');
    this.ankleHeight = Math.min(rig.worldPos('foot.L').y, rig.worldPos('foot.R').y);
    this.active = null; // effector drag
    this.collider = null; // optional: keeps limbs out of the body (see collide.js)
    this.fk = null; // bone rotation drag
    this.t = {
      a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(),
      d: new THREE.Vector3(), q: new THREE.Quaternion(), q2: new THREE.Quaternion(),
    };
    this.reset();
  }

  reset() {
    this.rig.reset();
    this.pins = { ...DEFAULT_PINS };
    this.pinData = {};
    this.neckLocked = false;
    for (const n of EFFECTOR_NAMES) if (this.pins[n]) this.recordPin(n);
  }

  // ---------- positions ----------
  handleWorld(name, out = new THREE.Vector3()) {
    const e = EFFECTORS[name];
    return this.rig.worldPoint(e.end, e.handle, out);
  }

  // The point the solver drives: wrist/ankle for limbs, head center, hips origin.
  effectorPoint(name, out = new THREE.Vector3()) {
    const e = EFFECTORS[name];
    if (e.kind === 'head') return this.handleWorld(name, out);
    return this.rig.worldPos(e.end, out);
  }

  // ---------- pins ----------
  recordPin(name) {
    this.pinData[name] = {
      p: this.effectorPoint(name, new THREE.Vector3()),
      q: this.rig.worldQuat(EFFECTORS[name].end, new THREE.Quaternion()),
    };
  }

  setPin(name, on) {
    this.pins[name] = on;
    if (on) this.recordPin(name);
  }

  // ---------- effector drag ----------
  beginDrag(name) {
    const e = EFFECTORS[name];
    const offset = new THREE.Vector3();
    if (e.kind === 'arm' || e.kind === 'leg') {
      offset.subVectors(this.handleWorld(name), this.effectorPoint(name));
    }
    this.active = {
      name,
      offset,
      q: this.rig.worldQuat(e.end, new THREE.Quaternion()),
      localQ: this.rig.bones[e.end].quaternion.clone(),
      target: this.effectorPoint(name, new THREE.Vector3()),
    };
  }

  dragTo(handleTarget) {
    if (!this.active) return;
    const a = this.active;
    a.target.copy(handleTarget).sub(a.offset);
    this.clampTarget(a.name, a.target);
    this.solve();
    // A dragged hand follows its forearm, so the wrist-to-dot offset turns with it:
    // nudge the wrist target until the dot sits under the pointer.
    if (EFFECTORS[a.name].kind === 'arm') {
      const err = this.t.c;
      for (let i = 0; i < 3; i++) {
        err.subVectors(handleTarget, this.handleWorld(a.name, this.t.b));
        if (err.lengthSq() < 1e-6) break;
        a.target.add(err);
        this.clampTarget(a.name, a.target);
        this.solve();
      }
    }
  }

  endDrag() {
    if (!this.active) return;
    const name = this.active.name;
    const kind = EFFECTORS[name].kind;
    this.active = null;
    // Limbs stay where you put them; head and hips keep their pin state.
    if (kind === 'arm' || kind === 'leg') this.setPin(name, true);
    else if (this.pins[name]) this.recordPin(name);
  }

  clampTarget(name, target) {
    const kind = EFFECTORS[name].kind;
    if (kind === 'leg') target.y = Math.max(target.y, this.ankleHeight);
    else if (kind === 'hips') target.y = Math.max(target.y, MIN_HIPS_Y);
    else if (kind === 'head') target.y = Math.max(target.y, 0.2);
    else if (kind === 'arm') {
      target.y = Math.max(target.y, 0.03);
      // Keep hands out of the torso.
      const { a, b, c } = this.t;
      this.rig.worldPos('hips', a);
      this.rig.worldPos('neck', b);
      closestOnSegment(target, a, b, c);
      const off = target.clone().sub(c);
      const dist = off.length();
      if (dist < TORSO_RADIUS) {
        if (dist < 1e-4) off.copy(FWD).applyQuaternion(this.rig.worldQuat('chest'));
        target.copy(c).addScaledVector(off.normalize(), TORSO_RADIUS);
      }
    }
  }

  // ---------- bone rotation (FK) drag ----------
  beginRotate(boneName, grabWorld) {
    const owner = CHAIN_OWNER[boneName];
    if (owner) this.pins[owner] = false; // you are moving this limb by hand now
    if (boneName === 'neck' || boneName === 'head') this.neckLocked = true;
    const bone = this.rig.bones[boneName];
    bone.updateWorldMatrix(true, false);
    this.fk = { bone: boneName, grabLocal: bone.worldToLocal(grabWorld.clone()) };
  }

  rotateTo(targetWorld) {
    if (!this.fk) return;
    const name = this.fk.bone;
    aimBone(this.rig, name, this.fk.grabLocal, targetWorld);
    if (this.pins[name] && LIMBS.includes(name)) this.pinData[name].q = this.rig.worldQuat(name, new THREE.Quaternion());
    this.solve();
  }

  // Pelvis: turn with horizontal drag, tilt with vertical drag.
  rotateHipsBy(dx, dy) {
    const hips = this.rig.bones.hips;
    const { q } = this.t;
    q.setFromAxisAngle(UP, dx * 0.01);
    hips.quaternion.premultiply(q);
    q.setFromAxisAngle(RIGHT.clone().applyQuaternion(hips.quaternion), dy * 0.006);
    hips.quaternion.premultiply(q).normalize();
    hips.updateMatrixWorld(true);
    this.solve();
  }

  endRotate() {
    if (!this.fk) return;
    const name = this.fk.bone;
    if (this.pins[name]) this.recordPin(name);
    this.fk = null;
  }

  // ---------- solver ----------
  polePoint(name, endQuat, out) {
    const e = EFFECTORS[name];
    const { a, d } = this.t;
    this.rig.worldPos(e.upper, a);
    if (e.kind === 'arm') {
      // Elbows point back, down and slightly out.
      d.set(e.side * 0.55, -0.45, -0.7).normalize().applyQuaternion(this.rig.worldQuat('chest', this.t.q2));
    } else {
      // Knees follow the pelvis and the foot direction.
      const hq = this.rig.worldQuat('hips', this.t.q2);
      d.copy(FWD).applyQuaternion(hq);
      d.add(FWD.clone().applyQuaternion(endQuat));
      d.addScaledVector(RIGHT.clone().applyQuaternion(hq), e.side * 0.15);
      d.normalize();
    }
    return out.copy(a).addScaledVector(d, 0.5);
  }

  // keepLocal: the hand/foot keeps its angle to the forearm/shin (instead of its world angle).
  solveLimb(name, target, keepQuat, keepLocal = null) {
    const e = EFFECTORS[name];
    const pole = this.polePoint(name, keepQuat, new THREE.Vector3());
    solveTwoBone(this.rig, e.upper, e.lower, e.end, target, pole, e.kind === 'arm' ? -1 : 1);
    if (keepLocal) {
      this.rig.bones[e.end].quaternion.copy(keepLocal);
      this.rig.bones[e.end].updateMatrixWorld(true);
    } else {
      this.rig.setWorldQuat(e.end, keepQuat);
    }
  }

  // Move the hips by `delta`, unless the hips are pinned.
  shiftHips(delta) {
    if (this.pins.hips && this.active?.name !== 'hips') return;
    const hips = this.rig.bones.hips;
    hips.position.add(delta);
    hips.updateMatrixWorld(true);
  }

  // Keep the hips close enough to every planted foot.
  constrainHips() {
    const hips = this.rig.bones.hips;
    const { a, d } = this.t;
    const maxLen = this.legReach * 0.995;
    for (let k = 0; k < 6; k++) {
      let moved = false;
      for (const leg of ['foot.L', 'foot.R']) {
        if (!this.pins[leg] || this.active?.name === leg) continue;
        this.rig.worldPos(EFFECTORS[leg].upper, a);
        d.subVectors(this.pinData[leg].p, a);
        const dist = d.length();
        if (dist > maxLen) {
          hips.position.addScaledVector(d.normalize(), dist - maxLen);
          hips.updateMatrixWorld(true);
          moved = true;
        }
      }
      if (!moved) break;
    }
    if (hips.position.y < MIN_HIPS_Y) {
      hips.position.y = MIN_HIPS_Y;
      hips.updateMatrixWorld(true);
    }
  }

  // Let the torso (and then the hips) help when the target is out of reach.
  followBody(active) {
    const e = EFFECTORS[active.name];
    const T = active.target;
    const { a, b, d } = this.t;

    if (e.kind === 'hips') {
      this.rig.bones.hips.position.copy(T);
      this.rig.bones.hips.updateMatrixWorld(true);
      return;
    }

    if (e.kind === 'head') {
      ccdPass(this.rig, ['neck', 'chest', 'spine'], [0.55, 0.35, 0.25], (o) => this.handleWorld('head', o), T);
      this.handleWorld('head', b);
      d.subVectors(T, b);
      if (d.length() > 0.01) this.shiftHips(d.multiplyScalar(0.5));
      return;
    }

    if (e.kind === 'arm') {
      const reach = this.armReach * 0.97;
      this.rig.worldPos(e.upper, a);
      if (a.distanceTo(T) <= reach) return;
      const shoulder = e.upper;
      const end = (o) => {
        this.rig.worldPos(shoulder, o);
        const dir = d.subVectors(T, o).normalize();
        return o.addScaledVector(dir, reach);
      };
      ccdPass(this.rig, ['chest', 'spine'], [0.45, 0.35], end, T);
      this.rig.worldPos(e.upper, a);
      const dist = a.distanceTo(T);
      if (dist > reach) this.shiftHips(d.subVectors(T, a).normalize().multiplyScalar((dist - reach) * 0.5));
      return;
    }

    if (e.kind === 'leg') {
      const reach = this.legReach * 0.995;
      this.rig.worldPos(e.upper, a);
      const dist = a.distanceTo(T);
      if (dist > reach) this.shiftHips(d.subVectors(T, a).normalize().multiplyScalar(dist - reach));
    }
  }

  stabilizeHead() {
    const { q, q2, d } = this.t;
    d.copy(UP).applyQuaternion(this.rig.worldQuat('head', q));
    q2.setFromUnitVectors(d, UP);
    q.slerpQuaternions(IDENTITY, q2, 0.25);
    const nq = this.rig.worldQuat('neck', new THREE.Quaternion()).premultiply(q);
    this.rig.setWorldQuat('neck', nq);
    clampBone(this.rig.bones.neck);
  }

  solve() {
    const active = this.active;
    const keep = {};
    for (const n of LIMBS) {
      if (active?.name === n) keep[n] = active.q;
      else if (this.pins[n]) keep[n] = this.pinData[n].q;
    }

    for (let it = 0; it < 3; it++) {
      if (active) this.followBody(active);
      if (this.pins.hips && active?.name !== 'hips' && this.pinData.hips) {
        this.rig.bones.hips.position.copy(this.pinData.hips.p);
        this.rig.bones.hips.updateMatrixWorld(true);
      }
      this.constrainHips();

      for (const leg of ['foot.L', 'foot.R']) {
        if (this.pins[leg] && active?.name !== leg) this.solveLimb(leg, this.pinData[leg].p, keep[leg]);
      }
      // a hand or foot dragged into the body stops at its surface
      const target = active && this.collider && LIMBS.includes(active.name)
        ? this.collider.projectOut(active.name, active.target, EFFECTORS[active.name].kind === 'arm' ? 0.03 : 0.045)
        : active?.target;
      if (active && EFFECTORS[active.name].kind === 'leg') {
        this.solveLimb(active.name, target, keep[active.name]); // feet stay flat
      }
      if (active && EFFECTORS[active.name].kind === 'arm') {
        this.solveLimb(active.name, target, keep[active.name], active.localQ); // hand follows forearm
      }
      for (const arm of ['hand.L', 'hand.R']) {
        if (this.pins[arm] && active?.name !== arm) this.solveLimb(arm, this.pinData[arm].p, keep[arm]);
      }
      if (this.pins.head && active?.name !== 'head' && this.pinData.head) {
        ccdPass(this.rig, ['neck', 'chest'], [0.5, 0.3], (o) => this.handleWorld('head', o), this.pinData.head.p);
      }
    }

    if (this.collider) {
      for (const limb of LIMBS) {
        if (active?.name !== limb && this.pins[limb]) continue; // pinned limbs stay exactly where they were put
        this.collider.resolve(limb, EFFECTORS[limb].kind === 'leg' ? keep[limb] : null);
      }
    }
    if (active && active.name !== 'head' && !this.pins.head && !this.neckLocked) this.stabilizeHead();
    this.rig.update();
  }

  // ---------- undo support ----------
  snapshot() {
    const pinData = {};
    for (const n in this.pinData) pinData[n] = { p: this.pinData[n].p.toArray(), q: this.pinData[n].q.toArray() };
    return { rig: this.rig.snapshot(), pins: { ...this.pins }, pinData, neckLocked: this.neckLocked };
  }

  restore(s) {
    this.rig.restore(s.rig);
    this.pins = { ...s.pins };
    this.pinData = {};
    for (const n in s.pinData) {
      this.pinData[n] = { p: new THREE.Vector3().fromArray(s.pinData[n].p), q: new THREE.Quaternion().fromArray(s.pinData[n].q) };
    }
    this.neckLocked = s.neckLocked;
  }
}

export { clamp };
