import * as THREE from 'three';
import { clampBone } from './ik.js';

// Self-collision: arms and legs may not pass through the body or each other.
//
// The body is filled with spheres that ride on its bones: the trunk, neck and head are cut into thin
// horizontal slabs and each slab into columns (one sphere per column, as deep as the body there), and
// every limb segment gets a row of spheres along its axis. After the pose is solved, a limb that ends up
// inside something is turned out of it at its root joint: first by swinging the elbow / knee around the
// shoulder-wrist (hip-ankle) line, which keeps the hand or foot where it is, and only if that cannot help
// by turning the whole limb.

const CHAINS = {
  'hand.L': { root: 'upperArm.L', end: 'hand.L', group: 'arm.L', bones: ['upperArm.L', 'foreArm.L', 'hand.L'] },
  'hand.R': { root: 'upperArm.R', end: 'hand.R', group: 'arm.R', bones: ['upperArm.R', 'foreArm.R', 'hand.R'] },
  'foot.L': { root: 'thigh.L', end: 'foot.L', group: 'leg.L', bones: ['thigh.L', 'shin.L', 'foot.L'] },
  'foot.R': { root: 'thigh.R', end: 'foot.R', group: 'leg.R', bones: ['thigh.R', 'shin.R', 'foot.R'] },
};
const TRUNK = ['hips', 'spine', 'chest'];
const HEAD = ['neck', 'head'];
const SLAB = 0.03;
const COLUMN = 0.025;
const STEP = 0.025;

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();

export class Collider {
  /**
   * @param rig  the rig, in its standing rest pose
   * @param mesh the bound SkinnedMesh (bind-pose positions, skin weights, bone inverses)
   */
  constructor(rig, mesh) {
    this.rig = rig;
    this.bones = mesh.skeleton.bones;
    this.inv = mesh.skeleton.boneInverses;
    const names = this.bones.map((b) => b.name);
    const P = mesh.geometry.attributes.position.array;
    const si = mesh.geometry.attributes.skinIndex.array, sw = mesh.geometry.attributes.skinWeight.array;
    const n = P.length / 3;
    const dom = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      let b = 0;
      for (let k = 1; k < 4; k++) if (sw[i * 4 + k] > sw[i * 4 + b]) b = k;
      dom[i] = si[i * 4 + b];
    }
    // joint positions in bind space
    const bind = this.inv.map((m) => new THREE.Vector3().setFromMatrixPosition(m.clone().invert()));
    const J = (name) => bind[names.indexOf(name)];

    const S = []; // { bone, c (bind space), r, group }
    // trunk / head: slabs and columns
    const columns = (set, group) => {
      const ids = new Set(set.map((b) => names.indexOf(b)));
      const cells = new Map();
      let ymin = Infinity;
      for (let i = 0; i < n; i++) if (ids.has(dom[i])) ymin = Math.min(ymin, P[i * 3 + 1]);
      for (let i = 0; i < n; i++) {
        if (!ids.has(dom[i])) continue;
        const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
        const sy = Math.floor((y - ymin) / SLAB), sx = Math.floor(x / COLUMN + 1000);
        const key = sy * 4096 + sx;
        let c = cells.get(key);
        if (!c) cells.set(key, (c = { sy, sx, zmin: Infinity, zmax: -Infinity, cnt: 0, votes: new Map() }));
        c.zmin = Math.min(c.zmin, z); c.zmax = Math.max(c.zmax, z); c.cnt++;
        c.votes.set(dom[i], (c.votes.get(dom[i]) || 0) + 1);
      }
      // slab x-extent, so side spheres do not poke out sideways
      const ext = new Map();
      for (const c of cells.values()) {
        const e = ext.get(c.sy) || [Infinity, -Infinity];
        ext.set(c.sy, [Math.min(e[0], c.sx), Math.max(e[1], c.sx)]);
      }
      for (const c of cells.values()) {
        if (c.cnt < 4) continue;
        const xc = (c.sx - 1000 + 0.5) * COLUMN;
        const [e0, e1] = ext.get(c.sy);
        const side = Math.min(xc - (e0 - 1000) * COLUMN, (e1 - 1000 + 1) * COLUMN - xc);
        const r = Math.min(0.9 * (c.zmax - c.zmin) / 2, side);
        if (r < 0.012) continue;
        const bone = [...c.votes.entries()].sort((a, b) => b[1] - a[1])[0][0];
        S.push({ bone, c: new THREE.Vector3(xc, ymin + (c.sy + 0.5) * SLAB, (c.zmin + c.zmax) / 2), r, group });
      }
    };
    columns(TRUNK, 'trunk');
    columns(HEAD, 'head');

