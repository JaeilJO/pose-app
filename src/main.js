import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Rig } from './rig.js';
import { Poser, EFFECTOR_NAMES } from './poser.js';
import { buildMannequin } from './mannequin.js';
import { Skirt } from './cloth.js';
import { STRINGS, detectLang } from './i18n.js';

// ---------- renderer / scene ----------
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xe9e9ec);

const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 60);
const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 0.95, 0);
controls.enableDamping = true;
controls.minDistance = 0.6;
controls.maxDistance = 12;

scene.add(new THREE.HemisphereLight(0xffffff, 0xb8b0a5, 1.4));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(2.5, 4.5, 3);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
Object.assign(sun.shadow.camera, { left: -2, right: 2, top: 2.5, bottom: -1, near: 0.5, far: 12 });
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.02;
scene.add(sun);

const ground = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), new THREE.ShadowMaterial({ opacity: 0.18 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);
const grid = new THREE.GridHelper(10, 20, 0xb0b0b6, 0xd0d0d5);
grid.position.y = 0.001;
scene.add(grid);

// ---------- figure ----------
const rig = new Rig();
scene.add(rig.root);
const poser = new Poser(rig);
const { meshes, highlight } = buildMannequin(rig);
const skirt = new Skirt(rig);
skirt.mesh.visible = false;
scene.add(skirt.mesh);
let skirtOn = false;

// ---------- handles (dots) ----------
const COLORS = { free: 0x2f6fed, pinned: 0xff4d4f, active: 0xffb020 };
const dotGeom = new THREE.SphereGeometry(1, 20, 14);
const handleGroup = new THREE.Group();
scene.add(handleGroup);
const handles = {};
for (const name of EFFECTOR_NAMES) {
  const group = new THREE.Group();
  const rim = new THREE.Mesh(dotGeom, new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true }));
  const core = new THREE.Mesh(dotGeom, new THREE.MeshBasicMaterial({ color: COLORS.free, depthTest: false, transparent: true }));
  rim.renderOrder = 10;
  core.renderOrder = 11;
  group.add(rim, core);
  handleGroup.add(group);
  handles[name] = { group, rim, core };
}
let handlesVisible = true;

const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();

function updateHandles() {
  const rect = canvas.getBoundingClientRect();
  const perPixel = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / Math.max(rect.height, 1);
  for (const name of EFFECTOR_NAMES) {
    const h = handles[name];
    poser.handleWorld(name, h.group.position);
    const dist = camera.position.distanceTo(h.group.position);
    const px = dist * perPixel;
    h.rim.scale.setScalar(px * 9);
    h.core.scale.setScalar(px * 7);
    const color = drag?.mode === 'handle' && drag.name === name ? COLORS.active : poser.pins[name] ? COLORS.pinned : COLORS.free;
    h.core.material.color.setHex(color);
    const opacity = isHidden(name, h.group.position, dist) ? 0.35 : 1;
    h.core.material.opacity = opacity;
    h.rim.material.opacity = opacity;
  }
}

// A dot behind the body is drawn faded (its own hand/foot/head mesh doesn't count).
const OWN_BONE = { 'hand.L': 'hand.L', 'hand.R': 'hand.R', 'foot.L': 'foot.L', 'foot.R': 'foot.R', head: 'head', hips: 'hips' };
const occluder = new THREE.Raycaster();
function isHidden(name, pos, dist) {
  occluder.set(camera.position, tmpV2.subVectors(pos, camera.position).normalize());
  occluder.far = dist - 0.01;
  for (const hit of occluder.intersectObjects(meshes, false)) {
    if (hit.object.userData.bone !== OWN_BONE[name]) return true;
  }
  return false;
}

// ---------- picking ----------
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const dragPlane = new THREE.Plane();

function setRay(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
}

function pickHandle(clientX, clientY, pointerType) {
  if (!handlesVisible) return null;
  const rect = canvas.getBoundingClientRect();
  let best = null;
  let bestD = pointerType === 'touch' ? 34 : 20;
  for (const name of EFFECTOR_NAMES) {
    const p = poser.handleWorld(name, tmpV).project(camera);
    if (p.z > 1) continue;
    const sx = ((p.x + 1) / 2) * rect.width + rect.left;
    const sy = ((1 - p.y) / 2) * rect.height + rect.top;
    const d = Math.hypot(sx - clientX, sy - clientY);
    if (d < bestD) {
      bestD = d;
      best = name;
    }
  }
  return best;
}

