/**
 * Vnode ring and placement directory — the routing half of progressive sharding.
 *
 * A single Durable Object holds ~10 GB of SQLite, which is plenty until it
 * isn't. `.shardBy(field)` answers that, but it makes partitioning a SCHEMA
 * decision the author has to get right before they have any data — and changing
 * it later is a migration. The alternative is to let a deployment start as one
 * DO and grow, which needs a routing layer that can say where a document lives
 * without the client ever naming a shard.
 *
 * Names are deliberately vnode-specific: `@lunora/platform` already owns a
 * `ShardDirectory`/`resolveShard` pair for resolving a shard STUB from a
 * name, and `@lunora/do` imports both packages. Two same-named contracts for
 * different concepts in one package family is a trap, so this one talks about
 * vnode placement and says so.
 *
 * This module is that layer, and *only* that layer. It is pure: given a
 * directory and a document id it computes a placement. It moves no data, opens
 * no storage, and talks to no host.
 *
 * **Scope.** Deliberately excluded, because each needs its own design and test
 * plan and a half-built version risks misrouting live rows:
 *
 * - rebalance (moving vnodes between shards, plus the dual-read window such a
 * move needs to stay correct while it is in flight)
 * - the per-shard write-ahead log and applied-watermark protocol
 * - autoscale policy (spill / split / merge / un-spill, and their hysteresis)
 *
 * What IS here is the part those all build on, and the part that has to be
 * right first: a fixed ring, a stable hash, and a directory that can express
 * "everything is still local".
 *
 * **Tier 0.** A fresh deployment bootstraps with `shardCount: 0`, so every
 * vnode maps to {@link LOCAL_SHARD} and every document resolves to the
 * coordinator's own store. That placement is byte-identical to today's
 * single-DO topology — which is what makes this safe to land before anything
 * consumes it, and what a future spill policy would grow out of.
 *
 * **Why a ring at all.** Hashing ids straight onto shards would remap most
 * documents whenever the shard count changed. Ids map to a FIXED number of
 * vnodes, and vnodes map to shards; growing the shard set then moves whole
 * vnodes rather than rehashing every document, and the vnode ring never
 * changes size after creation.
 */

/** The tier-0 pseudo-shard: the coordinator's own local store. */
const LOCAL_SHARD = -1;

/** Vnodes in a ring, when the caller does not choose. */
const DEFAULT_VNODE_COUNT = 256;

/**
 * Which shard owns each vnode. `assignments[v]` is the shard for vnode `v`; the
 * array's length is the ring size and is fixed at creation.
 */
interface VnodeDirectory {
    /** `assignments[vnode] -> shard id` (`>= 0`, or {@link LOCAL_SHARD}). */
    readonly assignments: ReadonlyArray<number>;
    /** Real shards allocated so far. `0` means everything is still tier-0 local. */
    readonly shardCount: number;
}

/**
 * 64-bit FNV-1a. Chosen for being tiny, dependency-free, and identical across
 * every runtime the framework targets — placement must not vary by host.
 * Computed in `BigInt` because the 64-bit multiply overflows a JS number, and
 * truncated with `BigInt.asUintN` rather than a mask constant so the 64-bit
 * wrap-around is explicit at every use site.
 */
const FNV_OFFSET_BASIS = 0xcb_f2_9c_e4_84_22_23_25n;

const FNV_PRIME = 0x1_00_00_01_b3n;

/* eslint-disable no-bitwise -- FNV-1a and the jump-hash LCG ARE bit
   manipulation; both are fixed published algorithms whose constants and
   shifts define the distribution, so expressing them otherwise would only
   obscure them. */
const fnv1a64 = (input: string): bigint => {
    let hash = FNV_OFFSET_BASIS;
    const bytes = new TextEncoder().encode(input);

    for (const byte of bytes) {
        hash ^= BigInt(byte);
        hash = BigInt.asUintN(64, hash * FNV_PRIME);
    }

    return hash;
};

/**
 * Jump consistent hash (Lamping & Veach): map `key` onto `[0, buckets)` such
 * that growing `buckets` moves the minimum possible number of keys and nothing
 * else is disturbed. No memory, no lookup table — just the jump loop.
 *
 * Returns `0` for `buckets &lt;= 1`, which keeps the degenerate one-bucket case
 * from needing a caller-side branch.
 */
