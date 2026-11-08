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
PRESET = sys.argv[3] if len(sys.argv) > 3 else 'male'
SCALE = 0.1  # MakeHuman units are decimeters

PRESETS = {
    'male': dict(  # athletic adult male
        gender=1.0, muscle=1.0, weight=0.2, proportions=0.8,
        detail={
            'torso/torso-muscle-pectoral-incr.target': 0.75,
            'torso/torso-muscle-dorsi-incr.target': 0.6,
            'torso/torso-vshape-incr.target': 0.45,
            'armslegs/l-upperarm-muscle-incr.target': 0.75, 'armslegs/r-upperarm-muscle-incr.target': 0.75,
            'armslegs/l-upperarm-shoulder-muscle-incr.target': 0.65, 'armslegs/r-upperarm-shoulder-muscle-incr.target': 0.65,
            'armslegs/l-lowerarm-muscle-incr.target': 0.6, 'armslegs/r-lowerarm-muscle-incr.target': 0.6,
            'armslegs/l-upperleg-muscle-incr.target': 0.75, 'armslegs/r-upperleg-muscle-incr.target': 0.75,
            'armslegs/l-lowerleg-muscle-incr.target': 0.6, 'armslegs/r-lowerleg-muscle-incr.target': 0.6,
        }),
    'female': dict(  # fit adult female
        gender=0.0, muscle=0.72, weight=0.38, proportions=0.8,
        detail={
            'torso/torso-muscle-dorsi-incr.target': 0.2,
            'armslegs/l-upperarm-muscle-incr.target': 0.3, 'armslegs/r-upperarm-muscle-incr.target': 0.3,
            'armslegs/l-upperarm-shoulder-muscle-incr.target': 0.25, 'armslegs/r-upperarm-shoulder-muscle-incr.target': 0.25,
            'armslegs/l-upperleg-muscle-incr.target': 0.35, 'armslegs/r-upperleg-muscle-incr.target': 0.35,
            'armslegs/l-lowerleg-muscle-incr.target': 0.35, 'armslegs/r-lowerleg-muscle-incr.target': 0.35,
        }),
}
cfg = PRESETS[PRESET]
GENDER, MUSCLE, WEIGHT, PROPORTIONS, DETAIL = cfg['gender'], cfg['muscle'], cfg['weight'], cfg['proportions'], cfg['detail']
RACES = {'african': 1 / 3, 'asian': 1 / 3, 'caucasian': 1 / 3}
KEEP_GROUPS = {'body'}
FACELESS = True

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
    if not rows:
        return
    t = np.atleast_2d(np.array(rows, dtype=float))
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

# ---------------- faceless head ----------------
import scipy.sparse as sp
import scipy.sparse.linalg as spla
from collections import defaultdict


def boundary_loops(tris):
    """Closed loops of boundary edges, each oriented as its edges appear in the triangles."""
    count = defaultdict(int)
    for t in tris:
        for k in range(3):
            a, b = t[k], t[(k + 1) % 3]
            count[(min(a, b), max(a, b))] += 1
    nxt = defaultdict(list)
    for t in tris:
        for k in range(3):
            a, b = t[k], t[(k + 1) % 3]
            if count[(min(a, b), max(a, b))] == 1:
                nxt[a].append(b)
    loops, used = [], set()
    for start in list(nxt):
        for first in nxt[start]:
            if (start, first) in used:
                continue
            loop, a, b = [start], start, first
            while True:
                used.add((a, b))
                if b == start:
                    break
                loop.append(b)
                cands = [c for c in nxt[b] if (b, c) not in used]
                if not cands:
                    break
                a, b = b, cands[0]
            loops.append(loop)
    return loops


def largest_component(tris, n):
    parent = np.arange(n)

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    for t in tris:
        r = [find(v) for v in t]
        for x in r[1:]:
            parent[x] = r[0]
    roots = np.array([find(t[0]) for t in tris])
    best = np.bincount(roots).argmax()
    return tris[roots == best]


