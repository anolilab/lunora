import type { ColumnMetaLike, DatabaseWriterLike, SchemaLike, ValidatorLike } from "@lunora/shard-engine";
import { ConflictError } from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { importGlobalRows } from "../src/admin-export-import";
import { createD1CtxDb as createD1ContextDatabase } from "../src/d1-ctx-db";
import { createD1Exec } from "./_helpers/node-sqlite-d1";
import type { ObservedExec } from "./_helpers/observe-exec";
import { observeExec } from "./_helpers/observe-exec";

const FIXED_CLOCK = 1_700_000_000_000;

const col = (kind: string, column: Partial<ColumnMetaLike> = {}): ValidatorLike => {
    return { _meta: { column: { notNull: true, ...column } }, kind };
};

type Exec = ReturnType<typeof createD1Exec>["exec"];
type TriggerHandler = (context: { db: DatabaseWriterLike }, event: { id: string }) => Promise<void>;

/** A single `.global()` table `alpha`, optionally with an after-insert trigger and a count aggregate. */
const schemaWith = (options: { aggregate?: boolean; trigger?: TriggerHandler } = {}): SchemaLike =>
    ({
        tables: {
            alpha: {
                ...(options.aggregate === true ? { aggregateIndexes: [{ by: ["label"], name: "c", on: "alpha", op: "count" }] } : {}),
                indexes: [],
                shape: { label: col("string") },
                shardMode: { kind: "global" },
                ...(options.trigger === undefined ? {} : { triggerMap: { hook: { handler: options.trigger, op: "insert", timing: "after" } } }),
            },
        },
    }) as never;

let harness: ReturnType<typeof createD1Exec>;

const observeProbes = (failWrite?: RegExp, failProbes = false): ObservedExec => observeExec(harness.exec, failWrite, failProbes);

const writerFor = (schema: SchemaLike, exec: Exec = harness.exec): DatabaseWriterLike => createD1ContextDatabase({ clock: () => FIXED_CLOCK, exec, schema });

describe("d1 import against its own triggers", () => {
    beforeEach(() => {
        harness = createD1Exec();
    });

    afterEach(() => {
        harness.close();
    });

    const deleteVictim: TriggerHandler = async (context, event) => {
        if (event.id === "first") {
            await context.db.delete("alpha", "victim");
        }
    };

    const spawn: TriggerHandler = async (context, event) => {
        if (event.id === "first") {
            await context.db.insert("alpha", { _id: "spawned", label: "trigger" }, { allowExplicitId: true });
        }
    };

    it("inserts a row whose id an earlier row's trigger deleted from the same table", async () => {
        expect.assertions(3);

        const schema = schemaWith({ trigger: deleteVictim });
        const writer = writerFor(schema);

        await writer.insert("alpha", { _id: "victim", label: "old" }, { allowExplicitId: true });

        const result = await importGlobalRows(writer, schema, {
            exec: observeProbes().exec,
            rows: [
                { doc: { _id: "first", label: "a" }, table: "alpha" },
                { doc: { _id: "victim", label: "new" }, table: "alpha" },
            ],
        });

        expect(result).toMatchObject({ conflicts: 0, errors: [], inserted: { alpha: 2 }, replaced: 0 });
        await expect(writer.get("alpha", "victim")).resolves.toMatchObject({ label: "new" });
        await expect(writer.get("alpha", "first")).resolves.toMatchObject({ label: "a" });
    });

    it("inserts, rather than fails to replace, a row whose id a trigger deleted under replace", async () => {
        expect.assertions(2);

        const schema = schemaWith({ trigger: deleteVictim });
        const writer = writerFor(schema);

        await writer.insert("alpha", { _id: "victim", label: "old" }, { allowExplicitId: true });

        const result = await importGlobalRows(writer, schema, {
            exec: observeProbes().exec,
            onConflict: "replace",
            rows: [
                { doc: { _id: "first", label: "a" }, table: "alpha" },
                { doc: { _id: "victim", label: "new" }, table: "alpha" },
            ],
        });

        expect(result).toMatchObject({ errors: [], inserted: { alpha: 2 }, replaced: 0 });
        await expect(writer.get("alpha", "victim")).resolves.toMatchObject({ label: "new" });
    });

    it("counts a row whose id an earlier row's trigger created as a conflict, or replaces it", async () => {
        expect.assertions(4);

        const schema = schemaWith({ trigger: spawn });
        const rows = [
            { doc: { _id: "first", label: "a" }, table: "alpha" },
            { doc: { _id: "spawned", label: "b" }, table: "alpha" },
        ];
        const skipped = await importGlobalRows(writerFor(schema), schema, { exec: observeProbes().exec, rows });

        expect(skipped).toMatchObject({ conflicts: 1, errors: [], inserted: { alpha: 1 } });

        harness.close();
        harness = createD1Exec();

        const writer = writerFor(schema);
        const replaced = await importGlobalRows(writer, schema, { exec: observeProbes().exec, onConflict: "replace", rows });

        expect(replaced).toMatchObject({ conflicts: 0, errors: [], inserted: { alpha: 1 }, replaced: 1 });
        await expect(writer.get("alpha", "spawned")).resolves.toMatchObject({ label: "b" });
        await expect(writer.get("alpha", "first")).resolves.toMatchObject({ label: "a" });
    });

    it("probes each row's own table right before its write when a table has triggers, and batches otherwise", async () => {
        expect.assertions(4);

        const rows = [
            { doc: { _id: "p1", label: "a" }, table: "alpha" },
            { doc: { _id: "p2", label: "b" }, table: "alpha" },
            { doc: { _id: "p3", label: "c" }, table: "alpha" },
        ];
        const withTriggers = observeProbes();

        await importGlobalRows(writerFor(schemaWith({ trigger: spawn })), schemaWith({ trigger: spawn }), { exec: withTriggers.exec, rows });

        expect(withTriggers.batched()).toBe(0);
        expect(withTriggers.perRow()).toBe(3);

        harness.close();
        harness = createD1Exec();

        const plain = observeProbes();

        await importGlobalRows(writerFor(schemaWith()), schemaWith(), { exec: plain.exec, rows });

        expect(plain.batched()).toBe(1);
        expect(plain.perRow()).toBe(0);
    });

    it("fails closed when the per-row probe fails: the row errors and nothing is written", async () => {
        expect.assertions(3);

        const schema = schemaWith({ trigger: spawn });
        const writer = writerFor(schema);
        const result = await importGlobalRows(writer, schema, {
            exec: observeProbes(undefined, true).exec,
            rows: [{ doc: { _id: "p1", label: "a" }, table: "alpha" }],
        });

        expect(result.errors).toMatchObject([{ code: "PROBE_FAILED", line: 1, table: "alpha" }]);
        expect(result.inserted).toEqual({});
        await expect(writer.get("alpha", "p1")).resolves.toBeNull();
    });
});

