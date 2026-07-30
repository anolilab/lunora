import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createShardCtxDb as createShardContextDatabase } from "../src/ctx-db";
import { runShardMigrations } from "../src/ctx-db-migrations";
import { readSourceCursor } from "../src/external-source-cursor";
import type { ExternalSourceLike, SourceClientLike } from "../src/external-source-pull";
import {
    isSoftDeleted,
    isSourceDue,
    liftSourceId,
    normalizeSourceValue,
    pullExternalSourceIncrementalTick,
    pullExternalSourceTick,
} from "../src/external-source-pull";
import type { DatabaseWriterLike, SchemaLike } from "../src/schema-types";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * The pull + cadence layer the DO poll alarm runs per sourced table (plan 077).
 * This is the logic the codegen-emitted override now delegates to, so it is tested
 * here rather than only as a code-generation string: the id-lift safety, the
 * cadence gate, and the query → project → materialize round-trip.
 */

describe("liftSourceId", () => {
    it("lifts the default `id` column to `_id` and drops it from the body", () => {
        expect.assertions(1);

        expect(liftSourceId({ body: "hi", id: "d1", title: "Doc" })).toStrictEqual({ _id: "d1", body: "hi", title: "Doc" });
    });

    it("honours a custom id column and a map", () => {
        expect.assertions(1);

        expect(
            liftSourceId(
                { org_id: "o1", title: "Doc", uuid: 42 },
                {
                    idColumn: "uuid",
                    map: (row) => {
                        return { orgId: row.org_id, title: row.title };
                    },
                },
            ),
        ).toStrictEqual({ _id: "42", orgId: "o1", title: "Doc" });
    });

    it("throws on a missing id (loud misconfig, not a silent `_id: undefined`)", () => {
        expect.assertions(1);

        expect(() => liftSourceId({ title: "Doc" })).toThrow('missing id column "id"');
    });

    it("throws on a null id", () => {
        expect.assertions(1);

        expect(() => liftSourceId({ id: null, title: "Doc" })).toThrow('missing id column "id"');
    });

    it("throws on a non-scalar id (would otherwise stringify to [object Object])", () => {
        expect.assertions(1);

        expect(() => liftSourceId({ id: { nested: true }, title: "Doc" })).toThrow("must be a string or number");
    });

    it("normalizes a Date to its ISO string and a bigint to its decimal string (DO-01)", () => {
        expect.assertions(1);

        expect(
            liftSourceId({
                created_at: new Date("2026-07-17T12:00:00.000Z"),
                id: "d1",
                seq: 42n,
                title: "Doc",
            }),
        ).toStrictEqual({ _id: "d1", created_at: "2026-07-17T12:00:00.000Z", seq: "42", title: "Doc" });
    });

    it("normalizes a map's returned Date/bigint values too, not just verbatim-copied columns", () => {
        expect.assertions(1);

        expect(
            liftSourceId(
                { id: "d1", raw_count: 7n, raw_date: new Date("2026-01-01T00:00:00.000Z") },
                {
                    map: (row) => {
                        return { count: row.raw_count, seenAt: row.raw_date };
                    },
                },
            ),
        ).toStrictEqual({ _id: "d1", count: "7", seenAt: "2026-01-01T00:00:00.000Z" });
    });
});

describe("normalizeSourceValue", () => {
    it("passes through JSON-safe primitives and plain objects/arrays unchanged", () => {
        expect.assertions(4);

        expect(normalizeSourceValue("x")).toBe("x");
        expect(normalizeSourceValue(1)).toBe(1);
        expect(normalizeSourceValue(null)).toBeNull();
        expect(normalizeSourceValue({ a: 1 })).toStrictEqual({ a: 1 });
    });
});

describe("isSourceDue", () => {
    it("never polls a manual source", () => {
        expect.assertions(2);

        expect(isSourceDue("manual", undefined, 1000)).toBe(false);
        expect(isSourceDue("manual", 0, 10_000_000)).toBe(false);
    });

    it("polls every tick when refresh is omitted", () => {
        expect.assertions(2);

        expect(isSourceDue(undefined, undefined, 1000)).toBe(true);
        expect(isSourceDue(undefined, 999, 1000)).toBe(true);
    });

    it("throttles to the interval for { everyMs }", () => {
        expect.assertions(3);

        expect(isSourceDue({ everyMs: 5000 }, undefined, 1000)).toBe(true); // first poll
        expect(isSourceDue({ everyMs: 5000 }, 1000, 4000)).toBe(false); // 3s < 5s
        expect(isSourceDue({ everyMs: 5000 }, 1000, 6000)).toBe(true); // 5s elapsed
    });
});

