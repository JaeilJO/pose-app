import * as THREE from 'three';

// A wooden drawing-mannequin built from simple shapes, parented to the rig's bones.
// Every mesh remembers its bone in userData.bone so it can be grabbed and rotated.

const sphere = new THREE.SphereGeometry(1, 28, 18);
const UP = new THREE.Vector3(0, 1, 0);

export function buildMannequin(rig) {
  const meshes = [];
  const materials = {};
  const matFor = (bone, joint = false) => {
    const key = bone + (joint ? ':j' : '');
    if (!materials[key]) {
      materials[key] = new THREE.MeshStandardMaterial({
        color: joint ? 0xc9a175 : 0xe7cfa6,
        roughness: 0.55,
        metalness: 0,
      });
    }
    return materials[key];
  };

  const add = (bone, geom, pos, scale, quat, joint = false) => {
    const m = new THREE.Mesh(geom, matFor(bone, joint));
    m.position.set(...pos);
    if (scale) m.scale.set(...scale);
    if (quat) m.quaternion.copy(quat);
    m.castShadow = true;
    m.receiveShadow = true;
    m.userData.bone = bone;
    rig.bones[bone].add(m);
    meshes.push(m);
    return m;
  };

  const ellipsoid = (bone, pos, r) => add(bone, sphere, pos, r);
  const ball = (bone, pos, r) => add(bone, sphere, pos, [r, r, r], null, true);
  // Tapered segment hanging down the bone's -Y axis.
  const limb = (bone, len, rTop, rBot) => {
    const g = new THREE.CylinderGeometry(rTop, rBot, len, 20, 1, true);
    add(bone, g, [0, -len / 2, 0]);
  };
  const capsule = (bone, from, to, r) => {
    const a = new THREE.Vector3(...from);
    const b = new THREE.Vector3(...to);
    const len = a.distanceTo(b);
    const g = new THREE.CapsuleGeometry(r, Math.max(0.001, len - r * 1.2), 6, 14);
    const q = new THREE.Quaternion().setFromUnitVectors(UP, b.clone().sub(a).normalize());
    add(bone, g, a.add(b).multiplyScalar(0.5).toArray(), null, q);
  };

  // Torso
  ellipsoid('hips', [0, -0.01, 0], [0.15, 0.1, 0.105]);
  ellipsoid('spine', [0, 0.09, 0], [0.125, 0.12, 0.095]);
  ellipsoid('chest', [0, 0.11, 0.005], [0.165, 0.15, 0.105]);
  capsule('neck', [0, -0.01, 0], [0, 0.1, 0], 0.042);
  ellipsoid('head', [0, 0.1, 0.012], [0.092, 0.118, 0.104]);
  ellipsoid('head', [0, 0.095, 0.112], [0.016, 0.024, 0.018]); // nose: shows where the face points

  for (const s of ['L', 'R']) {
    const side = s === 'L' ? 1 : -1;
    // Arm
    ball(`upperArm.${s}`, [0, 0, 0], 0.055);
    limb(`upperArm.${s}`, 0.28, 0.048, 0.038);
    ball(`foreArm.${s}`, [0, 0, 0], 0.041);
    limb(`foreArm.${s}`, 0.26, 0.038, 0.029);
    ball(`hand.${s}`, [0, 0, 0], 0.03);
    // Mitten hand: palm faces the body, thumb points forward.
    ellipsoid(`hand.${s}`, [0, -0.07, 0], [0.02, 0.065, 0.045]);
    ellipsoid(`hand.${s}`, [0, -0.14, 0.002], [0.017, 0.045, 0.041]);
    capsule(`hand.${s}`, [-side * 0.004, -0.035, 0.035], [-side * 0.006, -0.09, 0.062], 0.013);
    // Leg
    ball(`thigh.${s}`, [0, 0, 0], 0.075);
    limb(`thigh.${s}`, 0.43, 0.075, 0.052);
    ball(`shin.${s}`, [0, 0, 0], 0.055);
    limb(`shin.${s}`, 0.42, 0.052, 0.036);
    ellipsoid(`shin.${s}`, [0, -0.14, -0.012], [0.054, 0.11, 0.056]); // calf
    ball(`foot.${s}`, [0, 0, 0], 0.04);
    ellipsoid(`foot.${s}`, [0, -0.025, 0.05], [0.046, 0.032, 0.11]);
  }

  const highlight = (bone, on) => {
    for (const key of [bone, `${bone}:j`]) {
      const m = materials[key];
      if (m) m.emissive.setHex(on ? 0x5a3a12 : 0x000000);
    }
  };

  return { meshes, highlight };
}
