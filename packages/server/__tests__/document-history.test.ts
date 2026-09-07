import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defineDocumentHistory, DOCUMENT_HISTORY_TABLE } from "../src/document-history";
import type { TriggerBuilder, TriggerCtx, TriggerDefinition } from "../src/index";

/**
 * Minimal in-memory `db` covering the slice this preset uses: `insert`,
 * `delete`, and `query(table).withIndex(...).order(...).take(...)` where the
 * index range builds `eq` / `lt` / `lte` predicates. Ordered reads sort by
 * `recordedAt`, the only column either index orders on.
 */
type Predicate = (row: Record<string, unknown>) => boolean;

const byRecordedAt = (rows: Record<string, unknown>[], direction: "asc" | "desc"): Record<string, unknown>[] =>
    // The index keys, in order — `[..., recordedAt, seq]`. Sorting on `recordedAt`
    // alone would leave the double unable to express the ordering the real index
    // gives, and the tie-break tests would fail against correct code.
    rows.toSorted((a, b) => {
        const byTime = (a["recordedAt"] as number) - (b["recordedAt"] as number);
        const delta = byTime === 0 ? (a["seq"] as number) - (b["seq"] as number) : byTime;

        return direction === "asc" ? delta : -delta;
    });

/** Emulate one index read: the table filter plus the predicates the range built. */
const matchRows = (rows: Map<string, Record<string, unknown>>, table: string, predicates: Predicate[]): Record<string, unknown>[] =>
    [...rows.values()].filter((row) => (row["__table"] as string) === table && predicates.every((predicate) => predicate(row)));

const equals =
    (field: string, value: unknown): Predicate =>
    (row) =>
        row[field] === value;

const lessThan =
    (field: string, value: unknown): Predicate =>
    (row) =>
        (row[field] as number) < (value as number);

const atMost =
    (field: string, value: unknown): Predicate =>
    (row) =>
        (row[field] as number) <= (value as number);

/** The `q` handed to `withIndex(name, (q) => …)`; only the three comparisons this preset uses. */
const createRangeBuilder = (predicates: Predicate[]) => {
    const builder = {
        eq(field: string, value: unknown) {
            predicates.push(equals(field, value));

            return builder;
        },
        lt(field: string, value: unknown) {
            predicates.push(lessThan(field, value));

            return builder;
        },
        lte(field: string, value: unknown) {
            predicates.push(atMost(field, value));

            return builder;
        },
    };

    return builder;
};

const createMemoryDb = () => {
    const rows = new Map<string, Record<string, unknown>>();
    // Every `take(n)` the reader was asked for. A clamp on a caller-supplied
    // `limit` is invisible in the returned rows on a small fixture — the bound
    // that matters is the one handed to the index scan, so record it.
    const takes: number[] = [];
    let nextId = 1;
    // Stands in for `.commitOrdered()`: a per-shard integer allocated ONCE per
    // mutation and strictly increasing in commit order. `commit()` opens the next
    // one, so a test can express "these writes shared a mutation" and "this write
    // came from a later one" — including across a simulated restart.
    let commitSeq = 1;

    const makeReader = (table: string) => {
        const predicates: Predicate[] = [];
        let direction: "asc" | "desc" | undefined;

        const resolved = (): Record<string, unknown>[] => {
            const matched = matchRows(rows, table, predicates);

            return direction === undefined ? matched : byRecordedAt(matched, direction);
        };

        const reader = {
            first: async () => resolved()[0] ?? null,
            order(requested: "asc" | "desc") {
                direction = requested;

                return reader;
            },
            take: async (limit: number) => {
                takes.push(limit);

                return resolved().slice(0, limit);
            },
            withIndex(_name: string, range?: (q: unknown) => unknown) {
                range?.(createRangeBuilder(predicates));

                return reader;
            },
        };

        return reader;
    };

    return {
        delete: async (id: string) => {
            rows.delete(id);
        },
        takes,
        insert: async (table: string, document: Record<string, unknown>) => {
            const id = `${table}|${String(nextId)}`;

            nextId += 1;
            rows.set(id, { ...document, __table: table, _commitSeq: commitSeq, _creationTime: Date.now(), _id: id });

            return id;
        },
        /** Open the next mutation, the way a fresh dispatch does. */
        commit: () => {
            commitSeq += 1;
        },
        query: (table: string) => makeReader(table),
        rows,
    };
};

