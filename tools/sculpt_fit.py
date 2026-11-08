"""Fit the MakeHuman body onto a detailed sculpt (Blender Studio Human Base Meshes, CC0).

1. pose_align: rotate our rig's bones (linear blend skinning) so the MakeHuman body takes the
   sculpt's pose (both are A-poses, but arm and leg angles differ).
2. nonrigid_fit: let the surface slide onto the sculpt with a smooth (Laplacian-regularised)
   displacement field; head and hands stay put.
3. to_rest: carry that displacement back into MakeHuman's own pose, so the rig and skin weights
   keep working unchanged.
"""
import numpy as np
import scipy.sparse as sp
import scipy.sparse.linalg as spla
from scipy.spatial import cKDTree

# bone -> (pivot joint, parent bone)
BONES = {
    'hips': ('hips', None), 'spine': ('spine', 'hips'), 'chest': ('chest', 'spine'),
    'neck': ('neck', 'chest'), 'head': ('head', 'neck'),
}
for s in ('L', 'R'):
    BONES.update({
        f'upperArm.{s}': (f'shoulder.{s}', 'chest'), f'foreArm.{s}': (f'elbow.{s}', f'upperArm.{s}'),
        f'hand.{s}': (f'wrist.{s}', f'foreArm.{s}'),
        f'thigh.{s}': (f'hip.{s}', 'hips'), f'shin.{s}': (f'knee.{s}', f'thigh.{s}'),
        f'foot.{s}': (f'ankle.{s}', f'shin.{s}'),
    })


def vertex_normals(P, T):
    fn = np.cross(P[T[:, 1]] - P[T[:, 0]], P[T[:, 2]] - P[T[:, 0]])
    N = np.zeros_like(P)
    for k in range(3):
        np.add.at(N, T[:, k], fn)
    return N / (np.linalg.norm(N, axis=1, keepdims=True) + 1e-12)


class Sculpt:
    def __init__(self, P, T):
        self.P, self.T = P, T
        self.N = vertex_normals(P, T)
        self.tree = cKDTree(P)

    def closest(self, X, NX, max_d=0.04, min_dot=0.4):
        """Nearest sculpt vertex per point, with a validity mask (close enough, normals agree)."""
        d, i = self.tree.query(X, k=1)
        ok = (d < max_d) & ((self.N[i] * NX).sum(1) > min_dot)
        return self.P[i], self.N[i], ok


def descendants(bone):
    out = [bone]
    for b, (_, parent) in BONES.items():
        if parent == bone:
            out += descendants(b)
    return out


ORDER = descendants('hips')


class Pose:
    """Global rotation + pivot per bone; poses rest positions by linear blend skinning."""

    def __init__(self, J, names):
        self.names = names
        self.rest_p = {b: np.array(J[BONES[b][0]]) for b in BONES}
        self.p = {b: self.rest_p[b].copy() for b in BONES}
        self.R = {b: np.eye(3) for b in BONES}

    def apply(self, X, W):
        out = np.zeros_like(X)
        for k, b in enumerate(self.names):
            out += W[:, k:k + 1] * ((X - self.rest_p[b]) @ self.R[b].T + self.p[b])
        return out

    def joints(self, Jrest):
        """Posed pivots for another body's rest joints (same bone rotations, forward kinematics)."""
        out = {}
        for b in ORDER:
            joint, parent = BONES[b]
            r = np.array(Jrest[joint])
            if parent is None:
                out[b] = r + (self.p[b] - self.rest_p[b])
            else:
                pj = np.array(Jrest[BONES[parent][0]])
                out[b] = out[parent] + self.R[parent] @ (r - pj)
        return out

    def apply_joints(self, X, W, Jrest):
        """Pose another body (its own rest joints) with these bone rotations; returns (X, joints)."""
        piv = self.joints(Jrest)
        out = np.zeros_like(X)
        for k, b in enumerate(self.names):
            r = np.array(Jrest[BONES[b][0]])
            out += W[:, k:k + 1] * ((X - r) @ self.R[b].T + piv[b])
        Jp = dict(Jrest)
        for b, (joint, _) in BONES.items():
            Jp[joint] = piv[b]
        for k in Jrest:  # joints that are not bone pivots ride along with their bone (none today)
            Jp.setdefault(k, Jrest[k])
        return out, Jp

    def blended_rotation(self, W):
        M = np.zeros((len(W), 3, 3))
        for k, b in enumerate(self.names):
            M += W[:, k, None, None] * self.R[b][None]
        return M

    def rotate(self, bone, R, pivot):
        for b in descendants(bone):
            self.R[b] = R @ self.R[b]
            self.p[b] = (self.p[b] - pivot) @ R.T + pivot

    def translate(self, t):
        for b in BONES:
            self.p[b] = self.p[b] + t


