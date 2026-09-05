import { describe, expect, it, vi } from "vitest";

import { applyDiff, applyDiffs, applyDiffToSnapshot, classifyChanges, createTableDiff, diffSize, EventLog, isDiffEmpty, mergeDiffs } from "../src/index";
import type { InputEvent } from "../src/seq";

// ─── TableDiff ────────────────────────────────────────────────────────

describe(createTableDiff, () => {
    it("creates a diff with default timestamp", () => {
        expect.assertions(3);

        const diff = createTableDiff("users", [{ type: "insert", data: { name: "alice" } }]);

        expect(diff.table).toBe("users");
        expect(diff.changes).toHaveLength(1);
        expect(diff.timestamp).toBeGreaterThan(0);
    });

    it("accepts an explicit timestamp", () => {
        expect.assertions(1);

        const diff = createTableDiff("users", [], 42);

        expect(diff.timestamp).toBe(42);
    });

    it("mints a stable id without throwing when crypto.randomUUID is unavailable (non-secure origin)", () => {
        expect.assertions(3);

        const realCrypto = globalThis.crypto;

        try {
            // Simulate a non-secure origin (e.g. http://192.168.x.x LAN dev):
            // `crypto.randomUUID` is undefined there, so a bare call throws.
            // `getRandomValues` remains available as the fallback entropy.
            vi.stubGlobal("crypto", { getRandomValues: realCrypto.getRandomValues.bind(realCrypto) });

            const a = createTableDiff("users", [{ type: "insert", data: { name: "alice" } }]);
            const b = createTableDiff("users", [{ type: "insert", data: { name: "bob" } }]);

            expect(a.id).toBeTypeOf("string");
            expect(a.id).not.toBe("");
            // Distinct diffs get distinct ids even when minted in the same
            // millisecond — required by `deriveInsertId`.
            expect(a.id).not.toBe(b.id);
        } finally {
            vi.unstubAllGlobals();
        }
    });
});

describe(isDiffEmpty, () => {
    it("returns true for diff with no changes", () => {
        expect.assertions(1);
        expect(isDiffEmpty(createTableDiff("t", []))).toBe(true);
    });

    it("returns false for diff with changes", () => {
        expect.assertions(1);
        expect(isDiffEmpty(createTableDiff("t", [{ type: "insert", data: {} }]))).toBe(false);
    });
});

describe(diffSize, () => {
    it("counts all changes", () => {
        expect.assertions(1);

        const diff = createTableDiff("t", [
            { type: "insert", data: {} },
            { type: "update", id: "1", data: {} },
            { type: "delete", id: "2" },
        ]);

        expect(diffSize(diff)).toBe(3);
    });
});

describe(classifyChanges, () => {
    it("partitions changes by kind", () => {
        expect.assertions(3);

        const diff = createTableDiff("t", [
            { type: "insert", data: { id: "1" } },
            { type: "update", id: "2", data: {} },
            { type: "delete", id: "3" },
            { type: "insert", data: { id: "4" } },
        ]);

        const { inserts, updates, deletes } = classifyChanges(diff);

        expect(inserts).toHaveLength(2);
        expect(updates).toHaveLength(1);
        expect(deletes).toHaveLength(1);
    });

    it("returns empty arrays for empty diff", () => {
        expect.assertions(3);

        const { inserts, updates, deletes } = classifyChanges(createTableDiff("t", []));

        expect(inserts).toEqual([]);
        expect(updates).toEqual([]);
        expect(deletes).toEqual([]);
    });
});

