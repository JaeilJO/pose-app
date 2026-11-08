// Same posing checks, on the MakeHuman-based rig.
import * as THREE from 'three';
import { createHumanRig, buildHuman, transferPose, shapeBody, heightOf, heightParam, MODELS } from '../src/human.js';
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
const fresh = (m = 'male') => { const rig = createHumanRig(MODELS[m]); const body = buildHuman(rig, MODELS[m]); return { rig, body, poser: new Poser(rig) }; };

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
{
  const { rig, body, poser } = fresh('female');
  body.mesh.computeBoundingBox();
  ok(Math.abs(body.mesh.boundingBox.min.y) < 0.005 && body.mesh.boundingBox.max.y > 1.5, `female stands on the floor, ${body.mesh.boundingBox.max.y.toFixed(2)} m`);
  drag(poser, 'hips', rig.bones.hips.position.clone().add(v(0, -0.3, -0.05)));
  const ankle = rig.worldPos('foot.L').clone();
  const m = fresh('male');
  transferPose(rig, m.rig);
  const kneeF = Math.abs(hingeAngle(rig.bones['shin.L'])), kneeM = Math.abs(hingeAngle(m.rig.bones['shin.L']));
  ok(Math.abs(kneeF - kneeM) < 0.05, `squat transfers to the other body (knee ${kneeF.toFixed(2)} vs ${kneeM.toFixed(2)})`);
  ok(m.rig.bones.hips.position.y < m.rig.rest.hips.p.y - 0.2, 'transferred hips are lowered too');
  ok(ankle.y < 0.12, 'female feet stay on the floor');
}
for (const m of ['male', 'female']) {
  const data = MODELS[m];
  const build = (vals) => { const shaped = shapeBody(data, { ...data.shapeBase, ...vals }); const rig = createHumanRig(data, shaped); const body = buildHuman(rig, data, shaped); return { rig, body }; };
  const t0 = performance.now();
  const short = build({ height: 0 }), tall = build({ height: 1 });
  const ms = (performance.now() - t0) / 2;
  ok(tall.body.height > short.body.height + 0.25, `${m} height slider ${short.body.height.toFixed(2)}–${tall.body.height.toFixed(2)} m (${ms.toFixed(0)} ms/rebuild)`);
  const girth = (b) => { const g = b.mesh.geometry; g.computeBoundingBox(); const y = g.boundingBox.min.y + 0.6 * (g.boundingBox.max.y - g.boundingBox.min.y); const p = g.attributes.position; let mx = 0; for (let i = 0; i < p.count; i++) if (Math.abs(p.getY(i) - y) < 0.02 && Math.abs(p.getX(i)) < 0.12) mx = Math.max(mx, p.getZ(i)); return mx; };
  const lean = build({ weight: 0 }), heavy = build({ weight: 1 });
  ok(girth(heavy.body) > girth(lean.body) * 1.15, `${m} body-fat slider widens the belly (${girth(lean.body).toFixed(3)} → ${girth(heavy.body).toFixed(3)})`);
  const hv = heightParam(data, 1.85);
  const at = build({ height: hv });
  ok(Math.abs(at.body.height - 1.85) < 0.01 && Math.abs(heightOf(data, hv) - 1.85) < 1e-6, `${m} height slider maps cm exactly (asked 185, got ${(at.body.height * 100).toFixed(1)})`);
  let floor = true;
  for (const b of [short, tall, lean, heavy, build({ muscle: 0 }), build({ muscle: 1 })]) { b.body.mesh.computeBoundingBox(); if (Math.abs(b.body.mesh.boundingBox.min.y) > 0.006) floor = false; }
  ok(floor, `${m} every shape stands on the floor`);
  const p = new Poser(short.rig);
  drag(p, 'hips', short.rig.bones.hips.position.clone().add(v(0, -0.3, -0.05)));
  transferPose(short.rig, tall.rig);
  ok(Math.abs(hingeAngle(short.rig.bones['shin.L']) - hingeAngle(tall.rig.bones['shin.L'])) < 0.05 && tall.rig.worldPos('foot.L').y < 0.15, `${m} pose survives a height change`);
}
for (const m of ['male', 'female']) {
  const data = MODELS[m];
  const base = shapeBody(data).positions;
  const moved = [];
  for (const k of ['shoulders', 'chest', 'arms', 'belly', 'hips', 'thighs', 'calves']) {
    for (const v of [0, 1]) {
      const p = shapeBody(data, { [k]: v }).positions;
      let mx = 0;
      for (let i = 0; i < p.length; i++) mx = Math.max(mx, Math.abs(p[i] - base[i]));
      if (mx < 0.005) moved.push(`${k}=${v}`);
    }
  }
  ok(moved.length === 0, `${m} every body-part slider changes the body${moved.length ? ` (no change: ${moved})` : ''}`);
  const lean = shapeBody(data, { muscle: 1, weight: 0 }).definition, soft = shapeBody(data, { muscle: 0, weight: 1 }).definition;
  ok(lean > soft + 0.5, `${m} muscle definition follows the sliders (${soft.toFixed(2)} → ${lean.toFixed(2)})`);
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
