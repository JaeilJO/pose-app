import * as THREE from 'three';

// A smooth, continuous figure: one skinned mesh swept along the skeleton with
// anatomical cross-sections (torso, arms, legs, neck), plus rigid head, hands and feet.

const RADIAL = 36;
const X = new THREE.Vector3(1, 0, 0);
const Z = new THREE.Vector3(0, 0, 1);

const catmull = (p0, p1, p2, p3, t) =>
  0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
const smooth = (t) => t * t * (3 - 2 * t);

function blendWeights(a, b, t) {
  const out = {};
  for (const k in a) out[k] = (out[k] || 0) + a[k] * (1 - t);
  for (const k in b) out[k] = (out[k] || 0) + b[k] * t;
  return out;
}

class SkinBuilder {
  constructor(rig) {
    this.rig = rig;
    this.pos = [];
    this.skinIndex = [];
    this.skinWeight = [];
    this.index = [];
  }

  vertex(p, weights) {
    const entries = Object.entries(weights).filter(([, w]) => w > 1e-4).sort((a, b) => b[1] - a[1]).slice(0, 4);
    const sum = entries.reduce((s, [, w]) => s + w, 0) || 1;
    const idx = [0, 0, 0, 0];
    const w = [0, 0, 0, 0];
    entries.forEach(([name, ww], i) => {
      idx[i] = this.rig.boneIndex[name];
      w[i] = ww / sum;
    });
    this.pos.push(p.x, p.y, p.z);
    this.skinIndex.push(...idx);
    this.skinWeight.push(...w);
  }

  // stations: [{ c, ax, az, rx, rz, w }] ; rings are interpolated between them.
  sweep(stations, { segs = 5, capStart = false, capEnd = false, squareness = 2.3 } = {}) {
    const n = stations.length;
    const rings = [];
    for (let i = 0; i < n - 1; i++) {
      const s0 = stations[Math.max(i - 1, 0)], s1 = stations[i], s2 = stations[i + 1], s3 = stations[Math.min(i + 2, n - 1)];
      for (let k = 0; k < segs; k++) {
        const t = k / segs;
        rings.push({
          c: new THREE.Vector3(
            catmull(s0.c.x, s1.c.x, s2.c.x, s3.c.x, t),
            catmull(s0.c.y, s1.c.y, s2.c.y, s3.c.y, t),
            catmull(s0.c.z, s1.c.z, s2.c.z, s3.c.z, t),
          ),
          ax: s1.ax.clone().lerp(s2.ax, t).normalize(),
          az: s1.az.clone().lerp(s2.az, t).normalize(),
          rx: Math.max(0.004, catmull(s0.rx, s1.rx, s2.rx, s3.rx, t)),
          rz: Math.max(0.004, catmull(s0.rz, s1.rz, s2.rz, s3.rz, t)),
          w: blendWeights(s1.w, s2.w, smooth(t)),
        });
      }
    }
    const last = stations[n - 1];
    rings.push({ c: last.c.clone(), ax: last.ax.clone(), az: last.az.clone(), rx: last.rx, rz: last.rz, w: last.w });

    // Rounded caps: shrink the radius along a quarter circle.
    const cap = (from, next, atStart) => {
      const tangent = from.c.clone().sub(next.c).normalize();
      const len = Math.min(from.rx, from.rz) * 0.9;
      const extra = [];
      for (let k = 1; k <= 4; k++) {
        const phi = (k / 4) * (Math.PI / 2);
        const s = Math.max(Math.cos(phi), 0.03);
        extra.push({ ...from, c: from.c.clone().addScaledVector(tangent, Math.sin(phi) * len), rx: from.rx * s, rz: from.rz * s });
      }
      return atStart ? extra.reverse() : extra;
    };
    if (capStart) rings.unshift(...cap(rings[0], rings[1], true));
    if (capEnd) rings.push(...cap(rings[rings.length - 1], rings[rings.length - 2], false));

    const base = this.pos.length / 3;
    const e = 2 / squareness;
    const p = new THREE.Vector3();
    for (const r of rings) {
      for (let j = 0; j < RADIAL; j++) {
        const ang = (j / RADIAL) * Math.PI * 2;
        const c = Math.cos(ang), s = Math.sin(ang);
        const x = Math.sign(c) * Math.pow(Math.abs(c), e) * r.rx;
        const z = Math.sign(s) * Math.pow(Math.abs(s), e) * r.rz;
        p.copy(r.c).addScaledVector(r.ax, x).addScaledVector(r.az, z);
        this.vertex(p, r.w);
      }
    }

    // Wind triangles so normals face outward.
    const dir = rings[rings.length - 1].c.clone().sub(rings[0].c);
    const flip = new THREE.Vector3().crossVectors(rings[0].ax, rings[0].az).dot(dir) > 0;
    for (let i = 0; i < rings.length - 1; i++) {
      for (let j = 0; j < RADIAL; j++) {
        const a = base + i * RADIAL + j;
        const b = base + i * RADIAL + ((j + 1) % RADIAL);
        const c = base + (i + 1) * RADIAL + j;
        const d = base + (i + 1) * RADIAL + ((j + 1) % RADIAL);
        if (flip) this.index.push(a, b, c, b, d, c);
        else this.index.push(a, c, b, b, c, d);
      }
    }
  }

  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.skinIndex, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.skinWeight, 4));
    g.setIndex(this.index);
    g.computeVertexNormals();
    return g;
  }
}

