'use strict';
/**
 * hash.js — xxHash32, because the ring needs a fast, well-distributed,
 * non-cryptographic hash.
 *
 * Why not MD5 (what the original ketama uses): MD5 is ~20x slower and its
 * cryptographic strength buys nothing here — nobody is attacking a shard
 * assignment, they just need the bits spread evenly. Why not a trivial hash
 * like djb2: poor avalanche means similar keys land in similar places, which
 * on a ring shows up as visibly lumpy arcs.
 *
 * All arithmetic is kept in 32-bit integer space with `|0` and `Math.imul`,
 * because JS numbers are doubles and a plain `*` on two large ints silently
 * loses precision.
 */

const P1 = 0x9e3779b1 | 0;
const P2 = 0x85ebca77 | 0;
const P3 = 0xc2b2ae3d | 0;
const P4 = 0x27d4eb2f | 0;
const P5 = 0x165667b1 | 0;

const rotl = (x, r) => ((x << r) | (x >>> (32 - r))) | 0;

/** @param {string} str @param {number} [seed] @returns {number} signed 32-bit */
function xxhash32(str, seed = 0) {
  // Encode to UTF-8 bytes so non-ASCII keys hash by their real bytes rather
  // than by UTF-16 code units.
  const bytes = Buffer.from(str, 'utf8');
  const len = bytes.length;
  let h;
  let i = 0;

  if (len >= 16) {
    let v1 = (seed + P1 + P2) | 0;
    let v2 = (seed + P2) | 0;
    let v3 = seed | 0;
    let v4 = (seed - P1) | 0;
    const limit = len - 16;
    while (i <= limit) {
      v1 = Math.imul(rotl((v1 + Math.imul(bytes.readInt32LE(i), P2)) | 0, 13), P1);
      v2 = Math.imul(rotl((v2 + Math.imul(bytes.readInt32LE(i + 4), P2)) | 0, 13), P1);
      v3 = Math.imul(rotl((v3 + Math.imul(bytes.readInt32LE(i + 8), P2)) | 0, 13), P1);
      v4 = Math.imul(rotl((v4 + Math.imul(bytes.readInt32LE(i + 12), P2)) | 0, 13), P1);
      i += 16;
    }
    h = (rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18)) | 0;
  } else {
    h = (seed + P5) | 0;
  }

  h = (h + len) | 0;

  while (i + 4 <= len) {
    h = Math.imul(rotl((h + Math.imul(bytes.readInt32LE(i), P3)) | 0, 17), P4);
    i += 4;
  }
  while (i < len) {
    h = Math.imul(rotl((h + Math.imul(bytes[i], P5)) | 0, 11), P1);
    i++;
  }

  h = Math.imul(h ^ (h >>> 15), P2);
  h = Math.imul(h ^ (h >>> 13), P3);
  h = h ^ (h >>> 16);
  return h | 0;
}

module.exports = { xxhash32 };
