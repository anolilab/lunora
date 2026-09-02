/**
 * Unit tests for the secure-by-default write-path guard (`guardWriter`).
 *
 * The guard is a pure wrapper over a structural writer — no SQLite, no workerd —
 * so these run as plain Node tests. A fake writer records every call it receives;
 * assertions verify the guard DENIES protected tables (table-named + id-based)
 * under a `.rls("required")` schema, ALLOWS `.public()` ones, and is a no-op for
 * a non-required schema.
 */
import { describe, expect, it, vi } from "vitest";

import { guardWriter, RLS_UNWRAP_SYMBOL, RlsRequiredError, TABLE_FIRST_METHODS } from "../src/rls-guard";

/** A spy writer: every gated method records its table/id and returns a sentinel. */
const createFakeWriter = () => {
    return {
        aggregate: vi.fn<(tableName: string) => Promise<string>>((tableName: string) => Promise.resolve(`aggregate:${tableName}`)),
        count: vi.fn<(tableName: string) => Promise<string>>((tableName: string) => Promise.resolve(`count:${tableName}`)),
        delete: vi.fn<(id: string) => Promise<string>>((id: string) => Promise.resolve(`delete:${id}`)),
        deleteAll: vi.fn<(tableName: string) => Promise<string>>((tableName: string) => Promise.resolve(`deleteAll:${tableName}`)),
        deleteMany: vi.fn<(ids: ReadonlyArray<string>) => Promise<string>>((ids: ReadonlyArray<string>) => Promise.resolve(`deleteMany:${ids.join(",")}`)),
        findFirst: vi.fn<(tableName: string) => Promise<string>>((tableName: string) => Promise.resolve(`findFirst:${tableName}`)),
        findFirstOrThrow: vi.fn<(tableName: string) => Promise<string>>((tableName: string) => Promise.resolve(`findFirstOrThrow:${tableName}`)),
        findMany: vi.fn<(tableName: string) => Promise<string>>((tableName: string) => Promise.resolve(`findMany:${tableName}`)),
        get: vi.fn<(id: string) => Promise<string>>((id: string) => Promise.resolve(`get:${id}`)),
        groupBy: vi.fn<(tableName: string) => Promise<string>>((tableName: string) => Promise.resolve(`groupBy:${tableName}`)),
        insert: vi.fn<(tableName: string) => Promise<string>>((tableName: string) => Promise.resolve(`insert:${tableName}`)),
        // The bulk inserts: `insertManyUnsafe` skips validators and triggers, NOT
        // the guard. Both must be reachable by the `it.each` below — they were
        // gated in source but absent from this fake, so nothing proved it.
        insertMany: vi.fn<(tableName: string) => Promise<string>>((tableName: string) => Promise.resolve(`insertMany:${tableName}`)),
        insertManyUnsafe: vi.fn<(tableName: string) => Promise<string>>((tableName: string) => Promise.resolve(`insertManyUnsafe:${tableName}`)),
        lookupById: vi.fn<(id: string) => Promise<null | { row: Record<string, unknown>; tableName: string }>>((id: string) =>
            Promise.resolve({ row: { _id: id }, tableName: "sentinel" }),
        ),
        patch: vi.fn<(id: string) => Promise<string>>((id: string) => Promise.resolve(`patch:${id}`)),
        patchMany: vi.fn<(patches: ReadonlyArray<{ id: string; patch: Record<string, unknown> }>) => Promise<string>>(
            (patches: ReadonlyArray<{ id: string; patch: Record<string, unknown> }>) =>
                Promise.resolve(`patchMany:${patches.map((entry) => entry.id).join(",")}`),
        ),
        query: vi.fn<(tableName: string) => string>((tableName: string) => `query:${tableName}`),
        rank: vi.fn<(tableName: string) => Promise<string>>((tableName: string) => Promise.resolve(`rank:${tableName}`)),
        rankBefore: vi.fn<(tableName: string) => Promise<string>>((tableName: string) => Promise.resolve(`rankBefore:${tableName}`)),
        rankPage: vi.fn<(tableName: string) => Promise<string>>((tableName: string) => Promise.resolve(`rankPage:${tableName}`)),
        rankPageRows: vi.fn<(tableName: string) => Promise<string>>((tableName: string) => Promise.resolve(`rankPageRows:${tableName}`)),
        replace: vi.fn<(id: string) => Promise<string>>((id: string) => Promise.resolve(`replace:${id}`)),
    };
};

