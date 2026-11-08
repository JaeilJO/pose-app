import * as THREE from 'three';

// Position-based cloth skirt (Verlet + distance constraints + capsule collisions).
// The waist ring is attached to the hips; everything else falls and drapes.

const GRAVITY = -9.8;
const STEP = 1 / 90;
const ITERATIONS = 10;
const MAX_SUBSTEPS = 16;
const MAX_TRAVEL = 0.02; // a collider moves at most this far (m) per substep

export class Skirt {
  constructor(rig, { rings = 32, rows = 13, waist = 0.165, hem = 0.31, length = 0.5, top = 0.06, folds = 7 } = {}) {
    this.rig = rig;
    this.M = rings;
    this.N = rows;
    const count = rings * rows;
    this.count = count;
    this.local = new Float32Array(count * 3);
    this.pos = new Float32Array(count * 3);
    this.prev = new Float32Array(count * 3);
    this.acc = 0;

    // Rest shape: an A-line with soft folds "sewn" into the pattern, like a real flared skirt.
    for (let i = 0; i < rows; i++) {
      const t = i / (rows - 1);
      const base = waist + (hem - waist) * t;
      const y = top - length * t;
      for (let j = 0; j < rings; j++) {
        const ang = (j / rings) * Math.PI * 2;
        const r = base * (1 + 0.09 * t * Math.sin(ang * folds));
        const k = (i * rings + j) * 3;
        this.local[k] = Math.sin(ang) * r;
        this.local[k + 1] = y;
        this.local[k + 2] = Math.cos(ang) * r * 1.05;
      }
    }

    // Constraints: [a, b, restLength, stretchStiffness, compressStiffness]
    const cons = [];
    const idx = (i, j) => i * rings + (((j % rings) + rings) % rings);
    const restLen = (a, b) => Math.hypot(
      this.local[a * 3] - this.local[b * 3],
      this.local[a * 3 + 1] - this.local[b * 3 + 1],
      this.local[a * 3 + 2] - this.local[b * 3 + 2],
    );
    const link = (a, b, stretch, compress) => cons.push(a, b, restLen(a, b), stretch, compress);
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < rings; j++) {
        link(idx(i, j), idx(i, j + 1), 1, 0.12); // around: fabric can bunch up
        if (i + 1 < rows) {
          link(idx(i, j), idx(i + 1, j), 1, 1); // down: does not stretch or squash
          link(idx(i, j), idx(i + 1, j + 1), 0.5, 0.05); // shear
          link(idx(i, j + 1), idx(i + 1, j), 0.5, 0.05);
        }
        if (i + 2 < rows) link(idx(i, j), idx(i + 2, j), 0.2, 0.2); // vertical bend
        link(idx(i, j), idx(i, j + 2), 0.25, 0.04); // around bend
      }
    }
    this.cons = new Float32Array(cons);

    const geom = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(new Float32Array(count * 3), 3);
    geom.setAttribute('position', this.posAttr);
    const index = [];
    for (let i = 0; i < rows - 1; i++) {
      for (let j = 0; j < rings; j++) {
        const a = idx(i, j), b = idx(i, j + 1), c = idx(i + 1, j), d = idx(i + 1, j + 1);
        index.push(a, b, c, b, d, c);
      }
    }
    geom.setIndex(index);
    this.mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({
      color: 0x6f8fd8, roughness: 0.85, side: THREE.DoubleSide,
    }));
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;

    this.capsules = [];
    for (const s of ['L', 'R']) {
      this.capsules.push({ a: `thigh.${s}`, b: `shin.${s}`, r: 0.09 });
      this.capsules.push({ a: `shin.${s}`, b: `foot.${s}`, r: 0.065 });
    }
    this._v = new THREE.Vector3();
    this.reset();
  }

  ringNow(out) {
    const hips = this.rig.bones.hips;
    hips.updateWorldMatrix(true, false);
    for (let p = 0; p < this.M; p++) {
      const k = p * 3;
      this._v.set(this.local[k], this.local[k + 1], this.local[k + 2]);
      hips.localToWorld(this._v);
      out[k] = this._v.x;
      out[k + 1] = this._v.y;
      out[k + 2] = this._v.z;
    }
    return out;
  }

  collidersNow() {
    const out = [];
    for (const c of this.capsules) {
      const a = this.rig.worldPos(c.a, this._v);
      const ax = a.x, ay = a.y, az = a.z;
      const b = this.rig.worldPos(c.b, this._v);
      out.push(ax, ay, az, b.x, b.y, b.z, c.r);
    }
    const h = this.rig.worldPoint('hips', [0, -0.02, 0], this._v);
    out.push(h.x, h.y, h.z, h.x, h.y, h.z, 0.15);
    return Float32Array.from(out);
  }

  reset() {
    this.rig.update();
    const hips = this.rig.bones.hips;
    for (let p = 0; p < this.count; p++) {
      const k = p * 3;
      this._v.set(this.local[k], this.local[k + 1], this.local[k + 2]);
      hips.localToWorld(this._v);
      this.pos[k] = this.prev[k] = this._v.x;
      this.pos[k + 1] = this.prev[k + 1] = this._v.y;
      this.pos[k + 2] = this.prev[k + 2] = this._v.z;
    }
    this.prevCols = null;
    this.prevRing = null;
    this.acc = 0;
    this.writeGeometry();
  }

  step(dt, cols, ring) {
    const { pos, prev, M, count } = this;
    const g = GRAVITY * dt * dt;
    for (let p = M; p < count; p++) {
      const k = p * 3;
      for (let c = 0; c < 3; c++) {
        const v = (pos[k + c] - prev[k + c]) * 0.985;
        prev[k + c] = pos[k + c];
        pos[k + c] += v + (c === 1 ? g : 0);
      }
    }
    // Waist ring follows the hips.
    for (let k = 0; k < M * 3; k++) pos[k] = prev[k] = ring[k];

    const cons = this.cons;
    const nCols = cols.length / 7;
    for (let it = 0; it < ITERATIONS; it++) {
      for (let c = 0; c < cons.length; c += 5) {
        const a = cons[c], b = cons[c + 1], rest = cons[c + 2];
        const wa = a < M ? 0 : 1, wb = b < M ? 0 : 1;
        const w = wa + wb;
        if (!w) continue;
        const ka = a * 3, kb = b * 3;
        const dx = pos[kb] - pos[ka], dy = pos[kb + 1] - pos[ka + 1], dz = pos[kb + 2] - pos[ka + 2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-9;
        const s = d > rest ? cons[c + 3] : cons[c + 4];
        const corr = ((d - rest) / d) * s / w;
        pos[ka] += dx * corr * wa; pos[ka + 1] += dy * corr * wa; pos[ka + 2] += dz * corr * wa;
        pos[kb] -= dx * corr * wb; pos[kb + 1] -= dy * corr * wb; pos[kb + 2] -= dz * corr * wb;
      }
      for (let p = M; p < count; p++) {
        const k = p * 3;
        for (let q = 0; q < nCols; q++) {
          const o = q * 7;
          const ax = cols[o], ay = cols[o + 1], az = cols[o + 2], r = cols[o + 6];
          const abx = cols[o + 3] - ax, aby = cols[o + 4] - ay, abz = cols[o + 5] - az;
          const len2 = abx * abx + aby * aby + abz * abz;
          let t = len2 > 1e-9 ? ((pos[k] - ax) * abx + (pos[k + 1] - ay) * aby + (pos[k + 2] - az) * abz) / len2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const cx = ax + abx * t, cy = ay + aby * t, cz = az + abz * t;
          const dx = pos[k] - cx, dy = pos[k + 1] - cy, dz = pos[k + 2] - cz;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < r * r) {
            const d = Math.sqrt(d2) || 1e-6;
            const f = r / d;
            pos[k] = cx + dx * f; pos[k + 1] = cy + dy * f; pos[k + 2] = cz + dz * f;
          }
        }
        if (pos[k + 1] < 0.005) pos[k + 1] = 0.005;
      }
    }
  }

  update(frameDt) {
    const cols = this.collidersNow();
    const ring = this.ringNow(new Float32Array(this.M * 3));
    if (!this.prevCols) {
      this.prevCols = cols;
      this.prevRing = ring;
    }

    // How far did the body jump since last frame? Big jumps get more substeps,
    // with colliders moved along the way, so a fast kick can't tunnel through the cloth.
    let travel = 0;
    for (let i = 0; i < cols.length; i += 7) {
      travel = Math.max(travel,
        Math.hypot(cols[i] - this.prevCols[i], cols[i + 1] - this.prevCols[i + 1], cols[i + 2] - this.prevCols[i + 2]),
        Math.hypot(cols[i + 3] - this.prevCols[i + 3], cols[i + 4] - this.prevCols[i + 4], cols[i + 5] - this.prevCols[i + 5]));
    }
    for (let k = 0; k < ring.length; k += 3) {
      travel = Math.max(travel, Math.hypot(ring[k] - this.prevRing[k], ring[k + 1] - this.prevRing[k + 1], ring[k + 2] - this.prevRing[k + 2]));
    }

    this.acc = Math.min(this.acc + frameDt, STEP * 4);
    let steps = Math.floor(this.acc / STEP);
    steps = Math.min(MAX_SUBSTEPS, Math.max(steps, Math.ceil(travel / MAX_TRAVEL)));
    this.acc = Math.max(0, this.acc - steps * STEP);

    const c = new Float32Array(cols.length);
    const r = new Float32Array(ring.length);
    for (let s = 0; s < steps; s++) {
      const f = (s + 1) / steps;
      for (let i = 0; i < c.length; i++) c[i] = this.prevCols[i] + (cols[i] - this.prevCols[i]) * f;
      for (let i = 0; i < r.length; i++) r[i] = this.prevRing[i] + (ring[i] - this.prevRing[i]) * f;
      this.step(STEP, c, r);
    }
    this.prevCols = cols;
    this.prevRing = ring;
    this.writeGeometry();
  }

  writeGeometry() {
    this.posAttr.array.set(this.pos);
    this.posAttr.needsUpdate = true;
    this.mesh.geometry.computeVertexNormals();
    this.mesh.geometry.computeBoundingSphere();
  }
}