describe("pullExternalSourceTick", () => {
    const schema: SchemaLike = {
        tables: { documents: { indexes: [], shape: { orgId: { kind: "string" }, title: { kind: "string" } } } },
    };

    let harness: ReturnType<typeof createSqliteExec>;

    const setupWriter = (): DatabaseWriterLike => {
        runShardMigrations(harness.sql, schema, { cdc: true });

        return createShardContextDatabase({ broadcast: () => undefined, cdc: true, clock: () => 1_700_000_000_000, schema, sql: harness.sql });
    };

    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    it("queries under tenantBy(shardKey), projects, and materializes the slice", async () => {
        expect.assertions(3);

        const writer = setupWriter();
        let calledWith: [string, ReadonlyArray<unknown> | undefined] | undefined;

        const client: SourceClientLike = {
            query: (async (text: string, parameters?: ReadonlyArray<unknown>) => {
                calledWith = [text, parameters];

                return [
                    { id: "d1", org_id: "tenant-a", title: "One" },
                    { id: "d2", org_id: "tenant-a", title: "Two" },
                ];
            }) as SourceClientLike["query"],
        };

        const source: ExternalSourceLike = {
            binding: "HD",
            map: (row) => {
                return { orgId: row.org_id, title: row.title };
            },
            query: "select id, title, org_id from documents where org_id = $1",
            tenantBy: (shardKey) => [shardKey],
        };

        const result = await pullExternalSourceTick(harness.sql, writer, client, "documents", source, "tenant-a");

        // The shard key bound into the query params (the tenant boundary).
        expect(calledWith).toStrictEqual(["select id, title, org_id from documents where org_id = $1", ["tenant-a"]]);
        expect(result.applied).toBe(2);

        const ids = (harness.sql.exec("SELECT id FROM documents ORDER BY id").toArray() as { id: string }[]).map((row) => row.id);

        expect(ids).toStrictEqual(["d1", "d2"]);
    });

    it("ingests a Date/bigint-bearing row without throwing out of stableStringify (DO-01)", async () => {
        expect.assertions(3);

        const writer = setupWriter();
        const client: SourceClientLike = {
            query: (async () => [
                { id: "d1", org_id: "tenant-a", seq: 42n, title: "One", updated_at: new Date("2026-07-17T12:00:00.000Z") },
            ]) as SourceClientLike["query"],
        };

        const source: ExternalSourceLike = {
            binding: "HD",
            query: "select id, org_id, title, updated_at, seq from documents where org_id = $1",
            tenantBy: (shardKey) => [shardKey],
        };

        // Previously threw a TypeError out of `stableStringify` (Date/bigint
        // aren't JSON-safe) before the watermark/membership could ever be
        // established — bricking ingest for this table on the very first tick.
        const result = await pullExternalSourceTick(harness.sql, writer, client, "documents", source, "tenant-a");

        expect(result.applied).toBe(1);
        await expect(writer.get("d1")).resolves.toMatchObject({ seq: "42", updated_at: "2026-07-17T12:00:00.000Z" });

        // A repeat tick with the identical Date/bigint values is a steady-state
        // no-op — proves the normalized values also compare byte-identical
        // across ticks (the diff's canonical-JSON short-circuit), not merely
        // that the first tick didn't throw.
        const second = await pullExternalSourceTick(harness.sql, writer, client, "documents", source, "tenant-a");

        expect(second.applied).toBe(0);
    });

    it("aborts the whole tick on a row with a missing id (no partial corruption under `undefined`)", async () => {
        expect.assertions(2);

        const writer = setupWriter();
        const client: SourceClientLike = {
            query: (async () => [
                { id: "d1", orgId: "t", title: "ok" },
                { orgId: "t", title: "no-id" },
            ]) as SourceClientLike["query"],
        };
        const source: ExternalSourceLike = { binding: "HD", query: "select …" };

        await expect(pullExternalSourceTick(harness.sql, writer, client, "documents", source, "__root__")).rejects.toThrow('missing id column "id"');

        // The diff is computed before any apply, so a bad row leaves the table untouched.
        expect(harness.sql.exec("SELECT id FROM documents").toArray()).toStrictEqual([]);
    });
});