// Round-cornered blob: a sphere pushed toward a box (k > 1 = boxier).
function blob(k = 1.6, w = 32, h = 24) {
  const g = new THREE.SphereGeometry(1, w, h);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const f = (v) => Math.sign(v) * Math.pow(Math.abs(v), 1 / k);
    p.setXYZ(i, f(p.getX(i)), f(p.getY(i)), f(p.getZ(i)));
  }
  g.computeVertexNormals();
  return g;
}

export function buildBody(rig) {
  rig.reset();
  const sb = new SkinBuilder(rig);
  const hipsY = rig.worldPos('hips').y;

  // ----- torso (hips → neck), boxy-oval sections -----
  const T = (y, rx, rz, dz, w) => ({ c: new THREE.Vector3(0, hipsY + y, dz), ax: X.clone(), az: Z.clone(), rx, rz, w });
  sb.sweep([
    T(-0.125, 0.11, 0.07, -0.006, { hips: 1 }),
    T(-0.08, 0.16, 0.096, -0.012, { hips: 1 }),
    T(-0.03, 0.172, 0.104, -0.016, { hips: 1 }),
    T(0.03, 0.16, 0.098, -0.008, { hips: 1 }),
    T(0.1, 0.131, 0.087, 0.0, { hips: 0.45, spine: 0.55 }),
    T(0.17, 0.128, 0.088, 0.004, { spine: 1 }),
    T(0.24, 0.14, 0.096, 0.01, { spine: 0.55, chest: 0.45 }),
    T(0.31, 0.153, 0.104, 0.016, { chest: 1 }),
    T(0.38, 0.16, 0.104, 0.014, { chest: 1 }),
    T(0.43, 0.165, 0.092, 0.002, { chest: 1 }),
    T(0.465, 0.15, 0.078, -0.006, { chest: 1 }),
    T(0.49, 0.1, 0.064, -0.008, { chest: 0.85, neck: 0.15 }),
    T(0.51, 0.06, 0.053, -0.006, { chest: 0.6, neck: 0.4 }),
  ], { segs: 6, capStart: true, capEnd: true, squareness: 2.6 });

  // ----- limbs: stations placed along bones in their own frames -----
  const L = (from, to, t, rx, rz, w, { dz = 0, dx = 0, side = 1 } = {}) => {
    const a = rig.worldPos(from, new THREE.Vector3());
    const b = rig.worldPos(to, new THREE.Vector3());
    const q = rig.worldQuat(from);
    const ax = X.clone().applyQuaternion(q);
    const az = Z.clone().applyQuaternion(q);
    const c = a.lerp(b, t).addScaledVector(az, dz).addScaledVector(ax, dx * side);
    return { c, ax, az, rx, rz, w };
  };

  // Neck
  sb.sweep([
    L('neck', 'head', -0.25, 0.056, 0.05, { chest: 0.5, neck: 0.5 }),
    L('neck', 'head', 0.3, 0.047, 0.045, { neck: 1 }),
    L('neck', 'head', 1.0, 0.044, 0.043, { neck: 0.6, head: 0.4 }),
    L('neck', 'head', 1.35, 0.04, 0.04, { head: 1 }),
  ], { segs: 4, capEnd: true });

  for (const s of ['L', 'R']) {
    const side = s === 'L' ? 1 : -1;
    const ua = `upperArm.${s}`, fa = `foreArm.${s}`, hd = `hand.${s}`;
    const th = `thigh.${s}`, sh = `shin.${s}`, ft = `foot.${s}`;
    const o = (extra = {}) => ({ side, ...extra });

    sb.sweep([
      L(ua, fa, -0.04, 0.05, 0.05, { chest: 0.5, [ua]: 0.5 }, o({ dx: -0.004 })),
      L(ua, fa, 0.08, 0.056, 0.055, { [ua]: 0.8, chest: 0.2 }, o({ dx: 0.004 })),
      L(ua, fa, 0.3, 0.05, 0.052, { [ua]: 1 }, o()),
      L(ua, fa, 0.55, 0.045, 0.049, { [ua]: 1 }, o({ dz: 0.004 })),
      L(ua, fa, 0.85, 0.038, 0.04, { [ua]: 1 }, o()),
      L(ua, fa, 1.0, 0.036, 0.037, { [ua]: 0.5, [fa]: 0.5 }, o()),
      L(fa, hd, 0.15, 0.04, 0.038, { [fa]: 0.9, [ua]: 0.1 }, o()),
      L(fa, hd, 0.35, 0.039, 0.034, { [fa]: 1 }, o()),
      L(fa, hd, 0.7, 0.031, 0.026, { [fa]: 1 }, o()),
      L(fa, hd, 1.0, 0.026, 0.02, { [fa]: 0.6, [hd]: 0.4 }, o()),
    ], { segs: 5, capStart: true, capEnd: true });

    sb.sweep([
      L(th, sh, -0.06, 0.082, 0.088, { hips: 0.7, [th]: 0.3 }, o({ dx: -0.012 })),
      L(th, sh, 0.06, 0.088, 0.092, { hips: 0.3, [th]: 0.7 }, o({ dx: -0.004 })),
      L(th, sh, 0.22, 0.085, 0.09, { [th]: 1 }, o({ dz: 0.008 })),
      L(th, sh, 0.55, 0.072, 0.078, { [th]: 1 }, o({ dz: 0.006 })),
      L(th, sh, 0.85, 0.058, 0.062, { [th]: 1 }, o()),
      L(th, sh, 1.0, 0.051, 0.056, { [th]: 0.5, [sh]: 0.5 }, o()),
      L(sh, ft, 0.12, 0.05, 0.058, { [sh]: 0.85, [th]: 0.15 }, o({ dz: -0.006 })),
      L(sh, ft, 0.3, 0.053, 0.064, { [sh]: 1 }, o({ dz: -0.016 })),
      L(sh, ft, 0.55, 0.045, 0.05, { [sh]: 1 }, o({ dz: -0.01 })),
      L(sh, ft, 0.85, 0.033, 0.036, { [sh]: 1 }, o()),
      L(sh, ft, 1.0, 0.03, 0.033, { [sh]: 0.6, [ft]: 0.4 }, o()),
    ], { segs: 5, capStart: true, capEnd: true });
  }

  const material = new THREE.MeshPhysicalMaterial({
    color: 0xcfc4b5,
    roughness: 0.5,
    metalness: 0,
    clearcoat: 0.3,
    clearcoatRoughness: 0.35,
    sheen: 0.25,
    sheenRoughness: 0.8,
    sheenColor: new THREE.Color(0xffffff),
  });

  const skinned = new THREE.SkinnedMesh(sb.geometry(), material);
  skinned.castShadow = true;
  skinned.receiveShadow = true;
  skinned.frustumCulled = false;
  rig.root.add(skinned);
  skinned.updateMatrixWorld(true);
  skinned.bind(new THREE.Skeleton(rig.boneList));

  // ----- rigid parts -----
  const parts = [];
  const rigid = (bone, geom, pos, scale, rot) => {
    const m = new THREE.Mesh(geom, material);
    m.position.set(...pos);
    m.scale.set(...scale);
    if (rot) m.rotation.set(...rot);
    m.castShadow = true;
    m.receiveShadow = true;
    rig.bones[bone].add(m);
    parts.push(m);
    return m;
  };

  // Egg head: narrower toward the chin, fuller at the back.
  const head = new THREE.SphereGeometry(1, 48, 32);
  const hp = head.attributes.position;
  for (let i = 0; i < hp.count; i++) {
    let x = hp.getX(i), y = hp.getY(i), z = hp.getZ(i);
    if (y < 0) {
      x *= 1 - 0.2 * -y;
      z *= 1 - 0.06 * -y;
    }
    if (z < 0 && y > -0.2) z *= 1.05;
    hp.setXYZ(i, x, y, z);
  }
  head.computeVertexNormals();
  rigid('head', head, [0, 0.1, 0.012], [0.088, 0.114, 0.1]);
  rigid('head', new THREE.SphereGeometry(1, 16, 12), [0, 0.088, 0.108], [0.013, 0.022, 0.016]); // nose: shows the face direction

  const box = blob(1.8);
  const roundBox = blob(1.5);
  for (const s of ['L', 'R']) {
    const side = s === 'L' ? 1 : -1;
    // Mitten hand: palm faces the body, thumb forward.
    rigid(`hand.${s}`, box, [0, -0.055, 0.002], [0.019, 0.05, 0.042]);
    rigid(`hand.${s}`, roundBox, [0, -0.128, 0.004], [0.016, 0.044, 0.038], [-0.12, 0, 0]);
    rigid(`hand.${s}`, roundBox, [-side * 0.004, -0.06, 0.044], [0.013, 0.034, 0.013], [0.55, 0, 0]);
    // Foot with a flat sole.
    const foot = blob(1.7);
    const fp = foot.attributes.position;
    for (let i = 0; i < fp.count; i++) fp.setY(i, Math.max(fp.getY(i), -0.75));
    foot.computeVertexNormals();
    rigid(`foot.${s}`, foot, [0, -0.025, 0.052], [0.046, 0.036, 0.115]);
  }

  const outline = addOutline(skinned, parts);
  return { skinned, parts, material, outline };
}