type FakeWriter = ReturnType<typeof createFakeWriter>;

/** A schema with one protected table (`posts`) and one `.public()` table (`stats`). */
const requiredSchema = {
    rlsMode: "required" as const,
    tables: {
        posts: { isPublic: false },
        stats: { isPublic: true },
    },
};

/**
 * Resolve owning table from id by a fixed map (mirrors the DO `lookupById` seam).
 * @returns the table name, or `undefined` when the id prefix is unrecognised
 */
const tableOfId = (id: string): string | undefined => {
    if (id.startsWith("post_")) {
        return "posts";
    }

    if (id.startsWith("stat_")) {
        return "stats";
    }

    return undefined;
};

describe("guardWriter — no-op for a non-required schema", () => {
    it("returns the raw writer unchanged when rlsMode is undefined", () => {
        expect.assertions(2);

        const raw = createFakeWriter();
        const guarded = guardWriter(raw as never, { tables: requiredSchema.tables }, tableOfId);

        expect(guarded).toBe(raw);
        expect((guarded as unknown as Record<PropertyKey, unknown>)[RLS_UNWRAP_SYMBOL]).toBeUndefined();
    });
});

describe("guardWriter — table-named methods under .rls('required')", () => {
    const tableMethods = [
        "aggregate",
        "count",
        "deleteAll",
        "findFirst",
        "findFirstOrThrow",
        "findMany",
        "groupBy",
        "insert",
        "insertMany",
        "insertManyUnsafe",
        "query",
        "rank",
        "rankBefore",
        "rankPage",
        "rankPageRows",
    ] as const;

    const byName = (a: string, b: string): number => a.localeCompare(b);

    it("covers every method the guard gates by table name", () => {
        expect.assertions(1);

        // Tripwire for the FIRST structural half: this hand-written list drifting
        // below `TABLE_FIRST_METHODS` is what let `insertMany` /
        // `insertManyUnsafe` be gated in source and unreachable here, so deleting
        // them from the guard left all 61 tests passing. The guard's own list is
        // now derived from an exhaustive `keyof DatabaseWriterLike` map, so a new
        // table-first method on the real writer reaches this assertion.
        expect([...tableMethods].toSorted(byName)).toStrictEqual([...TABLE_FIRST_METHODS].toSorted(byName));
    });

    it("the fake writer declares every table-first method, so it.each actually reaches them", () => {
        expect.assertions(1);

        // The SECOND structural half: `it.each` silently no-ops for a method the
        // fake never declared (the guard skips a non-function), so a green
        // `it.each` proves nothing unless the fake implements the whole set.
        const raw = createFakeWriter() as unknown as Record<string, unknown>;

        expect(TABLE_FIRST_METHODS.filter((name) => typeof raw[name] !== "function")).toStrictEqual([]);
    });

    it.each(tableMethods)("denies %s against the protected table", (method) => {
        expect.assertions(3);

        const raw = createFakeWriter();
        const guarded = guardWriter(raw as never, requiredSchema as never, tableOfId) as unknown as Record<string, (...a: unknown[]) => unknown>;

        expect(() => guarded[method]!("posts", {})).toThrow(RlsRequiredError);
        expect(() => guarded[method]!("posts", {})).toThrow(/\.rls\("required"\)/);
        expect((raw as unknown as Record<string, FakeWriter[keyof FakeWriter]>)[method]).not.toHaveBeenCalled();
    });

    it.each(tableMethods)("allows %s against the .public() table", (method) => {
        expect.assertions(2);

        const raw = createFakeWriter();
        const guarded = guardWriter(raw as never, requiredSchema as never, tableOfId) as unknown as Record<string, (...a: unknown[]) => unknown>;

        expect(() => guarded[method]!("stats", {})).not.toThrow();
        expect((raw as unknown as Record<string, FakeWriter[keyof FakeWriter]>)[method]).toHaveBeenCalledTimes(1);
    });

    it("passes an unknown table through to the raw writer (its own error owns it)", () => {
        expect.assertions(2);

        const raw = createFakeWriter();
        const guarded = guardWriter(raw as never, requiredSchema as never, tableOfId) as unknown as { findMany: (t: string, a: unknown) => unknown };

        expect(() => guarded.findMany("ghosts", {})).not.toThrow();
        expect(raw.findMany).toHaveBeenCalledWith("ghosts", {});
    });
});

