import * as THREE from 'three';

// Invisible, simple shapes on each bone: cheap targets for touch picking and for
// "is this dot behind the body?" tests (raycasting a skinned mesh is slow on phones).

const UP = new THREE.Vector3(0, 1, 0);
const material = new THREE.MeshBasicMaterial();

export function buildProxies(rig) {
  const meshes = [];
  const capsule = (bone, from, to, r) => {
    const a = new THREE.Vector3(...from);
    const b = new THREE.Vector3(...to);
    const len = a.distanceTo(b);
    const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, Math.max(len, 0.001), 4, 10), material);
    m.position.copy(a).add(b).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(UP, b.clone().sub(a).normalize());
    m.visible = false;
    m.userData.bone = bone;
    rig.bones[bone].add(m);
    meshes.push(m);
  };
  const childOffset = (child) => rig.bones[child].position.toArray();
  const O = [0, 0, 0];

  capsule('hips', [0, -0.04, 0], childOffset('spine'), 0.15);
  capsule('spine', O, childOffset('chest'), 0.14);
  capsule('chest', O, childOffset('neck'), 0.16);
  capsule('neck', O, childOffset('head'), 0.055);
  capsule('head', [0, 0.06, 0.02], [0, 0.14, 0.02], 0.1);
  for (const s of ['L', 'R']) {
    capsule(`upperArm.${s}`, O, childOffset(`foreArm.${s}`), 0.055);
    capsule(`foreArm.${s}`, O, childOffset(`hand.${s}`), 0.045);
    capsule(`hand.${s}`, [0, -0.02, 0], [0, -0.16, 0], 0.045);
    capsule(`thigh.${s}`, O, childOffset(`shin.${s}`), 0.085);
    capsule(`shin.${s}`, O, childOffset(`foot.${s}`), 0.06);
    capsule(`foot.${s}`, [0, -0.03, 0], [0, -0.05, 0.16], 0.05);
  }
  return meshes;
}
