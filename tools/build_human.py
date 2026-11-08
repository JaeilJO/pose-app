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
V_BASE = np.array(verts)
TARGETS = {}


def target(path):
    if path not in TARGETS:
        rows = [l.split() for l in open(f'{MH}/targets/{path}') if l.strip() and not l.startswith('#')]
        TARGETS[path] = np.atleast_2d(np.array(rows, dtype=float)) if rows else None
    return TARGETS[path]


def split(v):
    """Slider value -> {min/average/max: weight} like MakeHuman's macro modifiers."""
    if v >= 0.5:
        return {'average': (1 - v) * 2, 'max': (v - 0.5) * 2}
    return {'min': (0.5 - v) * 2, 'average': v * 2}


def shape(gender, muscle, weight, height, proportions, detail, base_muscle):
    """Base mesh + MakeHuman macro targets (+ extra muscle detail scaled with the muscle slider)."""
    V = V_BASE.copy()

    def apply(path, w):
        t = target(path)
        if w > 1e-6 and t is not None:
            V[t[:, 0].astype(int)] += w * t[:, 1:4]

    genders = {'male': gender, 'female': 1 - gender}
    for g, gw in genders.items():
        for m, mw in split(muscle).items():
            for wt, ww in split(weight).items():
                w = gw * mw * ww
                apply(f'macrodetails/universal-{g}-young-{m}muscle-{wt}weight.target', w)
                apply(f'macrodetails/proportions/{g}-young-{m}muscle-{wt}weight-idealproportions.target', w * proportions)
                for h, hw_ in split(height).items():
                    if h != 'average':
                        apply(f'macrodetails/height/{g}-young-{m}muscle-{wt}weight-{h}height.target', w * hw_)
        for race, rw in RACES.items():
            apply(f'macrodetails/{race}-{g}-young.target', gw * rw)
    k = np.clip(muscle / base_muscle, 0, 1.6)
    for path, w in detail.items():
        apply(path, w * k)
    return V


BASE = dict(gender=GENDER, muscle=MUSCLE, weight=WEIGHT, height=0.5, proportions=PROPORTIONS)
V = shape(**BASE, detail=DETAIL, base_muscle=MUSCLE)

# ---------------- joints ----------------
skel = json.load(open(f'{MH}/rigs/default.mhskel'))


def joints_of(V):
    joint = lambda name: V[skel['joints'][name]].mean(0)
    head_of = lambda bone: joint(skel['bones'][bone]['head'])
    J = {
        'hips': head_of('spine05'), 'spine': head_of('spine03'), 'chest': head_of('spine01'),
        'neck': head_of('neck01'), 'head': head_of('head'),
    }
    for side in ('L', 'R'):
        J[f'shoulder.{side}'] = head_of(f'upperarm01.{side}')
        J[f'elbow.{side}'] = head_of(f'lowerarm01.{side}')
        J[f'wrist.{side}'] = head_of(f'wrist.{side}')
        J[f'hip.{side}'] = head_of(f'upperleg01.{side}')
        J[f'knee.{side}'] = head_of(f'lowerleg01.{side}')
        J[f'ankle.{side}'] = head_of(f'foot.{side}')
    return {k: v * SCALE for k, v in J.items()}


J = joints_of(V)

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


def vertex_normals(P, tris):
    fn = np.cross(P[tris[:, 1]] - P[tris[:, 0]], P[tris[:, 2]] - P[tris[:, 0]])
    N = np.zeros_like(P)
    for k in range(3):
        np.add.at(N, tris[:, k], fn)
    return N / (np.linalg.norm(N, axis=1, keepdims=True) + 1e-12)


def ray_hits(O, D, P, T, maxd=0.06, eps=1e-4):
    """For each ray O + tD (eps < t < maxd): does it hit any triangle of T? (Moller-Trumbore)"""
    A, B, C = P[T[:, 0]], P[T[:, 1]], P[T[:, 2]]
    e1, e2 = B - A, C - A
    hit = np.zeros(len(O), bool)
    for i in range(0, len(O), 64):
        o, d = O[i:i + 64, None], D[i:i + 64, None]
        pv = np.cross(d, e2[None])
        det = (e1[None] * pv).sum(-1)
        inv = 1 / np.where(np.abs(det) < 1e-12, 1e-12, det)
        tv = o - A[None]
        u = (tv * pv).sum(-1) * inv
        qv = np.cross(tv, e1[None])
        v = (d * qv).sum(-1) * inv
        t = (e2[None] * qv).sum(-1) * inv
        hit[i:i + 64] = ((u >= 0) & (v >= 0) & (u + v <= 1) & (t > eps) & (t < maxd)).any(1)
    return hit


FEATURE_BONES = ('eye', 'levator', 'oculi', 'orbicularis', 'oris', 'risorius', 'special', 'tongue')