describe("guardWriter — optional analytical methods omitted on the underlying writer (D1/sql-store twin) (plan 254)", () => {
    // `rankBefore` and `rankPageRows` are both optional on the real writer type
    // (only the shard-local engine implements them; the D1/sql-store backend
    // omits both) — the `...raw` spread must not leave an unguarded copy
    // behind, and the guard must not synthesize a call that reaches into a
    // method the raw writer never had (a TypeError, not a denial).
    const optionalMethods = ["rankBefore", "rankPageRows"] as const;

    it.each(optionalMethods)("does not synthesize %s when the raw writer omits it, and does not throw", (method) => {
        expect.assertions(2);

        const full = createFakeWriter();
        // Omit `method` up front (rather than deleting it after the fact) so
        // the fake writer never has the key at all, matching the D1/sql-store
        // twin's actual shape rather than a shard-local writer with a key
        // deleted off it.
        const raw = Object.fromEntries(Object.entries(full).filter(([key]) => key !== method)) as Partial<FakeWriter>;

        const guarded = guardWriter(raw as never, requiredSchema as never, tableOfId) as unknown as Record<string, unknown>;

        expect(guarded[method]).toBeUndefined();
        // Calling through the `...raw` spread's own copy (if any leaked) would
        // either throw RlsRequiredError (still gated, acceptable) or a
        // TypeError (the regression this test guards against) — assert the
        // property itself is gone rather than calling it, since `undefined`
        // is the only correct shape for "this writer doesn't support it".
        expect(method in guarded).toBe(false);
    });
});

describe("guardWriter — id-based methods with a pinned table (by-id facade)", () => {
    // `delete`/`get` pin the table at arg[1]; `patch`/`replace` carry a
    // body at arg[1] and pin at arg[2]. Each entry calls with the correct shape.
    const idMethods: ReadonlyArray<{ call: (m: Record<string, (...a: unknown[]) => unknown>, table: string) => unknown; name: string }> = [
        { call: (m, table) => m["delete"]!("any-id", table), name: "delete" },
        { call: (m, table) => m["get"]!("any-id", table), name: "get" },
        { call: (m, table) => m["lookupById"]!("any-id", table), name: "lookupById" },
        { call: (m, table) => m["patch"]!("any-id", {}, table), name: "patch" },
        { call: (m, table) => m["replace"]!("any-id", {}, table), name: "replace" },
    ];

    it.each(idMethods)("denies $name when the pinned expectedTable is protected", async ({ call, name }) => {
        expect.assertions(2);

        const raw = createFakeWriter();
        const guarded = guardWriter(raw as never, requiredSchema as never, tableOfId) as unknown as Record<string, (...a: unknown[]) => unknown>;

        await expect(call(guarded, "posts")).rejects.toThrow(RlsRequiredError);
        expect((raw as unknown as Record<string, FakeWriter[keyof FakeWriter]>)[name]).not.toHaveBeenCalled();
    });

    it.each(idMethods)("allows $name when the pinned expectedTable is .public()", async ({ call, name }) => {
        expect.assertions(1);

        const raw = createFakeWriter();
        const guarded = guardWriter(raw as never, requiredSchema as never, tableOfId) as unknown as Record<string, (...a: unknown[]) => unknown>;

        await call(guarded, "stats");

        expect((raw as unknown as Record<string, FakeWriter[keyof FakeWriter]>)[name]).toHaveBeenCalledTimes(1);
    });
});

