import { describe, expect, it } from "vitest";

import {
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
} from "../src/shard-ring";

/** Deterministic id generator — placement tests must not depend on randomness. */
const ids = (count: number): string[] => Array.from({ length: count }, (_, index) => `doc_${String(index)}`);

describe("fnv1a64", () => {
    it("is deterministic and differs for near-identical inputs", () => {
        expect.assertions(2);

        expect(fnv1a64("abc")).toBe(fnv1a64("abc"));
        expect(fnv1a64("abc")).not.toBe(fnv1a64("abd"));
    });

    it("avalanches — a one-character change redistributes the hash", () => {
        expect.assertions(1);

        // Placement quality depends on this: a hash that clustered similar ids
        // would pile sequential document ids onto one vnode.
        const buckets = new Set(ids(64).map((id) => Number(fnv1a64(id) % 8n)));

        expect(buckets.size).toBe(8);
    });
});

describe("jumpConsistentHash", () => {
    it("always lands inside the bucket range", () => {
        expect.assertions(1);

        const inRange = ids(500).every((id) => {
            const bucket = jumpConsistentHash(id, 16);

            return Number.isInteger(bucket) && bucket >= 0 && bucket < 16;
        });

        expect(inRange).toBe(true);
    });

    it("collapses degenerate bucket counts to 0", () => {
        expect.assertions(2);

        expect(jumpConsistentHash("x", 1)).toBe(0);
        expect(jumpConsistentHash("x", 0)).toBe(0);
    });

    it("moves only a minority of keys when the bucket count grows", () => {
        expect.assertions(2);

        const sample = ids(1000);
        const moved = sample.filter((id) => jumpConsistentHash(id, 4) !== jumpConsistentHash(id, 5)).length;

        // Growing 4 -> 5 should relocate ~1/5 of keys. A plain modulo hash would
        // move ~80%, which is the whole reason for consistent hashing here.
        expect(moved).toBeGreaterThan(0);
        expect(moved).toBeLessThan(sample.length * 0.4);
    });

    it("spreads keys across every bucket", () => {
        expect.assertions(1);

        const buckets = new Set(ids(2000).map((id) => jumpConsistentHash(id, 8)));

        expect(buckets.size).toBe(8);
    });
});

describe("bootstrapDirectory", () => {
    it("starts every vnode local, so tier 0 matches single-DO placement", () => {
        expect.assertions(3);

        const directory = bootstrapDirectory();

        expect(directory.shardCount).toBe(0);
        expect(directory.assignments).toHaveLength(DEFAULT_VNODE_COUNT);
        expect(directory.assignments.every((shard) => shard === LOCAL_SHARD)).toBe(true);
    });

    it("round-robins vnodes when shards are pre-allocated", () => {
        expect.assertions(2);

        const directory = bootstrapDirectory(8, 3);

        expect(directory.assignments).toStrictEqual([0, 1, 2, 0, 1, 2, 0, 1]);
        expect(vnodesForShard(directory, 0)).toStrictEqual([0, 3, 6]);
    });

    it("rejects a ring that could not route anything", () => {
        expect.assertions(3);

        expect(() => bootstrapDirectory(0)).toThrow(RangeError);
        expect(() => bootstrapDirectory(1.5)).toThrow(RangeError);
        expect(() => bootstrapDirectory(8, -1)).toThrow(RangeError);
    });
});

describe("resolveShard", () => {
    it("keeps everything local at tier 0", () => {
        expect.assertions(1);

        const directory = bootstrapDirectory(64);
        const allLocal = ids(200).every((id) => resolveVnodePlacement(directory, "messages", id) === LOCAL_SHARD);

        expect(allLocal).toBe(true);
    });

    it("routes user documents onto real shards once they exist", () => {
        expect.assertions(2);

        const directory = bootstrapDirectory(64, 4);
        const placements = new Set(ids(500).map((id) => resolveVnodePlacement(directory, "messages", id)));

        expect([...placements].every((shard) => shard >= 0 && shard < 4)).toBe(true);
        expect(placements.size).toBeGreaterThan(1);
    });

    it("places an id identically across separately-built directories", () => {
        expect.assertions(1);

        // The property that matters: placement is a pure function of the id and
        // the ring shape, so a coordinator that rebuilds its directory (a cold
        // start, another isolate) routes every document exactly as before.
        const first = bootstrapDirectory(64, 4);
        const second = bootstrapDirectory(64, 4);
        const stable = ids(200).every((id) => resolveVnodePlacement(first, "messages", id) === resolveVnodePlacement(second, "messages", id));

        expect(stable).toBe(true);
    });

    it("pins system tables to the coordinator even when shards exist", () => {
        expect.assertions(3);

        const directory = bootstrapDirectory(64, 4);

        expect(resolveVnodePlacement(directory, "_migrations", "doc_1")).toBe(LOCAL_SHARD);
        expect(resolveVnodePlacement(directory, "comp/billing/_state", "doc_1")).toBe(LOCAL_SHARD);
        expect(resolveVnodePlacement(directory, "messages", "doc_1")).not.toBe(LOCAL_SHARD);
    });

    it("routes from the id alone, so the table never changes placement", () => {
        expect.assertions(1);

        const directory = bootstrapDirectory(64, 4);
        const sameEverywhere = ids(100).every((id) => resolveVnodePlacement(directory, "messages", id) === resolveVnodePlacement(directory, "posts", id));

        expect(sameEverywhere).toBe(true);
    });
});

describe("isSystemTable", () => {
    it("recognises reserved and component-namespaced system tables", () => {
        expect.assertions(4);

        expect(isSystemTable("_migrations")).toBe(true);
        expect(isSystemTable("comp/billing/_state")).toBe(true);
        expect(isSystemTable("messages")).toBe(false);
        expect(isSystemTable("comp/billing/invoices")).toBe(false);
    });
});

describe("isTierZero", () => {
    it("reports tier 0 until a vnode actually moves", () => {
        expect.assertions(3);

        expect(isTierZero(bootstrapDirectory(8))).toBe(true);
        expect(isTierZero(bootstrapDirectory(8, 2))).toBe(false);
        // A directory that allocated shards but never placed a vnode on one is
        // still, in effect, tier 0.
        expect(isTierZero({ assignments: [LOCAL_SHARD, LOCAL_SHARD], shardCount: 2 })).toBe(true);
    });
});

describe("vnodeForId", () => {
    it("stays inside the ring and rejects an empty one", () => {
        expect.assertions(2);

        expect(ids(300).every((id) => vnodeForId(id, 128) < 128)).toBe(true);
        expect(() => vnodeForId("doc_1", 0)).toThrow(RangeError);
    });
});