type MemoryDb = ReturnType<typeof createMemoryDb>;

const triggerContextFor = (db: MemoryDb): TriggerCtx => ({ db }) as unknown as TriggerCtx;

const entries = (db: MemoryDb): Record<string, unknown>[] => [...db.rows.values()].filter((row) => row["__table"] === DOCUMENT_HISTORY_TABLE);

/**
 * Collect the trigger definitions the recorder builds, capturing each handler so
 * a test can fire it the way the write path would.
 */
const capture = (build: (t: TriggerBuilder) => Record<string, TriggerDefinition>) => {
    const handlers: Record<string, TriggerDefinition["handler"]> = {};
    const bind =
        (op: string) =>
        (handler: TriggerDefinition["handler"]): TriggerDefinition => {
            handlers[op] = handler;

            return { handler, op, timing: "after" } as unknown as TriggerDefinition;
        };

    const builder = {
        afterDelete: bind("delete"),
        afterInsert: bind("insert"),
        afterUpdate: bind("update"),
        beforeDelete: bind("beforeDelete"),
        beforeInsert: bind("beforeInsert"),
        beforeUpdate: bind("beforeUpdate"),
    } as unknown as TriggerBuilder;

    const definitions = build(builder);

    return { definitions, handlers };
};

describe("defineDocumentHistory — recording", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("binds all three after-triggers and no before-triggers", () => {
        expect.assertions(2);

        const history = defineDocumentHistory();
        const { definitions, handlers } = capture(history.record);

        // A `before*` handler runs while the write can still be aborted, so an
        // entry written there could describe a write that never landed.
        expect(Object.keys(handlers).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["delete", "insert", "update"]);
        expect(Object.keys(definitions)).toHaveLength(3);
    });

    it("records an insert with the new row and no previous", async () => {
        expect.assertions(4);

        const db = createMemoryDb();
        const history = defineDocumentHistory();
        const { handlers } = capture(history.record);

        vi.setSystemTime(1000);
        await handlers["insert"]?.(triggerContextFor(db), {
            doc: { title: "a" },
            id: "thread_1",
            op: "insert",
            table: "threads",
        } as never);

        const [entry] = entries(db);

        expect(entry?.["op"]).toBe("insert");
        expect(entry?.["documentId"]).toBe("thread_1");
        expect(entry?.["recordedAt"]).toBe(1000);
        expect(entry?.["previous"]).toBeUndefined();
    });

    it("records an update with both sides", async () => {
        expect.assertions(2);

        const db = createMemoryDb();
        const history = defineDocumentHistory();
        const { handlers } = capture(history.record);

        vi.setSystemTime(1000);
        await handlers["update"]?.(triggerContextFor(db), {
            doc: { title: "b" },
            id: "thread_1",
            op: "update",
            previous: { title: "a" },
            table: "threads",
        } as never);

        const [entry] = entries(db);

        expect(JSON.parse(entry?.["doc"] as string)).toStrictEqual({ title: "b" });
        expect(JSON.parse(entry?.["previous"] as string)).toStrictEqual({ title: "a" });
    });

    it("records a delete with the pre-write row and no doc", async () => {
        expect.assertions(2);

        const db = createMemoryDb();
        const history = defineDocumentHistory();
        const { handlers } = capture(history.record);

        vi.setSystemTime(1000);
        await handlers["delete"]?.(triggerContextFor(db), {
            id: "thread_1",
            op: "delete",
            previous: { title: "a" },
            table: "threads",
        } as never);

        const [entry] = entries(db);

        expect(entry?.["doc"]).toBeUndefined();
        expect(JSON.parse(entry?.["previous"] as string)).toStrictEqual({ title: "a" });
    });

    it("drops secret-shaped fields from both snapshots", async () => {
        expect.assertions(3);

        const db = createMemoryDb();
        const history = defineDocumentHistory();
        const { handlers } = capture(history.record);

        vi.setSystemTime(1000);
        await handlers["update"]?.(triggerContextFor(db), {
            doc: { email: "a@b.c", hashedPassword: "new-hash" },
            id: "user_1",
            op: "update",
            previous: { email: "a@b.c", hashedPassword: "old-hash" },
            table: "users",
        } as never);

        const [entry] = entries(db);
        const serialized = `${entry?.["doc"] as string}${entry?.["previous"] as string}`;

        // A stored credential outlives the rotation meant to retire it.
        expect(serialized).not.toContain("new-hash");
        expect(serialized).not.toContain("old-hash");
        expect(JSON.parse(entry?.["doc"] as string)).toStrictEqual({ email: "a@b.c" });
    });

    it("walks a Map/Set column — the wire codec round-trips both, and a Map holds NAMED keys", async () => {
        expect.assertions(2);

        const db = createMemoryDb();
        const history = defineDocumentHistory();
        const { handlers } = capture(history.record);

        vi.setSystemTime(1000);
        await handlers["insert"]?.(triggerContextFor(db), {
            doc: {
                oauth: new Map([
                    ["provider", "github"],
                    ["refreshToken", "rt-secret"],
                ]),
                sessions: new Set([{ hashedPassword: "hp-secret", id: "s1" }]),
            },
            id: "user_1",
            op: "insert",
            table: "users",
        } as never);

        // A `Map` was passed through whole as a "wire codec leaf that holds no
        // named field" — it holds named fields, and this table retains what it is
        // given for months.
        const serialized = entries(db)[0]?.["doc"] as string;

        expect(serialized).not.toContain("rt-secret");
        expect(serialized).not.toContain("hp-secret");
    });

    it("drops the caller's extra redacted fields too", async () => {
        expect.assertions(1);

        const db = createMemoryDb();
        const history = defineDocumentHistory({ redact: ["inviteToken"] });
        const { handlers } = capture(history.record);

        vi.setSystemTime(1000);
        await handlers["insert"]?.(triggerContextFor(db), {
            doc: { inviteToken: "tok", name: "n" },
            id: "org_1",
            op: "insert",
            table: "orgs",
        } as never);

        expect(JSON.parse(entries(db)[0]?.["doc"] as string)).toStrictEqual({ name: "n" });
    });

    it("keeps the entry but drops the snapshot past the size cap", async () => {
        expect.assertions(3);

        const db = createMemoryDb();
        const history = defineDocumentHistory({ maxSnapshotBytes: 32 });
        const { handlers } = capture(history.record);

        vi.setSystemTime(1000);
        await handlers["insert"]?.(triggerContextFor(db), {
            doc: { blob: "x".repeat(500) },
            id: "doc_1",
            op: "insert",
            table: "documents",
        } as never);

        const [entry] = entries(db);

        // "This row changed, at this time" is the part a trail cannot lose.
        expect(entry?.["truncated"]).toBe(true);
        expect(entry?.["doc"]).toBeUndefined();
        expect(entry?.["recordedAt"]).toBe(1000);
    });
});

