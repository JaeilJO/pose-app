// Headless checks for the posing engine: run with `npm test`.
import * as THREE from 'three';
import { Rig } from '../src/rig.js';
import { Poser } from '../src/poser.js';
import { LIMITS, HINGES, hingeAngle } from '../src/ik.js';

let failed = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failed++;
};
const v = (x, y, z) => new THREE.Vector3(x, y, z);
const noNaN = (rig) => Object.values(rig.bones).every((b) => b.quaternion.toArray().every(Number.isFinite) && b.position.toArray().every(Number.isFinite));

function withinLimits(rig) {
  const e = new THREE.Euler();
  for (const name in LIMITS) {
    if (name.startsWith('thigh') || name.startsWith('hand') || name.startsWith('foot')) continue; // IK/pins may override these
    e.setFromQuaternion(rig.bones[name].quaternion, 'YXZ');
    const L = LIMITS[name];
    const eps = 1e-3;
    if (e.x < L.x[0] - eps || e.x > L.x[1] + eps || e.y < L.y[0] - eps || e.y > L.y[1] + eps || e.z < L.z[0] - eps || e.z > L.z[1] + eps) return name;
  }
  for (const name in HINGES) {
    const a = hingeAngle(rig.bones[name]);
    if (a < HINGES[name][0] - 1e-3 || a > HINGES[name][1] + 1e-3) return name;
  }
  return null;
}

// Simulate a pointer drag of a handle from its current spot to `to`, in small steps.
function drag(poser, name, to, steps = 30) {
  poser.beginDrag(name);
  const from = poser.handleWorld(name);
  for (let i = 1; i <= steps; i++) poser.dragTo(from.clone().lerp(to, i / steps));
  poser.endDrag();
}

// 1. Reachable hand target lands exactly.
{
  const rig = new Rig();
  const poser = new Poser(rig);
  const target = v(0.35, 1.25, 0.35);
  drag(poser, 'hand.L', target);
  const got = poser.handleWorld('hand.L');
  ok(got.distanceTo(target) < 0.01, `hand reaches a reachable target (err ${got.distanceTo(target).toFixed(4)} m)`);
  ok(poser.pins['hand.L'] === true, 'hand is pinned after the drag');
  ok(noNaN(rig), 'no NaN after hand drag');
  ok(withinLimits(rig) === null, `joint limits hold (${withinLimits(rig)})`);
}

// 2. Dragging the hips down makes a squat with feet planted.
{
  const rig = new Rig();
  const poser = new Poser(rig);
  const ankleL = rig.worldPos('foot.L').clone();
  const ankleR = rig.worldPos('foot.R').clone();
  drag(poser, 'hips', v(0, 0.55, -0.1));
  ok(rig.worldPos('foot.L').distanceTo(ankleL) < 0.005 && rig.worldPos('foot.R').distanceTo(ankleR) < 0.005, 'feet stay planted while squatting');
  ok(hingeAngle(rig.bones['shin.L']) > 1.0, `knees bend (${hingeAngle(rig.bones['shin.L']).toFixed(2)} rad)`);
  const kneeZ = rig.worldPos('shin.L').z;
  ok(kneeZ > rig.worldPos('hips').z, 'knees point forward');
  ok(Math.abs(rig.bones.hips.position.y - 0.55) < 0.02, `hips reach the target height (${rig.bones.hips.position.y.toFixed(3)})`);
}

// 3. Reaching to the floor: the body bends and follows, feet stay put.
{
  const rig = new Rig();
  const poser = new Poser(rig);
  const ankleL = rig.worldPos('foot.L').clone();
  const target = v(0.15, 0.15, 0.55);
  drag(poser, 'hand.R', target, 60);
  const got = poser.handleWorld('hand.R');
  ok(got.distanceTo(target) < 0.05, `far floor reach gets close (err ${got.distanceTo(target).toFixed(3)} m)`);
  ok(rig.bones.hips.position.y < 0.9, `hips dropped to help (${rig.bones.hips.position.y.toFixed(2)})`);
  ok(rig.worldPos('foot.L').distanceTo(ankleL) < 0.005, 'planted foot did not slide');
  ok(withinLimits(rig) === null, `joint limits hold (${withinLimits(rig)})`);
  ok(noNaN(rig), 'no NaN');
}

