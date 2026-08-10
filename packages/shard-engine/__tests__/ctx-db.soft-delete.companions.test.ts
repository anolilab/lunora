import type { SchemaLike as VectorSchemaLike, VectorSearchLike } from "@lunora/bindings/vectors";
import { createVectorSyncHook } from "@lunora/bindings/vectors";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { aggregateTableName } from "../src/aggregate-tally";
import type { DatabaseWriterLike, SchemaLike, WriteHook } from "../src/ctx-db";
import { backfillAggregateIndexes, createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * Companions a soft delete must drop, because no read-time marker filter is
 * possible for them: the rank companion (its row carries no marker column),
 * external Vectorize (its query can't be scoped), and the aggregate companion
 * (a maintained tally, so there is nothing to filter at read time). A soft
 * delete removes the row from all three, like a physical delete; `restore()`
 * re-adds them via the patch path.
 */
const FIXED = 1_700_000_000_000;

describe("soft delete — rank companion", () => {
    const schema: SchemaLike = {
        tables: {
            scores: {
                indexes: [],
                rankIndexes: [{ name: "by_score", on: "scores", sortBy: [{ direction: "desc", field: "score" }] }],
                shape: { deletedAt: { kind: "number" }, score: { kind: "number" } },
                softDeleteMode: { field: "deletedAt" },
            },
        },
    };

    let harness: ReturnType<typeof createSqliteExec>;

    const setup = async (): Promise<DatabaseWriterLike> => {
        runShardMigrations(harness.sql, schema);

        const writer = createShardContextDatabase({ clock: () => FIXED, schema, sql: harness.sql });

        await writer.insert("scores", { _id: "s1", score: 10 }, { allowExplicitId: true });
        await writer.insert("scores", { _id: "s2", score: 20 }, { allowExplicitId: true });
        await writer.insert("scores", { _id: "s3", score: 30 }, { allowExplicitId: true });

        return writer;
    };

    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    it("excludes a soft-deleted row from rankPage, and restore re-adds it", async () => {
        expect.assertions(3);

        const writer = await setup();

        await writer.delete("s2", "scores");

        const afterDelete = await writer.rankPage("scores", "by_score", {});

        expect(afterDelete.page.map((row) => row["_id"])).toStrictEqual(["s3", "s1"]);

        await writer.restore!("s2", "scores");

        const afterRestore = await writer.rankPage("scores", "by_score", {});

        expect(afterRestore.page.map((row) => row["_id"])).toStrictEqual(["s3", "s2", "s1"]);

        // hardDelete keeps it out for good.
        await writer.delete("s2", "scores", { hard: true });

        const afterHard = await writer.rankPage("scores", "by_score", {});

        expect(afterHard.page.map((row) => row["_id"])).toStrictEqual(["s3", "s1"]);
    });
});

/**
 * The aggregate companion is the one a soft delete keeps — by dropping the row
 * from its tally rather than by read-filtering. It has to be that way round:
 * the companion row carries no marker column, so a reader that could not trust
 * it had to fall back to the SQL scan — and the scan REFUSES a projected field
 * (it would reduce the order-preserving key, not the value). Before the
 * companion became live-only, that left a bigint column with no way to be
 * aggregated at all on a `.softDelete()` table, at any magnitude.
 *
 * Every case here therefore aggregates a PROJECTED column, because that is the
 * only shape that reaches the companion on a soft-delete table — a reader whose
 * scan can answer keeps the scan (see the note on `isProjectedField`). A case
 * that groups or counts on a plain column would pass with the fix reverted and
 * prove nothing.
 */
describe("soft delete — aggregate companion", () => {
    const schema: SchemaLike = {
        tables: {
            invoices: {
                aggregateIndexes: [
                    { by: ["currency"], field: "amountMinor", name: "sumByCurrency", on: "invoices", op: "sum" },
                    { by: ["currency"], field: "amountMinor", name: "maxByCurrency", on: "invoices", op: "max" },
                    // `loose` is `v.any()`: its stored form depends on the RUNTIME
                    // value, so a bigint under it is padded-key text exactly like a
                    // declared one. The recompute has to reduce it in JS too.
                    { by: ["currency"], field: "loose", name: "maxLooseByCurrency", on: "invoices", op: "max" },
                ],
                indexes: [],
                shape: { amountMinor: { kind: "bigint" }, currency: { kind: "string" }, deletedAt: { kind: "number" }, loose: { kind: "any" } },
                softDeleteMode: { field: "deletedAt" },
            },
        },
    } as unknown as SchemaLike;

    let harness: ReturnType<typeof createSqliteExec>;

    const setup = async (): Promise<DatabaseWriterLike> => {
        runShardMigrations(harness.sql, schema);

        const writer = createShardContextDatabase({ clock: () => FIXED, schema, sql: harness.sql });

        await writer.insert("invoices", { _id: "i1", amountMinor: 9n, currency: "usd", loose: 9n }, { allowExplicitId: true });
        await writer.insert("invoices", { _id: "i2", amountMinor: 10n, currency: "usd", loose: 10n }, { allowExplicitId: true });
        await writer.insert("invoices", { _id: "i3", amountMinor: 200n, currency: "eur", loose: 200n }, { allowExplicitId: true });

        return writer;
    };

    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    it("sums a bigint column on a soft-delete table (pre-fix: threw, no path existed)", async () => {
        expect.assertions(2);

        const writer = await setup();

        await expect(writer.aggregate("invoices", { field: "amountMinor", op: "sum", where: { currency: "usd" } })).resolves.toBe(19);

        await writer.delete("i1", "invoices");

        await expect(writer.aggregate("invoices", { field: "amountMinor", op: "sum", where: { currency: "usd" } })).resolves.toBe(10);
    });

    it("re-adds the row to the tally on restore", async () => {
        expect.assertions(2);

        const writer = await setup();

        await writer.delete("i2", "invoices");

        await expect(writer.aggregate("invoices", { field: "amountMinor", op: "sum", where: { currency: "usd" } })).resolves.toBe(9);

        await writer.restore!("i2", "invoices");

        await expect(writer.aggregate("invoices", { field: "amountMinor", op: "sum", where: { currency: "usd" } })).resolves.toBe(19);
    });

    it("recomputes a max group's extreme over live rows only", async () => {
        expect.assertions(2);

        // The departing row carries the stored extreme, which is the branch that
        // recomputes from the source table — so that recompute has to exclude
        // soft-deleted rows too, or the deleted 10n comes straight back.
        const writer = await setup();

        await expect(writer.aggregate("invoices", { field: "amountMinor", op: "max", where: { currency: "usd" } })).resolves.toBe(10);

        await writer.delete("i2", "invoices");

        await expect(writer.aggregate("invoices", { field: "amountMinor", op: "max", where: { currency: "usd" } })).resolves.toBe(9);
    });

    it("omits a group whose last live row was soft-deleted, summing a bigint", async () => {
        expect.assertions(3);

        // Reduces a PROJECTED field, so it goes through the companion — the scan
        // would refuse it. A companion row left at count 0 would surface as a
        // phantom group the SQL `GROUP BY` it stands in for never returns.
        const writer = await setup();
        const options = { agg: { field: "amountMinor", op: "sum" }, by: ["currency"] } as const;

        await expect(writer.groupBy("invoices", options)).resolves.toHaveLength(2);

        await writer.delete("i3", "invoices");

        const groups = await writer.groupBy("invoices", options);

        expect(groups.map((group) => group.key["currency"])).toStrictEqual(["usd"]);
        expect(groups[0]?.value).toBe(19);
    });

    it("recomputes a v.any() column's extreme into the companion as a value, not a padded key", async () => {
        expect.assertions(1);

        // The projection runs on the RUNTIME type, so a bigint under a `v.any()`
        // column is stored as the same padded key a declared one is. Gating the
        // recompute on the DECLARED kind sent this down the SQL branch, where
        // MAX over the padded text coerces to ~1e39 and is written back as the
        // group's extreme — the same silent wrong number, one declaration away.
        //
        // Asserted against the companion row rather than through `aggregate()`,
        // because the READER's refusal (`assertReducibleBySql`) is narrow in the
        // same way and would serve this column off the scan — a separate,
        // pre-existing gap recorded in plan 312 §10. This pins the write.
        const writer = await setup();

        await writer.delete("i2", "invoices");

        // Named through `aggregateTableName` rather than spelled out, so the
        // assertion cannot drift from the companion's real naming rule.
        const companion = aggregateTableName("invoices", "maxLooseByCurrency");
        const usd = harness.sql.exec(`SELECT __value__ AS value FROM ${companion} WHERE __key__ = ?`, JSON.stringify({ currency: "usd" })).toArray()[0] as
            undefined | { value: number };

        expect(usd?.value).toBe(9);
    });

    it("seeds the EXPLICIT backfill over live rows only", async () => {
        expect.assertions(1);

        // `backfillAggregateIndexes` is the eager twin of the lazy rebuild — a
        // separate implementation with its own idempotence guard, so the
        // liveness rule has to hold in both or a host that pre-seeds its
        // companions gets a different answer from one that does not. The lazy
        // path is covered above; this is the twin.
        const writer = await setup();

        await writer.delete("i1", "invoices");

        // Drop the companions so the eager seed does the work rather than
        // no-opping on its `hasRows` guard.
        harness.sql.exec(`DELETE FROM ${aggregateTableName("invoices", "sumByCurrency")}`);
        backfillAggregateIndexes(harness.sql, schema);

        const usd = harness.sql
            .exec(`SELECT __value__ AS value FROM ${aggregateTableName("invoices", "sumByCurrency")} WHERE __key__ = ?`, JSON.stringify({ currency: "usd" }))
            .toArray()[0] as undefined | { value: number };

        expect(usd?.value).toBe(10);
    });

    it("holds the 2^53 companion bound on rows that are dead on arrival", async () => {
        expect.assertions(2);

        // The liveness gate decides what the tally COUNTS, and must not decide
        // what the table ACCEPTS. A row stamped deleted on insert, or patched
        // while dead, contributes nothing today — but `restore()` makes it
        // contribute tomorrow, and the refusal would land there: on a write the
        // caller cannot fix, leaving a row that can never be brought back.
        const writer = await setup();
        const huge = 9_007_199_254_740_993n;

        const onInsert = await writer
            .insert("invoices", { _id: "dead", amountMinor: huge, currency: "usd", deletedAt: 5 }, { allowExplicitId: true })
            .catch((error: unknown) => error);

        expect((onInsert as Error).message).toContain("MAX_SAFE_INTEGER");

        await writer.delete("i1", "invoices");

        const onPatch = await writer.patch("i1", { amountMinor: huge }, "invoices").catch((error: unknown) => error);

        expect((onPatch as Error).message).toContain("MAX_SAFE_INTEGER");
    });

    it("rebuilds a companion in a fresh ctx-db over live rows only", async () => {
        expect.assertions(1);

        // The lazy backfill rebuilds from the source table on first touch, so it
        // is a second place the live-only rule has to hold — a fresh ctx-db
        // reading after a soft delete must not re-tally the deleted row.
        const writer = await setup();

        await writer.delete("i1", "invoices");

        const reader = createShardContextDatabase({ clock: () => FIXED, schema, sql: harness.sql });

        await expect(reader.aggregate("invoices", { field: "amountMinor", op: "sum", where: { currency: "usd" } })).resolves.toBe(10);
    });
});

const embed = async (value: string): Promise<ReadonlyArray<number>> => [value.length];

describe("soft delete — Vectorize sync", () => {
    const ctxSchema: SchemaLike = {
        tables: {
            messages: {
                indexes: [],
                shape: { deletedAt: { kind: "number" }, text: { kind: "string" } },
                softDeleteMode: { field: "deletedAt" },
            },
        },
    };

    const vectorsSchema: VectorSchemaLike = {
        tables: { messages: { vectorIndexes: [{ embed, field: "text", name: "messages-text" }] } },
        vectorIndexes: {},
    };

    const fakeVectors = (): VectorSearchLike & { deletes: [string, ReadonlyArray<string>][]; upserts: [string, unknown][] } => {
        const upserts: [string, unknown][] = [];
        const deletes: [string, ReadonlyArray<string>][] = [];

        return {
            deleteByIds: vi.fn<VectorSearchLike["deleteByIds"]>(async (indexName, indexIds) => {
                deletes.push([indexName, indexIds]);
            }),
            deletes,
            getByIds: vi.fn<VectorSearchLike["getByIds"]>(async () => []),
            query: vi.fn<VectorSearchLike["query"]>(async () => {
                return { count: 0, matches: [] };
            }),
            upsert: vi.fn<VectorSearchLike["upsert"]>(async (indexName, input) => {
                upserts.push([indexName, input]);
            }),
            upsertNow: vi.fn<VectorSearchLike["upsertNow"]>(async (indexName, input) => {
                upserts.push([indexName, input]);
            }),
            upserts,
        };
    };

    let harness: ReturnType<typeof createSqliteExec>;

    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    it("drops the vector on soft delete and re-upserts on restore", async () => {
        expect.assertions(3);

        runShardMigrations(harness.sql, ctxSchema);

        const vectors = fakeVectors();
        const onWrite: WriteHook = createVectorSyncHook({ schema: vectorsSchema, vectors });
        const writer = createShardContextDatabase({ clock: () => FIXED, idGenerator: () => "m1", onWrite, schema: ctxSchema, sql: harness.sql });

        await writer.insert("messages", { text: "hello" });

        expect(vectors.upserts).toHaveLength(1);

        // Soft delete must REMOVE the vector (else it leaks into similarity search).
        await writer.delete("m1", "messages");

        expect(vectors.deletes).toStrictEqual([["messages-text", ["m1"]]]);

        // Restore re-embeds it.
        await writer.restore!("m1", "messages");

        expect(vectors.upserts).toHaveLength(2);
    });
});