describe(mergeDiffs, () => {
    it("merges diffs for the same table, preserving order", () => {
        expect.assertions(6);

        const a = createTableDiff("t", [{ type: "insert", data: { id: "1" } }], 10);
        const b = createTableDiff("t", [{ type: "update", id: "1", data: { name: "bob" } }], 20);

        const merged = mergeDiffs([a, b]);

        expect(merged).not.toBeNull();
        expect(merged!.table).toBe("t");
        expect(merged!.changes).toHaveLength(2);
        expect(merged!.changes[0]).toEqual(a.changes[0]);
        expect(merged!.changes[1]).toEqual(b.changes[0]);
        expect(merged!.timestamp).toBe(20);
    });

    it("returns null for empty input", () => {
        expect.assertions(1);
        expect(mergeDiffs([])).toBeNull();
    });

    it("produces a constant-size, non-compounding merge id regardless of child count", () => {
        expect.assertions(4);

        const many = Array.from({ length: 1000 }, (_, index) => createTableDiff("t", [{ type: "insert", data: { id: String(index) } }], index));

        const merged = mergeDiffs(many);

        expect(merged).not.toBeNull();
        // `merge:` + a fixed-width 16-hex digest — bounded no matter how many
        // children were merged (not O(N) in the child count).
        expect(merged!.id).toMatch(/^merge:[\da-f]{16}$/);

        // Merging an already-merged diff must NOT compound the prefix
        // (`merge:merge:…`) or grow the id.
        const remerged = mergeDiffs([merged!, createTableDiff("t", [{ type: "insert", data: { id: "x" } }], 2000)]);

        expect(remerged!.id).toMatch(/^merge:[\da-f]{16}$/);
        expect((remerged!.id ?? "").match(/merge:/g) ?? []).toHaveLength(1);
    });

    it("mints the SAME merged id for the SAME child sequence, a different id otherwise", () => {
        expect.assertions(3);

        const a = createTableDiff("t", [{ type: "insert", data: { id: "1" } }], 10, "diff-a");
        const b = createTableDiff("t", [{ type: "insert", data: { id: "2" } }], 20, "diff-b");
        const c = createTableDiff("t", [{ type: "insert", data: { id: "3" } }], 30, "diff-c");

        // Same ordered children → identical deterministic id.
        expect(mergeDiffs([a, b])!.id).toBe(mergeDiffs([a, b])!.id);

        // A different child sequence → a different id.
        expect(mergeDiffs([a, b])!.id).not.toBe(mergeDiffs([a, c])!.id);
        // Order matters.
        expect(mergeDiffs([a, b])!.id).not.toBe(mergeDiffs([b, a])!.id);
    });
});

// ─── EventLog ─────────────────────────────────────────────────────────

