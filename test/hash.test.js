'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { xxhash32 } = require('../src/hash');

test('matches the official xxHash32 test vectors', () => {
  // From the xxHash reference implementation, seed 0. If these pass, the
  // 32-bit wraparound arithmetic is right — which is the whole risk of
  // implementing a hash in a language whose numbers are doubles.
  assert.equal(xxhash32('') | 0, 0x02cc5d05 | 0, 'empty string');
  assert.equal(xxhash32('abc') | 0, 0x32d153ff | 0, '"abc"');
});

test('stays inside 32-bit range for every input length', () => {
  for (let len = 0; len < 80; len++) {
    const h = xxhash32('k'.repeat(len));
    assert.ok(Number.isInteger(h), `len ${len} produced an integer`);
    assert.ok(h >= -2147483648 && h <= 2147483647, `len ${len} is in int32 range`);
    assert.equal(h, h | 0, `len ${len} did not lose precision`);
  }
});

test('is deterministic and seed-sensitive', () => {
  assert.equal(xxhash32('node-a#17'), xxhash32('node-a#17'));
  assert.notEqual(xxhash32('x', 0), xxhash32('x', 1));
});

test('avalanches: a one-character change scrambles the output', () => {
  // Poor avalanche is what makes a ring lumpy, because adjacent keys land in
  // adjacent arcs. Check that single-bit input changes move about half the
  // output bits.
  const popcount = (x) => { let c = 0; x >>>= 0; while (x) { c += x & 1; x >>>= 1; } return c; };
  let total = 0;
  const N = 2000;
  for (let i = 0; i < N; i++) {
    const a = xxhash32(`key:${i}`);
    const b = xxhash32(`key:${i + 1}`);
    total += popcount(a ^ b);
  }
  const avgBitsFlipped = total / N;
  assert.ok(avgBitsFlipped > 13 && avgBitsFlipped < 19,
    `avg ${avgBitsFlipped.toFixed(1)} of 32 bits flipped (ideal 16)`);
});

test('spreads uniformly across buckets', () => {
  const buckets = new Array(16).fill(0);
  const N = 200_000;
  for (let i = 0; i < N; i++) buckets[(xxhash32(`k${i}`) >>> 0) % 16]++;
  const expected = N / 16;
  for (const [i, c] of buckets.entries()) {
    const dev = Math.abs(c - expected) / expected;
    assert.ok(dev < 0.03, `bucket ${i} within 3% of expected (was ${(dev * 100).toFixed(2)}%)`);
  }
});

test('hashes by UTF-8 bytes, so non-ASCII keys are handled', () => {
  assert.notEqual(xxhash32('مفتاح'), xxhash32('clé'));
  assert.equal(xxhash32('مفتاح'), xxhash32('مفتاح'));
  assert.ok(Number.isInteger(xxhash32('🇩🇿 emoji key')));
});