describe("guardWriter — generic id-based access resolves the owning table", () => {
    it("denies get(id) for a bare id that resolves to a protected table", async () => {
        expect.assertions(2);

        const raw = createFakeWriter();
        const guarded = guardWriter(raw as never, requiredSchema as never, tableOfId) as unknown as { get: (id: string) => Promise<unknown> };

        await expect(guarded.get("post_42")).rejects.toThrow(RlsRequiredError);
        expect(raw.get).not.toHaveBeenCalled();
    });

    it("allows get(id) for a bare id that resolves to a .public() table", async () => {
        expect.assertions(1);

        const raw = createFakeWriter();
        const guarded = guardWriter(raw as never, requiredSchema as never, tableOfId) as unknown as { get: (id: string) => Promise<unknown> };

        await guarded.get("stat_7");

        expect(raw.get).toHaveBeenCalledWith("stat_7", undefined);
    });

    it("passes an unresolvable bare id through (nothing to leak)", async () => {
        expect.assertions(1);

        const raw = createFakeWriter();
        const guarded = guardWriter(raw as never, requiredSchema as never, tableOfId) as unknown as { patch: (id: string, p: unknown) => Promise<unknown> };

        await guarded.patch("orphan_id", { x: 1 });

        expect(raw.patch).toHaveBeenCalledTimes(1);
    });

    it("denies lookupById(id) for a bare id that resolves to a protected table (plan 254)", async () => {
        expect.assertions(2);

        const raw = createFakeWriter();
        const guarded = guardWriter(raw as never, requiredSchema as never, tableOfId) as unknown as { lookupById: (id: string) => Promise<unknown> };

        await expect(guarded.lookupById("post_42")).rejects.toThrow(RlsRequiredError);
        expect(raw.lookupById).not.toHaveBeenCalled();
    });

    it("allows lookupById(id) for a bare id that resolves to a .public() table (plan 254)", async () => {
        expect.assertions(1);

        const raw = createFakeWriter();
        const guarded = guardWriter(raw as never, requiredSchema as never, tableOfId) as unknown as { lookupById: (id: string) => Promise<unknown> };

        await guarded.lookupById("stat_7");

        expect(raw.lookupById).toHaveBeenCalledWith("stat_7", undefined);
    });

    it("passes an unresolvable bare id through lookupById without throwing (nothing to leak) (plan 254)", async () => {
        expect.assertions(2);

        const raw = createFakeWriter();
        const guarded = guardWriter(raw as never, requiredSchema as never, tableOfId) as unknown as { lookupById: (id: string) => Promise<unknown> };

        await expect(guarded.lookupById("orphan_id")).resolves.not.toBeNull();

        expect(raw.lookupById).toHaveBeenCalledTimes(1);
    });

    it("lookupById(id) resolves null (does not throw) when the underlying writer has no match, mirroring the seam's own contract (plan 254)", async () => {
        expect.assertions(1);

        const raw = createFakeWriter();

        // Override the fake's default sentinel-object return to mirror the
        // real seam's "absent row" contract (`ctx-db.ts`'s `lookupById`
        // returns `null`, never throws, when the id/table can't be resolved —
        // e.g. a `.global()` row this shard-local seam can't see).
        raw.lookupById.mockResolvedValueOnce(null);

        const guarded = guardWriter(raw as never, requiredSchema as never, tableOfId) as unknown as { lookupById: (id: string) => Promise<unknown> };

        await expect(guarded.lookupById("orphan_id")).resolves.toBeNull();
    });
});

