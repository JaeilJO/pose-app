// Same posing checks, on the MakeHuman-based rig.
import * as THREE from 'three';
import { createHumanRig, buildHuman } from '../src/human.js';
import { Poser } from '../src/poser.js';
import { hingeAngle } from '../src/ik.js';

let failed = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failed++; };
const v = (x, y, z) => new THREE.Vector3(x, y, z);
function drag(poser, name, to, steps = 30) {
  poser.beginDrag(name);
  const from = poser.handleWorld(name);
  for (let i = 1; i <= steps; i++) poser.dragTo(from.clone().lerp(to, i / steps));
  poser.endDrag();
}
const fresh = () => { const rig = createHumanRig(); const body = buildHuman(rig); return { rig, body, poser: new Poser(rig) }; };

{
  const { rig, body } = fresh();
  body.mesh.computeBoundingBox();
  const bb = body.mesh.boundingBox;
  ok(Math.abs(bb.min.y) < 0.005, `soles on the floor (min y ${bb.min.y.toFixed(4)})`);
  ok(bb.max.y > 1.6 && bb.max.y < 1.85, `standing height ${bb.max.y.toFixed(2)} m`);
  const handL = rig.worldPos('hand.L'), hip = rig.worldPos('thigh.L');
  ok(handL.y < hip.y + 0.15 && handL.x > 0.15, `arms hang at the sides (left wrist ${handL.toArray().map((n) => n.toFixed(2))})`);
  ok(Math.abs(hingeAngle(rig.bones['foreArm.L']) + 0.22) < 1e-3, 'elbow rest bend is a pure hinge');
  const a = rig.worldPos('foot.L'), b = rig.worldPos('foot.R');
  ok(a.distanceTo(b) < 0.4, `feet ${a.distanceTo(b).toFixed(2)} m apart`);
}
{
  const { poser, rig } = fresh();
  const target = v(0.4, 1.4, 0.4);
  drag(poser, 'hand.L', target);
  ok(poser.handleWorld('hand.L').distanceTo(target) < 0.01, `hand reaches (err ${poser.handleWorld('hand.L').distanceTo(target).toFixed(4)})`);
  const elbow = rig.worldPos('foreArm.L'), sh = rig.worldPos('upperArm.L');
  ok(elbow.y < sh.y + 0.2, 'elbow sits below the hand, not flipped up');
}
{
  const { poser, rig } = fresh();
  const ankle = rig.worldPos('foot.L').clone();
  const hipsY = rig.bones.hips.position.y;
  drag(poser, 'hips', rig.bones.hips.position.clone().add(v(0, -0.4, -0.08)));
  ok(rig.worldPos('foot.L').distanceTo(ankle) < 0.005, 'squat keeps feet planted');
  const knee = rig.worldPos('shin.L');
  ok(knee.z > rig.worldPos('thigh.L').z, 'knees bend forward');
  ok(rig.bones.hips.position.y < hipsY - 0.3, 'hips went down');
}
{
  const { poser, body } = fresh();
  drag(poser, 'hand.R', v(-0.2, 0.2, 0.5), 60);
  drag(poser, 'foot.L', v(0.2, 0.6, 0.5), 30);
  const pos = body.mesh.geometry.attributes.position;
  const t = new THREE.Vector3();
  let finite = true;
  for (let i = 0; i < pos.count; i += 97) { body.mesh.getVertexPosition(i, t); if (!Number.isFinite(t.x + t.y + t.z)) finite = false; }
  ok(finite, 'skinned vertices stay finite in a hard pose');
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