describe("isSoftDeleted", () => {
    it("treats a set tombstone (timestamp / true / non-zero) as deleted", () => {
        expect.assertions(3);

        expect(isSoftDeleted({ deleted_at: "2026-07-17T00:00:00Z" }, "deleted_at")).toBe(true);
        expect(isSoftDeleted({ is_deleted: true }, "is_deleted")).toBe(true);
        expect(isSoftDeleted({ flag: 1 }, "flag")).toBe(true);
    });

    it("treats null / undefined / false / 0 as live", () => {
        expect.assertions(4);

        expect(isSoftDeleted({ deleted_at: null }, "deleted_at")).toBe(false);
        expect(isSoftDeleted({}, "deleted_at")).toBe(false);
        expect(isSoftDeleted({ is_deleted: false }, "is_deleted")).toBe(false);
        expect(isSoftDeleted({ flag: 0 }, "flag")).toBe(false);
    });
});

describe("pullExternalSourceIncrementalTick", () => {
    const schema: SchemaLike = {
        tables: { documents: { indexes: [], shape: { title: { kind: "string" }, updatedAt: { kind: "number" } } } },
    };

    let harness: ReturnType<typeof createSqliteExec>;

    // eslint-disable-next-line sonarjs/no-identical-functions -- same body as the full-pull describe's helper but closes over this block's `schema`/`harness`; hoisting couples the two suites.
    const setupWriter = (): DatabaseWriterLike => {
        runShardMigrations(harness.sql, schema, { cdc: true });

        return createShardContextDatabase({ broadcast: () => undefined, cdc: true, clock: () => 1_700_000_000_000, schema, sql: harness.sql });
    };

    /** A fake source client that returns a scripted response per call (FIFO), recording the (text, params) it was asked. */
    const scriptedClient = (
        responses: ReadonlyArray<ReadonlyArray<Record<string, unknown>>>,
    ): { calls: [string, ReadonlyArray<unknown> | undefined][]; client: SourceClientLike } => {
        const calls: [string, ReadonlyArray<unknown> | undefined][] = [];
        let index = -1;

        return {
            calls,
            client: {
                query: (async (text: string, parameters?: ReadonlyArray<unknown>) => {
                    calls.push([text, parameters]);
                    index += 1;

                    return responses[index] ?? [];
                }) as SourceClientLike["query"],
            },
        };
    };

    const rows = (): { id: string; title: string }[] =>
        (harness.sql.exec("SELECT id, __doc__ FROM documents ORDER BY id").toArray() as { __doc__: string; id: string }[]).map(({ __doc__, id }) => {
            return {
                id,
                title: (JSON.parse(__doc__) as { title: string }).title,
            };
        });

    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    const incrementalSource = (extra: Partial<ExternalSourceLike> = {}): ExternalSourceLike => {
        return {
            binding: "HD",
            cursor: { column: "updatedAt", query: "select id, title, updatedAt from documents where updatedAt >= $1" },
            map: (row) => {
                return { title: row.title, updatedAt: row.updatedAt };
            },
            mode: "incremental",
            query: "select id, title, updatedAt from documents",
            reconcileEveryMs: 10_000,
            ...extra,
        };
    };

    it("first poll is a full-pull seed that records the watermark and reconcile time", async () => {
        expect.assertions(4);

        const writer = setupWriter();
        const { calls, client } = scriptedClient([
            [
                { id: "d1", title: "One", updatedAt: 100 },
                { id: "d2", title: "Two", updatedAt: 250 },
            ],
        ]);

        await pullExternalSourceIncrementalTick(harness.sql, writer, client, "documents", incrementalSource(), "__root__", 5000);

        // Full-pull uses the membership query (no watermark param), not the cursor query.
        expect(calls[0]).toStrictEqual(["select id, title, updatedAt from documents", []]);
        expect(rows()).toStrictEqual([
            { id: "d1", title: "One" },
            { id: "d2", title: "Two" },
        ]);
        expect(readSourceCursor(harness.sql, "documents", "__root__")).toStrictEqual({ lastReconcileMs: 5000, watermark: "n:250" });
        expect(rows()).toHaveLength(2);
    });

    it("steady-state pulls only past the watermark and upserts (no delete of absent rows)", async () => {
        expect.assertions(3);

        const writer = setupWriter();
        const { calls, client } = scriptedClient([
            // seed
            [
                { id: "d1", title: "One", updatedAt: 100 },
                { id: "d2", title: "Two", updatedAt: 250 },
            ],
            // incremental: d2 changed + a new d3; d1 is absent (unchanged) → must NOT be deleted
            [
                { id: "d2", title: "Two-edited", updatedAt: 300 },
                { id: "d3", title: "Three", updatedAt: 400 },
            ],
        ]);
        const source = incrementalSource();

        await pullExternalSourceIncrementalTick(harness.sql, writer, client, "documents", source, "__root__", 5000);
        // 5000 + no reconcile-due (10s interval), same watermark path
        await pullExternalSourceIncrementalTick(harness.sql, writer, client, "documents", source, "__root__", 8000);

        // Second call used the cursor query with the seeded watermark (250) bound.
        expect(calls[1]).toStrictEqual(["select id, title, updatedAt from documents where updatedAt >= $1", [250]]);
        expect(rows()).toStrictEqual([
            { id: "d1", title: "One" }, // untouched, still present
            { id: "d2", title: "Two-edited" }, // upserted
            { id: "d3", title: "Three" }, // inserted
        ]);
        expect(readSourceCursor(harness.sql, "documents", "__root__").watermark).toBe("n:400");
    });

    it("applies soft-delete tombstones as deletes on the incremental slice", async () => {
        expect.assertions(2);

        const writer = setupWriter();
        const { client } = scriptedClient([
            // seed
            [
                { id: "d1", title: "One", updatedAt: 100 },
                { id: "d2", title: "Two", updatedAt: 250 },
            ],
            // incremental: d1 tombstoned
            [{ deleted_at: "2026-07-17T00:00:00Z", id: "d1", title: "One", updatedAt: 300 }],
        ]);
        const source = incrementalSource({ reconcileEveryMs: undefined, softDeleteColumn: "deleted_at" });

        await pullExternalSourceIncrementalTick(harness.sql, writer, client, "documents", source, "__root__", 5000);
        await pullExternalSourceIncrementalTick(harness.sql, writer, client, "documents", source, "__root__", 6000);

        expect(rows()).toStrictEqual([{ id: "d2", title: "Two" }]);
        expect(readSourceCursor(harness.sql, "documents", "__root__").watermark).toBe("n:300");
    });

    it("runs a reconcile full-pull sweep when the interval elapses (GCs absent rows)", async () => {
        expect.assertions(2);

        const writer = setupWriter();
        const { calls, client } = scriptedClient([
            // seed
            [
                { id: "d1", title: "One", updatedAt: 100 },
                { id: "d2", title: "Two", updatedAt: 250 },
            ],
            // reconcile full-pull (d1 gone upstream) → membership query again
            [{ id: "d2", title: "Two", updatedAt: 250 }],
        ]);
        const source = incrementalSource();

        await pullExternalSourceIncrementalTick(harness.sql, writer, client, "documents", source, "__root__", 5000);
        // 5000 + 15000 = 20000 ≥ reconcileEveryMs (10s) → reconcile due
        await pullExternalSourceIncrementalTick(harness.sql, writer, client, "documents", source, "__root__", 20_000);

        // Reconcile used the membership query, and it GC'd d1 (absent = deleted under full-pull).
        expect(calls[1]).toStrictEqual(["select id, title, updatedAt from documents", []]);
        expect(rows()).toStrictEqual([{ id: "d2", title: "Two" }]);
    });

    it("applies nothing when the incremental slice re-pulls only unchanged boundary rows", async () => {
        expect.assertions(2);

        const writer = setupWriter();
        const { client } = scriptedClient([
            // seed → watermark 250
            [
                { id: "d1", title: "One", updatedAt: 100 },
                { id: "d2", title: "Two", updatedAt: 250 },
            ],
            // steady-state `>= 250` re-pulls d2 UNCHANGED (the boundary row) — no real change
            [{ id: "d2", title: "Two", updatedAt: 250 }],
        ]);
        const source = incrementalSource();

        await pullExternalSourceIncrementalTick(harness.sql, writer, client, "documents", source, "__root__", 5000);
        const second = await pullExternalSourceIncrementalTick(harness.sql, writer, client, "documents", source, "__root__", 8000);

        // The unchanged boundary row is short-circuited — zero writes, no spurious broadcast.
        expect(second.applied).toBe(0);
        expect(rows()).toStrictEqual([
            { id: "d1", title: "One" },
            { id: "d2", title: "Two" },
        ]);
    });

    it("advances a numeric-string cursor column numerically through a full tick (bigint sequence)", async () => {
        expect.assertions(1);

        const writer = setupWriter();
        // `updatedAt` arrives as JS strings (as node-postgres returns bigint/numeric).
        const { client } = scriptedClient([
            [
                { id: "d1", title: "One", updatedAt: "9" },
                { id: "d2", title: "Two", updatedAt: "10" },
                { id: "d3", title: "Three", updatedAt: "100" },
            ],
        ]);
        const source = incrementalSource();

        await pullExternalSourceIncrementalTick(harness.sql, writer, client, "documents", source, "__root__", 5000);

        // Not stranded at "9" (the lexical max) — the numeric max is 100.
        expect(readSourceCursor(harness.sql, "documents", "__root__").watermark).toBe("s:100");
    });

    it("throws when the seed query returns rows that don't carry the cursor column (misconfig, fail loud)", async () => {
        expect.assertions(1);

        const writer = setupWriter();
        // Seed rows omit `updatedAt` (the cursor column) → watermark can't advance.
        const { client } = scriptedClient([[{ id: "d1", title: "One" }]]);
        const source = incrementalSource();

        await expect(pullExternalSourceIncrementalTick(harness.sql, writer, client, "documents", source, "__root__", 5000)).rejects.toThrow(
            /none carry the cursor column "updatedAt"/u,
        );
    });

    it("throws when an incremental cursor.query strands the watermark (misaligned cursor column, DO-03)", async () => {
        expect.assertions(1);

        const writer = setupWriter();
        const { client } = scriptedClient([
            // seed → watermark 250
            [
                { id: "d1", title: "One", updatedAt: 100 },
                { id: "d2", title: "Two", updatedAt: 250 },
            ],
            // incremental: cursor.query never projects `updatedAt` at all (a
            // misaliased column, not the legitimate re-pulled-boundary case).
            [{ id: "d3", title: "Three" }],
        ]);
        const source = incrementalSource();

        await pullExternalSourceIncrementalTick(harness.sql, writer, client, "documents", source, "__root__", 5000);

        await expect(pullExternalSourceIncrementalTick(harness.sql, writer, client, "documents", source, "__root__", 8000)).rejects.toThrow(
            /none carry the cursor column "updatedAt"/u,
        );
    });

    it("does NOT throw when the incremental slice legitimately re-pulls the boundary row unchanged (not a DO-03 misconfig)", async () => {
        expect.assertions(1);

        const writer = setupWriter();
        const { client } = scriptedClient([
            [
                { id: "d1", title: "One", updatedAt: 100 },
                { id: "d2", title: "Two", updatedAt: 250 },
            ],
            // `>= 250` re-pulls d2 carrying its actual (unchanged) cursor value —
            // this must NOT be mistaken for a stranded/misaligned cursor.
            [{ id: "d2", title: "Two", updatedAt: 250 }],
        ]);
        const source = incrementalSource();

        await pullExternalSourceIncrementalTick(harness.sql, writer, client, "documents", source, "__root__", 5000);

        await expect(pullExternalSourceIncrementalTick(harness.sql, writer, client, "documents", source, "__root__", 8000)).resolves.toStrictEqual({
            applied: 0,
        });
    });

    it("excludes a tombstoned row from full-pull/reconcile membership when softDeleteColumn is set (DO-04)", async () => {
        expect.assertions(2);

        const writer = setupWriter();
        const { client } = scriptedClient([
            // First-ever poll is a full-pull seed: d1 is ALREADY tombstoned
            // upstream, d2 is live.
            [
                { deleted_at: "2026-07-17T00:00:00Z", id: "d1", title: "One", updatedAt: 100 },
                { id: "d2", title: "Two", updatedAt: 250 },
            ],
        ]);
        const source = incrementalSource({ softDeleteColumn: "deleted_at" });

        await pullExternalSourceIncrementalTick(harness.sql, writer, client, "documents", source, "__root__", 5000);

        // d1 must never be materialized as live — the full-pull seed excludes
        // tombstoned rows from membership, same as the incremental branch does.
        expect(rows()).toStrictEqual([{ id: "d2", title: "Two" }]);
        // The watermark still advances off the RAW rows (including d1's), so a
        // resurrected-then-re-tombstoned row wouldn't strand the cursor.
        expect(readSourceCursor(harness.sql, "documents", "__root__").watermark).toBe("n:250");
    });
});