describe("guardWriter — batch id-based methods (deleteMany/patchMany)", () => {
    /** Invoke `deleteMany`/`patchMany` with a uniform (ids, expectedTable) shape. */
    const batchMethods: ReadonlyArray<{
        call: (m: Record<string, (...a: unknown[]) => unknown>, ids: ReadonlyArray<string>, table?: string) => unknown;
        name: string;
    }> = [
        { call: (m, ids, table) => m["deleteMany"]!(ids, undefined, table), name: "deleteMany" },
        {
            call: (m, ids, table) =>
                m["patchMany"]!(
                    ids.map((id) => {
                        return { id, patch: {} };
                    }),
                    undefined,
                    table,
                ),
            name: "patchMany",
        },
    ];

    it.each(batchMethods)("$name denies a bare-id batch when one id resolves to a protected, policy-less table", async ({ call, name }) => {
        expect.assertions(2);

        const raw = createFakeWriter();
        const guarded = guardWriter(raw as never, requiredSchema as never, tableOfId) as unknown as Record<string, (...a: unknown[]) => unknown>;

        // "stat_1" resolves to the public table (allowed); "post_2" resolves to
        // the protected table and must deny the WHOLE batch before it reaches base.
        await expect(call(guarded, ["stat_1", "post_2"])).rejects.toThrow(RlsRequiredError);
        expect((raw as unknown as Record<string, FakeWriter[keyof FakeWriter]>)[name]).not.toHaveBeenCalled();
    });

    it.each(batchMethods)("$name denies with expectedTable pinned to a protected table, with NO probe at all", async ({ call, name }) => {
        expect.assertions(3);

        const raw = createFakeWriter();
        const tablesOfIds = vi.fn<(ids: ReadonlyArray<string>, expectedTable?: string) => ReadonlyMap<string, string>>();
        const guarded = guardWriter(raw as never, requiredSchema as never, tableOfId, tablesOfIds) as unknown as Record<string, (...a: unknown[]) => unknown>;

        await expect(call(guarded, ["any-id-1", "any-id-2"], "posts")).rejects.toThrow(RlsRequiredError);
        expect((raw as unknown as Record<string, FakeWriter[keyof FakeWriter]>)[name]).not.toHaveBeenCalled();
        // Pinned-table gating never needs to resolve anything — no probe issued.
        expect(tablesOfIds).not.toHaveBeenCalled();
    });

    it.each(batchMethods)("$name passes a batch of only unresolved ids through to base", async ({ call, name }) => {
        expect.assertions(1);

        const raw = createFakeWriter();
        const guarded = guardWriter(raw as never, requiredSchema as never, tableOfId) as unknown as Record<string, (...a: unknown[]) => unknown>;

        await call(guarded, ["orphan_1", "orphan_2"]);

        expect((raw as unknown as Record<string, FakeWriter[keyof FakeWriter]>)[name]).toHaveBeenCalledTimes(1);
    });

    it("consults the batch resolver exactly once with the deduped id set, and never the per-id tableOfId", async () => {
        expect.assertions(3);

        const raw = createFakeWriter();
        const tableOfIdSpy = vi.fn<typeof tableOfId>(tableOfId);
        const tablesOfIds = vi.fn<(ids: ReadonlyArray<string>) => ReadonlyMap<string, string>>(
            (ids: ReadonlyArray<string>) => new Map(ids.map((id) => [id, "stats"])),
        );
        const guarded = guardWriter(raw as never, requiredSchema as never, tableOfIdSpy, tablesOfIds) as unknown as {
            deleteMany: (ids: ReadonlyArray<string>) => Promise<unknown>;
        };

        // A duplicated id ("stat_1" twice) — the resolver sees the DEDUPED set.
        await guarded.deleteMany(["stat_1", "stat_2", "stat_1"]);

        expect(tablesOfIds).toHaveBeenCalledTimes(1);
        expect(tablesOfIds.mock.calls[0]?.[0]).toStrictEqual(["stat_1", "stat_2"]);
        expect(tableOfIdSpy).not.toHaveBeenCalled();
    });

    it("falls back to the per-id loop when no batch resolver is supplied (D1-twin fallback, pinned)", async () => {
        expect.assertions(1);

        const raw = createFakeWriter();
        const tableOfIdSpy = vi.fn<typeof tableOfId>(tableOfId);
        // No 4th argument: guardWriter's D1-twin call shape, unchanged.
        const guarded = guardWriter(raw as never, requiredSchema as never, tableOfIdSpy) as unknown as {
            deleteMany: (ids: ReadonlyArray<string>) => Promise<unknown>;
        };

        await guarded.deleteMany(["stat_1", "stat_2"]);

        expect(tableOfIdSpy).toHaveBeenCalledTimes(2);
    });
});

