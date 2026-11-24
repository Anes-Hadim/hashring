'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { HashRing, BoundedRing, moduloAssign } = require('../src/hashring');

const keys = (n, p = 'key') => Array.from({ length: n }, (_, i) => `${p}:${i}`);

test('an empty ring returns null rather than throwing', () => {
  const r = new HashRing([]);
  assert.equal(r.get('anything'), null);
  assert.deepEqual(r.getN('anything', 3), []);
});

test('a single node owns every key', () => {
  const r = new HashRing(['only']);
  for (const k of keys(500)) assert.equal(r.get(k), 'only');
});

test('lookups are stable: the same key always maps to the same node', () => {
  const r = new HashRing(['a', 'b', 'c', 'd']);
  const first = keys(1000).map((k) => r.get(k));
  const second = keys(1000).map((k) => r.get(k));
  assert.deepEqual(first, second);

  // And a freshly built ring with the same members agrees — so two processes
  // independently computing the ring route identically, which is the property
  // that makes it usable as a client-side sharding scheme at all.
  const r2 = new HashRing(['d', 'c', 'b', 'a']);   // different insertion order
  assert.deepEqual(keys(1000).map((k) => r2.get(k)), first,
    'membership determines the ring, not insertion order');
});

test('a key hashing past the last ring point wraps to the first node', () => {
  // The classic off-by-one. Force a hash above every ring point and check the
  // lookup wraps instead of falling off the end.
  const r = new HashRing(['a', 'b', 'c'], { replicas: 4 });
  const maxPoint = Math.max(...r.ring.map((e) => e.point));
  const r2 = new HashRing(['a', 'b', 'c'], { replicas: 4, hash: () => maxPoint + 1 });
  assert.equal(r2.get('whatever'), r2.ring[0].node, 'wrapped to the first point');

  const minPoint = Math.min(...r.ring.map((e) => e.point));
  const r3 = new HashRing(['a', 'b', 'c'], { replicas: 4, hash: () => minPoint - 1 });
  assert.equal(r3.get('whatever'), r3.ring[0].node, 'below the first point also lands on it');
});

test('a hash landing exactly on a ring point takes that point', () => {
  const probe = new HashRing(['a', 'b', 'c'], { replicas: 4 });
  const target = probe.ring[2];
  const r = new HashRing(['a', 'b', 'c'], { replicas: 4, hash: () => target.point });
  assert.equal(r.get('x'), target.node, 'inclusive lower bound, not exclusive');
});

test('virtual nodes flatten the distribution', () => {
  // The measurement that justifies the complexity. With one point per node the
  // arcs are wildly uneven; with 160 they are close to equal.
  const ks = keys(60_000);
  const one = new HashRing(['a', 'b', 'c', 'd', 'e'], { replicas: 1 }).distribution(ks);
  const many = new HashRing(['a', 'b', 'c', 'd', 'e'], { replicas: 160 }).distribution(ks);

  assert.ok(many.maxOverAvg < one.maxOverAvg,
    `160 vnodes (${many.maxOverAvg.toFixed(2)}x) beats 1 vnode (${one.maxOverAvg.toFixed(2)}x)`);
  assert.ok(many.maxOverAvg < 1.2,
    `busiest node within 20% of its share (was ${((many.maxOverAvg - 1) * 100).toFixed(1)}% over)`);
});

test('adding a node moves only about 1/N of the keys', () => {
  // The entire reason consistent hashing exists. Compare against modulo on
  // the same keys and the same hash.
  const before = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8'];
  const after = [...before, 'n9'];
  const ks = keys(50_000);

  const ring = new HashRing(before);
  const ringBefore = ks.map((k) => ring.get(k));
  ring.add('n9');
  const ringMoved = ks.filter((k, i) => ring.get(k) !== ringBefore[i]).length / ks.length;

  const modBefore = ks.map((k) => moduloAssign(k, before));
  const modMoved = ks.filter((k, i) => moduloAssign(k, after) !== modBefore[i]).length / ks.length;

  // 1/9 = 11.1% is the theoretical minimum for 8 -> 9 nodes.
  assert.ok(ringMoved < 0.16, `ring moved ${(ringMoved * 100).toFixed(1)}% (minimum is 11.1%)`);
  assert.ok(modMoved > 0.8, `modulo moved ${(modMoved * 100).toFixed(1)}%`);
  assert.ok(modMoved > ringMoved * 4, 'modulo is several times worse');
});

