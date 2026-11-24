#!/usr/bin/env node
'use strict';
/** Measures what actually moves when a node joins — ring vs `hash % n`. */
const { HashRing, BoundedRing, moduloAssign } = require('../src/hashring');

const KEYS = Number(process.env.KEYS || 100_000);
const keys = Array.from({ length: KEYS }, (_, i) => `user:${i}:session`);

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);

console.log(`\nkeys: ${KEYS.toLocaleString()}   (1/N is the theoretical minimum that must move)\n`);
console.log(`${pad('change', 14)}${rpad('modulo', 10)}${rpad('ring', 10)}${rpad('minimum', 10)}`);
console.log('-'.repeat(44));

for (const n of [4, 8, 16, 32, 64]) {
  const before = Array.from({ length: n }, (_, i) => `node${i}`);
  const after = [...before, `node${n}`];

  const ring = new HashRing(before);
  const ringBefore = keys.map((k) => ring.get(k));
  ring.add(`node${n}`);
  const ringMoved = keys.reduce((c, k, i) => c + (ring.get(k) !== ringBefore[i] ? 1 : 0), 0) / KEYS;

  const modBefore = keys.map((k) => moduloAssign(k, before));
  const modMoved = keys.reduce((c, k, i) => c + (moduloAssign(k, after) !== modBefore[i] ? 1 : 0), 0) / KEYS;

  console.log(`${pad(`${n} -> ${n + 1}`, 14)}${rpad(pct(modMoved), 10)}${rpad(pct(ringMoved), 10)}${rpad(pct(1 / (n + 1)), 10)}`);
}

console.log(`\n\nvirtual nodes vs distribution evenness (8 nodes, ${KEYS.toLocaleString()} keys)\n`);
console.log(`${pad('replicas', 12)}${rpad('busiest/avg', 14)}${rpad('min', 10)}${rpad('max', 10)}`);
console.log('-'.repeat(46));
for (const replicas of [1, 4, 16, 64, 160, 512]) {
  const d = new HashRing(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], { replicas }).distribution(keys);
  console.log(`${pad(replicas, 12)}${rpad(`${d.maxOverAvg.toFixed(3)}x`, 14)}${rpad(d.min.toLocaleString(), 10)}${rpad(d.max.toLocaleString(), 10)}`);
}

console.log(`\n\nbounded loads: hard ceiling on the busiest node (8 nodes)\n`);
console.log(`${pad('factor', 12)}${rpad('busiest/avg', 14)}${rpad('spilled', 12)}`);
console.log('-'.repeat(38));
const plain = new HashRing(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']).distribution(keys);
console.log(`${pad('unbounded', 12)}${rpad(`${plain.maxOverAvg.toFixed(3)}x`, 14)}${rpad('-', 12)}`);
for (const factor of [1.25, 1.1, 1.02]) {
  const b = new BoundedRing(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], { factor });
  for (const k of keys) b.assign(k);
  const s = b.stats();
  console.log(`${pad(factor, 12)}${rpad(`${s.maxOverAvg.toFixed(3)}x`, 14)}${rpad(pct(s.spilled / KEYS), 12)}`);
}

console.log('\n\nlookup throughput\n');
for (const [label, ring] of [
  ['8 nodes, 160 vnodes', new HashRing(Array.from({ length: 8 }, (_, i) => `n${i}`))],
  ['64 nodes, 160 vnodes', new HashRing(Array.from({ length: 64 }, (_, i) => `n${i}`))],
]) {
  const t0 = process.hrtime.bigint();
  for (const k of keys) ring.get(k);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`  ${pad(label, 24)}${rpad(Math.round(KEYS / (ms / 1000)).toLocaleString(), 12)} lookups/sec  (${ring.ring.length} ring points)`);
}
console.log();
