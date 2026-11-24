# hashring

Consistent hashing with virtual nodes and bounded loads, plus a from-scratch
**xxHash32**. **Zero dependencies.**

This is the answer to "how would you shard [nanocache](https://github.com/Anes-Hadim/nanocache)
across ten machines?" — so I built it to find out whether the textbook claim
about `1/N` actually holds when you measure it.

## The problem

You have 100,000 keys across 8 cache servers. `hash(key) % 8` spreads them
evenly. Then you add a ninth server, `N` becomes 9, and the result changes for
**almost every key**:

```console
$ node bench/rebalance.js

change            modulo      ring   minimum
--------------------------------------------
4 -> 5             80.1%     18.8%     20.0%
8 -> 9             88.9%     10.9%     11.1%
16 -> 17           94.1%      5.8%      5.9%
32 -> 33           97.0%      3.2%      3.0%
64 -> 65           98.5%      1.6%      1.5%
```

**Modulo moves 88.9% of keys to add one server out of eight.** For a cache
that is a near-total miss storm landing on your database at once. For a
sharded store it is a full data migration.

The ring moves **10.9%** — against a theoretical minimum of 11.1%. It is not
"better"; it is *optimal*, and the `minimum` column is there so you can check
that claim rather than take it.

## How

Nodes and keys are hashed onto the same 32-bit ring. Each key belongs to the
first node clockwise:

```
0 ──────────────────── hash space ──────────────────── 2³²
│       ▲          ▲                  ▲           ▲     │
│     node A     node B             node C      node A' │
          └─ these keys go to B ─┘
```

Adding a node only captures the arc between it and its predecessor, so only
the keys in that arc move. Everything else is untouched — and that is a
stronger guarantee than "few keys move". A test asserts the *direction* too:
when a node joins, every key that moves must move **to the new node**, never
sideways between two existing ones. Sideways movement would make each add a
partial migration everywhere, which is exactly what you were avoiding.

## Virtual nodes, and why 160

With one ring point per node, random placement leaves arcs of wildly different
sizes. Measured, 8 nodes, 100,000 keys:

| ring points per node | busiest / average | min keys | max keys |
|---|---|---|---|
| 1 | **2.677×** | 813 | 33,462 |
| 4 | 2.100× | 5,854 | 26,249 |
| 16 | 1.295× | 9,553 | 16,187 |
| 64 | 1.171× | 11,048 | 14,633 |
| **160** | **1.095×** | 10,860 | 13,690 |
| 512 | 1.047× | 11,740 | 13,084 |

With one point each, one node holds **41× more keys than another** — 33,462
against 813. That is the "consistent hashing is evenly distributed" claim
failing in practice, and it is why nobody runs one point per node.

160 is what ketama (libmemcached) uses, and the table shows why it is a
sensible stopping place: it buys most of the flattening, and 512 costs 3× the
memory and rebuild time for another 5%.

## Bounded loads

Virtual nodes make the distribution even **on average over random keys**. Real
traffic is not random — one key can be a thousand times hotter than the rest,
and the node owning it is overloaded no matter how good the ring is.

Bounded loads (Mirrokni–Thorup–Zadimoghaddam) caps every node at
`ceil(avg × factor)` and spills past it to the next node clockwise:

| factor | busiest / average | keys displaced |
|---|---|---|
| unbounded | 1.095× | — |
| 1.25 | 1.095× | 0.0% |
| 1.10 | 1.093× | 0.1% |
| 1.02 | **1.020×** | 3.5% |

At `1.25` nothing spills, because the natural distribution is already inside
the bound — the cap costs nothing until you actually need it. At `1.02` you buy
a 2% ceiling for 3.5% of keys losing their natural placement. That is the real
trade and the table is the honest way to show it: **a tighter bound is not
free, it is paid for in locality.**

The cost is architectural too. Once keys can spill, a lookup can no longer be
computed from the hash alone — it has to consult the same assignment state,
which means that state must be shared or replicated. Plain consistent hashing
is stateless and every client agrees by computing; bounded loads is not.

## xxHash32 from scratch

`src/hash.js` implements xxHash32, verified against the reference test vectors:

```js
assert.equal(xxhash32('')    | 0, 0x02cc5d05 | 0);
assert.equal(xxhash32('abc') | 0, 0x32d153ff | 0);
```

Not MD5 (what original ketama uses): ~20× slower, and its cryptographic
strength buys nothing — nobody attacks a shard assignment, the bits just need
spreading. Not djb2 either: poor avalanche means similar keys land in similar
places, which on a ring shows up as visibly lumpy arcs. A test measures the
avalanche directly and asserts that a one-character input change flips ~16 of
32 output bits.

The implementation risk in JavaScript is that numbers are doubles, so a plain
`*` on two large integers silently loses precision. Everything is kept in
32-bit space with `Math.imul` and `|0`, and a test checks every input length
from 0 to 79 for precision loss.

## Throughput

```
8 nodes, 160 vnodes     7,009,387 lookups/sec   (1,280 ring points)
64 nodes, 160 vnodes    6,221,533 lookups/sec   (10,240 ring points)
```

8× the ring points costs 11% of lookup speed, which is what `O(log n)` looks
like. Ring points live in a parallel `Int32Array` as well as the object list —
the binary search runs on every lookup, and scanning a typed array of numbers
beats chasing object properties.

## Usage

```js
const { HashRing, BoundedRing } = require('hashring');

const ring = new HashRing(['cache-1', 'cache-2', 'cache-3']);
ring.get('user:42:session');        // -> 'cache-2'
ring.getN('user:42:session', 3);    // -> 3 distinct nodes, for replication
ring.add({ name: 'cache-4', weight: 2 });   // twice the share
ring.remove('cache-1');
ring.distribution(allKeys);         // { counts, maxOverAvg, stddev, ... }
```

`getN` walks past extra virtual points belonging to a node already chosen, so
replicas always land on **distinct physical nodes** — otherwise a 3× replicated
key could have all three copies on one machine.

## Tests

```console
$ npm test
ℹ tests 21
ℹ pass 21
ℹ fail 0
```

Including the two ring bugs that are easiest to write: a key hashing **past the
last point** must wrap to the first node rather than falling off the end, and a
key hashing **exactly onto** a point must take that point (inclusive bound).
Plus: ring membership determines placement regardless of insertion order, so
two processes computing the ring independently route identically.

## Known limits

- **`#rebuild()` is O(P log P)** over all ring points and runs on every
  membership change — 10,240 points for 64 nodes. Fine for a cluster that
  changes occasionally, wasteful for one that autoscales every minute.
- **No replication or repair.** `getN` says where copies *should* live; nothing
  here copies anything or notices when a replica is missing.
- **No failure detection.** `remove()` must be called by something that knows
  a node is down. Pair it with the health checker in
  [`minilb`](https://github.com/Anes-Hadim/minilb).
- **`BoundedRing` keeps per-key state in memory**, so it is bounded by key
  count, not node count, and it is per process — two instances would make
  different spill decisions.
- **32-bit ring.** With ~10k points, collisions are rare but not impossible;
  ties break on node name for determinism. A 64-bit ring would make it moot.

## Layout

```
src/hash.js         xxHash32, 32-bit-safe, reference vectors tested
src/hashring.js     the ring, virtual nodes, weights, getN, BoundedRing
bench/rebalance.js  the measurements in this README
```

MIT.
