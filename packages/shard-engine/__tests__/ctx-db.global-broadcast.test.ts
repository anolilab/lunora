import { describe, expect, it, vi } from "vitest";

import type { BroadcastDelta, ColumnMetaLike, CtxDbOptions, DatabaseWriterLike, SchemaLike, ValidatorLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import createSqliteExec from "./_helpers/node-sqlite";

const FIXED_CLOCK = 1_700_000_000_000;

const col = (kind: string, column: Partial<ColumnMetaLike> = {}): ValidatorLike => {
    return {
        _meta: { column: { notNull: true, ...column } },
        kind,
    };
};

const globalSchema: SchemaLike = {
    tables: { counters: { indexes: [], shape: { n: col("number") }, shardMode: { kind: "global" } } },
};

type GlobalStub = Partial<Record<"delete" | "deleteMany" | "findMany" | "get" | "patch" | "patchIf" | "replace" | "restore", unknown>>;

/**
 * Live subscriptions on this shard read `.global()` rows, and the write lands in D1.
 * Every write must reach `broadcast`, or a subscriber keeps the old row until a refetch.
 */
const setup = (
    globalOverrides: GlobalStub = {},
    options: Partial<Pick<CtxDbOptions, "cache" | "onRead" | "schema">> = {},
): { deltas: Parameters<BroadcastDelta>[0][]; sql: ReturnType<typeof createSqliteExec>["sql"]; writer: DatabaseWriterLike } => {
    const deltas: Parameters<BroadcastDelta>[0][] = [];
    const { sql } = createSqliteExec();
    const globalDb = {
        delete: vi.fn<() => Promise<undefined>>(async () => undefined),
        findMany: vi.fn<() => Promise<{ continueCursor: null; isDone: true; page: Record<string, unknown>[] }>>(async () => {
            return { continueCursor: null, isDone: true, page: [] };
        }),
        patch: vi.fn<() => Promise<undefined>>(async () => undefined),
        patchIf: vi.fn<() => Promise<{ applied: boolean; doc: null }>>(async () => {
            return { applied: true, doc: null };
        }),
        replace: vi.fn<() => Promise<undefined>>(async () => undefined),
        ...globalOverrides,
    } as unknown as DatabaseWriterLike;
    const schema = options.schema ?? globalSchema;

    runShardMigrations(sql, schema);

    const writer = createShardContextDatabase({
        broadcast: (delta) => deltas.push(delta),
        cache: options.cache,
        clock: () => FIXED_CLOCK,
        globalDb,
        onRead: options.onRead,
        schema,
        sql,
    });

    return { deltas, sql, writer };
};

describe("ctx.db writes on a .global() table reach live subscriptions", () => {
    it("a patch broadcasts an update for the row", async () => {
        expect.hasAssertions();

        const { deltas, writer } = setup();

        await writer.patch("counters", "g1", { n: 2 });

        expect(deltas).toStrictEqual([{ key: "g1", op: "update", table: "counters" }]);
    });

    it("a replace broadcasts an update for the row", async () => {
        expect.hasAssertions();

        const { deltas, writer } = setup();

        await writer.replace("counters", "g1", { n: 2 });

        expect(deltas).toStrictEqual([{ key: "g1", op: "update", table: "counters" }]);
    });

    it("a delete broadcasts a delete for the row", async () => {
        expect.hasAssertions();

        const { deltas, writer } = setup();

        await writer.delete("counters", "g1");

        expect(deltas).toStrictEqual([{ key: "g1", op: "delete", table: "counters" }]);
    });

    it("a restore broadcasts an update for the row", async () => {
        expect.hasAssertions();

        const { deltas, writer } = setup({ restore: vi.fn<() => Promise<undefined>>(async () => undefined) });

        await writer.restore?.("counters", "g1");

        expect(deltas).toStrictEqual([{ key: "g1", op: "update", table: "counters" }]);
    });

    it("a conditional patch broadcasts only when it applied", async () => {
        expect.hasAssertions();

        const applied = setup();

        await applied.writer.patchIf?.("counters", "g1", { patch: { n: 2 }, where: {} });

        expect(applied.deltas).toStrictEqual([{ key: "g1", op: "update", table: "counters" }]);

        const refused = setup({
            patchIf: vi.fn<() => Promise<{ applied: boolean; doc: null }>>(async () => {
                return { applied: false, doc: null };
            }),
        });

        await refused.writer.patchIf?.("counters", "g1", { patch: { n: 2 }, where: {} });

        expect(refused.deltas).toStrictEqual([]);
    });

    it("a write that throws after reaching D1 still broadcasts, and the error still reaches the caller", async () => {
        expect.hasAssertions();

        const failing = vi.fn<() => Promise<undefined>>(async () => {
            throw new Error("after-commit hook failed");
        });
        const { deltas, writer } = setup({ patch: failing, replace: failing });

        await expect(writer.patch("counters", "g1", { n: 2 })).rejects.toThrow("after-commit hook failed");
        await expect(writer.replace("counters", "g2", { n: 3 })).rejects.toThrow("after-commit hook failed");

        expect(deltas).toStrictEqual([
            { key: "g1", op: "update", table: "counters" },
            { key: "g2", op: "update", table: "counters" },
        ]);
    });

    it("a global write drops the shard's cached reads of the whole table", async () => {
        expect.hasAssertions();

        const invalidateTable = vi.fn<(table: string) => string[]>(() => []);
        const cache = { invalidate: vi.fn<() => string[]>(() => []), invalidateTable } as unknown as CtxDbOptions["cache"];
        const { writer } = setup({}, { cache });

        await writer.patch("counters", "g1", { n: 2 });
        await writer.delete("counters", "g2");

        expect(invalidateTable.mock.calls).toStrictEqual([["counters"], ["counters"]]);
    });
});

describe("reads of .global() rows record the dependency a global write refreshes", () => {
    it("a get answered by the D1 writer records a point read of the row", async () => {
        expect.hasAssertions();

        const onRead = vi.fn<NonNullable<CtxDbOptions["onRead"]>>();
        const { writer } = setup(
            {
                get: vi.fn<() => Promise<Record<string, unknown>>>(async () => {
                    return { _id: "g1", n: 1 };
                }),
            },
            { onRead },
        );

        await writer.get("counters", "g1");

        expect(onRead).toHaveBeenCalledWith("counters", "g1", true);
    });

    it("a with load of a .global() child records a scan of the child table", async () => {
        expect.hasAssertions();

        const schema: SchemaLike = {
            tables: {
                globals: { indexes: [], shape: { value: col("string") }, shardMode: { kind: "global" } },
                local: {
                    indexes: [],
                    relationMap: { remote: { field: "ref", kind: "one", references: "_id", table: "globals" } },
                    shape: { ref: col("string") },
                    shardMode: { kind: "root" },
                },
            },
        };
        const onRead = vi.fn<NonNullable<CtxDbOptions["onRead"]>>();
        const { writer } = setup(
            {
                findMany: vi.fn<() => Promise<{ continueCursor: null; isDone: true; page: Record<string, unknown>[] }>>(async () => {
                    return { continueCursor: null, isDone: true, page: [{ _id: "g1", value: "alpha" }] };
                }),
            },
            { onRead, schema },
        );

        await writer.insert("local", { _id: "l1", ref: "g1" }, { allowExplicitId: true });
        await writer.findMany("local", { with: { remote: true } });

        expect(onRead).toHaveBeenCalledWith("globals", "*scan", undefined);
    });
});

describe("a .global() delete announces the rows D1 cascades to", () => {
    const schema: SchemaLike = {
        tables: {
            authors: { indexes: [], shape: { name: col("string") }, shardMode: { kind: "global" } },
            comments: {
                indexes: [],
                relationMap: { post: { field: "postId", kind: "one", onDelete: "set null", references: "_id", table: "posts" } },
                shape: { postId: col("string", { notNull: false }) },
                shardMode: { kind: "global" },
            },
            posts: {
                indexes: [],
                relationMap: { author: { field: "authorId", kind: "one", onDelete: "cascade", references: "_id", table: "authors" } },
                shape: { authorId: col("string") },
                shardMode: { kind: "global" },
            },
        },
    };
    const holders: Record<string, Record<string, unknown>[]> = {
        "comments:postId=p1": [{ _id: "c1", postId: "p1" }],
        "posts:authorId=a1": [{ _id: "p1", authorId: "a1" }],
    };
    const findMany = vi.fn<
        (table: string, query: { where: Record<string, unknown> }) => Promise<{ continueCursor: null; isDone: true; page: Record<string, unknown>[] }>
    >(async (table, query) => {
        const [field, value] = Object.entries(query.where)[0] ?? [];

        return { continueCursor: null, isDone: true, page: holders[`${table}:${String(field)}=${String(value)}`] ?? [] };
    });

    it("broadcasts the cascaded holder as deleted and the set-null holder as updated", async () => {
        expect.hasAssertions();

        const { deltas, writer } = setup({ findMany }, { schema });

        await writer.delete("authors", "a1");

        expect(deltas).toStrictEqual([
            { key: "a1", op: "delete", table: "authors" },
            { key: "p1", op: "delete", table: "posts" },
            { key: "c1", op: "update", table: "comments" },
        ]);
    });
});

describe("the cascade pre-read matches what the D1 writer touches", () => {
    const schema: SchemaLike = {
        tables: {
            authors: { indexes: [], shape: { name: col("string") }, shardMode: { kind: "global" } },
            posts: {
                indexes: [],
                relationMap: { author: { field: "authorId", kind: "one", onDelete: "cascade", references: "_id", table: "authors" } },
                shape: { authorId: col("string") },
                shardMode: { kind: "global" },
            },
        },
    };

    it("includes soft-deleted holders on a hard delete, and only then", async () => {
        expect.hasAssertions();

        const findMany = vi.fn<
            (table: string, query: { includeDeleted?: boolean }) => Promise<{ continueCursor: null; isDone: true; page: Record<string, unknown>[] }>
        >(async () => {
            return { continueCursor: null, isDone: true, page: [] };
        });
        const { writer } = setup({ findMany }, { schema });

        await writer.delete("authors", "a1", { hard: true });
        await writer.delete("authors", "a2");

        expect(findMany.mock.calls.map(([, query]) => query.includeDeleted)).toStrictEqual([true, false]);
    });

    it("reads the holders a page at a time and announces every page's rows", async () => {
        expect.hasAssertions();

        const findMany = vi.fn<
            (
                table: string,
                query: { cursor?: string | null; limit?: number },
            ) => Promise<{ continueCursor: string | null; isDone: boolean; page: Record<string, unknown>[] }>
        >(async (_table, query) =>
            query.cursor === "page-2"
                ? { continueCursor: null, isDone: true, page: [{ _id: "p2", authorId: "a1" }] }
                : { continueCursor: "page-2", isDone: false, page: [{ _id: "p1", authorId: "a1" }] },
        );
        const { deltas, writer } = setup({ findMany }, { schema });

        await writer.delete("authors", "a1");

        expect(findMany.mock.calls.map(([, query]) => [query.cursor, query.limit])).toStrictEqual([
            [undefined, 500],
            ["page-2", 500],
        ]);
        expect(deltas).toStrictEqual([
            { key: "a1", op: "delete", table: "authors" },
            { key: "p1", op: "delete", table: "posts" },
            { key: "p2", op: "delete", table: "posts" },
        ]);
    });
});

describe("review follow-ups on .global() reads and cascades", () => {
    it("walks a row's cascade children even when a set-null relation reached it first", async () => {
        expect.hasAssertions();

        const schema: SchemaLike = {
            tables: {
                children: {
                    indexes: [],
                    relationMap: {
                        backup: { field: "backupId", kind: "one", onDelete: "set null", references: "_id", table: "parents" },
                        owner: { field: "ownerId", kind: "one", onDelete: "cascade", references: "_id", table: "parents" },
                    },
                    shape: { backupId: col("string", { notNull: false }), ownerId: col("string") },
                    shardMode: { kind: "global" },
                },
                grandchildren: {
                    indexes: [],
                    relationMap: { child: { field: "childId", kind: "one", onDelete: "cascade", references: "_id", table: "children" } },
                    shape: { childId: col("string") },
                    shardMode: { kind: "global" },
                },
                parents: { indexes: [], shape: { name: col("string") }, shardMode: { kind: "global" } },
            },
        };
        const rows: Record<string, Record<string, unknown>[]> = {
            "children:backupId=p1": [{ _id: "c1" }],
            "children:ownerId=p1": [{ _id: "c1" }],
            "grandchildren:childId=c1": [{ _id: "g1" }],
        };
        const findMany = vi.fn<
            (table: string, query: { where: Record<string, unknown> }) => Promise<{ continueCursor: null; isDone: true; page: Record<string, unknown>[] }>
        >(async (table, query) => {
            const [field, value] = Object.entries(query.where)[0] ?? [];

            return { continueCursor: null, isDone: true, page: rows[`${table}:${String(field)}=${String(value)}`] ?? [] };
        });
        const { deltas, writer } = setup({ findMany }, { schema });

        await writer.delete("parents", "p1");

        expect(deltas).toStrictEqual([
            { key: "p1", op: "delete", table: "parents" },
            { key: "c1", op: "update", table: "children" },
            { key: "c1", op: "delete", table: "children" },
            { key: "g1", op: "delete", table: "grandchildren" },
        ]);
    });

    it("records the scan of a .global() grandchild that a nested with loads inside D1", async () => {
        expect.hasAssertions();

        const schema: SchemaLike = {
            tables: {
                deeper: { indexes: [], shape: { value: col("string") }, shardMode: { kind: "global" } },
                globals: {
                    indexes: [],
                    relationMap: { deep: { field: "deepId", kind: "one", references: "_id", table: "deeper" } },
                    shape: { deepId: col("string") },
                    shardMode: { kind: "global" },
                },
                local: {
                    indexes: [],
                    relationMap: { remote: { field: "ref", kind: "one", references: "_id", table: "globals" } },
                    shape: { ref: col("string") },
                    shardMode: { kind: "root" },
                },
            },
        };
        const onRead = vi.fn<NonNullable<CtxDbOptions["onRead"]>>();
        const { writer } = setup(
            {
                findMany: vi.fn<() => Promise<{ continueCursor: null; isDone: true; page: Record<string, unknown>[] }>>(async () => {
                    return { continueCursor: null, isDone: true, page: [{ _id: "g1", deep: { _id: "d1", value: "x" }, deepId: "d1" }] };
                }),
            },
            { onRead, schema },
        );

        await writer.insert("local", { _id: "l1", ref: "g1" }, { allowExplicitId: true });
        await writer.findMany("local", { with: { remote: { with: { deep: true } } } });

        expect(onRead).toHaveBeenCalledWith("deeper", "*scan", undefined);
    });
});

describe("nested counts under a .global() relation", () => {
    it("records the scan of the table a nested _count reads inside D1", async () => {
        expect.hasAssertions();

        const schema: SchemaLike = {
            tables: {
                deeper: { indexes: [], shape: { value: col("string") }, shardMode: { kind: "global" } },
                globals: {
                    indexes: [],
                    relationMap: { deep: { field: "deepId", kind: "one", references: "_id", table: "deeper" } },
                    shape: { deepId: col("string") },
                    shardMode: { kind: "global" },
                },
                local: {
                    indexes: [],
                    relationMap: { remote: { field: "ref", kind: "one", references: "_id", table: "globals" } },
                    shape: { ref: col("string") },
                    shardMode: { kind: "root" },
                },
            },
        };
        const onRead = vi.fn<NonNullable<CtxDbOptions["onRead"]>>();
        const { writer } = setup(
            {
                findMany: vi.fn<() => Promise<{ continueCursor: null; isDone: true; page: Record<string, unknown>[] }>>(async () => {
                    return { continueCursor: null, isDone: true, page: [{ _count: { deep: 1 }, _id: "g1", deepId: "d1" }] };
                }),
            },
            { onRead, schema },
        );

        await writer.insert("local", { _id: "l1", ref: "g1" }, { allowExplicitId: true });
        await writer.findMany("local", { with: { remote: { with: { _count: { deep: true } } } } });

        expect(onRead).toHaveBeenCalledWith("deeper", "*scan", undefined);
    });
});