def make_faceless(P, tris, Wu, topo=None):
    """Mannequin face on the real MakeHuman head: skull, jaw, cheekbones and ears stay; the eye
    sockets and mouth cavity are removed and capped, then the face is faired (bilaplacian) and a
    heavily smoothed copy of the original features is added back, leaving soft brow, nose and lips."""
    n = len(P)
    if topo is None:
        feat = np.zeros(n)
        for bone, pairs in json.load(open(f'{MH}/rigs/default_weights.mhw'))['weights'].items():
            if bone.startswith(FEATURE_BONES):
                for vi, w in pairs:
                    if REMAP_ALL[vi] >= 0:
                        feat[REMAP_ALL[vi]] += w
        cand = np.where(feat > 0.02)[0]
        N = vertex_normals(P, tris)
        c0 = P[cand].mean(0)
        near = tris[np.abs(P[tris].mean(1) - c0).max(1) < 0.2]
        interior = np.zeros(n, bool)
        interior[cand[ray_hits(P[cand] + N[cand] * 2e-4, N[cand], P, near)]] = True  # inside eye sockets / mouth
        kept = largest_component(tris[~interior[tris].any(1)], n)
        loops = boundary_loops(kept)
        fill = []
        for k, L in enumerate(loops):
            for j in range(len(L)):
                fill.append((L[(j + 1) % len(L)], L[j], n + k))
        T2 = np.vstack([kept, np.array(fill)])
        n2 = n + len(loops)
        used = np.unique(T2)
        # face region: an ellipse spanning brow to lower lip, sized from the eye and mouth openings
        cen = np.array([P[L].mean(0) for L in loops])
        eyes = [k for k in range(len(loops)) if abs(cen[k, 0]) > 0.02 and cen[k, 2] > 0.1]
        mouth = max((k for k in range(len(loops)) if abs(cen[k, 0]) < 0.005), key=lambda k: len(loops[k]))
        ye, ym = cen[eyes, 1].mean(), cen[mouth, 1]
        xe = np.abs(cen[eyes, 0]).mean()
        cy, ry, rx, zmin = (ye + ym) / 2 + 0.13 * (ye - ym), 1.03 * (ye - ym), 2.06 * xe, cen[mouth, 2] - 0.065
        P2 = np.vstack([P, cen])
        hw = np.r_[Wu[:, IDX['head']] / Wu.sum(1), np.ones(len(loops))]
        e = (P2[:, 0] / rx) ** 2 + ((P2[:, 1] - cy) / ry) ** 2
        region = (e < 1) & (P2[:, 2] > zmin) & (hw > 0.5)
        region[n:] = True
        region &= np.isin(np.arange(n2), used)
        E = np.unique(np.sort(np.concatenate([T2[:, [0, 1]], T2[:, [1, 2]], T2[:, [2, 0]]]), 1), axis=0)
        A = sp.coo_matrix((np.ones(2 * len(E)), (np.r_[E[:, 0], E[:, 1]], np.r_[E[:, 1], E[:, 0]])), shape=(n2, n2)).tocsr()
        deg = np.maximum(np.asarray(A.sum(1)).ravel(), 1)
        Lu = sp.diags(1 / deg) @ (sp.diags(deg) - A)
        M = (Lu @ Lu).tocsr()
        free, fixed = np.where(region)[0], np.where(~region)[0]
        w = np.clip((1 - e) / 0.3, 0, 1)
        w = w * w * (3 - 2 * w) * region
        w[n:] = 1
        band = (w > 0.01) & (w < 0.99)
        band |= (A @ band.astype(float) > 0)
        remap = -np.ones(n2, dtype=np.int64)
        remap[used] = np.arange(len(used))
        topo = dict(loops=loops, T2=T2, A=A, deg=deg, free=free, fixed=fixed, Mfc=M[free][:, fixed],
                    solve=spla.factorized(M[free][:, free].tocsc()), region=region, w=w, band=band,
                    used=used, remap=remap)
        print(f'mannequin face: removed {interior.sum()} cavity verts, capped {len(loops)} openings, faired {len(free)} verts')
    t = topo
    P2 = np.vstack([P, [P[L].mean(0) for L in t['loops']]])
    W2 = np.vstack([Wu, [Wu[L].mean(0) for L in t['loops']]])
    F = P2.copy()
    for c in range(3):
        F[t['free'], c] = t['solve'](-t['Mfc'] @ P2[t['fixed'], c])
    D = P2 - F
    D[~t['region']] = 0
    for _ in range(20):  # keep only the broad forms of the original features
        D = (t['A'] @ D) / t['deg'][:, None] * t['region'][:, None]
    P2 = P2 + t['w'][:, None] * (F + D - P2)
    for _ in range(3):  # melt the seam where the faired patch meets the head
        avg = (t['A'] @ P2) / t['deg'][:, None]
        P2[t['band']] += 0.5 * (avg[t['band']] - P2[t['band']])
    used, remap = t['used'], t['remap']
    return P2[used], remap[t['T2']], W2[used], topo


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
REMAP_ALL = remap
P = V[used] * SCALE
Wu = W[used]
Wu[Wu.sum(1) < 1e-6, IDX['head']] = 1  # unweighted helper verts (eyeballs) ride the head
tris_c, used_c, Wu_c = tris, used, Wu.copy()

