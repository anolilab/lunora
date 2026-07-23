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

import { guardWriter, RLS_UNWRAP_SYMBOL, RlsRequiredError } from "../src/rls-guard";

/** A spy writer: every gated method records its table/id and returns a sentinel. */
const createFakeWriter = () => {
    return {
        aggregate: vi.fn<(tableName: string) => Promise<string>>((tableName: string) => Promise.resolve(`aggregate:${tableName}`)),
        count: vi.fn<(tableName: string) => Promise<string>>((tableName: string) => Promise.resolve(`count:${tableName}`)),
        delete: vi.fn<(id: string) => Promise<string>>((id: string) => Promise.resolve(`delete:${id}`)),
        findFirst: vi.fn<(tableName: string) => Promise<string>>((tableName: string) => Promise.resolve(`findFirst:${tableName}`)),
        findFirstOrThrow: vi.fn<(tableName: string) => Promise<string>>((tableName: string) => Promise.resolve(`findFirstOrThrow:${tableName}`)),
        findMany: vi.fn<(tableName: string) => Promise<string>>((tableName: string) => Promise.resolve(`findMany:${tableName}`)),
        get: vi.fn<(id: string) => Promise<string>>((id: string) => Promise.resolve(`get:${id}`)),
        groupBy: vi.fn<(tableName: string) => Promise<string>>((tableName: string) => Promise.resolve(`groupBy:${tableName}`)),
        insert: vi.fn<(tableName: string) => Promise<string>>((tableName: string) => Promise.resolve(`insert:${tableName}`)),
        patch: vi.fn<(id: string) => Promise<string>>((id: string) => Promise.resolve(`patch:${id}`)),
        query: vi.fn<(tableName: string) => string>((tableName: string) => `query:${tableName}`),
        rank: vi.fn<(tableName: string) => Promise<string>>((tableName: string) => Promise.resolve(`rank:${tableName}`)),
        rankBefore: vi.fn<(tableName: string) => Promise<string>>((tableName: string) => Promise.resolve(`rankBefore:${tableName}`)),
        rankPage: vi.fn<(tableName: string) => Promise<string>>((tableName: string) => Promise.resolve(`rankPage:${tableName}`)),
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
        "findFirst",
        "findFirstOrThrow",
        "findMany",
        "groupBy",
        "insert",
        "query",
        "rank",
        "rankBefore",
        "rankPage",
    ] as const;

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

describe("guardWriter — id-based methods with a pinned table (by-id facade)", () => {
    // `delete`/`get` pin the table at arg[1]; `patch`/`replace` carry a
    // body at arg[1] and pin at arg[2]. Each entry calls with the correct shape.
    const idMethods: ReadonlyArray<{ call: (m: Record<string, (...a: unknown[]) => unknown>, table: string) => unknown; name: string }> = [
        { call: (m, table) => m["delete"]!("any-id", table), name: "delete" },
        { call: (m, table) => m["get"]!("any-id", table), name: "get" },
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