describe("d1 import when a write fails after the base row committed", () => {
    beforeEach(() => {
        harness = createD1Exec();
    });

    afterEach(() => {
        harness.close();
    });

    const AGGREGATE_WRITE = /^\s*INSERT INTO "alpha__agg_c"/u;

    it("reports a companion failure as an error, writes nothing again, and still counts the id as present", async () => {
        expect.assertions(4);

        const schema = schemaWith({ aggregate: true });
        const failing = observeProbes(AGGREGATE_WRITE);
        const writer = writerFor(schema, failing.exec);
        const replace = vi.fn<DatabaseWriterLike["replace"]>(writer.replace.bind(writer));
        const result = await importGlobalRows({ ...writer, replace }, schema, {
            exec: failing.exec,
            onConflict: "replace",
            rows: [{ doc: { _id: "c1", label: "boom" }, table: "alpha" }],
        });

        expect(result).toMatchObject({ conflicts: 0, errors: [{ code: "CONFLICT", line: 1, table: "alpha" }], inserted: {}, replaced: 0 });
        expect(replace).not.toHaveBeenCalled();
        // The base row did commit; only its companion write failed.
        await expect(writer.get("alpha", "c1")).resolves.toMatchObject({ label: "boom" });
        expect(result.errors).toHaveLength(1);
    });

    it("says in the error that the row was stored, so an operator does not re-import it as missing", async () => {
        expect.assertions(2);

        const schema = schemaWith({ aggregate: true });
        const failing = observeProbes(AGGREGATE_WRITE);
        const result = await importGlobalRows(writerFor(schema, failing.exec), schema, {
            exec: failing.exec,
            rows: [{ doc: { _id: "c2", label: "boom" }, table: "alpha" }],
        });

        // A re-import would skip the row as a conflict and never redo the failed work, so the report must say so.
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]?.message).toMatch(/row "c2" was stored/u);
    });

    it("counts a later row repeating that id as a conflict instead of rechecking the failed one", async () => {
        expect.assertions(2);

        const schema = schemaWith({ aggregate: true });
        const failing = observeProbes(AGGREGATE_WRITE);
        const result = await importGlobalRows(writerFor(schema, failing.exec), schema, {
            exec: failing.exec,
            rows: [
                { doc: { _id: "c1", label: "boom" }, table: "alpha" },
                { doc: { _id: "c1", label: "again" }, table: "alpha" },
            ],
        });

        expect(result.errors).toMatchObject([{ code: "CONFLICT", line: 1 }]);
        expect(result).toMatchObject({ conflicts: 1, inserted: {} });
    });

    it("reports a trigger's unique violation after the row landed as an error, not a conflict, and never replaces", async () => {
        expect.assertions(3);

        const schema = schemaWith({
            trigger: async () => {
                throw new ConflictError("unique index breached");
            },
        });
        const writer = writerFor(schema);
        const replace = vi.fn<DatabaseWriterLike["replace"]>(writer.replace.bind(writer));
        const result = await importGlobalRows({ ...writer, replace }, schema, {
            exec: observeProbes().exec,
            onConflict: "replace",
            rows: [{ doc: { _id: "t1", label: "a" }, table: "alpha" }],
        });

        expect(result).toMatchObject({ conflicts: 0, errors: [{ code: "CONFLICT", line: 1 }], inserted: {}, replaced: 0 });
        expect(replace).not.toHaveBeenCalled();
        await expect(writer.get("alpha", "t1")).resolves.toMatchObject({ label: "a" });
    });
});
