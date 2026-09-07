import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createShardCtxDb as createShardContextDatabase } from "../src/ctx-db";
import { readCdcChanges } from "../src/ctx-db-cdc";
import { runShardMigrations } from "../src/ctx-db-migrations";
import { materializeExternalRows, materializeExternalRowsIncremental, runExternalSourceTick } from "../src/external-source-materialize";
import type { DatabaseWriterLike, SchemaLike } from "../src/schema-types";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * Integration round-trip for plan 077's materialize primitive, driven through the
 * real `createShardCtxDb` writer + a real SQLite engine. The pure diff test proves
 * the change computation; this proves the *apply* — that a pulled membership lands
 * in the DO table as the right inserts/updates/deletes AND appends to `__cdc_log`
 * (the property that makes a sourced table live-pokeable to `defineShape`).
 */

const schema: SchemaLike = {
    tables: {
        documents: {
            indexes: [],
            shape: { orgId: { kind: "string" }, title: { kind: "string" } },
        },
    },
};

let harness: ReturnType<typeof createSqliteExec>;

const setupWriter = (): DatabaseWriterLike => {
    runShardMigrations(harness.sql, schema, { cdc: true });

    return createShardContextDatabase({ broadcast: () => undefined, cdc: true, clock: () => 1_700_000_000_000, schema, sql: harness.sql });
};

/** Read the table's current membership as the canonical `id → JSON` baseline (the full-pull baseline the DO derives from its own SQLite). */
const readBaseline = (): Map<string, string> => {
    const rows = harness.sql.exec("SELECT id, __doc__ FROM documents").toArray() as { __doc__: string; id: string }[];

    return new Map(
        rows.map(({ __doc__, id }) => {
            const stored = JSON.parse(__doc__) as Record<string, unknown>;

            return [id, JSON.stringify({ _id: id, orgId: stored.orgId, title: stored.title })];
        }),
    );
};

describe("materializeExternalRows", () => {
    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    it("applies inserts, updates, and deletes to bring the table to the pulled membership", async () => {
        expect.assertions(6);

        const writer = setupWriter();

        // Seed the local table: d1, d2, d3.
        await writer.insert("documents", { _id: "d1", orgId: "org_1", title: "one" }, { allowExplicitId: true });
        await writer.insert("documents", { _id: "d2", orgId: "org_1", title: "two" }, { allowExplicitId: true });
        await writer.insert("documents", { _id: "d3", orgId: "org_1", title: "three" }, { allowExplicitId: true });

        // Upstream now: d1 unchanged, d2 retitled, d3 gone, d4 new.
        const pulled = [
            { _id: "d1", orgId: "org_1", title: "one" },
            { _id: "d2", orgId: "org_1", title: "two-edited" },
            { _id: "d4", orgId: "org_1", title: "four" },
        ];

        const { applied, nextBaseline } = await materializeExternalRows(writer, pulled, readBaseline(), { table: "documents" });

        // update d2 + insert d4 + delete d3 = 3 changes.
        expect(applied).toBe(3);

        await expect(writer.get("d2")).resolves.toMatchObject({ _id: "d2", title: "two-edited" });
        await expect(writer.get("d4")).resolves.toMatchObject({ _id: "d4", title: "four" });
        await expect(writer.get("d3")).resolves.toBeNull();

        // The returned baseline reflects the post-tick membership (d1, d2, d4).
        expect([...nextBaseline.keys()].toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["d1", "d2", "d4"]);

        // The applied changes appended to the CDC log — so a defineShape subscriber gets poked.
        const { changes } = readCdcChanges(harness.sql);
        const sourcedOps = changes.filter((change) => ["d2", "d3", "d4"].includes(change.id)).map((change) => `${change.op}:${change.id}`);

        // Seed inserts (d2, d3), then the materialize delta in diff order: upserts in pulled order (update d2, insert d4), then deletes (d3).
        expect(sourcedOps).toStrictEqual(["insert:d2", "insert:d3", "update:d2", "insert:d4", "delete:d3"]);
    });

    it("applies nothing and reproduces the baseline on a steady-state tick", async () => {
        expect.assertions(2);

        const writer = setupWriter();

        await writer.insert("documents", { _id: "d1", orgId: "org_1", title: "one" }, { allowExplicitId: true });

        const baseline = readBaseline();
        const pulled = [{ _id: "d1", orgId: "org_1", title: "one" }];

        const { applied, nextBaseline } = await materializeExternalRows(writer, pulled, baseline, { table: "documents" });

        expect(applied).toBe(0);
        expect([...nextBaseline]).toStrictEqual([...baseline]);
    });
});