def kabsch(A, B):
    """Rotation R minimising |R A - B| (rows are vectors, both already centred on the pivot)."""
    H = A.T @ B
    U, _, Vt = np.linalg.svd(H)
    D = np.diag([1, 1, np.sign(np.linalg.det(Vt.T @ U.T))])
    return Vt.T @ D @ U.T


def limit(R, max_angle):
    ang = np.arccos(np.clip((np.trace(R) - 1) / 2, -1, 1))
    if ang <= max_angle or ang < 1e-9:
        return R
    axis = np.array([R[2, 1] - R[1, 2], R[0, 2] - R[2, 0], R[1, 0] - R[0, 1]]) / (2 * np.sin(ang))
    a = max_angle
    K = np.array([[0, -axis[2], axis[1]], [axis[2], 0, -axis[0]], [-axis[1], axis[0], 0]])
    return np.eye(3) + np.sin(a) * K + (1 - np.cos(a)) * K @ K


def pose_align(X, T, W, J, names, sculpt, iterations=10, log=print):
    pose = Pose(J, names)
    dom = W.argmax(1)
    wmax = W.max(1)
    for it in range(iterations):
        Xp = pose.apply(X, W)
        # root translation from the torso
        torso = np.isin(dom, [names.index(b) for b in ('hips', 'spine', 'chest')])
        C, _, ok = sculpt.closest(Xp, vertex_normals(Xp, T), max_d=0.08, min_dot=0.0)
        pose.translate(np.median((C - Xp)[torso & ok], axis=0))
        for b in ORDER:
            Xp = pose.apply(X, W)
            sel = (dom == names.index(b)) & (wmax > 0.6)
            C, _, ok = sculpt.closest(Xp, vertex_normals(Xp, T), max_d=0.08, min_dot=0.2)
            sel &= ok
            if sel.sum() < 20:
                continue
            piv = pose.p[b]
            R = kabsch(Xp[sel] - piv, C[sel] - piv)
            pose.rotate(b, limit(R, np.radians(12)), piv)
        Xp = pose.apply(X, W)
        d, _ = sculpt.tree.query(Xp)
        log(f'  pose fit {it}: median gap {np.median(d) * 1000:.1f} mm, 90% {np.percentile(d, 90) * 1000:.1f} mm')
    return pose


def laplacian(T, n):
    E = np.unique(np.sort(np.concatenate([T[:, [0, 1]], T[:, [1, 2]], T[:, [2, 0]]]), 1), axis=0)
    A = sp.coo_matrix((np.ones(2 * len(E)), (np.r_[E[:, 0], E[:, 1]], np.r_[E[:, 1], E[:, 0]])), shape=(n, n)).tocsr()
    deg = np.asarray(A.sum(1)).ravel()
    return (sp.diags(deg) - A).tocsr()


def nonrigid_fit(X0, T, sculpt, fit_w, anchor_w, stiffness=(40, 20, 10, 5, 2.5, 1.5), log=print):
    """Displacement D (on X0) pulling the surface onto the sculpt; returns D."""
    n = len(X0)
    L = laplacian(T, n)
    LtL = (L.T @ L).tocsr()
    D = np.zeros_like(X0)
    for lam in stiffness:
        for _ in range(2):
            X = X0 + D
            C, CN, ok = sculpt.closest(X, vertex_normals(X, T), max_d=0.03, min_dot=0.5)
            w = fit_w * ok
            A = (sp.diags(w + anchor_w) + lam * LtL).tocsc()
            solve = spla.factorized(A)
            rhs = w[:, None] * (C - X0)
            D = np.stack([solve(rhs[:, c]) for c in range(3)], 1)
        d, _ = sculpt.tree.query(X0 + D)
        m = fit_w > 0.5
        log(f'  surface fit (stiffness {lam}): median gap {np.median(d[m]) * 1000:.2f} mm, 95% {np.percentile(d[m], 95) * 1000:.1f} mm')
    return D


def to_rest(D_posed, pose, W):
    """Bring a displacement field from the posed body back into the rest pose."""
    M = pose.blended_rotation(W)
    return np.einsum('nij,nj->ni', np.linalg.inv(M), D_posed)