function pickBody(clientX, clientY) {
  setRay(clientX, clientY);
  const hit = raycaster.intersectObjects(meshes, false)[0];
  return hit ? { bone: hit.object.userData.bone, point: hit.point.clone() } : null;
}

function planeThrough(point) {
  camera.getWorldDirection(tmpV2);
  dragPlane.setFromNormalAndCoplanarPoint(tmpV2.negate(), point);
}

function pointOnPlane(clientX, clientY, out) {
  setRay(clientX, clientY);
  return raycaster.ray.intersectPlane(dragPlane, out);
}

// ---------- undo ----------
const undoStack = [];
const redoStack = [];
const btn = (act) => document.querySelector(`[data-act="${act}"]`);

function refreshButtons() {
  btn('undo').disabled = !undoStack.length;
  btn('redo').disabled = !redoStack.length;
}
function pushUndo() {
  undoStack.push(poser.snapshot());
  if (undoStack.length > 80) undoStack.shift();
  redoStack.length = 0;
  refreshButtons();
}
function afterJump() {
  rig.update();
  if (skirtOn) skirt.reset();
  refreshButtons();
}
function undo() {
  if (!undoStack.length) return;
  redoStack.push(poser.snapshot());
  poser.restore(undoStack.pop());
  afterJump();
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(poser.snapshot());
  poser.restore(redoStack.pop());
  afterJump();
}

// ---------- pointer interaction ----------
let drag = null;

function onPointerDown(e) {
  if (e.target !== canvas || drag) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  const name = pickHandle(e.clientX, e.clientY, e.pointerType);
  let body = null;
  if (!name) {
    body = pickBody(e.clientX, e.clientY);
    if (!body) return; // empty space: let the camera orbit
  }

  e.stopImmediatePropagation();
  e.preventDefault();
  controls.enabled = false;
  canvas.setPointerCapture(e.pointerId);
  pushUndo();

  if (name) {
    drag = { mode: 'handle', name, id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
    planeThrough(poser.handleWorld(name, tmpV));
  } else {
    drag = { mode: 'bone', bone: body.bone, id: e.pointerId, x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, moved: false };
    planeThrough(body.point);
    poser.beginRotate(body.bone, body.point);
    highlight(body.bone, true);
  }
}

function onPointerMove(e) {
  if (!drag || e.pointerId !== drag.id) return;
  if (!drag.moved) {
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 4) return;
    drag.moved = true;
    if (drag.mode === 'handle') poser.beginDrag(drag.name);
  }
  if (drag.mode === 'bone' && drag.bone === 'hips') {
    poser.rotateHipsBy(e.clientX - drag.lx, e.clientY - drag.ly);
    drag.lx = e.clientX;
    drag.ly = e.clientY;
    return;
  }
  const p = pointOnPlane(e.clientX, e.clientY, tmpV);
  if (!p) return;
  if (drag.mode === 'handle') poser.dragTo(p);
  else poser.rotateTo(p);
}

function onPointerUp(e) {
  if (!drag || e.pointerId !== drag.id) return;
  if (drag.mode === 'handle') {
    if (drag.moved) poser.endDrag();
    else poser.setPin(drag.name, !poser.pins[drag.name]); // tap = pin / unpin
  } else {
    poser.endRotate();
    highlight(drag.bone, false);
    if (!drag.moved) {
      undoStack.pop(); // a tap on the body changes nothing
      refreshButtons();
    }
  }
  try { canvas.releasePointerCapture(e.pointerId); } catch { /* already released */ }
  drag = null;
  controls.enabled = true;
}

// Capture on window so we run before OrbitControls sees the event.
window.addEventListener('pointerdown', onPointerDown, { capture: true });
canvas.addEventListener('pointermove', onPointerMove);
canvas.addEventListener('pointerup', onPointerUp);
canvas.addEventListener('pointercancel', onPointerUp);
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// ---------- camera views & lens ----------
const VIEW_DIRS = [
  new THREE.Vector3(0.55, 0.22, 0.8),
  new THREE.Vector3(0, 0.1, 1),
  new THREE.Vector3(1, 0.1, 0),
  new THREE.Vector3(0, 0.1, -1),
];
let viewIndex = 0;
let tween = null;

function goToView(i, instant = false) {
  viewIndex = i;
  const dist = instant ? 3.4 : camera.position.distanceTo(controls.target);
  const to = VIEW_DIRS[i].clone().normalize().multiplyScalar(dist).add(controls.target);
  if (instant) camera.position.copy(to);
  else tween = { from: camera.position.clone(), to, t: 0 };
  document.getElementById('viewName').textContent = STRINGS[lang].views[i];
}