describe(EventLog, () => {
    it("starts empty", () => {
        expect.assertions(2);

        const log = new EventLog();

        expect(log.isEmpty).toBe(true);
        expect(log.size).toBe(0);
    });

    it("appends entries with monotonically increasing seq", () => {
        expect.assertions(3);

        const log = new EventLog();

        const e1 = log.append("test", { msg: "first" });
        const e2 = log.append("test", { msg: "second" });

        expect(e1.seq).toBe(0);
        expect(e2.seq).toBe(1);
        expect(log.size).toBe(2);
    });

    it("assigns timestamps on append", () => {
        expect.assertions(2);

        const log = new EventLog();
        const entry = log.append("test", null);

        expect(entry.timestamp).toBeGreaterThan(0);
        expect(entry.type).toBe("test");
    });

    it("getSince returns entries from watermark", () => {
        expect.assertions(3);

        const log = new EventLog();

        log.append("a", null);
        log.append("b", null);
        log.append("c", null);

        const since = log.getSince(1);

        expect(since).toHaveLength(2);
        expect(since[0]!.seq).toBe(1);
        expect(since[1]!.seq).toBe(2);
    });

    it("getSince returns all entries when sinceSeq <= 0", () => {
        expect.assertions(2);

        const log = new EventLog();

        log.append("a", null);
        log.append("b", null);

        expect(log.getSince(0)).toHaveLength(2);
        expect(log.getSince(-1)).toHaveLength(2);
    });

    it("getSince returns empty when seq is beyond end", () => {
        expect.assertions(1);

        const log = new EventLog();

        log.append("a", null);

        expect(log.getSince(99)).toEqual([]);
    });

    it("getFrom supports pagination", () => {
        expect.assertions(6);

        const log = new EventLog();

        for (let i = 0; i < 10; i += 1) {
            log.append("e", i);
        }

        const page1 = log.getFrom(0, 4);

        expect(page1.entries).toHaveLength(4);
        expect(page1.hasMore).toBe(true);

        const page2 = log.getFrom(4, 4);

        expect(page2.entries).toHaveLength(4);
        expect(page2.hasMore).toBe(true);

        const page3 = log.getFrom(8, 4);

        expect(page3.entries).toHaveLength(2);
        expect(page3.hasMore).toBe(false);
    });

    it("getFrom rejects a limit that cannot make progress", () => {
        expect.assertions(3);

        const log = new EventLog();

        log.append("a", null);

        // `{ entries: [], hasMore: true }` is what these used to return, which
        // spins a paginating caller on a page it can never advance past.
        expect(() => log.getFrom(0, 0)).toThrow(RangeError);
        expect(() => log.getFrom(0, -1)).toThrow(RangeError);
        expect(() => log.getFrom(0, Number.NaN)).toThrow(RangeError);
    });

    it("append keeps an InputEvent's own timestamp", () => {
        expect.assertions(1);

        const log = new EventLog();

        log.append({ payload: { n: 1 }, timestamp: 111, type: "a" });

        expect(log.getSince(0)[0]?.timestamp).toBe(111);
    });

    it("getFrom returns empty when fromSeq is beyond end", () => {
        expect.assertions(2);

        const log = new EventLog();

        log.append("a", null);

        expect(log.getFrom(99).entries).toEqual([]);
        expect(log.getFrom(99).hasMore).toBe(false);
    });

    it("snapshot captures full state", () => {
        expect.assertions(2);

        const log = new EventLog();

        log.append("a", { x: 1 });
        log.append("b", { y: 2 });

        const snap = log.snapshot();

        expect(snap.entries).toHaveLength(2);
        expect(snap.nextSeq).toBe(2);
    });

    it("load restores from snapshot", () => {
        expect.assertions(3);

        const log1 = new EventLog();

        log1.append("a", 1);
        log1.append("b", 2);

        const log2 = new EventLog();

        log2.load(log1.snapshot());

        expect(log2.size).toBe(2);
        expect(log2.nextSeq).toBe(2);
        expect(log2.getSince(0)).toHaveLength(2);
    });

    it("clear removes all entries", () => {
        expect.assertions(3);

        const log = new EventLog();

        log.append("a", null);
        log.clear();

        expect(log.isEmpty).toBe(true);
        expect(log.size).toBe(0);
        expect(log.nextSeq).toBe(0);
    });

    it("stores table diffs on entries", () => {
        expect.assertions(2);

        const log = new EventLog();
        const diff = createTableDiff("users", [{ type: "insert", data: { id: "1" } }]);

        const entry = log.append("mutation", { table: "users" }, [diff]);

        expect(entry.tableDiffs).toHaveLength(1);
        expect(entry.tableDiffs![0]!.table).toBe("users");
    });

    // ── headSeq ───────────────────────────────────────────────────────

    it("headSeq is null for empty log", () => {
        expect.assertions(1);

        const log = new EventLog();

        expect(log.headSeq).toBeNull();
    });

    it("headSeq tracks last appended entry", () => {
        expect.assertions(2);

        const log = new EventLog();

        log.append("a", null);

        expect(log.headSeq).toBe(0);

        log.append("b", null);

        expect(log.headSeq).toBe(1);
    });

    it("load restores headSeq from snapshot", () => {
        expect.assertions(3);

        const log1 = new EventLog();

        log1.append("a", 1);
        log1.append("b", 2);

        const snap = log1.snapshot();

        expect(snap.headSeq).toBe(1);

        const log2 = new EventLog();

        log2.load(snap);

        expect(log2.headSeq).toBe(1);
        expect(log2.size).toBe(2);
    });

    it("snapshot captures headSeq", () => {
        expect.assertions(2);

        const log = new EventLog();

        const snap1 = log.snapshot();

        expect(snap1.headSeq).toBeNull();

        log.append("x", null);

        const snap2 = log.snapshot();

        expect(snap2.headSeq).toBe(0);
    });

    // ── AppendOptions ──────────────────────────────────────────────────

    it("append accepts clientId and sessionId metadata", () => {
        expect.assertions(2);

        const log = new EventLog();

        const entry = log.append("test", { msg: "hello" }, undefined, {
            clientId: "client-1",
            sessionId: "session-a",
        });

        expect(entry.clientId).toBe("client-1");
        expect(entry.sessionId).toBe("session-a");
    });

    it("append with InputEvent accepts AppendOptions", () => {
        expect.assertions(2);

        const log = new EventLog();
        const input: InputEvent<string, { n: number }> = { type: "test", payload: { n: 1 }, timestamp: Date.now() };

        const entry = log.append(input, {
            clientId: "client-2",
            parentSeqNum: 0,
        });

        expect(entry.clientId).toBe("client-2");
        expect(entry.parentSeqNum).toBe(0);
    });

    it("append auto-assigns parentSeqNum from head", () => {
        expect.assertions(3);

        const log = new EventLog();

        const e1 = log.append("a", null);

        expect(e1.parentSeqNum).toBeUndefined();

        const e2 = log.append("b", null);

        expect(e2.parentSeqNum).toBe(0);

        const e3 = log.append("c", null);

        expect(e3.parentSeqNum).toBe(1);
    });

    it("append accepts explicit parentSeqNum overriding auto", () => {
        expect.assertions(1);

        const log = new EventLog();

        log.append("a", null); // seq 0
        log.append("b", null); // seq 1

        // Force parent to seq 0 instead of auto (seq 1)
        const entry = log.append("c", null, undefined, { parentSeqNum: 0 });

        expect(entry.parentSeqNum).toBe(0);
    });

    // ── commitAll ──────────────────────────────────────────────────────

    it("commitAll appends multiple entries atomically", () => {
        expect.assertions(5);

        const log = new EventLog();

        const entries = log.commitAll([
            { type: "a", payload: { n: 1 } },
            { type: "b", payload: { n: 2 } },
            { type: "c", payload: { n: 3 } },
        ]);

        expect(entries).toHaveLength(3);
        expect(log.size).toBe(3);
        expect(entries[0]!.seq).toBe(0);
        expect(entries[1]!.seq).toBe(1);
        expect(entries[2]!.seq).toBe(2);
    });

    it("commitAll returns empty array for empty input", () => {
        expect.assertions(2);

        const log = new EventLog();

        const entries = log.commitAll([]);

        expect(entries).toEqual([]);
        expect(log.isEmpty).toBe(true);
    });

    it("commitAll wires causal chain within the batch", () => {
        expect.assertions(3);

        const log = new EventLog();

        const entries = log.commitAll([
            { type: "a", payload: null },
            { type: "b", payload: null },
            { type: "c", payload: null },
        ]);

        expect(entries[0]!.parentSeqNum).toBeUndefined();
        expect(entries[1]!.parentSeqNum).toBe(0);
        expect(entries[2]!.parentSeqNum).toBe(1);
    });

    it("commitAll chains from head when log has prior entries", () => {
        expect.assertions(3);

        const log = new EventLog();

        log.append("prior", null); // seq 0, headSeq = 0

        const entries = log.commitAll([
            { type: "a", payload: null },
            { type: "b", payload: null },
        ]);

        // First batch entry's parent is the prior head (seq 0)
        expect(entries[0]!.parentSeqNum).toBe(0);
        // Second batch entry's parent is the first batch entry (seq 1)
        expect(entries[1]!.parentSeqNum).toBe(1);
        // headSeq advanced to last entry in batch
        expect(log.headSeq).toBe(2);
    });

    it("commitAll updates headSeq", () => {
        expect.assertions(2);

        const log = new EventLog();

        log.commitAll([{ type: "x", payload: null }]);

        expect(log.headSeq).toBe(0);

        log.commitAll([{ type: "y", payload: null }]);

        expect(log.headSeq).toBe(1);
    });

    // REPLICA-06: bounded in-memory growth ─────────────────────────────

    it("maxEntries caps the log — a long run does not grow it unboundedly", () => {
        expect.assertions(4);

        const log = new EventLog({ maxEntries: 5 });

        for (let index = 0; index < 100; index += 1) {
            log.append("tick", index);
        }

        expect(log.size).toBe(5);
        // headSeq/nextSeq are independent counters — unaffected by eviction.
        expect(log.headSeq).toBe(99);
        expect(log.nextSeq).toBe(100);

        // Only the newest entries survive (oldest-first eviction).
        const remaining = log.getSince(0);

        expect(remaining.map((e) => e.seq)).toStrictEqual([95, 96, 97, 98, 99]);
    });

    it("maxEntries caps commitAll batches too", () => {
        expect.assertions(2);

        const log = new EventLog({ maxEntries: 3 });

        log.commitAll(
            Array.from({ length: 10 }, (_unused, index) => ({
                type: "tick",
                payload: index,
            })),
        );

        expect(log.size).toBe(3);
        expect(log.getSince(0).map((e) => e.seq)).toStrictEqual([7, 8, 9]);
    });

    it("without maxEntries the log stays unbounded (default, backward-compatible)", () => {
        expect.assertions(1);

        const log = new EventLog();

        for (let index = 0; index < 50; index += 1) {
            log.append("tick", index);
        }

        expect(log.size).toBe(50);
    });

    it("truncateBelow discards entries below the floor without disturbing headSeq/nextSeq", () => {
        expect.assertions(6);

        const log = new EventLog();

        log.append("a", null);
        log.append("b", null);
        log.append("c", null);

        log.truncateBelow(2);

        expect(log.size).toBe(1);
        expect(log.getSince(0).map((e) => e.seq)).toStrictEqual([2]);
        expect(log.headSeq).toBe(2);
        expect(log.nextSeq).toBe(3);

        // Appends after truncation continue the same sequence.
        const next = log.append("d", null);

        expect(next.seq).toBe(3);
        expect(log.size).toBe(2);
    });

    it("truncateBelow a floor past every entry empties the log", () => {
        expect.assertions(2);

        const log = new EventLog();

        log.append("a", null);
        log.append("b", null);

        log.truncateBelow(99);

        expect(log.size).toBe(0);
        expect(log.headSeq).toBe(1); // unaffected — still the real head
    });

    it("truncateBelow(0) is a no-op", () => {
        expect.assertions(1);

        const log = new EventLog();

        log.append("a", null);
        log.append("b", null);

        log.truncateBelow(0);

        expect(log.size).toBe(2);
    });
});