P, tris, Wu, TOPO = make_faceless(P, tris_c, Wu_c)

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


# ---------------- ambient occlusion: armpits, under the chin, between fingers and legs ----------------
def bake_ao(P, tris, N, rays=96, reach=0.22, seed=7):
    """Per-vertex AO (1 = open, 0 = enclosed), cosine-weighted rays, nearer hits count more."""
    import trimesh
    mesh = trimesh.Trimesh(P, tris, process=False)
    rng = np.random.default_rng(seed)
    u1, u2 = rng.random(rays), rng.random(rays)
    r, phi = np.sqrt(u1), 2 * np.pi * u2
    local = np.stack([r * np.cos(phi), r * np.sin(phi), np.sqrt(1 - u1)], 1)  # cosine-weighted hemisphere
    ref = np.where(np.abs(N[:, :1]) < 0.9, [[1.0, 0, 0]], [[0, 1.0, 0]])
    tx = np.cross(N, ref); tx /= np.linalg.norm(tx, axis=1, keepdims=True)
    ty = np.cross(N, tx)
    occl = np.zeros(len(P))
    for i in range(0, len(P), 2000):
        sl = slice(i, i + 2000)
        D = (local[None, :, :1] * tx[sl, None] + local[None, :, 1:2] * ty[sl, None] + local[None, :, 2:] * N[sl, None]).reshape(-1, 3)
        O = np.repeat(P[sl] + N[sl] * 1e-4, rays, 0)
        loc, idx, _ = mesh.ray.intersects_location(O, D, multiple_hits=False)
        d = np.linalg.norm(loc - O[idx], axis=1)
        w = np.clip(1 - d / reach, 0, 1) ** 0.7
        hit = np.zeros(len(O)); np.add.at(hit, idx, w)
        occl[sl] = hit.reshape(-1, rays).mean(1)
    return 1 - occl


ao = bake_ao(P, tris, N)
for _ in range(2):  # soften ray noise
    s_ = np.zeros(n_v); np.add.at(s_, edges[:, 0], ao[edges[:, 1]]); np.add.at(s_, edges[:, 1], ao[edges[:, 0]])
    ao = 0.5 * ao + 0.5 * s_ / cnt
shade = cavity * (1 - 0.62 * (1 - ao) ** 1.2)
print(f'ao: mean {ao.mean():.2f}, min {ao.min():.2f}')
cavity = np.round(np.clip(shade, 0, 1) * 255).astype(np.uint8)

b64 = lambda a: base64.b64encode(a.tobytes()).decode()
rnd = lambda d: {k: [round(float(x), 5) for x in v] for k, v in d.items()}

# ---------------- body-shape sliders: offsets at each slider's ends ----------------
SLIDERS = ('height', 'weight', 'muscle')
DELTA_SCALE = 1e-4  # int16 steps of 0.1 mm
shapes = {}
for name in SLIDERS:
    shapes[name] = {}
    for end, key in ((0.0, 'lo'), (1.0, 'hi')):
        if abs(BASE[name] - end) < 1e-6:
            continue
        params = dict(BASE, **{name: end})
        Vs = shape(**params, detail=DETAIL, base_muscle=MUSCLE)
        Ps = make_faceless(Vs[used_c] * SCALE, tris_c, Wu_c, TOPO)[0]
        dP = np.round((Ps - P) / DELTA_SCALE)
        assert np.abs(dP).max() < 32767
        Js = joints_of(Vs)
        shapes[name][key] = {'d': b64(dP.astype(np.int16)), 'j': rnd({k: Js[k] - J[k] for k in J})}
shape_base = {name: BASE[name] for name in SLIDERS}

out = (
    '// Generated by tools/build_human.py from MakeHuman CC0 data. Do not edit by hand.\n'
    'export default {\n'
    f'  name: "{PRESET}",\n'
    f'  bones: {json.dumps(OUR)},\n'
    f'  joints: {json.dumps(rnd(J))},\n'
    f'  positions: "{b64(P.astype(np.float32))}",\n'
    f'  index: "{b64(tris.astype(np.uint16).ravel())}",\n'
    f'  skinIndex: "{b64(skin_index.ravel())}",\n'
    f'  skinWeight: "{b64(skin_weight.ravel())}",\n'
    f'  cavity: "{b64(cavity)}",\n'
    f'  shapeBase: {json.dumps(shape_base)},\n'
    f'  deltaScale: {DELTA_SCALE},\n'
    f'  shapes: {json.dumps(shapes)},\n'
    '};\n'
)
open(OUT, 'w').write(out)
print(f'vertices {len(P)}, triangles {len(tris)}, height {P[:, 1].max() - P[:, 1].min():.3f} m, file {len(out) / 1024:.0f} KB')
