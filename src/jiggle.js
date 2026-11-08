import * as THREE from 'three';

// Secondary motion for soft tissue (breasts, belly).
// Each region hangs from a point fixed to a bone. A mass on a damped spring follows that point;
// the lag (and the change of gravity relative to the body) is fed to the vertex shader as an offset.
const REGIONS = ['breast.L', 'breast.R', 'belly'];
const G = new THREE.Vector3(0, -9.81, 0);
const STEP = 1 / 240;

export class Jiggle {
  /**
   * @param rig   the figure's rig (bones in rest pose when constructed)
   * @param mesh  the SkinnedMesh built by buildHuman (bound, with userData.softOffset)
   * @param data  the model asset (softAnchors)
   */
  constructor(rig, mesh, data) {
    this.rig = rig;
    this.mesh = mesh;
    this.out = mesh.userData.softOffset;
    rig.update();
    const inv = new THREE.Matrix4();
    this.regions = REGIONS.map((name) => {
      const [boneName, p] = data.softAnchors[name];
      const bone = rig.bones[boneName];
      const i = mesh.skeleton.bones.indexOf(bone);
      // anchor in the bone's local space: bind space -> bone space
      const local = new THREE.Vector3(...p).applyMatrix4(mesh.bindMatrix).applyMatrix4(inv.copy(mesh.skeleton.boneInverses[i]));
      const restQ = bone.getWorldQuaternion(new THREE.Quaternion());
      return {
        name,
        bone,
        local,
        gRest: G.clone().applyQuaternion(restQ.clone().invert()), // gravity as the body feels it standing
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        amount: 0,
        ready: false,
      };
    });
    this.tmp = new THREE.Vector3();
    this.q = new THREE.Quaternion();
    this.acc = 0;
    this.setAmounts({});
  }

  /** How soft each region is (0 = firm). Driven by the body sliders. */
  setAmounts({ breast = 0, belly = 0 }) {
    for (const r of this.regions) {
      r.amount = Math.max(0, r.name === 'belly' ? belly : breast);
      // softer tissue: lower frequency, more travel
      r.freq = 6.5 - 2.5 * Math.min(1, r.amount); // Hz
      r.zeta = 0.22; // damping ratio: a couple of visible wobbles
      r.max = (r.name === 'belly' ? 0.022 : 0.03) * Math.min(1.4, r.amount);
      r.sag = (r.name === 'belly' ? 0.012 : 0.02) * Math.min(1.4, r.amount);
    }
  }

  // where the mass rests: the anchor, plus a sag toward gravity as felt by the body (zero when standing)
  target(r, out) {
    r.bone.getWorldQuaternion(this.q);
    out.copy(r.local).applyMatrix4(r.bone.matrixWorld);
    const gNow = G.clone().applyQuaternion(this.q.clone().invert()); // gravity in bone space now
    const dg = gNow.sub(r.gRest).applyQuaternion(this.q).multiplyScalar(r.sag / 9.81);
    return out.add(dg);
  }

  /** Snap to rest (after a model swap, undo, reset). */
  settle() {
    for (const r of this.regions) r.ready = false;
  }

  update(dt) {
    const t = this.tmp;
    this.acc = Math.min(this.acc + dt, 0.1);
    while (this.acc >= STEP) {
      this.acc -= STEP;
      for (const r of this.regions) {
        this.target(r, t);
        if (!r.ready) {
          r.pos.copy(t);
          r.vel.set(0, 0, 0);
          r.ready = true;
          continue;
        }
        const w = 2 * Math.PI * r.freq;
        // a = w^2 (target - pos) - 2 zeta w vel   (semi-implicit Euler)
        const ax = w * w * (t.x - r.pos.x) - 2 * r.zeta * w * r.vel.x;
        const ay = w * w * (t.y - r.pos.y) - 2 * r.zeta * w * r.vel.y;
        const az = w * w * (t.z - r.pos.z) - 2 * r.zeta * w * r.vel.z;
        r.vel.x += ax * STEP; r.vel.y += ay * STEP; r.vel.z += az * STEP;
        r.pos.addScaledVector(r.vel, STEP);
      }
    }
    // offset = how far the mass trails its target (+ static sag), clamped, in mesh space
    const toMesh = new THREE.Matrix3().setFromMatrix4(this.mesh.bindMatrixInverse);
    this.regions.forEach((r, k) => {
      if (!r.ready || r.amount <= 0) { this.out[k].set(0, 0, 0); return; }
      r.bone.getWorldQuaternion(this.q);
      const anchor = t.copy(r.local).applyMatrix4(r.bone.matrixWorld);
      const off = r.pos.clone().sub(anchor);
      const len = off.length();
      if (len > r.max) off.multiplyScalar(r.max / len);
      this.out[k].copy(off.applyMatrix3(toMesh));
    });
  }
}