describe("defineDocumentHistory — listForDocument", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    const seed = async (db: MemoryDb, history: ReturnType<typeof defineDocumentHistory>): Promise<void> => {
        const { handlers } = capture(history.record);

        vi.setSystemTime(1000);
        await handlers["insert"]?.(triggerContextFor(db), { doc: { title: "a" }, id: "thread_1", op: "insert", table: "threads" } as never);
        vi.setSystemTime(2000);
        await handlers["update"]?.(triggerContextFor(db), {
            doc: { title: "b" },
            id: "thread_1",
            op: "update",
            previous: { title: "a" },
            table: "threads",
        } as never);
        vi.setSystemTime(3000);
        await handlers["update"]?.(triggerContextFor(db), {
            doc: { title: "c" },
            id: "thread_1",
            op: "update",
            previous: { title: "b" },
            table: "threads",
        } as never);
        vi.setSystemTime(1500);
        await handlers["insert"]?.(triggerContextFor(db), { doc: { title: "x" }, id: "thread_2", op: "insert", table: "threads" } as never);
    };

    it("returns one row's versions newest first", async () => {
        expect.assertions(2);

        const db = createMemoryDb();
        const history = defineDocumentHistory();

        await seed(db, history);

        const result = await history.functions.listForDocument.handler({ db }, { documentId: "thread_1" });

        expect(result.map((entry) => entry.recordedAt)).toStrictEqual([3000, 2000, 1000]);
        expect(result[0]?.doc).toStrictEqual({ title: "c" });
    });

    it("bounds by `before`, so the first entry is the version as of that instant", async () => {
        expect.assertions(2);

        const db = createMemoryDb();
        const history = defineDocumentHistory();

        await seed(db, history);

        const result = await history.functions.listForDocument.handler({ db }, { before: 2500, documentId: "thread_1" });

        expect(result[0]?.recordedAt).toBe(2000);
        expect(result[0]?.doc).toStrictEqual({ title: "b" });
    });

    it("does not leak another row's versions", async () => {
        expect.assertions(1);

        const db = createMemoryDb();
        const history = defineDocumentHistory();

        await seed(db, history);

        const result = await history.functions.listForDocument.handler({ db }, { documentId: "thread_1" });

        expect(result.every((entry) => entry.documentId === "thread_1")).toBe(true);
    });
});

