'use strict';
/**
 * hashring.js — consistent hashing with virtual nodes and bounded loads.
 *
 * The problem: you have K keys across N cache servers. `hash(key) % N` spreads
 * them evenly, and then you add one server and N becomes N+1 — which changes
 * the result for *almost every key*. Measured in bench/rebalance.js: going
 * from 8 nodes to 9 with modulo moves about 89% of keys. For a cache that is a
 * near-total miss storm; for a sharded database it is a full data migration.
 *
 * Consistent hashing instead places nodes and keys on the same 32-bit ring and
 * assigns each key to the first node clockwise. Adding a node only captures
 * the keys in the arc between it and its predecessor, so only ~K/N keys move
 * — about 11% for the same 8-to-9 change, and that is the theoretical minimum.
 *
 *            0 ──────────────── hash space ──────────────── 2^32
 *            │    ▲        ▲              ▲         ▲        │
 *            │   node A   node B        node C    node A'    │
 *                  └── keys here go to B ──┘
 *
 * Two refinements on top, both load-bearing:
 *
 *   Virtual nodes. With one point per node, random placement leaves arcs of
 *   wildly different sizes — a 3-node ring routinely gives one node 60% of the
 *   keyspace. Each node is placed at `replicas` points instead, so the law of
 *   large numbers flattens the distribution. Measured below.
 *
 *   Bounded loads. Even with virtual nodes the distribution is only even on
 *   average, and key *popularity* is not uniform anyway. Bounded loads caps
 *   any node at `ceil(avg * factor)` and spills past it to the next node
 *   clockwise, which trades a little locality for a hard ceiling on hot spots.
 */

const { xxhash32 } = require('./hash');

const DEFAULT_REPLICAS = 160;   // what ketama (libmemcached) uses

class HashRing {
  /**
   * @param {string[]} [nodes]
   * @param {{replicas?: number, hash?: (s: string) => number}} [opts]
   */
  constructor(nodes = [], opts = {}) {
    this.replicas = opts.replicas ?? DEFAULT_REPLICAS;
    this.hash = opts.hash ?? xxhash32;
    this.nodes = new Map();        // name -> { name, weight }
    this.ring = [];                // sorted [{ point, node }]
    this.points = new Int32Array(0);
    for (const n of nodes) this.#addNode(n);
    this.#rebuild();
  }

  get size() { return this.nodes.size; }
  nodeNames() { return [...this.nodes.keys()]; }