// ─── applyDiff ────────────────────────────────────────────────────────

describe(applyDiff, () => {
    it("inserts new rows", () => {
        expect.assertions(1);

        const rows = new Map<string, Record<string, unknown>>();
        const diff = createTableDiff("t", [{ type: "insert", data: { id: "1", name: "alice" } }]);

        const next = applyDiff(rows, diff);

        expect(next.get("1")).toEqual({ id: "1", name: "alice" });
    });

    it("inserts row with auto-generated id when missing", () => {
        expect.assertions(4);

        const rows = new Map<string, Record<string, unknown>>();
        const diff = createTableDiff("t", [{ type: "insert", data: { name: "bob" } }]);

        const next = applyDiff(rows, diff);

        expect(next.size).toBe(1);

        const [key, val] = next.entries().next().value as [string, Record<string, unknown>];

        expect(key).toBeTypeOf("string");
        expect(val.name).toBe("bob");
        expect(val.id).toBe(key);
    });

    // REPLICA-05: replay determinism — re-applying the exact same diff must
    // derive the exact same id every time, not a fresh `crypto.randomUUID()`.
    it("derives the SAME id when the same id-less diff is replayed", () => {
        expect.assertions(2);

        const diff = createTableDiff("t", [{ type: "insert", data: { name: "bob" } }], 1000);

        const first = applyDiff(new Map(), diff);
        const second = applyDiff(new Map(), diff);

        const [firstKey] = [...first.keys()];
        const [secondKey] = [...second.keys()];

        expect(firstKey).toBe(secondKey);
        expect(first.get(firstKey as string)).toStrictEqual(second.get(secondKey as string));
    });

    it("derives ONE id for id-less inserts with identical data, whatever their position in the diff", () => {
        expect.assertions(1);

        // Position was in the digest so two identical rows in one diff stayed
        // distinct; it also made a re-emitted mirror frame land under a new key
        // whenever the row moved. Content-only keying trades the first for the
        // second, which is the one that grew without bound.
        const diff = createTableDiff(
            "t",
            [
                { type: "insert", data: { name: "dup" } },
                { type: "insert", data: { name: "dup" } },
            ],
            1000,
        );

        const next = applyDiff(new Map(), diff);

        expect(next.size).toBe(1);
    });

    it("derives DIFFERENT ids for id-less inserts with different content", () => {
        expect.assertions(1);

        const diffA = createTableDiff("t", [{ type: "insert", data: { name: "alice" } }], 1000);
        const diffB = createTableDiff("t", [{ type: "insert", data: { name: "bob" } }], 1000);

        const [keyA] = [...applyDiff(new Map(), diffA).keys()];
        const [keyB] = [...applyDiff(new Map(), diffB).keys()];

        expect(keyA).not.toBe(keyB);
    });

    it("updates existing rows", () => {
        expect.assertions(1);

        const rows = new Map([["1", { id: "1", name: "alice", age: 30 }]]);
        const diff = createTableDiff("t", [{ type: "update", id: "1", data: { age: 31 } }]);

        const next = applyDiff(rows, diff);

        expect(next.get("1")).toEqual({ id: "1", name: "alice", age: 31 });
    });

    it("skips update for unknown row", () => {
        expect.assertions(1);

        const rows = new Map<string, Record<string, unknown>>();
        const diff = createTableDiff("t", [{ type: "update", id: "missing", data: { x: 1 } }]);

        const next = applyDiff(rows, diff);

        expect(next.size).toBe(0);
    });

    it("deletes a row", () => {
        expect.assertions(2);

        const rows = new Map([["1", { id: "1", name: "alice" }]]);
        const diff = createTableDiff("t", [{ type: "delete", id: "1" }]);

        const next = applyDiff(rows, diff);

        expect(next.has("1")).toBe(false);
        expect(next.size).toBe(0);
    });

    it("does not mutate the original map", () => {
        expect.assertions(1);

        const rows = new Map([["1", { id: "1", name: "alice" }]]);
        const diff = createTableDiff("t", [{ type: "delete", id: "1" }]);

        applyDiff(rows, diff);

        expect(rows.has("1")).toBe(true);
    });

    it("handles mixed changes in one pass", () => {
        expect.assertions(4);

        const rows = new Map([
            ["1", { id: "1", name: "alice" }],
            ["2", { id: "2", name: "bob" }],
        ]);

        const diff = createTableDiff("t", [
            { type: "update", id: "1", data: { name: "alice-updated" } },
            { type: "delete", id: "2" },
            { type: "insert", data: { id: "3", name: "charlie" } },
        ]);

        const next = applyDiff(rows, diff);

        expect(next.size).toBe(2);
        expect(next.get("1")?.name).toBe("alice-updated");
        expect(next.has("2")).toBe(false);
        expect(next.get("3")?.name).toBe("charlie");
    });
});