describe("defineDocumentHistory — vacuum", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("deletes only entries past the retention window", async () => {
        expect.assertions(3);

        const db = createMemoryDb();
        const history = defineDocumentHistory({ retentionMs: 10_000 });
        const { handlers } = capture(history.record);

        vi.setSystemTime(1000);
        await handlers["insert"]?.(triggerContextFor(db), { doc: {}, id: "old", op: "insert", table: "threads" } as never);
        vi.setSystemTime(9000);
        await handlers["insert"]?.(triggerContextFor(db), { doc: {}, id: "fresh", op: "insert", table: "threads" } as never);

        vi.setSystemTime(1000 + 10_500);
        const result = await history.functions.vacuum.handler({ db }, {});

        expect(result.deleted).toBe(1);
        expect(entries(db)).toHaveLength(1);
        expect(entries(db)[0]?.["documentId"]).toBe("fresh");
    });

    it("honours the limit so a caller can decide whether to run again", async () => {
        expect.assertions(2);

        const db = createMemoryDb();
        const history = defineDocumentHistory({ retentionMs: 1000 });
        const { handlers } = capture(history.record);

        vi.setSystemTime(1000);
        for (const id of ["a", "b", "c"]) {
            // eslint-disable-next-line no-await-in-loop -- deterministic order matters for the assertion below
            await handlers["insert"]?.(triggerContextFor(db), { doc: {}, id, op: "insert", table: "threads" } as never);
        }

        vi.setSystemTime(100_000);
        const result = await history.functions.vacuum.handler({ db }, { limit: 2 });

        expect(result.deleted).toBe(2);
        expect(entries(db)).toHaveLength(1);
    });
});

