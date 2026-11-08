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
import os
import sys

import numpy as np

MH, OUT = sys.argv[1], sys.argv[2]
PRESET = sys.argv[3] if len(sys.argv) > 3 else 'male'
SCULPT = sys.argv[4] if len(sys.argv) > 4 else None  # Blender Studio Human Base Meshes export (npz: co, tris)
SCALE = 0.1  # MakeHuman units are decimeters

PRESETS = {
    'male': dict(  # athletic adult male
        gender=1.0, muscle=1.0, weight=0.2, proportions=0.8, muscle_u=0.6, define=0.0,
        extra={'stomach/stomach-tone-incr.target': 0.6},
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
        gender=0.0, muscle=0.72, weight=0.38, proportions=0.8, muscle_u=0.45, define=0.0,
        extra={'stomach/stomach-tone-incr.target': 0.25},
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


def shape(gender, muscle, weight, height, proportions, detail_k=1.0, extra=None, cup=0.0, **_):
    """Base mesh + MakeHuman macro targets + the preset's muscle detail (scaled by detail_k)
    + extra targets {path: weight}; cup in [-1, 1] blends female breast size."""
    V = V_BASE.copy()

    def apply(path, w):
        t = target(path)
        if abs(w) > 1e-6 and t is not None:
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
                if g == 'female' and abs(cup) > 1e-6:
                    apply(f'breast/female-young-{m}muscle-{wt}weight-{"max" if cup > 0 else "min"}cup-averagefirmness.target', w * abs(cup))
        for race, rw in RACES.items():
            apply(f'macrodetails/{race}-{g}-young.target', gw * rw)
    for path, w in DETAIL.items():
        apply(path, w * detail_k)
    for path, w in (extra or {}).items():
        apply(path, w)
    return V + FIT


FIT = 0.0  # sculpt offset (MakeHuman units), set by the sculpt fit below
BASE = dict(gender=GENDER, muscle=MUSCLE, weight=WEIGHT, height=0.5, proportions=PROPORTIONS, detail_k=1.0,
            extra=dict(cfg.get('extra', {})), cup=0.0, define=cfg['define'])
V = shape(**BASE)

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

# ---------------- shape and surface detail from a sculpt (Blender Studio Human Base Meshes, CC0) ----------------
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sculpt_fit import Sculpt, pose_align, nonrigid_fit, to_rest  # noqa: E402
import scipy.sparse as sp  # noqa: E402
import scipy.sparse.linalg as spla  # noqa: E402
POSE = SC = None
if SCULPT:
    _bt = np.array([(f[0], f[k], f[k + 1]) for g, f in faces if g == 'body' for k in range(1, len(f) - 1)])
    _used = np.unique(_bt)
    _rm = -np.ones(len(V), dtype=np.int64)
    _rm[_used] = np.arange(len(_used))
    _T, _X = _rm[_bt], V[_used] * SCALE
    _W = W[_used] / np.maximum(W[_used].sum(1, keepdims=True), 1e-9)
    _W[_W.sum(1) < 1e-6, IDX['head']] = 1
    _z = np.load(SCULPT)
    _co = _z['co'].astype(float)
    SP = np.stack([_co[:, 0], _co[:, 2], -_co[:, 1]], 1)  # Blender Z-up, facing -Y -> Y-up, facing +Z
    SP[:, 0] -= SP[:, 0].mean()
    SP *= (_X[:, 1].max() - _X[:, 1].min()) / (SP[:, 1].max() - SP[:, 1].min())  # same height as our body
    SP[:, 1] += _X[:, 1].min() - SP[:, 1].min()
    _band = lambda Q: Q[(Q[:, 1] > J['chest'][1] - 0.15) & (Q[:, 1] < J['chest'][1]) & (np.abs(Q[:, 0]) < 0.1)]
    SP[:, 2] += _band(_X).mean(0)[2] - _band(SP).mean(0)[2]
    # the sculpt is anatomical at the groin: fair that patch first, so everything taken from it is mannequin-smooth
    ST = _z['tris'].astype(np.int64)
    _gy = (J['hip.L'][1] + J['hip.R'][1]) / 2 - float(os.environ.get('GOFF', 0.07))
    _gz = J['hips'][2] + float(os.environ.get('GZ', 0.04))
    _e = (SP[:, 0] / float(os.environ.get('GX', 0.075))) ** 2 + ((SP[:, 1] - _gy) / float(os.environ.get('GY', 0.09))) ** 2 + ((SP[:, 2] - _gz) / 0.1) ** 2
    _free, _fixed = np.where(_e < 1)[0], np.where(_e >= 1)[0]
    _Lg = __import__('sculpt_fit').laplacian(ST, len(SP))
    _Lg = (sp.diags(1 / np.maximum(_Lg.diagonal(), 1)) @ _Lg).tocsr()
    _Lf = _Lg[_free]
    _M = (_Lf.T @ _Lf).tocsr()  # least-squares bilaplacian on the patch
    _solve = spla.factorized(_M[_free][:, _free].tocsc())
    for _c in range(3):
        SP[_free, _c] = _solve(-(_M[_free][:, _fixed] @ SP[_fixed, _c]))
    print(f'  sculpt groin faired: {len(_free)} verts')
    SC = Sculpt(SP, ST)
    print('sculpt fit:')
    POSE = pose_align(_X, _T, _W, J, OUR, SC, iterations=8)
    _Xp = POSE.apply(_X, _W)
    _hand = _W[:, IDX['hand.L']] + _W[:, IDX['hand.R']]
    _fit_w = np.clip(1 - _W[:, IDX['head']] - 0.5 * _W[:, IDX['neck']] - _hand, 0, 1)
    _D = nonrigid_fit(_Xp, _T, SC, _fit_w, 5.0 * np.clip(_W[:, IDX['head']] + _hand, 0, 1))
    _Xf = _X + to_rest(_D, POSE, _W)
    FIT = np.zeros_like(V_BASE)
    FIT[_used] = (_Xf - _X) / SCALE
    V = shape(**BASE)
    J = joints_of(V)

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


import os
FACE = dict(nose_its=2, nose_gain=1.2, nose_r=0.013, eye_its=200, mouth_its=8, coarse_its=20, sock_depth=0.007, sock_up=0.006,
            bulge=0.004, eye_relax=60, dscale=1.0, tangent_its=20, eye_gain=1.0, eye_zero=0.0, rx=2.06,
            patch_rx=0.026, patch_ry=0.017, ball_rx=0.014, ball_ry=0.009, ball_dn=0.0, patch_grow=1)
FACE.update({k: type(FACE[k])(v) for k, v in (a.split('=') for a in os.environ.get('FACE', '').split(',') if a)})
FEATURE_BONES = ('eye', 'levator', 'oculi', 'orbicularis', 'oris', 'risorius', 'special', 'tongue')


def loop_point(P, L, u):
    """Point at arc-length fraction u (0..1) along closed loop L."""
    Q = P[L]
    seg = np.linalg.norm(np.roll(Q, -1, 0) - Q, axis=1)
    cum = np.r_[0, np.cumsum(seg)] / seg.sum()
    j = min(np.searchsorted(cum, u, side='right') - 1, len(L) - 1)
    t = (u - cum[j]) / max(cum[j + 1] - cum[j], 1e-12)
    return Q[j] * (1 - t) + Q[(j + 1) % len(L)] * t


def loop_params(P, L):
    Q = P[L]
    seg = np.linalg.norm(np.roll(Q, -1, 0) - Q, axis=1)
    return np.r_[0, np.cumsum(seg)[:-1]] / seg.sum()


def cap_all(P, loops, caps, loops2, caps2):
    P2 = np.vstack([P, cap_points(P, loops, caps)])
    return np.vstack([P2, cap_points(P2, loops2, caps2)]) if caps2 else P2


def ring_caps(P, loops, base):
    """Cap each loop with rings that shrink in vertex count toward the centre, so no cap vertex has
    a high valence (those show up as star-shaped pinches once subdivided). New vertices start at `base`.
    Returns (triangles, caps) with caps = [(loop, arc-length param or -1 for the centre, pull toward centre)]."""
    fill, caps = [], []
    for li, L in enumerate(loops):
        sizes = []
        k = len(L)
        while k > 6:
            k = max(6, int(round(k * 0.62)))
            sizes.append(k)
        R = len(sizes)
        prev, pu = list(L), list(loop_params(P, L))
        for r, size in enumerate(sizes, 1):
            cur = list(range(base + len(caps), base + len(caps) + size))
            cu = [j / size for j in range(size)]
            caps += [(li, u, r / (R + 1)) for u in cu]
            i = j = 0
            a_, b_ = len(prev), size
            while i < a_ or j < b_:
                nu_p = pu[i + 1] if i + 1 < a_ else 1.0
                nu_c = cu[j + 1] if j + 1 < b_ else 1.0
                if j >= b_ or (i < a_ and nu_p <= nu_c):
                    fill.append((prev[(i + 1) % a_], prev[i % a_], cur[j % b_]))
                    i += 1
                else:
                    fill.append((prev[i % a_], cur[j % b_], cur[(j + 1) % b_]))
                    j += 1
            prev, pu = cur, cu
        ci = base + len(caps)
        caps.append((li, -1, 1.0))
        for j in range(len(prev)):
            fill.append((prev[(j + 1) % len(prev)], prev[j], ci))
    return fill, caps


def cap_points(P, loops, caps):
    """Cap vertices: rings of points along each loop (by arc length), pulled toward its centre."""
    out = [np.zeros((0, 3))]
    for li, u, f in caps:
        c = P[loops[li]].mean(0)
        out.append((c if u < 0 else loop_point(P, loops[li], u) * (1 - f) + c * f)[None])
    return np.vstack(out)


def make_faceless(P, tris, Wu, topo=None):
    """See _faceless. On the first (topology-building) call, triangles that end up folded over
    (lid corners tucked into the socket) are removed with the cavity and the face is rebuilt."""
    if topo is not None:
        return _faceless(P, tris, Wu, topo)
    interior = None
    for _ in range(int(os.environ.get('FOLD_PASSES', '1'))):
        Pf, Tf, Wf, topo = _faceless(P, tris, Wu, None, interior)
        fn = np.cross(Pf[Tf[:, 1]] - Pf[Tf[:, 0]], Pf[Tf[:, 2]] - Pf[Tf[:, 0]])
        flip = (fn * vertex_normals(Pf, Tf)[Tf].mean(1)).sum(1) < 0
        bad = topo['used'][np.unique(Tf[flip])]
        bad = bad[bad < len(P)]
        if not len(bad):
            break
        interior = topo['interior'].copy()
        interior[bad] = True
        print(f'  folded verts removed: {len(bad)}')
    return Pf, Tf, Wf, topo


def _faceless(P, tris, Wu, topo=None, interior=None):
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
        if interior is None:
            interior = np.zeros(n, bool)
            interior[cand[ray_hits(P[cand] + N[cand] * 2e-4, N[cand], P, near)]] = True  # inside eye sockets / mouth
        kept = largest_component(tris[~interior[tris].any(1)], n)
        # where the upper and lower lids (and lips) meet, MakeHuman has vertices on top of each other;
        # weld them, or the corners pinch once the face is smoothed and subdivided
        from scipy.spatial import cKDTree as _KD
        _fv = np.unique(kept[(feat[kept] > 0.02).any(1)])
        weld = np.arange(n)
        for a_, b_ in sorted(_KD(P[_fv]).query_pairs(float(os.environ.get('WELD', 6e-4)))):
            ra, rb = weld[_fv[a_]], weld[_fv[b_]]
            while weld[ra] != ra: ra = weld[ra]
            while weld[rb] != rb: rb = weld[rb]
            if ra != rb:
                weld[max(ra, rb)] = min(ra, rb)
        for i_ in range(n):
            r_ = i_
            while weld[r_] != r_: r_ = weld[r_]
            weld[i_] = r_
        kept = weld[kept]
        kept = kept[(kept[:, 0] != kept[:, 1]) & (kept[:, 1] != kept[:, 2]) & (kept[:, 0] != kept[:, 2])]
        _ks = np.sort(kept, 1)
        _, _first = np.unique(_ks, axis=0, return_index=True)
        kept = kept[np.sort(_first)]
        print(f'  welded {(weld != np.arange(n)).sum()} lid/lip corner verts')
        loops = boundary_loops(kept)
        fill, caps = ring_caps(P, loops, n)
        T2 = np.vstack([kept, np.array(fill)])
        n2 = n + len(caps)
        used = np.unique(T2)
        # face region: an ellipse spanning brow to lower lip, sized from the eye and mouth openings
        cen = np.array([P[L].mean(0) for L in loops])
        side = lambda sg: [k for k in range(len(loops)) if sg * cen[k, 0] > 0.02 and cen[k, 2] > 0.1]
        eyes = [max(side(sg), key=lambda k: len(loops[k])) for sg in (1, -1)]  # the big opening on each side
        mouth = max((k for k in range(len(loops)) if abs(cen[k, 0]) < 0.005), key=lambda k: len(loops[k]))
        ye, ym = cen[eyes, 1].mean(), cen[mouth, 1]
        xe = np.abs(cen[eyes, 0]).mean()
        cy, ry, rx, zmin = (ye + ym) / 2 + 0.13 * (ye - ym), 1.03 * (ye - ym), FACE['rx'] * xe, cen[mouth, 2] - 0.065
        loops2, caps2 = [], []
        if FACE['patch_rx'] > 0:
            # eyes: cut out an elliptical patch around each (lids and all) and close it with a clean, even cap
            P2 = np.vstack([P, cap_points(P, loops, caps)])
            inside = np.zeros(n2, bool)
            sc_ = min(1.0, 0.78 * xe / FACE['patch_rx'])  # smaller heads: keep the two patches apart
            for k in eyes:
                inside |= ((((P2[:, 0] - cen[k, 0]) / (sc_ * FACE['patch_rx'])) ** 2 + ((P2[:, 1] - cen[k, 1]) / (sc_ * FACE['patch_ry'])) ** 2) < 1) & (P2[:, 2] > cen[k, 2] - 0.03)
            print(f'  eye patches: {inside.sum()} verts replaced (scale {sc_:.2f})')
            T2 = T2[~inside[T2].any(1)]
            loops2 = boundary_loops(T2)
            assert len(loops2) == 2, f'eye patches: expected 2 holes, got {len(loops2)}'
            fill2, caps2 = ring_caps(P2, loops2, n2)
            T2 = np.vstack([T2, np.array(fill2)])
            n2 += len(caps2)
            used = np.unique(T2)
        P2 = cap_all(P, loops, caps, loops2, caps2)
        hw = np.r_[Wu[:, IDX['head']] / Wu.sum(1), np.ones(n2 - n)]
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
        # where to keep more of the real face: nose (raised), closed eyelids, soft lips; sockets under the brow
        nostrils = [k for k in range(len(loops)) if 0.004 < abs(cen[k, 0]) < 0.02 and cen[k, 2] > 0.1 and cen[k, 1] < ye - 0.02]
        yn = cen[nostrils, 1].mean() if nostrils else ym + 0.3 * (ye - ym)
        x, y = P2[:, 0], P2[:, 1]
        t_ = np.clip((ye - 0.004 - y) / (ye - 0.004 - (yn + 0.004)), 0, 1)
        d_nose = np.hypot(x, y - (ye - 0.004 + t_ * ((yn + 0.004) - (ye - 0.004))))
        m_nose = np.exp(-(d_nose / FACE['nose_r']) ** 2) * (y > yn - 0.012) * (y < ye + 0.006)
        m_eye = np.max([np.exp(-(((x - cen[k, 0]) / 0.021) ** 2 + ((y - cen[k, 1]) / 0.012) ** 2)) for k in eyes], axis=0)
        m_mouth = np.exp(-((x / 0.028) ** 2 + ((y - ym) / 0.013) ** 2))
        m_sock = np.max([np.exp(-(((x - cen[k, 0]) / 0.017) ** 2 + ((y - cen[k, 1] - FACE['sock_up']) / 0.0105) ** 2)) for k in eyes], axis=0)
        m_nose = m_nose * (1 - m_eye) ** 2  # keep the eye corners out of the nose detail
        m_ball = np.max([np.exp(-(((x - cen[k, 0]) / 0.012) ** 2 + ((y - cen[k, 1]) / 0.010) ** 2)) for k in eyes], axis=0)
        masks = {k: v * region for k, v in dict(nose=m_nose, eye=m_eye, mouth=m_mouth, sock=m_sock, ball=m_ball).items()}
        # eye patches: rebuilt smooth (no lid geometry at all), then a closed-eye mound is added
        m_patch = np.zeros(n2, bool)
        m_patch[n2 - len(caps2):] = True
        for _ in range(FACE['patch_grow']):
            m_patch |= (A @ m_patch.astype(float) > 0) & region
        e_free, e_fixed = np.where(m_patch)[0], np.where(~m_patch)[0]
        masks['ball'] = np.max([np.exp(-(((x - cen[k, 0]) / FACE['ball_rx']) ** 2 + ((y - cen[k, 1] + FACE['ball_dn']) / FACE['ball_ry']) ** 2)) for k in eyes], axis=0) * region
        topo = dict(loops=loops, T2=T2, A=A, deg=deg, free=free, fixed=fixed, Mfc=M[free][:, fixed],
                    solve=spla.factorized(M[free][:, free].tocsc()), region=region, w=w, band=band,
                    used=used, remap=remap, masks=masks, caps=caps, interior=interior, loops2=loops2, caps2=caps2,
                    e_free=e_free, e_fixed=e_fixed, e_Mfc=M[e_free][:, e_fixed], e_solve=spla.factorized(M[e_free][:, e_free].tocsc()),
                    e_Lfc=Lu[e_free][:, e_fixed], e_lsolve=spla.factorized(Lu[e_free][:, e_free].tocsc()))
        print(f'mannequin face: removed {interior.sum()} cavity verts, capped {len(loops)} openings, faired {len(free)} verts')
    t = topo
    P2 = cap_all(P, t['loops'], t['caps'], t['loops2'], t['caps2'])
    W2 = np.vstack([Wu] + [Wu[t['loops'][li]].mean(0)[None] for li, _, _ in t['caps']])
    W2 = np.vstack([W2] + [W2[t['loops2'][li]].mean(0)[None] for li, _, _ in t['caps2']])
    F = P2.copy()
    for c in range(3):
        F[t['free'], c] = t['solve'](-t['Mfc'] @ P2[t['fixed'], c])
    D0 = P2 - F
    D0[~t['region']] = 0
    if FACE['eye_zero'] > 0:  # drop the lids entirely; the eye area is rebuilt from the faired surface + a socket
        D0[t['masks']['eye'] > FACE['eye_zero']] = 0

    def soften(D, its):
        for _ in range(its):
            D = (t['A'] @ D) / t['deg'][:, None] * t['region'][:, None]
        return D
    mk = t['masks']
    D = soften(D0, FACE['coarse_its'])  # broad forms everywhere
    for name, its, gain in (('mouth', FACE['mouth_its'], 1.0), ('eye', FACE['eye_its'], FACE['eye_gain']), ('nose', FACE['nose_its'], FACE['nose_gain'])):
        D = D + mk[name][:, None] * (gain * soften(D0, its) - D)
    Q = F + FACE['dscale'] * D
    if FACE['patch_rx'] > 0:  # eyes: drop the lids, fair the patch, add a smooth closed-eye mound
        for c in range(3):
            Q[t['e_free'], c] = t['e_solve'](-t['e_Mfc'] @ Q[t['e_fixed'], c])
        back = np.array([0.0, -0.1, 1.0]) / np.hypot(0.1, 1.0)
        Q -= (FACE['sock_depth'] * mk['sock'] - FACE['bulge'] * mk['ball'])[:, None] * back[None]
    else:
        relax = np.clip(mk['eye'] * 2, 0, 1)[:, None] * 0.5
        for _ in range(FACE['eye_relax']):  # untangle the closed lids
            Q += relax * ((t['A'] @ Q) / t['deg'][:, None] - Q)
        Q -= (FACE['sock_depth'] * mk['sock'] - FACE['bulge'] * mk['ball'])[:, None] * vertex_normals(Q, t['T2'])  # sockets under the brow, round lids
    tw = (t['region'] * 0.5)[:, None]
    for _ in range(FACE['tangent_its']):  # spread vertices the fairing bunched up, without changing the shape
        Nq = vertex_normals(Q, t['T2'])
        lap = (t['A'] @ Q) / t['deg'][:, None] - Q
        Q += tw * (lap - (lap * Nq).sum(1, keepdims=True) * Nq)
    P2 = P2 + t['w'][:, None] * (Q - P2)
    # untangle any folded triangles (closed lids, mouth corners): smooth them and their neighbours until none are left
    for _ in range(60):
        fn = np.cross(P2[t['T2'][:, 1]] - P2[t['T2'][:, 0]], P2[t['T2'][:, 2]] - P2[t['T2'][:, 0]])
        fn /= np.linalg.norm(fn, axis=1, keepdims=True) + 1e-15
        Nv = vertex_normals(P2, t['T2'])
        bad_t = ((fn[:, None, :] * Nv[t['T2']]).sum(2) < 0.2).any(1) & t['region'][t['T2']].all(1)
        if not bad_t.any():
            break
        m_ = np.zeros(len(P2))
        m_[np.unique(t['T2'][bad_t])] = 1
        for _ in range(2):
            m_ = np.maximum(m_, (t['A'] @ m_ > 0).astype(float))
        m_ *= t['region']
        for _ in range(4):
            P2 += 0.5 * m_[:, None] * ((t['A'] @ P2) / t['deg'][:, None] - P2)
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

# ---------------- muscle definition: deepen grooves between muscles, firm up the bulges ----------------
_E = np.unique(np.sort(np.concatenate([tris[:, [0, 1]], tris[:, [1, 2]], tris[:, [2, 0]]]), 1), axis=0)
ADJ = sp.coo_matrix((np.ones(2 * len(_E)), (np.r_[_E[:, 0], _E[:, 1]], np.r_[_E[:, 1], _E[:, 0]])), shape=(len(P), len(P))).tocsr()
ADJ_DEG = np.maximum(np.asarray(ADJ.sum(1)).ravel(), 1)
_skip = Wu[:, [IDX[b] for b in ('head', 'hand.L', 'hand.R', 'foot.L', 'foot.R')]].sum(1) + 0.6 * Wu[:, IDX['neck']]
DEF_MASK = np.clip(1 - _skip / Wu.sum(1), 0, 1)
for _ in range(4):
    DEF_MASK = (ADJ @ DEF_MASK) / ADJ_DEG


def define_mesh(P, amount):
    """Band-pass sharpen along the normals: muscle-sized bumps and grooves get stronger,
    the overall roundness of limbs and torso stays as it is."""
    if amount <= 0:
        return P
    N = vertex_normals(P, tris)
    Ps = P.copy()
    for _ in range(10):
        Ps = 0.5 * Ps + 0.5 * (ADJ @ Ps) / ADJ_DEG[:, None]
    h = ((P - Ps) * N).sum(1)
    hl = h.copy()
    for _ in range(30):
        hl = 0.5 * hl + 0.5 * (ADJ @ hl) / ADJ_DEG
    return P + (amount * DEF_MASK * (h - hl))[:, None] * N


P = define_mesh(P, BASE['define'])
WN = Wu / Wu.sum(1, keepdims=True)
if POSE is not None:  # bind in the sculpt's pose: its arms hang lower, so less skinning collapse at the shoulders
    J_REST = J
    P, J = POSE.apply_joints(P, WN, J_REST)

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


ao = bake_ao(P, tris, N) if not os.environ.get('NO_AO') else np.ones(len(P))
for _ in range(2):  # soften ray noise
    s_ = np.zeros(n_v); np.add.at(s_, edges[:, 0], ao[edges[:, 1]]); np.add.at(s_, edges[:, 1], ao[edges[:, 0]])
    ao = 0.5 * ao + 0.5 * s_ / cnt
print(f'ao: mean {ao.mean():.2f}, min {ao.min():.2f}')
ao8 = np.round(np.clip(ao, 0, 1) * 255).astype(np.uint8)

b64 = lambda a: base64.b64encode(a.tobytes()).decode()

# ---------------- sculpt surface detail, stored per vertex of the once-subdivided body ----------------
from subdiv import Loop  # noqa: E402
LOOP = Loop(tris, len(P))
detail8 = np.zeros(len(P) + len(LOOP.E), np.int8)
DETAIL_STEP = 1e-4  # int8 steps of 0.1 mm (+-12.7 mm)
if SC is not None:
    Wn = Wu / Wu.sum(1, keepdims=True)
    Ps = LOOP.positions(P)  # already in the sculpt's pose
    Ns = vertex_normals(Ps, LOOP.T)
    _d, _i = SC.tree.query(Ps)
    _h = ((SC.P[_i] - Ps) * Ns).sum(1)
    _ok = (_d < 0.02) & ((SC.N[_i] * Ns).sum(1) > 0.3)
    _skip = Wn[:, [IDX[b] for b in ('head', 'hand.L', 'hand.R', 'foot.L', 'foot.R')]].sum(1) + 0.5 * Wn[:, IDX['neck']]
    _yc = (J['hip.L'][1] + J['hip.R'][1]) / 2 - 0.07  # the sculpt is anatomical at the groin, our figure is not
    _groin = np.exp(-((P[:, 0] / 0.075) ** 2 + ((P[:, 1] - _yc) / 0.085) ** 2))
    _keep = np.clip(1 - _skip, 0, 1) * (1 - _groin)
    for _ in range(3):
        _keep = np.minimum(_keep, (ADJ @ _keep) / ADJ_DEG)  # fade in, no hard edges
    _h = np.clip(_h, -0.0125, 0.0125) * LOOP.linear(_keep[:, None])[:, 0] * _ok
    detail8 = np.round(_h / DETAIL_STEP).astype(np.int8)
    print(f'sculpt detail: {len(_h)} verts, |h| median {np.median(np.abs(_h[_h != 0])) * 1000:.2f} mm')
DETAIL_SCALE = {'base': 1.0, 'muscle': {'lo': -0.5, 'hi': 0.35}, 'weight': {'lo': 0.15, 'hi': -0.65}}

# ---------------- soft tissue for jiggle: breasts (MakeHuman breast bones) and belly ----------------
_wraw = json.load(open(f'{MH}/rigs/default_weights.mhw'))['weights']
_full = np.zeros((len(V), 2))
for k_, bone in enumerate(('breast.L', 'breast.R')):
    for vi, w in _wraw[bone]:
        _full[vi, k_] += w
_tot = np.zeros(len(V))
for bone, pairs in _wraw.items():
    for vi, w in pairs:
        _tot[vi] += w
_full /= np.maximum(_tot, 1e-9)[:, None]
_n_orig = len(used_c)
soft = np.zeros((len(P), 3))
_orig_of = TOPO['used']  # final vertex -> index in the compact pre-faceless mesh (caps are >= len(used_c))
_ok = _orig_of < _n_orig
soft[_ok, :2] = _full[used_c[_orig_of[_ok]]]
belly_c = (J['hips'] * 0.25 + J['spine'] * 0.75)
_front = P[(np.abs(P[:, 0]) < 0.03) & (np.abs(P[:, 1] - belly_c[1]) < 0.02)][:, 2].max()
belly_c = np.array([0.0, belly_c[1], _front - 0.07])
_e = (P[:, 0] / 0.14) ** 2 + ((P[:, 1] - belly_c[1]) / 0.13) ** 2
_wt = np.clip(1 - _e, 0, 1) ** 1.5 * np.clip((P[:, 2] - belly_c[2]) / 0.06, 0, 1)
_trunk = Wu[:, [IDX['hips'], IDX['spine']]].sum(1) / Wu.sum(1)
soft[:, 2] = _wt * _trunk
for _ in range(6):
    soft = 0.5 * soft + 0.5 * (ADJ @ soft) / ADJ_DEG[:, None]
soft /= np.maximum(soft.max(0), 1e-9)
soft = soft ** 0.75
soft8 = np.round(np.clip(soft, 0, 1) * 255).astype(np.uint8)
def _anchor(k, depth):
    c = (P * soft[:, k:k + 1]).sum(0) / soft[:, k].sum()
    return (c - np.array([0, 0, depth])).round(4).tolist()  # behind the soft tissue, where it hangs from


soft_anchors = {'breast.L': ['chest', _anchor(0, 0.06)], 'breast.R': ['chest', _anchor(1, 0.06)], 'belly': ['spine', _anchor(2, 0.08)]}
print('soft tissue verts:', (soft > 0.05).sum(0).tolist())
rnd = lambda d: {k: [round(float(x), 5) for x in v] for k, v in d.items()}

# ---------------- body-shape sliders: offsets at each slider's ends ----------------
def both(part, w):
    return {f'armslegs/{side}-{part}.target': w for side in ('l', 'r')}


def pair(incr, decr):
    """Part slider: decr targets at 0, incr targets at 1."""
    return {'lo': dict(extra=decr), 'hi': dict(extra=incr)}


MALE = PRESET == 'male'
SLIDERS = {
    'height': (0.5, {'lo': dict(height=0.0), 'hi': dict(height=1.0)}),
    'weight': (WEIGHT, {'lo': dict(weight=0.0, define=+0.1),
                        'hi': dict(weight=1.0, define=-BASE['define'], detail_k=0.5,
                                   extra={'stomach/stomach-tone-incr.target': 0.0, 'stomach/stomach-pregnant-incr.target': 0.35,
                                          **both('upperarm-fat-incr', 0.6), **both('upperleg-fat-incr', 0.5)})}),
    'muscle': (cfg['muscle_u'], {
        'lo': dict(muscle=0.0, detail_k=0.0, extra={'stomach/stomach-tone-decr.target': 0.4}),
        'hi': dict(muscle=1.0, detail_k=1.45 if MALE else 2.0, define=+0.25,
                   extra={'stomach/stomach-tone-incr.target': 1.0, 'torso/torso-vshape-incr.target': 0.4})}),
    'shoulders': (0.5, pair({**both('upperarm-shoulder-muscle-incr', 1.0), 'torso/torso-vshape-incr.target': 0.5},
                            {**both('upperarm-shoulder-muscle-decr', 1.0), 'torso/torso-vshape-decr.target': 0.5})),
    'chest': (0.5, pair({'torso/torso-muscle-pectoral-incr.target': 1.0}, {'torso/torso-muscle-pectoral-decr.target': 1.0})
              if MALE else {'lo': dict(cup=-0.8), 'hi': dict(cup=1.0)}),
    'arms': (0.5, pair({**both('upperarm-muscle-incr', 0.9), **both('upperarm-fat-incr', 0.5), **both('lowerarm-muscle-incr', 0.7)},
                       {**both('upperarm-muscle-decr', 0.9), **both('upperarm-fat-decr', 0.5), **both('lowerarm-muscle-decr', 0.7)})),
    'belly': (0.5, pair({'stomach/stomach-pregnant-incr.target': 0.6}, {'stomach/stomach-pregnant-decr.target': 1.0})),
    'hips': (0.5, pair({'buttocks/buttocks-volume-incr.target': 1.0, 'hip/hip-scale-horiz-incr.target': 0.4},
                       {'buttocks/buttocks-volume-decr.target': 1.0, 'hip/hip-scale-horiz-decr.target': 0.4})),
    'thighs': (0.5, pair({**both('upperleg-muscle-incr', 0.8), **both('upperleg-fat-incr', 0.8)},
                         {**both('upperleg-muscle-decr', 0.8), **both('upperleg-fat-decr', 0.8)})),
    'calves': (0.5, pair({**both('lowerleg-muscle-incr', 0.9), **both('lowerleg-fat-incr', 0.5)},
                         {**both('lowerleg-muscle-decr', 0.9), **both('lowerleg-fat-decr', 0.5)})),
}
DELTA_SCALE = 1e-4  # int16 steps of 0.1 mm
shapes = {}
for name, (base_u, ends) in SLIDERS.items():
    shapes[name] = {}
    for key, spec in ends.items():
        params = dict(BASE)
        for k, v in spec.items():
            if k == 'extra':
                params['extra'] = {**BASE['extra'], **v}
                for path in v:  # an incr target replaces the base amount of the same target
                    if path in BASE['extra']:
                        params['extra'][path] = v[path]
            elif k == 'define':
                params['define'] = BASE['define'] + v
            else:
                params[k] = v
        Vs = shape(**params)
        Ps = define_mesh(make_faceless(Vs[used_c] * SCALE, tris_c, Wu_c, TOPO)[0], params['define'])
        Js = joints_of(Vs)
        if POSE is not None:
            Ps, Js = POSE.apply_joints(Ps, WN, Js)
        dP = np.round((Ps - P) / DELTA_SCALE)
        assert np.abs(dP).max() < 32767
        moved = np.where(np.abs(dP).max(1) >= 2)[0]  # sparse: only vertices that move more than 0.2 mm
        jd = {k: Js[k] - J[k] for k in J if np.abs(Js[k] - J[k]).max() > 1e-5}
        shapes[name][key] = {'i': b64(moved.astype(np.uint16)), 'd': b64(dP[moved].astype(np.int16)), 'j': rnd(jd)}
        print(f'  slider {name}.{key}: {len(moved)} verts')
shape_base = {name: base_u for name, (base_u, _) in SLIDERS.items()}

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
    f'  ao: "{b64(ao8)}",\n'
    f'  soft: "{b64(soft8)}",\n'
    f'  detail: "{b64(detail8)}",\n'
    f'  detailStep: {DETAIL_STEP},\n'
    f'  detailScale: {json.dumps(DETAIL_SCALE)},\n'
    f'  softAnchors: {json.dumps(soft_anchors)},\n'
    f'  definition: {json.dumps({"base": BASE["define"], **{k: {e: SLIDERS[k][1][e].get("define", 0) for e in ("lo", "hi")} for k in ("weight", "muscle")}})},\n'
    f'  shapeBase: {json.dumps(shape_base)},\n'
    f'  deltaScale: {DELTA_SCALE},\n'
    f'  shapes: {json.dumps(shapes)},\n'
    '};\n'
)
open(OUT, 'w').write(out)
print(f'vertices {len(P)}, triangles {len(tris)}, height {P[:, 1].max() - P[:, 1].min():.3f} m, file {len(out) / 1024:.0f} KB')