// 4. Reaching above max height: arm stretches, no explosion.
{
  const rig = new Rig();
  const poser = new Poser(rig);
  drag(poser, 'hand.L', v(0.2, 2.6, 0.1), 40);
  ok(noNaN(rig), 'no NaN when target is unreachable');
  ok(rig.worldPos('foot.L').y < 0.06, 'feet stay on the ground');
  ok(poser.handleWorld('hand.L').y > 1.9, `hand goes as high as the body allows (${poser.handleWorld('hand.L').y.toFixed(2)})`);
}

// 5. Kick: foot follows, other foot planted.
{
  const rig = new Rig();
  const poser = new Poser(rig);
  const ankleL = rig.worldPos('foot.L').clone();
  const target = v(-0.1, 0.7, 0.55);
  drag(poser, 'foot.R', target);
  const got = poser.handleWorld('foot.R');
  ok(got.distanceTo(target) < 0.05, `kicking foot reaches (err ${got.distanceTo(target).toFixed(3)} m)`);
  ok(rig.worldPos('foot.L').distanceTo(ankleL) < 0.005, 'standing foot stays planted');
}

// 6. Pinned hand stays put while the hips move.
{
  const rig = new Rig();
  const poser = new Poser(rig);
  const target = v(0.3, 1.0, 0.3);
  drag(poser, 'hand.L', target);
  const pinned = poser.handleWorld('hand.L').clone();
  drag(poser, 'hips', v(0.05, 0.85, 0.05));
  ok(poser.handleWorld('hand.L').distanceTo(pinned) < 0.01, 'pinned hand holds while the body moves');
}

// 7. Rotating a forearm by hand respects the elbow hinge.
{
  const rig = new Rig();
  const poser = new Poser(rig);
  const grab = rig.worldPoint('foreArm.L', [0, -0.2, 0]);
  poser.beginRotate('foreArm.L', grab);
  poser.rotateTo(grab.clone().add(v(0, 0.3, -0.4))); // try to bend it backwards
  poser.endRotate();
  const a = hingeAngle(rig.bones['foreArm.L']);
  ok(a <= 1e-3 && a >= -2.6 - 1e-3, `elbow cannot bend backwards (${a.toFixed(3)})`);
}

// 8. Hand target inside the torso gets pushed out.
{
  const rig = new Rig();
  const poser = new Poser(rig);
  drag(poser, 'hand.L', v(0, 1.2, 0));
  const p = rig.worldPos('hand.L');
  const axisDist = Math.hypot(p.x, p.z);
  ok(axisDist > 0.12, `hand does not sink into the chest (${axisDist.toFixed(3)} m from axis)`);
}

// 9. Undo snapshot round-trip.
{
  const rig = new Rig();
  const poser = new Poser(rig);
  const s = poser.snapshot();
  drag(poser, 'hips', v(0, 0.6, 0));
  poser.restore(s);
  ok(Math.abs(rig.bones.hips.position.y - 0.95) < 1e-6 && poser.pins['foot.L'], 'restore brings back pose and pins');
}

// 10. Timing: one drag step should be cheap.
{
  const rig = new Rig();
  const poser = new Poser(rig);
  poser.beginDrag('hand.L');
  const start = performance.now();
  for (let i = 0; i < 500; i++) poser.dragTo(v(0.2 + 0.4 * Math.sin(i / 20), 0.6 + 0.8 * Math.cos(i / 30), 0.4));
  const ms = (performance.now() - start) / 500;
  poser.endDrag();
  ok(ms < 2, `solve step ${ms.toFixed(3)} ms`);
  ok(noNaN(rig), 'no NaN after 500 random drags');
}

// 11. Skirt cloth stays stable through a squat and a kick.
{
  const { Skirt } = await import('../src/cloth.js');
  const rig = new Rig();
  const poser = new Poser(rig);
  const skirt = new Skirt(rig);
  for (let i = 0; i < 120; i++) skirt.update(1 / 60);
  drag(poser, 'hips', v(0, 0.6, -0.1));
  for (let i = 0; i < 120; i++) skirt.update(1 / 60);
  drag(poser, 'foot.R', v(-0.1, 0.7, 0.5));
  const start = performance.now();
  for (let i = 0; i < 120; i++) skirt.update(1 / 60);
  const ms = (performance.now() - start) / 120;
  const finite = skirt.pos.every(Number.isFinite);
  let minY = Infinity;
  for (let k = 1; k < skirt.pos.length; k += 3) minY = Math.min(minY, skirt.pos[k]);
  ok(finite, 'skirt has no NaN after squat + kick');
  ok(minY >= 0.004, `skirt stays above the floor (min y ${minY.toFixed(3)})`);
  ok(ms < 4, `skirt frame cost ${ms.toFixed(2)} ms`);
}

console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
