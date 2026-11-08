// One level of Loop subdivision, laid out exactly like tools/subdiv.py (the sculpt detail is
// stored per vertex of this layout): original vertices first, then one per edge in (min, max)
// order; triangle (a, b, c) -> (a, ab, ca), (ab, b, bc), (ca, bc, c), (ab, bc, ca).
export class Loop {
  constructor(index, n) {
    this.n = n;
    const m = index.length / 3;
    const keys = new Float64Array(m * 3);
    for (let t = 0; t < m; t++) {
      for (let k = 0; k < 3; k++) {
        const a = index[t * 3 + k], b = index[t * 3 + ((k + 1) % 3)];
        keys[t * 3 + k] = a < b ? a * 65536 + b : b * 65536 + a;
      }
    }
    const sorted = Float64Array.from(keys).sort();
    const uniq = [];
    for (let i = 0; i < sorted.length; i++) if (i === 0 || sorted[i] !== sorted[i - 1]) uniq.push(sorted[i]);
    const edgeOf = new Map(uniq.map((k, i) => [k, i]));
    const E = uniq.length;
    this.edges = new Uint32Array(E * 2);
    uniq.forEach((k, i) => { this.edges[i * 2] = Math.floor(k / 65536); this.edges[i * 2 + 1] = k % 65536; });
    // vertex opposite each edge in its two triangles
    this.opp = new Int32Array(E * 2).fill(-1);
    const tri = new Uint32Array(m * 12);
    for (let t = 0; t < m; t++) {
      const a = index[t * 3], b = index[t * 3 + 1], c = index[t * 3 + 2];
      const eab = edgeOf.get(keys[t * 3]), ebc = edgeOf.get(keys[t * 3 + 1]), eca = edgeOf.get(keys[t * 3 + 2]);
      for (const [e, o] of [[eab, c], [ebc, a], [eca, b]]) this.opp[e * 2 + (this.opp[e * 2] < 0 ? 0 : 1)] = o;
      const AB = n + eab, BC = n + ebc, CA = n + eca;
      tri.set([a, AB, CA], t * 3);
      tri.set([AB, b, BC], (m + t) * 3);
      tri.set([CA, BC, c], (2 * m + t) * 3);
      tri.set([AB, BC, CA], (3 * m + t) * 3);
    }
    this.count = n + E;
    this.index = this.count < 65536 ? Uint16Array.from(tri) : tri;
    // even-vertex rule: (1 - k beta) v + beta * sum(neighbours)
    this.valence = new Uint16Array(n);
    for (let i = 0; i < E; i++) { this.valence[this.edges[i * 2]]++; this.valence[this.edges[i * 2 + 1]]++; }
    this.beta = Float32Array.from(this.valence, (k) => (k === 3 ? 3 / 16 : 3 / (8 * k)));
    // open borders (clothes): border vertices only see their two border neighbours, border edges split in half
    this.border = new Int32Array(n * 2).fill(-1);
    for (let i = 0; i < E; i++) {
      if (this.opp[i * 2 + 1] >= 0) continue;
      const a = this.edges[i * 2], b = this.edges[i * 2 + 1];
      this.border[a * 2 + (this.border[a * 2] < 0 ? 0 : 1)] = b;
      this.border[b * 2 + (this.border[b * 2] < 0 ? 0 : 1)] = a;
    }
  }

  /** Smoothly subdivided positions (Float32Array, count * 3). */
  positions(P) {
    const { n, edges, opp, valence, beta } = this;
    const E = edges.length / 2;
    const out = new Float32Array(this.count * 3);
    const sum = new Float32Array(n * 3);
    for (let i = 0; i < E; i++) {
      const a = edges[i * 2] * 3, b = edges[i * 2 + 1] * 3;
      for (let c = 0; c < 3; c++) { sum[a + c] += P[b + c]; sum[b + c] += P[a + c]; }
    }
    const bd = this.border;
    for (let v = 0; v < n; v++) {
      if (bd[v * 2] >= 0) {
        const p = bd[v * 2] * 3, q = (bd[v * 2 + 1] >= 0 ? bd[v * 2 + 1] : bd[v * 2]) * 3;
        for (let c = 0; c < 3; c++) out[v * 3 + c] = 0.75 * P[v * 3 + c] + 0.125 * (P[p + c] + P[q + c]);
        continue;
      }
      const w = 1 - valence[v] * beta[v];
      for (let c = 0; c < 3; c++) out[v * 3 + c] = w * P[v * 3 + c] + beta[v] * sum[v * 3 + c];
    }
    for (let i = 0; i < E; i++) {
      const a = edges[i * 2] * 3, b = edges[i * 2 + 1] * 3, c0 = opp[i * 2] * 3, d0 = opp[i * 2 + 1] * 3;
      const o = (n + i) * 3;
      if (d0 < 0) { for (let c = 0; c < 3; c++) out[o + c] = 0.5 * (P[a + c] + P[b + c]); continue; }
      for (let c = 0; c < 3; c++) out[o + c] = 0.375 * (P[a + c] + P[b + c]) + 0.125 * (P[c0 + c] + P[d0 + c]);
    }
    return out;
  }

  /** Per-vertex attributes (stride k): originals stay, edge vertices take the midpoint. */
  linear(X, k) {
    const E = this.edges.length / 2;
    const out = new Float32Array(this.count * k);
    out.set(X.subarray(0, this.n * k));
    for (let i = 0; i < E; i++) {
      const a = this.edges[i * 2] * k, b = this.edges[i * 2 + 1] * k, o = (this.n + i) * k;
      for (let c = 0; c < k; c++) out[o + c] = 0.5 * (X[a + c] + X[b + c]);
    }
    return out;
  }
}
