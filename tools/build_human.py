#!/usr/bin/env python3
"""Build the human body asset from MakeHuman's CC0 data.

Usage: python3 tools/build_human.py <makehuman/data dir> src/assets/human.js

Applies MakeHuman macro + muscle targets to the base mesh, keeps the body (and eyeballs),
maps MakeHuman's 163-bone skin weights onto our 17-bone rig, and writes a JS module
with base64 buffers. MakeHuman's base mesh, targets, skeleton and weights are CC0
(see https://github.com/makehumancommunity/makehuman/blob/master/LICENSE.md).
"""
import base64
import json
import sys

import numpy as np

MH, OUT = sys.argv[1], sys.argv[2]
SCALE = 0.1  # MakeHuman units are decimeters

# ---------------- body shape: athletic adult male ----------------
GENDER = 1.0          # 0 female .. 1 male
MUSCLE = 1.0          # 0.5 average .. 1 max
WEIGHT = 0.2          # 0 min .. 0.5 average
PROPORTIONS = 0.8     # ideal proportions
RACES = {'african': 1 / 3, 'asian': 1 / 3, 'caucasian': 1 / 3}
DETAIL = {  # extra muscle definition
    'torso/torso-muscle-pectoral-incr.target': 0.75,
    'torso/torso-muscle-dorsi-incr.target': 0.6,
    'torso/torso-vshape-incr.target': 0.45,
    'armslegs/l-upperarm-muscle-incr.target': 0.75, 'armslegs/r-upperarm-muscle-incr.target': 0.75,
    'armslegs/l-upperarm-shoulder-muscle-incr.target': 0.65, 'armslegs/r-upperarm-shoulder-muscle-incr.target': 0.65,
    'armslegs/l-lowerarm-muscle-incr.target': 0.6, 'armslegs/r-lowerarm-muscle-incr.target': 0.6,
    'armslegs/l-upperleg-muscle-incr.target': 0.75, 'armslegs/r-upperleg-muscle-incr.target': 0.75,
    'armslegs/l-lowerleg-muscle-incr.target': 0.6, 'armslegs/r-lowerleg-muscle-incr.target': 0.6,
}
KEEP_GROUPS = {'body', 'helper-l-eye', 'helper-r-eye'}

# ---------------- load base mesh ----------------
verts, faces, cur = [], [], None
for line in open(f'{MH}/3dobjs/base.obj'):
    if line.startswith('v '):
        verts.append([float(x) for x in line.split()[1:4]])
    elif line.startswith('g '):
        cur = line.split()[1]
    elif line.startswith('f '):
        faces.append((cur, [int(p.split('/')[0]) - 1 for p in line.split()[1:]]))
V = np.array(verts)


def apply_target(path, w):
    if w <= 0:
        return
    rows = [l.split() for l in open(f'{MH}/targets/{path}') if l.strip() and not l.startswith('#')]
    t = np.array(rows, dtype=float)
    V[t[:, 0].astype(int)] += w * t[:, 1:4]


def split(v):
    """Slider value -> {min/average/max: weight} like MakeHuman's macro modifiers."""
    if v >= 0.5:
        return {'average': (1 - v) * 2, 'max': (v - 0.5) * 2}
    return {'min': (0.5 - v) * 2, 'average': v * 2}


genders = {'male': GENDER, 'female': 1 - GENDER}
muscles, weights = split(MUSCLE), split(WEIGHT)
for g, gw in genders.items():
    for m, mw in muscles.items():
        for wt, ww in weights.items():
            apply_target(f'macrodetails/universal-{g}-young-{m}muscle-{wt}weight.target', gw * mw * ww)
            apply_target(f'macrodetails/proportions/{g}-young-{m}muscle-{wt}weight-idealproportions.target', gw * mw * ww * PROPORTIONS)
    for race, rw in RACES.items():
        apply_target(f'macrodetails/{race}-{g}-young.target', gw * rw)
for path, w in DETAIL.items():
    apply_target(path, w)

# ---------------- joints ----------------
skel = json.load(open(f'{MH}/rigs/default.mhskel'))
joint = lambda name: V[skel['joints'][name]].mean(0)
head_of = lambda bone: joint(skel['bones'][bone]['head'])
J = {
    'hips': head_of('spine05'), 'spine': head_of('spine03'), 'chest': head_of('spine01'),
    'neck': head_of('neck01'), 'head': head_of('head'),
}
for s, S in (('L', 'L'), ('R', 'R')):
    J[f'shoulder.{s}'] = head_of(f'upperarm01.{S}')
    J[f'elbow.{s}'] = head_of(f'lowerarm01.{S}')
    J[f'wrist.{s}'] = head_of(f'wrist.{S}')
    J[f'hip.{s}'] = head_of(f'upperleg01.{S}')
    J[f'knee.{s}'] = head_of(f'lowerleg01.{S}')
    J[f'ankle.{s}'] = head_of(f'foot.{S}')

# ---------------- skin weights: MakeHuman bones -> our bones ----------------
OUR = ['hips', 'spine', 'chest', 'neck', 'head',
       'upperArm.L', 'foreArm.L', 'hand.L', 'upperArm.R', 'foreArm.R', 'hand.R',
       'thigh.L', 'shin.L', 'foot.L', 'thigh.R', 'shin.R', 'foot.R']
IDX = {n: i for i, n in enumerate(OUR)}