// ----- contour line (inverted hull), like a drawing reference -----
const OUTLINE_WIDTH = 0.0055; // meters

function outlineMaterial(width) {
  const m = new THREE.MeshBasicMaterial({ color: 0x3a3530, side: THREE.BackSide });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.outlineWidth = { value: width };
    shader.vertexShader = `uniform float outlineWidth;\n${shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n\ttransformed += normalize( normal ) * outlineWidth;',
    )}`;
  };
  m.customProgramCacheKey = () => 'outline';
  return m;
}

export function addOutline(skinned, parts) {
  const meshes = [];
  const hull = new THREE.SkinnedMesh(skinned.geometry, outlineMaterial(OUTLINE_WIDTH));
  hull.frustumCulled = false;
  skinned.parent.add(hull);
  hull.bind(skinned.skeleton, skinned.bindMatrix);
  meshes.push(hull);
  for (const part of parts) {
    // Parts are scaled spheres: divide by their scale so the line keeps a steady width.
    const s = (part.scale.x + part.scale.y + part.scale.z) / 3;
    const m = new THREE.Mesh(part.geometry, outlineMaterial(OUTLINE_WIDTH / s));
    m.position.copy(part.position);
    m.quaternion.copy(part.quaternion);
    m.scale.copy(part.scale);
    part.parent.add(m);
    meshes.push(m);
  }
  return {
    meshes,
    setVisible(on) { for (const m of meshes) m.visible = on; },
  };
}