describe("defineDocumentHistory — snapshot fidelity", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("drops a nested credential, not only a top-level one", async () => {
        expect.assertions(2);

        const db = createMemoryDb();
        const history = defineDocumentHistory();
        const { handlers } = capture(history.record);

        vi.setSystemTime(1000);
        await handlers["insert"]?.(triggerContextFor(db), {
            doc: { connections: [{ label: "gh", refreshToken: "nested-secret" }], oauth: { apiKey: "deep-secret" }, name: "n" },
            id: "user_1",
            op: "insert",
            table: "users",
        } as never);

        const serialized = entries(db)[0]?.["doc"] as string;

        // This table retains what it is given for months, so a credential one level
        // down is the same problem as one at the root.
        expect(serialized).not.toContain("deep-secret");
        expect(serialized).not.toContain("nested-secret");
    });

    it("records a bigint column instead of aborting the write", async () => {
        expect.assertions(2);

        const db = createMemoryDb();
        const history = defineDocumentHistory();
        const { handlers } = capture(history.record);

        vi.setSystemTime(1000);

        // This runs in an AFTER-trigger: a throw here would roll back the write it
        // is recording, so a `v.bigint()` column would break every insert, update
        // and delete on any table with history attached.
        await expect(
            handlers["insert"]?.(triggerContextFor(db), {
                doc: { total: 9_007_199_254_740_993n },
                id: "invoice_1",
                op: "insert",
                table: "invoices",
            } as never),
        ).resolves.toBeUndefined();

        const result = await history.functions.listForDocument.handler({ db }, { documentId: "invoice_1" });

        expect(result[0]?.doc?.["total"]).toBe(9_007_199_254_740_993n);
    });

    it("caps doc and previous independently", async () => {
        expect.assertions(3);

        const db = createMemoryDb();
        const history = defineDocumentHistory({ maxSnapshotBytes: 128 });
        const { handlers } = capture(history.record);

        vi.setSystemTime(1000);
        await handlers["update"]?.(triggerContextFor(db), {
            doc: { title: "small" },
            id: "doc_1",
            op: "update",
            previous: { blob: "x".repeat(500) },
            table: "documents",
        } as never);

        const [entry] = entries(db);

        // A large `previous` must not discard a small `doc` — usually the more
        // useful half of the pair.
        expect(entry?.["doc"]).toBeDefined();
        expect(entry?.["previous"]).toBeUndefined();
        expect(entry?.["truncated"]).toBe(true);
    });

    it("orders entries written in the same millisecond", async () => {
        expect.assertions(1);

        const db = createMemoryDb();
        const history = defineDocumentHistory();
        const { handlers } = capture(history.record);

        // Workers do not advance the clock between I/O operations, so every entry
        // from one mutation shares a `recordedAt`. Without a tie-breaker these come
        // back in an arbitrary order and a point-in-time read picks at random.
        vi.setSystemTime(1000);
        await handlers["update"]?.(triggerContextFor(db), {
            doc: { title: "b" },
            id: "thread_1",
            op: "update",
            previous: { title: "a" },
            table: "threads",
        } as never);
        await handlers["update"]?.(triggerContextFor(db), {
            doc: { title: "c" },
            id: "thread_1",
            op: "update",
            previous: { title: "b" },
            table: "threads",
        } as never);

        const result = await history.functions.listForDocument.handler({ db }, { documentId: "thread_1" });

        expect(result[0]?.doc).toStrictEqual({ title: "c" });
    });
});

describe("defineDocumentHistory — ordering across a restart", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("keeps commit order when the in-process counter has been reset", async () => {
        expect.assertions(2);

        const db = createMemoryDb();

        // Two components over one table: the second stands in for the shard
        // restarting, which resets the in-process `seq` to zero. The clock is
        // pinned to the same instant throughout, so `recordedAt` cannot break the
        // tie either — only the durable `_commitSeq` can.
        const before = defineDocumentHistory();
        const after = defineDocumentHistory();

        vi.setSystemTime(1000);
        await capture(before.record).handlers["update"]?.(triggerContextFor(db), {
            doc: { title: "first" },
            id: "thread_1",
            op: "update",
            previous: { title: "zero" },
            table: "threads",
        } as never);

        db.commit();

        await capture(after.record).handlers["update"]?.(triggerContextFor(db), {
            doc: { title: "second" },
            id: "thread_1",
            op: "update",
            previous: { title: "first" },
            table: "threads",
        } as never);

        const result = await after.functions.listForDocument.handler({ db }, { documentId: "thread_1" });

        expect(result[0]?.doc).toStrictEqual({ title: "second" });
        expect(result[1]?.doc).toStrictEqual({ title: "first" });
    });
});

describe("defineDocumentHistory — listForDocument clamps its limit", () => {
    it("caps a caller-supplied limit rather than passing it straight to take()", async () => {
        expect.assertions(2);

        const db = createMemoryDb();
        const history = defineDocumentHistory();

        // `take()` has no ceiling of its own, and this read returns full un-RLS'd
        // row snapshots — the one preset read that skipped the clamp its siblings
        // (`action-cache`'s purge, `presence`'s `maxSessions`) all apply.
        await history.functions.listForDocument.handler({ db }, { documentId: "thread_1", limit: 5_000_000 });

        expect(db.takes).toEqual([1000]);

        await history.functions.listForDocument.handler({ db }, { documentId: "thread_1", limit: 7 });

        expect(db.takes).toEqual([1000, 7]);
    });
});