  #addNode(spec) {
    const { name, weight } = typeof spec === 'string' ? { name: spec, weight: 1 } : spec;
    this.nodes.set(name, { name, weight: weight ?? 1 });
  }

  /**
   * Rebuilds the sorted ring. O(n log n) in the number of virtual points, so
   * it is done once per membership change rather than per lookup.
   *
   * Points are stored in a parallel Int32Array as well as the object list:
   * the binary search in get() runs on every lookup, and scanning a typed
   * array of numbers is markedly faster than chasing object properties.
   */
  #rebuild() {
    const entries = [];
    for (const { name, weight } of this.nodes.values()) {
      const count = Math.max(1, Math.round(this.replicas * weight));
      for (let i = 0; i < count; i++) {
        // The vnode key includes the index, so a node's points are scattered
        // around the ring rather than clustered — which is the entire point of
        // having several.
        entries.push({ point: this.hash(`${name}#${i}`) | 0, node: name });
      }
    }
    entries.sort((a, b) => (a.point === b.point ? (a.node < b.node ? -1 : 1) : a.point - b.point));
    this.ring = entries;
    this.points = Int32Array.from(entries, (e) => e.point);
  }

  add(spec) { this.#addNode(spec); this.#rebuild(); return this; }

  remove(name) {
    const existed = this.nodes.delete(name);
    if (existed) this.#rebuild();
    return existed;
  }

  /** The node owning `key`: first ring point clockwise. */
  get(key) {
    if (this.ring.length === 0) return null;
    return this.ring[this.#searchClockwise(this.hash(String(key)) | 0)].node;
  }

  /**
   * Binary search for the first point >= h, wrapping to 0.
   * The wrap is the easy thing to get wrong: a key hashing past the last
   * point belongs to the *first* node, not to none.
   */
  #searchClockwise(h) {
    const pts = this.points;
    let lo = 0;
    let hi = pts.length - 1;
    if (h > pts[hi]) return 0;          // wrapped around the top of the ring
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (pts[mid] < h) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * The first `n` distinct nodes clockwise — for replication. A key's replicas
   * must be on *different physical* nodes, so this walks past extra virtual
   * points belonging to a node already chosen.
   */
  getN(key, n) {
    if (this.ring.length === 0 || n <= 0) return [];
    const want = Math.min(n, this.nodes.size);
    const out = [];
    const seen = new Set();
    let i = this.#searchClockwise(this.hash(String(key)) | 0);
    for (let step = 0; step < this.ring.length && out.length < want; step++) {
      const node = this.ring[(i + step) % this.ring.length].node;
      if (!seen.has(node)) { seen.add(node); out.push(node); }
    }
    return out;
  }

  /**
   * Distribution of `keys` across nodes, plus a spread figure.
   * `maxOverAvg` is the one number that matters: 1.0 is perfect, 1.1 means the
   * busiest node carries 10% more than its share.
   */
  distribution(keys) {
    const counts = new Map(this.nodeNames().map((n) => [n, 0]));
    for (const k of keys) {
      const n = this.get(k);
      counts.set(n, counts.get(n) + 1);
    }
    const vals = [...counts.values()];
    const avg = keys.length / Math.max(1, this.nodes.size);
    return {
      counts: Object.fromEntries(counts),
      avg,
      min: Math.min(...vals),
      max: Math.max(...vals),
      maxOverAvg: avg > 0 ? Math.max(...vals) / avg : 0,
      stddev: Math.sqrt(vals.reduce((s, v) => s + (v - avg) ** 2, 0) / vals.length),
    };
  }
}

/**
 * Consistent hashing with bounded loads (Mirrokni, Thorup, Zadimoghaddam).
 *
 * Plain consistent hashing is even *on average* over random keys. Real traffic
 * is not random — one key can be a thousand times hotter than another, and the
 * node that owns it is overloaded no matter how good the ring is.
 *
 * This caps every node at `ceil(avg * factor)` assignments. A key whose
 * natural owner is full walks clockwise to the first node with room. The
 * guarantee is a hard ceiling on any node's load; the cost is that some keys
 * no longer live on their natural owner, so lookups must consult the same
 * assignment state rather than recomputing from the hash alone.
 */
class BoundedRing {
  /** @param {string[]} nodes @param {{factor?: number, replicas?: number}} [opts] */
  constructor(nodes, opts = {}) {
    this.ring = new HashRing(nodes, { replicas: opts.replicas ?? DEFAULT_REPLICAS });
    this.factor = opts.factor ?? 1.25;
    this.load = new Map(this.ring.nodeNames().map((n) => [n, 0]));
    this.owner = new Map();
    this.spilled = 0;
  }

  get capacity() {
    const n = this.ring.size;
    if (n === 0) return 0;
    return Math.ceil((this.owner.size + 1) / n * this.factor);
  }

  /** Assigns `key`, respecting the cap. Idempotent for an already-placed key. */
  assign(key) {
    const existing = this.owner.get(key);
    if (existing !== undefined) return existing;

    const cap = this.capacity;
    const candidates = this.ring.getN(key, this.ring.size);
    for (let i = 0; i < candidates.length; i++) {
      const node = candidates[i];
      if (this.load.get(node) < cap) {
        if (i > 0) this.spilled++;
        this.load.set(node, this.load.get(node) + 1);
        this.owner.set(key, node);
        return node;
      }
    }
    // Every node is at the cap. Fall back to the natural owner rather than
    // refusing the key: a balancer that drops work to protect a bound is
    // worse than a slightly over-capacity node.
    const fallback = candidates[0];
    this.load.set(fallback, this.load.get(fallback) + 1);
    this.owner.set(key, fallback);
    return fallback;
  }

  get(key) { return this.owner.get(key) ?? this.ring.get(key); }

  release(key) {
    const node = this.owner.get(key);
    if (node === undefined) return false;
    this.owner.delete(key);
    this.load.set(node, Math.max(0, this.load.get(node) - 1));
    return true;
  }

  stats() {
    const vals = [...this.load.values()];
    const avg = this.owner.size / Math.max(1, this.ring.size);
    return {
      load: Object.fromEntries(this.load),
      assigned: this.owner.size,
      spilled: this.spilled,
      cap: this.capacity,
      maxOverAvg: avg > 0 ? Math.max(...vals) / avg : 0,
    };
  }
}

/** `hash(key) % n` — the thing consistent hashing replaces. For comparison. */
function moduloAssign(key, nodes, hash = xxhash32) {
  if (nodes.length === 0) return null;
  return nodes[(hash(String(key)) >>> 0) % nodes.length];
}

module.exports = { HashRing, BoundedRing, moduloAssign, DEFAULT_REPLICAS };
