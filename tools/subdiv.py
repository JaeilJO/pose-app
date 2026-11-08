"""One level of Loop subdivision, laid out exactly like src/subdiv.js:
vertices = original vertices, then one per edge in (min, max) lexicographic order;
each triangle (a, b, c) becomes (a, ab, ca), (ab, b, bc), (ca, bc, c), (ab, bc, ca)."""
import numpy as np
import scipy.sparse as sp


class Loop:
    def __init__(self, T, n):
        self.n = n
        e = np.sort(np.concatenate([T[:, [0, 1]], T[:, [1, 2]], T[:, [2, 0]]]), 1)
        self.E, inv = np.unique(e, axis=0, return_inverse=True)
        inv = inv.ravel()
        m = len(T)
        eab, ebc, eca = inv[:m] + n, inv[m:2 * m] + n, inv[2 * m:] + n
        a, b, c = T[:, 0], T[:, 1], T[:, 2]
        self.T = np.concatenate([np.stack([a, eab, eca], 1), np.stack([eab, b, ebc], 1),
                                 np.stack([eca, ebc, c], 1), np.stack([eab, ebc, eca], 1)])
        # the vertex opposite each edge, in both of its triangles
        opp = np.full((len(self.E), 2), -1)
        ei_all = np.concatenate([inv[:m], inv[m:2 * m], inv[2 * m:]])
        o_all = np.concatenate([c, a, b])
        order = np.argsort(ei_all, kind='stable')
        ei_s, o_s = ei_all[order], o_all[order]
        first = np.r_[True, ei_s[1:] != ei_s[:-1]]
        opp[ei_s[first], 0] = o_s[first]
        opp[ei_s[~first], 1] = o_s[~first]
        assert (opp >= 0).all(), 'mesh must be closed'
        self.opp = opp
        A = sp.coo_matrix((np.ones(2 * len(self.E)), (np.r_[self.E[:, 0], self.E[:, 1]], np.r_[self.E[:, 1], self.E[:, 0]])), shape=(n, n)).tocsr()
        val = np.asarray(A.sum(1)).ravel()
        beta = np.where(val == 3, 3 / 16, 3 / (8 * np.maximum(val, 1)))
        self.A, self.val, self.beta = A, val, beta

    def positions(self, P):
        even = (1 - self.val * self.beta)[:, None] * P + self.beta[:, None] * (self.A @ P)
        E, o = self.E, self.opp
        odd = 0.375 * (P[E[:, 0]] + P[E[:, 1]]) + 0.125 * (P[o[:, 0]] + P[o[:, 1]])
        return np.vstack([even, odd])

    def linear(self, X):
        """Attributes: originals stay, edge vertices take the midpoint."""
        return np.concatenate([X, 0.5 * (X[self.E[:, 0]] + X[self.E[:, 1]])])