def map_bone(b):
    side = b[-1] if b.endswith(('.L', '.R')) else None
    base = b[:-2] if side else b
    if base in ('root', 'pelvis', 'spine05'):
        return {'hips': 1}
    if base == 'spine04':
        return {'hips': 0.6, 'spine': 0.4}
    if base == 'spine03':
        return {'spine': 1}
    if base == 'spine02':
        return {'spine': 0.65, 'chest': 0.35}
    if base in ('spine01', 'breast', 'clavicle'):
        return {'chest': 1}
    if base == 'shoulder01':
        return {'chest': 0.5, f'upperArm.{side}': 0.5}
    if base.startswith('neck'):
        return {'neck': 1}
    if base.startswith('upperarm'):
        return {f'upperArm.{side}': 1}
    if base.startswith('lowerarm'):
        return {f'foreArm.{side}': 1}
    if base in ('wrist',) or base.startswith(('metacarpal', 'finger')):
        return {f'hand.{side}': 1}
    if base.startswith('upperleg'):
        return {f'thigh.{side}': 1}
    if base.startswith('lowerleg'):
        return {f'shin.{side}': 1}
    if base == 'foot' or base.startswith('toe'):
        return {f'foot.{side}': 1}
    return {'head': 1}  # head, jaw, eyes, tongue and face muscles


W = np.zeros((len(V), len(OUR)))
for bone, pairs in json.load(open(f'{MH}/rigs/default_weights.mhw'))['weights'].items():
    for ours, frac in map_bone(bone).items():
        for vi, w in pairs:
            W[vi, IDX[ours]] += w * frac

# ---------------- keep body + eyes, triangulate, compact ----------------
tris = []
for g, f in faces:
    if g not in KEEP_GROUPS:
        continue
    for k in range(1, len(f) - 1):
        tris.append((f[0], f[k], f[k + 1]))
tris = np.array(tris)
used = np.unique(tris)
remap = -np.ones(len(V), dtype=np.int64)
remap[used] = np.arange(len(used))
tris = remap[tris]
P = V[used] * SCALE
Wu = W[used]
Wu[Wu.sum(1) < 1e-6, IDX['head']] = 1  # unweighted helper verts (eyeballs) ride the head

# top-4 influences, quantized to bytes
order = np.argsort(-Wu, axis=1)[:, :4]
top = np.take_along_axis(Wu, order, axis=1)
top /= top.sum(1, keepdims=True)
q = np.round(top * 255).astype(np.int64)
q[:, 0] += 255 - q.sum(1)  # exact sum of 255
skin_index = order.astype(np.uint8)
skin_weight = np.clip(q, 0, 255).astype(np.uint8)

assert len(P) < 65536

# ---------------- cavity map: darken the grooves between muscles ----------------
n_v = len(P)
fn = np.cross(P[tris[:, 1]] - P[tris[:, 0]], P[tris[:, 2]] - P[tris[:, 0]])  # area-weighted face normals
N = np.zeros_like(P)
for k in range(3):
    np.add.at(N, tris[:, k], fn)
N /= np.linalg.norm(N, axis=1, keepdims=True) + 1e-12
edges = np.concatenate([tris[:, [0, 1]], tris[:, [1, 2]], tris[:, [2, 0]]])
edges = np.unique(np.sort(edges, axis=1), axis=0)
nsum = np.zeros_like(P)
cnt = np.zeros(n_v)
elen = np.zeros(n_v)
for a, b in ((0, 1), (1, 0)):
    np.add.at(nsum, edges[:, a], P[edges[:, b]])
    np.add.at(cnt, edges[:, a], 1)
    np.add.at(elen, edges[:, a], np.linalg.norm(P[edges[:, 0]] - P[edges[:, 1]], axis=1))
lap = nsum / cnt[:, None] - P
curv = (lap * N).sum(1) / (elen / cnt + 1e-9)  # > 0 in grooves, < 0 on ridges
for _ in range(2):  # soften
    s = np.zeros(n_v)
    np.add.at(s, edges[:, 0], curv[edges[:, 1]])
    np.add.at(s, edges[:, 1], curv[edges[:, 0]])
    curv = 0.5 * curv + 0.5 * s / cnt
cavity = 1 - 0.55 * np.clip(curv / (np.percentile(curv, 97) + 1e-9), 0, 1)
cavity = np.round(cavity * 255).astype(np.uint8)

b64 = lambda a: base64.b64encode(a.tobytes()).decode()
joints = {k: [round(float(x) * SCALE, 5) for x in v] for k, v in J.items()}
out = (
    '// Generated by tools/build_human.py from MakeHuman CC0 data. Do not edit by hand.\n'
    f'export const HUMAN = {json.dumps({"bones": OUR, "joints": joints, "vertexCount": int(len(P)), "triangleCount": int(len(tris))})};\n'
    f'export const HUMAN_POSITIONS = "{b64(P.astype(np.float32))}";\n'
    f'export const HUMAN_INDEX = "{b64(tris.astype(np.uint16).ravel())}";\n'
    f'export const HUMAN_SKIN_INDEX = "{b64(skin_index.ravel())}";\n'
    f'export const HUMAN_SKIN_WEIGHT = "{b64(skin_weight.ravel())}";\n'
    f'export const HUMAN_CAVITY = "{b64(cavity)}";\n'
)
open(OUT, 'w').write(out)
print(f'vertices {len(P)}, triangles {len(tris)}, height {P[:, 1].max() - P[:, 1].min():.3f} m, file {len(out) / 1024:.0f} KB')