    // limbs: rows of spheres along each segment
    const segment = (bone, a, b, group) => {
      const id = names.indexOf(bone);
      const axis = b.clone().sub(a);
      const len = axis.length();
      axis.normalize();
      const slabs = new Map();
      for (let i = 0; i < n; i++) {
        if (dom[i] !== id) continue;
        _v.fromArray(P, i * 3).sub(a);
        const t = _v.dot(axis);
        if (t < -0.01 || t > len + 0.01) continue;
        const k = Math.round(t / STEP);
        let s = slabs.get(k);
        if (!s) slabs.set(k, (s = []));
        s.push(i);
      }
      for (const ids of slabs.values()) {
        if (ids.length < 8) continue;
        const c = new THREE.Vector3();
        for (const i of ids) c.add(_v.fromArray(P, i * 3));
        c.divideScalar(ids.length);
        const d = ids.map((i) => { _v.fromArray(P, i * 3).sub(c); return _v.sub(axis.clone().multiplyScalar(_v.dot(axis))).length(); }).sort((x, y) => x - y);
        const r = 0.85 * d[Math.floor(d.length * 0.3)];
        if (r > 0.008) S.push({ bone: id, c, r, group });
      }
    };
    const far = (bone, from) => { // farthest vertex of a bone (fingertip, toe)
      const id = names.indexOf(bone);
      let best = from.clone(), bd = 0;
      for (let i = 0; i < n; i++) if (dom[i] === id) { const d = _v.fromArray(P, i * 3).distanceTo(from); if (d > bd) { bd = d; best = _v.clone(); } }
      return best;
    };
    for (const s of ['L', 'R']) {
      segment(`upperArm.${s}`, J(`upperArm.${s}`), J(`foreArm.${s}`), `arm.${s}`);
      segment(`foreArm.${s}`, J(`foreArm.${s}`), J(`hand.${s}`), `arm.${s}`);
      segment(`hand.${s}`, J(`hand.${s}`), far(`hand.${s}`, J(`hand.${s}`)), `arm.${s}`);
      segment(`thigh.${s}`, J(`thigh.${s}`), J(`shin.${s}`), `leg.${s}`);
      segment(`shin.${s}`, J(`shin.${s}`), J(`foot.${s}`), `leg.${s}`);
      segment(`foot.${s}`, J(`foot.${s}`), far(`foot.${s}`, J(`foot.${s}`)), `leg.${s}`);
    }
    this.spheres = S;
    this.world = S.map(() => new THREE.Vector3());
    this.M = this.bones.map(() => new THREE.Matrix4());
    this.boneName = names;
    this.ignore = new Set();
    this.calibrate();
  }

  updateWorld() {
    this.bones.forEach((b, k) => this.M[k].multiplyMatrices(b.matrixWorld, this.inv[k]));
    this.spheres.forEach((s, i) => this.world[i].copy(s.c).applyMatrix4(this.M[s.bone]));
  }

  // What may hit what: a limb against the trunk, the head and the other limbs (never itself).
  obstacles(group) {
    return this.spheres.map((s, j) => j).filter((j) => this.spheres[j].group !== group);
  }

  // In the rest pose nothing may touch: pairs that overlap a lot are part of a joint (armpit, groin)
  // and are never tested; pairs that barely touch are shrunk apart.
  calibrate() {
    this.rig.update();
    this.updateWorld();
    const S = this.spheres, W = this.world;
    for (let i = 0; i < S.length; i++) {
      if (!S[i].group.startsWith('arm') && !S[i].group.startsWith('leg')) continue;
      for (let j = 0; j < S.length; j++) {
        if (S[j].group === S[i].group) continue;
        const o = S[i].r + S[j].r - W[i].distanceTo(W[j]);
        if (o > 0.012) this.ignore.add(i * 8192 + j);
        else if (o > -0.004) { S[i].r -= (o + 0.004) / 2; S[j].r -= (o + 0.004) / 2; }
      }
    }
    for (const s of S) s.r = Math.max(0.004, s.r);
    for (let i = 0; i < S.length; i++) { // whatever still touches at rest belongs to a joint
      if (!S[i].group.startsWith('arm') && !S[i].group.startsWith('leg')) continue;
      for (let j = 0; j < S.length; j++) {
        if (S[j].group !== S[i].group && S[i].r + S[j].r > W[i].distanceTo(W[j])) this.ignore.add(i * 8192 + j);
      }
    }
    this.chainSpheres = {};
    this.chainObstacles = {};
    for (const [limb, ch] of Object.entries(CHAINS)) {
      this.chainSpheres[limb] = S.map((s, i) => i).filter((i) => S[i].group === ch.group);
      this.chainObstacles[limb] = this.obstacles(ch.group);
    }
  }

  deepest(limb) {
    const S = this.spheres, W = this.world;
    // broad phase: only obstacles near the limb's bounding box
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const i of this.chainSpheres[limb]) {
      const c = W[i], r = S[i].r;
      lo[0] = Math.min(lo[0], c.x - r); lo[1] = Math.min(lo[1], c.y - r); lo[2] = Math.min(lo[2], c.z - r);
      hi[0] = Math.max(hi[0], c.x + r); hi[1] = Math.max(hi[1], c.y + r); hi[2] = Math.max(hi[2], c.z + r);
    }
    const near = [];
    for (const j of this.chainObstacles[limb]) {
      const c = W[j], r = S[j].r;
      if (c.x + r > lo[0] && c.x - r < hi[0] && c.y + r > lo[1] && c.y - r < hi[1] && c.z + r > lo[2] && c.z - r < hi[2]) near.push(j);
    }
    let best = null;
    for (const i of this.chainSpheres[limb]) {
      const c = W[i], r = S[i].r;
      for (const j of near) {
        if (this.ignore.has(i * 8192 + j)) continue;
        const rr = S[i].r + S[j].r;
        const dx = W[i].x - W[j].x, dy = W[i].y - W[j].y, dz = W[i].z - W[j].z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= rr * rr) continue;
        const o = rr - Math.sqrt(d2);
        if (!best || o > best.o) best = { i, j, o };
      }
    }
    return best;
  }

  /** Where a dragged hand/foot handle may go: the target pushed out of everything except its own limb. */
  projectOut(limb, target, radius = 0.03) {
    const out = target.clone();
    const S = this.spheres, W = this.world;
    this.updateWorld();
    for (let it = 0; it < 12; it++) {
      let best = null;
      for (const j of this.chainObstacles[limb]) {
        const d = out.distanceTo(W[j]);
        const o = S[j].r + radius - d;
        if (o > 0 && (!best || o > best.o)) best = { j, o, d };
      }
      if (!best) break;
      const dir = best.d > 1e-6 ? out.clone().sub(W[best.j]).divideScalar(best.d) : new THREE.Vector3(0, 0, 1);
      out.addScaledVector(dir, best.o + 0.001);
    }
    return out;
  }

  /** Push one limb out of everything it is stuck in. `keepEnd`: world rotation the foot must keep. */
  resolve(limb, keepEnd = null) {
    const ch = CHAINS[limb];
    const rig = this.rig;
    for (let it = 0; it < 10; it++) {
      this.updateWorld();
      const hit = this.deepest(limb);
      if (!hit || hit.o < 0.0015) return;
      const ci = this.world[hit.i];
      const nrm = ci.clone().sub(this.world[hit.j]);
      if (nrm.lengthSq() < 1e-12) nrm.set(0, 0, 1);
      nrm.normalize();
      const pivot = rig.worldPos(ch.root);
      const end = rig.worldPos(ch.end);
      const axis = end.sub(pivot).normalize();
      const r = ci.clone().sub(pivot);
      const rPerp = r.clone().addScaledVector(axis, -r.dot(axis));
      const tangent = new THREE.Vector3().crossVectors(axis, rPerp);
      const lever = rPerp.length();
      const s = lever > 1e-6 ? tangent.divideScalar(lever).dot(nrm) : 0;
      const push = hit.o + 0.002;
      let rot;
      if (lever > 0.03 && Math.abs(s) > 0.35 && this.spheres[hit.i].bone !== this.boneName.indexOf(ch.end)) {
        // swing the elbow / knee: the hand / foot stays put
        rot = _q.setFromAxisAngle(axis, Math.sign(s) * Math.min(0.25, push / (lever * Math.abs(s))));
      } else {
        const ax = new THREE.Vector3().crossVectors(r, nrm);
        if (ax.lengthSq() < 1e-10) return;
        rot = _q.setFromAxisAngle(ax.normalize(), Math.min(0.25, push / Math.max(r.length(), 0.05)));
      }
      rig.setWorldQuat(ch.root, rig.worldQuat(ch.root).premultiply(rot));
      clampBone(rig.bones[ch.root]);
      if (keepEnd) rig.setWorldQuat(ch.end, keepEnd);
      rig.bones[ch.root].updateMatrixWorld(true);
    }
  }
}