test('keys that move on an add go to the NEW node, never between old ones', () => {
  // The subtler guarantee: adding n9 must not shuffle keys between n1..n8.
  // If it did, every add would still be a partial migration everywhere.
  const ring = new HashRing(['n1', 'n2', 'n3', 'n4']);
  const ks = keys(20_000);
  const before = new Map(ks.map((k) => [k, ring.get(k)]));
  ring.add('n5');
  for (const k of ks) {
    const now = ring.get(k);
    if (now !== before.get(k)) {
      assert.equal(now, 'n5', `${k} moved to the new node, not sideways`);
    }
  }
});

test('removing a node redistributes only its own keys', () => {
  const ring = new HashRing(['n1', 'n2', 'n3', 'n4', 'n5']);
  const ks = keys(20_000);
  const before = new Map(ks.map((k) => [k, ring.get(k)]));
  ring.remove('n3');

  for (const k of ks) {
    const now = ring.get(k);
    if (before.get(k) === 'n3') {
      assert.notEqual(now, 'n3', 'n3 keys went elsewhere');
    } else {
      assert.equal(now, before.get(k), `${k} was untouched by the removal`);
    }
  }
  assert.equal(ring.size, 4);
  assert.equal(ring.remove('nope'), false, 'removing an unknown node reports false');
});

test('weights shift proportionally more traffic to a bigger node', () => {
  const r = new HashRing([{ name: 'big', weight: 3 }, { name: 'small', weight: 1 }]);
  const d = r.distribution(keys(60_000));
  const ratio = d.counts.big / d.counts.small;
  assert.ok(ratio > 2.5 && ratio < 3.5, `big:small was ${ratio.toFixed(2)}, expected ~3`);
});

test('getN returns distinct physical nodes for replication', () => {
  const r = new HashRing(['a', 'b', 'c', 'd', 'e']);
  for (const k of keys(2000)) {
    const three = r.getN(k, 3);
    assert.equal(three.length, 3);
    assert.equal(new Set(three).size, 3, `${k}: no duplicate physical node`);
    assert.equal(three[0], r.get(k), 'the first replica is the primary');
  }
});

test('getN cannot ask for more nodes than exist', () => {
  const r = new HashRing(['a', 'b']);
  assert.equal(r.getN('k', 5).length, 2);
  assert.deepEqual(r.getN('k', 0), []);
});

test('bounded loads caps the busiest node', () => {
  // Plain consistent hashing is even on average. Bounded loads gives a hard
  // ceiling, which is what you need when key popularity is skewed.
  const nodes = ['a', 'b', 'c', 'd', 'e'];
  const ks = keys(10_000);

  const plain = new HashRing(nodes).distribution(ks);
  const bounded = new BoundedRing(nodes, { factor: 1.05 });
  for (const k of ks) bounded.assign(k);
  const bs = bounded.stats();

  assert.ok(bs.maxOverAvg <= 1.1,
    `bounded kept the busiest node at ${bs.maxOverAvg.toFixed(3)}x average`);
  assert.ok(bs.maxOverAvg <= plain.maxOverAvg,
    `bounded (${bs.maxOverAvg.toFixed(3)}x) is no worse than plain (${plain.maxOverAvg.toFixed(3)}x)`);
  assert.ok(bs.spilled > 0, `${bs.spilled} keys spilled past their natural owner`);
  assert.equal(bs.assigned, ks.length);
});

test('bounded assignment is idempotent and releasable', () => {
  const b = new BoundedRing(['a', 'b', 'c'], { factor: 1.5 });
  const first = b.assign('k1');
  assert.equal(b.assign('k1'), first, 'reassigning returns the same node');
  assert.equal(b.stats().assigned, 1, 'and does not count twice');

  assert.equal(b.get('k1'), first);
  assert.equal(b.release('k1'), true);
  assert.equal(b.release('k1'), false);
  assert.equal(b.stats().assigned, 0);
});

test('bounded loads still places every key when every node is at the cap', () => {
  // factor 1.0 with a keyspace that does not divide evenly: the cap will be
  // hit. The ring must place the key anyway rather than dropping work.
  const b = new BoundedRing(['a', 'b', 'c'], { factor: 1.0 });
  const ks = keys(1000);
  for (const k of ks) assert.ok(b.assign(k) !== undefined);
  assert.equal(b.stats().assigned, 1000, 'nothing was refused');
});