describe("materializeExternalRowsIncremental (upsert-only, plan 136)", () => {
    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    it("upserts the slice (insert new, replace existing) and never deletes an absent row", async () => {
        expect.assertions(4);

        const writer = setupWriter();

        await writer.insert("documents", { _id: "d1", orgId: "org_1", title: "one" }, { allowExplicitId: true });
        await writer.insert("documents", { _id: "d2", orgId: "org_1", title: "two" }, { allowExplicitId: true });

        // Incremental slice: d2 changed + d3 new. d1 is absent but must remain.
        const pulled = [
            { _id: "d2", orgId: "org_1", title: "two-edited" },
            { _id: "d3", orgId: "org_1", title: "three" },
        ];

        const { applied } = await materializeExternalRowsIncremental(writer, pulled, { table: "documents" });

        expect(applied).toBe(2);
        await expect(writer.get("d1")).resolves.toMatchObject({ _id: "d1", title: "one" });
        await expect(writer.get("d2")).resolves.toMatchObject({ _id: "d2", title: "two-edited" });
        await expect(writer.get("d3")).resolves.toMatchObject({ _id: "d3", title: "three" });
    });

    it("skips a re-pulled boundary row whose content is unchanged (no spurious update/CDC)", async () => {
        expect.assertions(3);

        const writer = setupWriter();

        await writer.insert("documents", { _id: "d1", orgId: "org_1", title: "one" }, { allowExplicitId: true });

        const cdcBefore = readCdcChanges(harness.sql).changes.length;

        // The `>= watermark` slice re-pulls d1 unchanged; it must NOT be re-applied.
        const { applied } = await materializeExternalRowsIncremental(writer, [{ _id: "d1", orgId: "org_1", title: "one" }], { table: "documents" });

        expect(applied).toBe(0);
        await expect(writer.get("d1")).resolves.toMatchObject({ _id: "d1", title: "one" });
        // No new CDC entry ⇒ no broadcast / re-embed for the unchanged row.
        expect(readCdcChanges(harness.sql).changes).toHaveLength(cdcBefore);
    });

    it("turns a `deletedIds` entry into a delete while upserting the rest", async () => {
        expect.assertions(2);

        const writer = setupWriter();

        await writer.insert("documents", { _id: "d1", orgId: "org_1", title: "one" }, { allowExplicitId: true });

        const pulled = [
            { _id: "d1", orgId: "org_1", title: "one" },
            { _id: "d2", orgId: "org_1", title: "two" },
        ];

        await materializeExternalRowsIncremental(writer, pulled, { deletedIds: new Set(["d1"]), table: "documents" });

        await expect(writer.get("d1")).resolves.toBeNull();
        await expect(writer.get("d2")).resolves.toMatchObject({ _id: "d2", title: "two" });
    });

    it("skips re-emitting a boundary tombstone whose row is already absent locally (no repeated delete, DO-05)", async () => {
        expect.assertions(4);

        const writer = setupWriter();

        await writer.insert("documents", { _id: "d1", orgId: "org_1", title: "one" }, { allowExplicitId: true });

        const pulled = [{ _id: "d1", orgId: "org_1", title: "one" }];

        // First tick: d1 is tombstoned upstream — the delete is emitted and applied.
        const first = await materializeExternalRowsIncremental(writer, pulled, { deletedIds: new Set(["d1"]), table: "documents" });

        expect(first.applied).toBe(1);
        await expect(writer.get("d1")).resolves.toBeNull();

        // Second tick re-pulls the SAME boundary tombstone (still `>= watermark`,
        // same as the content short-circuit's rationale) — d1 is already absent
        // locally, so the delete must not be re-emitted (no repeated CDC/broadcast).
        const second = await materializeExternalRowsIncremental(writer, pulled, { deletedIds: new Set(["d1"]), table: "documents" });

        expect(second.applied).toBe(0);
        await expect(writer.get("d1")).resolves.toBeNull();
    });
});