def make_faceless(P, tris, Wu):
    """Replace the head with a clean mannequin head: cut the mesh at the top of the neck,
    then loft rings from the neck edge into an egg fitted to the original cranium."""
    hw = Wu[:, IDX['head']] / Wu.sum(1)
    H = P[hw > 0.97]
    ymax = H[:, 1].max()
    ychin = np.percentile(H[:, 1], 1)
    cy = (ymax + ychin) / 2
    band = H[(H[:, 1] > cy) & (H[:, 1] < cy + 0.06)]
    cz = (band[:, 2].max() + band[:, 2].min()) / 2
    c = np.array([0.0, cy, cz])
    top, rbot = ymax - cy, cy - ychin
    crown = H[(H[:, 1] > cy + 0.04) & (H[:, 1] < cy + 0.08)]
    rx = np.percentile(np.abs(crown[:, 0]), 99)
    rz = (band[:, 2].max() - band[:, 2].min()) / 2

    def egg(dirs):
        u = dirs / np.linalg.norm(dirs, axis=1, keepdims=True)
        low = np.clip(-u[:, 1], 0, 1)
        ry = np.where(u[:, 1] > 0, top, rbot)
        rzq = np.where(u[:, 2] > 0, rz * (1 + 0.13 * low), rz * (1 - 0.05 * low))  # jaw reaches forward
        rxq = rx * (1 - 0.14 * low)  # jaw narrows a little toward the chin
        t = 1 / np.sqrt((u[:, 0] / rxq) ** 2 + (u[:, 1] / ry) ** 2 + (u[:, 2] / rzq) ** 2)
        return c + u * t[:, None]

    # 1. Cut along a tilted plane: under the jaw in front, at the skull base behind
    #    (only around the head: shoulders and arms stay).
    F = np.array([0.0, ychin - 0.004, cz + rz * 0.55])
    B = np.array([0.0, cy - 0.07, cz - rz * 0.9])
    dyz = B - F
    nrm = np.array([0.0, -dyz[2], dyz[1]])
    if np.dot(c - F, nrm) < 0:
        nrm = -nrm
    near_head = (np.abs(P[:, 0]) < rx * 1.8) & (np.abs(P[:, 2] - cz) < rz * 2.2) & (P[:, 1] > ychin - 0.06)
    cut = near_head & (((P - F) @ nrm > 0) | (hw > 0.85))  # everything above the plane + the old jaw
    kept = tris[~cut[tris].any(1)]
    kept = largest_component(kept, len(P))
    loops = sorted(boundary_loops(kept), key=len, reverse=True)
    neck = np.array(loops[0])
    nc = P[neck].mean(0)

    # 2. Loft: rings flow from the neck edge onto the egg, from jaw/skull base up to the crown.
    K = 20
    theta = np.arctan2(P[neck, 0] - nc[0], P[neck, 2] - nc[2])  # 0 = front
    back = (1 - np.cos(theta)) / 2  # 0 front .. 1 back
    phi0 = np.radians(-62 + 22 * back)  # chin is low, skull base is high
    new_pos, new_w, rings = [], [], [neck]
    n0 = len(P)
    neck_w = Wu[neck] / Wu[neck].sum(1, keepdims=True)
    for k in range(1, K):
        f = k / K
        phi = phi0 + (np.pi / 2 - phi0) * f ** 1.15
        dirs = np.stack([np.sin(theta) * np.cos(phi), np.sin(phi), np.cos(theta) * np.cos(phi)], 1)
        on_egg = egg(dirs)
        b = np.clip(f / 0.16, 0, 1)
        b = b * b * (3 - 2 * b)
        pts = P[neck] * (1 - b) + on_egg * b
        idx = np.arange(len(pts)) + n0 + len(new_pos)
        new_pos.extend(pts)
        wh = np.zeros_like(neck_w)
        wh[:, IDX['head']] = 1
        new_w.extend(neck_w * (1 - b) + wh * b)
        rings.append(idx)
    apex = n0 + len(new_pos)
    new_pos.append(c + np.array([0, top, 0]))
    w_apex = np.zeros(Wu.shape[1]); w_apex[IDX['head']] = 1
    new_w.append(w_apex)

    new_tris = []
    m = len(neck)
    for k in range(K - 1):
        r0, r1 = rings[k], rings[k + 1]
        for j in range(m):
            j1 = (j + 1) % m
            new_tris.append((r0[j1], r0[j], r1[j]))
            new_tris.append((r0[j1], r1[j], r1[j1]))
    rl = rings[-1]
    for j in range(m):
        new_tris.append((rl[(j + 1) % m], rl[j], apex))

    P = np.vstack([P, np.array(new_pos)])
    Wu = np.vstack([Wu, np.array(new_w)])
    tris = np.vstack([kept, np.array(new_tris)])

    # 3. Smooth the neck-to-head transition (first rings only).
    n = len(P)
    e = np.concatenate([tris[:, [0, 1]], tris[:, [1, 2]], tris[:, [2, 0]]])
    e = np.unique(np.sort(e, axis=1), axis=0)
    A = sp.coo_matrix((np.ones(len(e) * 2), (np.r_[e[:, 0], e[:, 1]], np.r_[e[:, 1], e[:, 0]])), shape=(n, n)).tocsr()
    deg = np.asarray(A.sum(1)).ravel()
    # Include the neck edge and two rows of the original neck below it.
    soft_mask = np.zeros(n, dtype=bool)
    soft_mask[np.concatenate([r for r in rings[0:3]])] = True
    original = np.arange(n) < n0
    for _ in range(1):  # grow downward into the old neck only
        soft_mask |= (np.asarray(A[:, np.flatnonzero(soft_mask)].sum(1)).ravel() > 0) & original
    soft = np.flatnonzero(soft_mask)
    for _ in range(4):
        avg = (A @ P) / np.maximum(deg, 1)[:, None]
        P[soft] = P[soft] * 0.5 + avg[soft] * 0.5

    used = np.unique(tris)
    remap = -np.ones(n, dtype=np.int64)
    remap[used] = np.arange(len(used))
    print(f'faceless: neck loop {m} verts, new head {len(new_pos)} verts, open loops left: {len(boundary_loops(tris))}')
    return P[used], remap[tris], Wu[used]


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