const fovInput = document.getElementById('fov');
fovInput.addEventListener('input', () => {
  const next = Number(fovInput.value);
  const prev = camera.fov;
  // Dolly so the figure keeps its size: only the perspective changes.
  const k = Math.tan(THREE.MathUtils.degToRad(prev) / 2) / Math.tan(THREE.MathUtils.degToRad(next) / 2);
  const offset = camera.position.clone().sub(controls.target).multiplyScalar(k);
  camera.position.copy(controls.target).add(offset);
  camera.fov = next;
  camera.updateProjectionMatrix();
  document.getElementById('fovText').textContent = `${next}°`;
});

// ---------- toolbar ----------
function snapshot() {
  const wasVisible = handleGroup.visible;
  handleGroup.visible = false;
  renderer.render(scene, camera);
  const url = canvas.toDataURL('image/png');
  handleGroup.visible = wasVisible;
  document.getElementById('snapImg').src = url;
  document.getElementById('snapOverlay').hidden = false;
}

const actions = {
  undo,
  redo,
  reset() {
    pushUndo();
    poser.reset();
    afterJump();
  },
  view() {
    goToView((viewIndex + 1) % VIEW_DIRS.length);
  },
  pins() {
    handlesVisible = !handlesVisible;
    handleGroup.visible = handlesVisible;
    btn('pins').classList.toggle('on', handlesVisible);
  },
  skirt() {
    skirtOn = !skirtOn;
    skirt.mesh.visible = skirtOn;
    if (skirtOn) skirt.reset();
    btn('skirt').classList.toggle('on', skirtOn);
  },
  snap: snapshot,
};
document.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => actions[b.dataset.act]()));
document.getElementById('snapClose').addEventListener('click', () => { document.getElementById('snapOverlay').hidden = true; });

window.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
  }
});

// ---------- timer (for speed tests) ----------
const timerBtn = document.getElementById('timerBtn');
const timerText = document.getElementById('timerText');
let timerStart = 0;
let timerRunning = false;
let timerElapsed = 0;
const fmt = (ms) => {
  const s = ms / 1000;
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
};
timerBtn.addEventListener('click', () => {
  timerRunning = !timerRunning;
  if (timerRunning) {
    timerStart = performance.now();
    timerElapsed = 0;
  }
  timerBtn.classList.toggle('running', timerRunning);
});

// ---------- language & hint ----------
let lang = detectLang();
const langSelect = document.getElementById('lang');
function applyLang() {
  const s = STRINGS[lang];
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = s[el.dataset.i18n]; });
  document.getElementById('viewName').textContent = s.views[viewIndex];
  document.title = s.title;
  langSelect.value = lang;
}
langSelect.addEventListener('change', () => {
  lang = langSelect.value;
  try { localStorage.setItem('pose.lang', lang); } catch { /* ignore */ }
  applyLang();
});

const hint = document.getElementById('hint');
let hintSeen = false;
try { hintSeen = localStorage.getItem('pose.hintSeen') === '1'; } catch { /* ignore */ }
hint.hidden = hintSeen;
document.getElementById('hintClose').addEventListener('click', () => {
  hint.hidden = true;
  try { localStorage.setItem('pose.hintSeen', '1'); } catch { /* ignore */ }
});

// ---------- loop ----------
function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

const fpsEl = document.getElementById('fps');
let frames = 0;
let fpsTime = performance.now();
let last = performance.now();

function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;

  if (tween) {
    tween.t = Math.min(tween.t + dt / 0.35, 1);
    const e = 1 - Math.pow(1 - tween.t, 3);
    const dist = tween.to.distanceTo(controls.target);
    const dir = tween.from.clone().sub(controls.target).normalize().lerp(tween.to.clone().sub(controls.target).normalize(), e).normalize();
    camera.position.copy(controls.target).addScaledVector(dir, dist);
    if (tween.t >= 1) tween = null;
  }
  controls.update();
  if (skirtOn) skirt.update(dt);
  updateHandles();
  renderer.render(scene, camera);

  if (timerRunning) timerElapsed = now - timerStart;
  timerText.textContent = fmt(timerElapsed);

  frames++;
  if (now - fpsTime > 500) {
    fpsEl.textContent = `${Math.round((frames * 1000) / (now - fpsTime))} fps`;
    frames = 0;
    fpsTime = now;
  }
  requestAnimationFrame(frame);
}

resize();
applyLang();
goToView(0, true);
refreshButtons();
requestAnimationFrame(frame);