describe("runExternalSourceTick — CDC delete pins to its own table (DO-02)", () => {
    // Two non-global tables sharing an id namespace, "otherTable" declared
    // BEFORE "documents" — `locateRowById`'s cross-table UNION-ALL probe (used
    // when a delete carries no `expectedTable`) matches branches in schema
    // declaration order, so this ordering is what makes an unpinned delete
    // reliably mis-hit the wrong table instead of accidentally the right one.
    const twoTableSchema: SchemaLike = {
        tables: {
            otherTable: { indexes: [], shape: { note: { kind: "string" } } },
            documents: { indexes: [], shape: { orgId: { kind: "string" }, title: { kind: "string" } } },
        },
    };

    let twoTableHarness: ReturnType<typeof createSqliteExec>;

    const setupTwoTableWriter = (): DatabaseWriterLike => {
        runShardMigrations(twoTableHarness.sql, twoTableSchema, { cdc: true });

        return createShardContextDatabase({
            broadcast: () => undefined,
            cdc: true,
            clock: () => 1_700_000_000_000,
            schema: twoTableSchema,
            sql: twoTableHarness.sql,
        });
    };

    beforeEach(() => {
        twoTableHarness = createSqliteExec();
    });

    afterEach(() => {
        twoTableHarness.close();
    });

    it("a sourced-table delete never removes a same-id row living in a different table", async () => {
        expect.assertions(2);

        const writer = setupTwoTableWriter();

        // Same id string, deliberately present in BOTH tables.
        await writer.insert("otherTable", { _id: "dup1", note: "unrelated row, must survive" }, { allowExplicitId: true });
        await writer.insert("documents", { _id: "dup1", orgId: "org_1", title: "to be deleted" }, { allowExplicitId: true });

        // Upstream membership is now empty for "documents" → the diff against
        // the current baseline (dup1 present) emits a delete for table "documents".
        await runExternalSourceTick(twoTableHarness.sql, writer, [], { table: "documents" });

        // The pinned delete (`applyCdcChange` passing `change.table`) must only
        // ever reach "documents" — an unpinned delete would probe both tables in
        // declaration order and remove "otherTable"'s row instead (DO-02).
        await expect(writer.get("dup1", "documents")).resolves.toBeNull();
        await expect(writer.get("dup1", "otherTable")).resolves.toMatchObject({ note: "unrelated row, must survive" });
    });

    it("a sourced-table update never rewrites a same-id row living in a different table", async () => {
        expect.assertions(3);

        const writer = setupTwoTableWriter();

        // Same id string, deliberately present in BOTH tables — same premise as
        // the delete case above, but this time the upstream row CHANGES rather
        // than disappearing, which is the incremental tick's normal update path.
        await writer.insert("otherTable", { _id: "dup1", note: "unrelated row, must survive" }, { allowExplicitId: true });
        await writer.insert("documents", { _id: "dup1", orgId: "org_1", title: "before" }, { allowExplicitId: true });

        // Upstream still holds dup1, retitled -> the diff emits `op: "update"`,
        // whose replay is insert-then-replace. The replace must carry the table.
        await runExternalSourceTick(twoTableHarness.sql, writer, [{ _id: "dup1", orgId: "org_1", title: "after" }], { table: "documents" });

        await expect(writer.get("dup1", "documents")).resolves.toMatchObject({ title: "after" });
        await expect(writer.get("dup1", "otherTable")).resolves.toMatchObject({ note: "unrelated row, must survive" });
        // The documents shape must not have leaked into the otherTable row.
        await expect(writer.get("dup1", "otherTable")).resolves.not.toHaveProperty("title");
    });

    it("an incremental sourced-table tick never rewrites a same-id row living in a different table", async () => {
        expect.assertions(2);

        const writer = setupTwoTableWriter();

        await writer.insert("otherTable", { _id: "dup1", note: "unrelated row, must survive" }, { allowExplicitId: true });
        await writer.insert("documents", { _id: "dup1", orgId: "org_1", title: "before" }, { allowExplicitId: true });

        // The incremental tick emits `op: "insert"` even for a changed existing
        // row, so the PK collision routes it through the same replace fallback.
        await materializeExternalRowsIncremental(writer, [{ _id: "dup1", orgId: "org_1", title: "after" }], { table: "documents" });

        await expect(writer.get("dup1", "documents")).resolves.toMatchObject({ title: "after" });
        await expect(writer.get("dup1", "otherTable")).resolves.toMatchObject({ note: "unrelated row, must survive" });
    });
});

describe("runExternalSourceTick (real baseline read from the table)", () => {
    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    it("a steady tick applies nothing — the stored _creationTime + key order do not register as a change", async () => {
        expect.assertions(2);

        const writer = setupWriter();

        // Seed: the writer stamps `_creationTime` and stores the doc in its own key order.
        await writer.insert("documents", { _id: "d1", orgId: "org_1", title: "one" }, { allowExplicitId: true });
        await writer.insert("documents", { _id: "d2", orgId: "org_1", title: "two" }, { allowExplicitId: true });

        // Pulled rows are the SOURCE shape: no `_creationTime`, keys in a different
        // order than stored. Canonicalization must make these compare equal.
        const pulled = [
            { title: "one", _id: "d1", orgId: "org_1" },
            { orgId: "org_1", title: "two", _id: "d2" },
        ];

        const first = await runExternalSourceTick(harness.sql, writer, pulled, { table: "documents" });

        expect(first.applied).toBe(0);

        // A second tick is also a no-op — the baseline derived from the table is stable.
        const second = await runExternalSourceTick(harness.sql, writer, pulled, { table: "documents" });

        expect(second.applied).toBe(0);
    });

    it("reads the live table as the baseline, so it applies only the upstream delta and deletes", async () => {
        expect.assertions(4);

        const writer = setupWriter();

        await writer.insert("documents", { _id: "d1", orgId: "org_1", title: "one" }, { allowExplicitId: true });
        await writer.insert("documents", { _id: "d2", orgId: "org_1", title: "two" }, { allowExplicitId: true });

        // Upstream: d1 retitled, d2 gone, d3 new.
        const pulled = [
            { _id: "d1", orgId: "org_1", title: "one-edited" },
            { _id: "d3", orgId: "org_1", title: "three" },
        ];

        const { applied } = await runExternalSourceTick(harness.sql, writer, pulled, { table: "documents" });

        // update d1 + insert d3 + delete d2 = 3.
        expect(applied).toBe(3);
        await expect(writer.get("d1")).resolves.toMatchObject({ title: "one-edited" });
        await expect(writer.get("d2")).resolves.toBeNull();
        await expect(writer.get("d3")).resolves.toMatchObject({ title: "three" });
    });
});