describe(applyDiffs, () => {
    it("applies multiple diffs in order", () => {
        expect.assertions(1);

        const rows = new Map<string, Record<string, unknown>>();

        const diffs = [
            createTableDiff("t", [{ type: "insert", data: { id: "1", name: "alice" } }]),
            createTableDiff("t", [{ type: "update", id: "1", data: { name: "bob" } }]),
        ];

        const next = applyDiffs(rows, diffs);

        expect(next.get("1")?.name).toBe("bob");
    });
});

describe(applyDiffToSnapshot, () => {
    it("updates the correct table map in the snapshot", () => {
        expect.assertions(1);

        const users = new Map([["1", { id: "1", name: "alice" }]]);
        const state = new Map([["users", users]]);

        const diff = createTableDiff("users", [{ type: "update", id: "1", data: { name: "bob" } }]);
        const next = applyDiffToSnapshot(state, diff);

        expect(next.get("users")?.get("1")?.name).toBe("bob");
    });

    it("creates a new table map when it does not exist", () => {
        expect.assertions(1);

        const state = new Map<string, Map<string, Record<string, unknown>>>();

        const diff = createTableDiff("users", [{ type: "insert", data: { id: "1", name: "alice" } }]);
        const next = applyDiffToSnapshot(state, diff);

        expect(next.get("users")?.get("1")?.name).toBe("alice");
    });

    it("does not mutate the original snapshot", () => {
        expect.assertions(1);

        const users = new Map([["1", { id: "1", name: "alice" }]]);
        const state = new Map([["users", users]]);

        const diff = createTableDiff("users", [{ type: "delete", id: "1" }]);
        applyDiffToSnapshot(state, diff);

        expect(state.get("users")?.has("1")).toBe(true);
    });
});