describe("guardWriter — erase primitives under .rls('required')", () => {
    /** The fake writer plus the erase methods the guard has to gate. */
    const createEraseWriter = () => {
        return {
            ...createFakeWriter(),
            deleteAll: vi.fn<(tableName: string) => Promise<string>>((tableName: string) => Promise.resolve(`deleteAll:${tableName}`)),
            wipeShard: vi.fn<() => Promise<string>>(() => Promise.resolve("wipeShard")),
        };
    };

    it("denies deleteAll against the protected table", () => {
        expect.assertions(2);

        const raw = createEraseWriter();
        const guarded = guardWriter(raw as never, requiredSchema as never, tableOfId) as unknown as { deleteAll: (t: string) => unknown };

        // The most destructive method on the writer: without an explicit override the
        // `...raw` spread would expose it unguarded.
        expect(() => guarded.deleteAll("posts")).toThrow(RlsRequiredError);
        expect(raw.deleteAll).not.toHaveBeenCalled();
    });

    it("allows deleteAll against the .public() table", () => {
        expect.assertions(1);

        const raw = createEraseWriter();
        const guarded = guardWriter(raw as never, requiredSchema as never, tableOfId) as unknown as { deleteAll: (t: string) => unknown };

        guarded.deleteAll("stats");

        expect(raw.deleteAll).toHaveBeenCalledTimes(1);
    });

    it("denies wipeShard while any swept table is protected", () => {
        expect.assertions(2);

        const raw = createEraseWriter();
        const guarded = guardWriter(raw as never, requiredSchema as never, tableOfId) as unknown as { wipeShard: (o?: unknown) => unknown };

        expect(() => guarded.wipeShard()).toThrow(RlsRequiredError);
        expect(raw.wipeShard).not.toHaveBeenCalled();
    });

    it("allows wipeShard when the sweep is restricted to .public() tables", () => {
        expect.assertions(1);

        const raw = createEraseWriter();
        const guarded = guardWriter(raw as never, requiredSchema as never, tableOfId) as unknown as {
            wipeShard: (o?: { tables?: string[] }) => unknown;
        };

        guarded.wipeShard({ tables: ["stats"] });

        expect(raw.wipeShard).toHaveBeenCalledTimes(1);
    });

    it("ignores a protected .global() table, which wipeShard never touches anyway", () => {
        expect.assertions(1);

        const raw = createEraseWriter();
        // A protected GLOBAL table must not block the sweep: `wipeShard` skips global
        // tables by design (their rows live in D1, shared across shards), so gating them
        // would deny a wipe whose real, shard-local targets are all `.public()`.
        const schema = {
            rlsMode: "required" as const,
            tables: {
                globalSecrets: { isPublic: false, shardMode: { kind: "global" } },
                stats: { isPublic: true },
            },
        };
        const guarded = guardWriter(raw as never, schema as never, tableOfId) as unknown as { wipeShard: (o?: unknown) => unknown };

        guarded.wipeShard();

        expect(raw.wipeShard).toHaveBeenCalledTimes(1);
    });

    it("still denies wipeShard when only the public table is excluded", () => {
        expect.assertions(1);

        const raw = createEraseWriter();
        const guarded = guardWriter(raw as never, requiredSchema as never, tableOfId) as unknown as {
            wipeShard: (o?: { exclude?: string[] }) => unknown;
        };

        // Excluding `stats` leaves the protected `posts` in the sweep.
        expect(() => guarded.wipeShard({ exclude: ["stats"] })).toThrow(RlsRequiredError);
    });
});

describe("guardWriter — unwrap seam", () => {
    it("exposes the raw writer under RLS_UNWRAP_SYMBOL so the middleware can recover it", () => {
        expect.assertions(1);

        const raw = createFakeWriter();
        const guarded = guardWriter(raw as never, requiredSchema as never, tableOfId);

        expect((guarded as unknown as Record<PropertyKey, unknown>)[RLS_UNWRAP_SYMBOL]).toBe(raw);
    });

    it("uses the well-known cross-realm symbol key (server reads it without importing do)", () => {
        expect.assertions(1);

        expect(RLS_UNWRAP_SYMBOL).toBe(Symbol.for("lunora.ctxdb.rls-unwrap"));
    });
});