if FACELESS:
    P, tris, Wu = make_faceless(P, tris, Wu)

# top-4 influences, quantized to bytes
order = np.argsort(-Wu, axis=1)[:, :4]
top = np.take_along_axis(Wu, order, axis=1)
top /= top.sum(1, keepdims=True)
q = np.round(top * 255).astype(np.int64)
q[:, 0] += 255 - q.sum(1)  # exact sum of 255
skin_index = order.astype(np.uint8)
skin_weight = np.clip(q, 0, 255).astype(np.uint8)

assert len(P) < 65536


# ---------------- faceless head: pull face and ears onto a smooth egg ----------------
def vertex_normals(P, tris):
    fn = np.cross(P[tris[:, 1]] - P[tris[:, 0]], P[tris[:, 2]] - P[tris[:, 0]])
    N = np.zeros_like(P)
    for k in range(3):
        np.add.at(N, tris[:, k], fn)
    return N / (np.linalg.norm(N, axis=1, keepdims=True) + 1e-12)


def edge_list(tris):
    e = np.concatenate([tris[:, [0, 1]], tris[:, [1, 2]], tris[:, [2, 0]]])
    return np.unique(np.sort(e, axis=1), axis=0)


def smooth_positions(P, edges, weight, iterations, lam=0.5):
    """Laplacian smoothing; `weight` (0..1 per vertex) says how much each vertex may move."""
    n = len(P)
    cnt = np.zeros(n)
    np.add.at(cnt, edges[:, 0], 1)
    np.add.at(cnt, edges[:, 1], 1)
    for _ in range(iterations):
        s = np.zeros_like(P)
        np.add.at(s, edges[:, 0], P[edges[:, 1]])
        np.add.at(s, edges[:, 1], P[edges[:, 0]])
        avg = s / np.maximum(cnt, 1)[:, None]
        P = P + (lam * weight)[:, None] * (avg - P)
    return P


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
for _ in range(4):  # soften
    s = np.zeros(n_v)
    np.add.at(s, edges[:, 0], curv[edges[:, 1]])
    np.add.at(s, edges[:, 1], curv[edges[:, 0]])
    curv = 0.5 * curv + 0.5 * s / cnt
cavity = 1 - 0.38 * np.clip(curv / (np.percentile(curv, 97) + 1e-9), 0, 1)
cavity = np.round(cavity * 255).astype(np.uint8)

b64 = lambda a: base64.b64encode(a.tobytes()).decode()
joints = {k: [round(float(x) * SCALE, 5) for x in v] for k, v in J.items()}
out = (
    '// Generated by tools/build_human.py from MakeHuman CC0 data. Do not edit by hand.\n'
    'export default {\n'
    f'  name: "{PRESET}",\n'
    f'  bones: {json.dumps(OUR)},\n'
    f'  joints: {json.dumps(joints)},\n'
    f'  positions: "{b64(P.astype(np.float32))}",\n'
    f'  index: "{b64(tris.astype(np.uint16).ravel())}",\n'
    f'  skinIndex: "{b64(skin_index.ravel())}",\n'
    f'  skinWeight: "{b64(skin_weight.ravel())}",\n'
    f'  cavity: "{b64(cavity)}",\n'
    '};\n'
)
open(OUT, 'w').write(out)
print(f'vertices {len(P)}, triangles {len(tris)}, height {P[:, 1].max() - P[:, 1].min():.3f} m, file {len(out) / 1024:.0f} KB')