const jumpConsistentHash = (key: string, buckets: number): number => {
    if (buckets <= 1) {
        return 0;
    }

    let hash = fnv1a64(key);
    let candidate = -1n;
    let next = 0n;
    const total = BigInt(buckets);

    while (next < total) {
        candidate = next;
        // The LCG constant and 31-bit shift are from the paper; they define the
        // distribution, so they are not tunable.
        hash = BigInt.asUintN(64, hash * 2_862_933_555_777_941_757n + 1n);
        next = BigInt(Math.floor((Number(candidate) + 1) * (2 ** 31 / Number((hash >> 33n) + 1n))));
    }

    return Number(candidate);
};

/* eslint-enable no-bitwise */

/**
 * Build the initial directory.
 *
 * `shardCount: 0` (the progressive default) assigns every vnode to
 * {@link LOCAL_SHARD} — identical to plain single-DO placement. A positive
 * `shardCount` is expert mode: vnodes round-robin over the shards, which
 * distributes them evenly and, unlike hashing, is trivially inspectable.
 */
const bootstrapDirectory = (vnodeCount: number = DEFAULT_VNODE_COUNT, shardCount = 0): VnodeDirectory => {
    if (!Number.isInteger(vnodeCount) || vnodeCount <= 0) {
        throw new RangeError(`vnodeCount must be a positive integer, received ${String(vnodeCount)}`);
    }

    if (!Number.isInteger(shardCount) || shardCount < 0) {
        throw new RangeError(`shardCount must be a non-negative integer, received ${String(shardCount)}`);
    }

    const assignments = Array.from({ length: vnodeCount }, (_, vnode) => (shardCount === 0 ? LOCAL_SHARD : vnode % shardCount));

    return { assignments, shardCount };
};

/** The vnode a document id belongs to. Fixed for the life of the ring. */
const vnodeForId = (id: string, vnodeCount: number): number => {
    if (!Number.isInteger(vnodeCount) || vnodeCount <= 0) {
        throw new RangeError(`vnodeCount must be a positive integer, received ${String(vnodeCount)}`);
    }

    return jumpConsistentHash(id, vnodeCount);
};

/**
 * A table routes to the coordinator's local store iff the final segment of its
 * name starts with `_`. That covers the reserved system tables and their
 * component-namespaced forms (`comp/path/_tbl`): they are small, they are read
 * on nearly every request, and several carry the coordinator's own bookkeeping
 * — distributing them would buy nothing and cost a hop.
 */
const isSystemTable = (table: string): boolean => {
    const segments = table.split("/");
    const last = segments.at(-1) ?? table;

    return last.startsWith("_");
};

/**
 * Where does `(table, id)` live under `directory`?
 *
 * Returns {@link LOCAL_SHARD} for system tables and for any deployment still at
 * tier 0. Routing is derived entirely from the document id, so a client never
 * names a shard and can never route itself somewhere it should not be.
 */
const resolveVnodePlacement = (directory: VnodeDirectory, table: string, id: string): number => {
    if (isSystemTable(table) || directory.shardCount === 0) {
        return LOCAL_SHARD;
    }

    const vnode = vnodeForId(id, directory.assignments.length);

    return directory.assignments[vnode] ?? LOCAL_SHARD;
};

/** Vnodes currently assigned to `shard`, ascending. */
const vnodesForShard = (directory: VnodeDirectory, shard: number): number[] => {
    const owned: number[] = [];

    for (const [vnode, assigned] of directory.assignments.entries()) {
        if (assigned === shard) {
            owned.push(vnode);
        }
    }

    return owned;
};

/** Is every vnode still local — i.e. is this deployment untouched by sharding? */
const isTierZero = (directory: VnodeDirectory): boolean => directory.shardCount === 0 || directory.assignments.every((shard) => shard === LOCAL_SHARD);

export {
    bootstrapDirectory,
    DEFAULT_VNODE_COUNT,
    fnv1a64,
    isSystemTable,
    isTierZero,
    jumpConsistentHash,
    LOCAL_SHARD,
    resolveVnodePlacement,
    vnodeForId,
    vnodesForShard,
};
export type { VnodeDirectory };
