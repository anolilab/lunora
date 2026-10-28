import type { ColumnMetaLike, DatabaseWriterLike, SchemaLike, ValidatorLike } from "@lunora/shard-engine";
import { ConflictError } from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { importGlobalRows } from "../src/admin-export-import";
import { createD1CtxDb as createD1ContextDatabase } from "../src/d1-ctx-db";
import { createD1Exec } from "./_helpers/node-sqlite-d1";

const FIXED_CLOCK = 1_700_000_000_000;

const col = (kind: string, column: Partial<ColumnMetaLike> = {}): ValidatorLike => {
    return { _meta: { column: { notNull: true, ...column } }, kind };
};

const globalTable = (): SchemaLike["tables"][string] => {
    return { indexes: [], shape: { label: col("string") }, shardMode: { kind: "global" } as never };
};

const schemaOf = (names: ReadonlyArray<string>): SchemaLike => {
    return { tables: Object.fromEntries(names.map((name) => [name, globalTable()])) };
};

/** Ownership probes are the only statements that select a `slot`; provisioning and inserts never do. */
const OWNER_PROBE = /AS slot/u;

type Exec = ReturnType<typeof createD1Exec>["exec"];

let harness: ReturnType<typeof createD1Exec>;

const counting = (failOn?: (probeNumber: number) => boolean): { exec: Exec; probes: () => number } => {
    let probes = 0;

    return {
        exec: {
            all: async (query, parameters) => {
                if (OWNER_PROBE.test(query)) {
                    probes += 1;

                    if (failOn?.(probes)) {
                        throw new Error("probe unavailable");
                    }
                }

                return harness.exec.all(query, parameters);
            },
            run: (query, parameters) => harness.exec.run(query, parameters),
        },
        probes: () => probes,
    };
};

const writerFor = (schema: SchemaLike): DatabaseWriterLike => createD1ContextDatabase({ clock: () => FIXED_CLOCK, exec: harness.exec, schema });

describe("d1 import ownership probe", () => {
    beforeEach(() => {
        harness = createD1Exec();
    });

    afterEach(() => {
        harness.close();
    });

    it("probes many rows across two tables in packed statements, not one per row", async () => {
        expect.assertions(2);

        const schema = schemaOf(["alpha", "beta"]);
        const probe = counting();
        const result = await importGlobalRows(writerFor(schema), schema, {
            exec: probe.exec,
            rows: Array.from({ length: 150 }, (_, index) => {
                return { doc: { _id: `a${String(index)}`, label: "x" }, table: "alpha" };
            }),
        });

        expect(result).toMatchObject({ conflicts: 0, errors: [], inserted: { alpha: 150 } });
        // 150 ids x 2 tables = 300 bound ids at 100 per statement; a per-row probe issued 150.
        expect(probe.probes()).toBe(3);
    });

    it("probes one row against sixty tables in a single statement", async () => {
        expect.assertions(2);

        const schema = schemaOf(Array.from({ length: 60 }, (_, index) => `t${String(index).padStart(2, "0")}`));
        const probe = counting();
        const result = await importGlobalRows(writerFor(schema), schema, { exec: probe.exec, rows: [{ doc: { _id: "one", label: "x" }, table: "t59" }] });

        expect(result).toMatchObject({ errors: [], inserted: { t59: 1 } });
        // The per-row probe asked 50 tables per statement: two round trips for the same row.
        expect(probe.probes()).toBe(1);
    });

    it("issues no probe for rows that fail validation or decoding", async () => {
        expect.assertions(2);

        const schema = schemaOf(["alpha"]);
        const probe = counting();
        const result = await importGlobalRows(writerFor(schema), schema, {
            exec: probe.exec,
            rows: [
                { doc: { _id: "bad1", unknown: 1 }, table: "alpha" },
                { doc: null as never, table: "alpha" },
            ],
        });

        expect(result.errors).toHaveLength(2);
        expect(probe.probes()).toBe(0);
    });

    it("names the first other table holding the id, and sees an id repeated across tables in one import", async () => {
        expect.assertions(2);

        const schema = schemaOf(["alpha", "beta", "gamma"]);
        const result = await importGlobalRows(writerFor(schema), schema, {
            exec: counting().exec,
            rows: [
                { doc: { _id: "x1", label: "a" }, table: "gamma" },
                { doc: { _id: "x1", label: "b" }, table: "alpha" },
                { doc: { _id: "x1", label: "c" }, table: "gamma" },
            ],
        });

        expect(result.errors).toMatchObject([{ code: "ID_COLLISION", line: 2, message: expect.stringContaining('"gamma"'), table: "alpha" }]);
        expect(result).toMatchObject({ conflicts: 1, inserted: { gamma: 1 } });
    });

    it("fails closed: a failing probe errors every row that carries an id and inserts nothing", async () => {
        expect.assertions(3);

        const schema = schemaOf(["alpha"]);
        const writer = writerFor(schema);
        const result = await importGlobalRows(writer, schema, {
            exec: counting(() => true).exec,
            rows: [
                { doc: { _id: "p1", label: "a" }, table: "alpha" },
                { doc: { _id: "p2", label: "b" }, table: "alpha" },
            ],
        });

        expect(result.errors).toMatchObject([
            { code: "PROBE_FAILED", line: 1 },
            { code: "PROBE_FAILED", line: 2 },
        ]);
        expect(result.inserted).toEqual({});
        await expect(writer.get("alpha", "p1")).resolves.toBeNull();
    });

    it("reports a row whose id appeared since the batch probe as a conflict, not an insert failure", async () => {
        expect.assertions(2);

        const base = schemaOf(["alpha"]);
        const triggerSchema = {
            tables: {
                alpha: {
                    ...base.tables["alpha"]!,
                    triggerMap: {
                        mirror: {
                            handler: async (context: { db: DatabaseWriterLike }, event: { id: string }) => {
                                if (event.id === "first") {
                                    await context.db.insert("alpha", { _id: "spawned", label: "trigger" }, { allowExplicitId: true });
                                }
                            },
                            op: "insert",
                            timing: "after",
                        },
                    },
                },
            },
        } as never as SchemaLike;
        const writer = writerFor(triggerSchema);
        const result = await importGlobalRows(writer, triggerSchema, {
            exec: counting().exec,
            rows: [
                { doc: { _id: "first", label: "a" }, table: "alpha" },
                { doc: { _id: "spawned", label: "b" }, table: "alpha" },
            ],
        });

        expect(result).toMatchObject({ conflicts: 1, errors: [], inserted: { alpha: 1 } });
        await expect(writer.get("alpha", "spawned")).resolves.toMatchObject({ label: "trigger" });
    });

    it("returns the original insert error when the recheck probe itself fails", async () => {
        expect.assertions(3);

        const schema = schemaOf(["alpha"]);
        const writer: DatabaseWriterLike = { ...writerFor(schema), insert: () => Promise.reject(new ConflictError("unique index breached")) };
        // Probe 1 is the batch probe; probe 2 is the recheck, which only a unique-index CONFLICT triggers.
        const probe = counting((probeNumber) => probeNumber === 2);
        const result = await importGlobalRows(writer, schema, {
            exec: probe.exec,
            rows: [{ doc: { _id: "r1", label: "a" }, table: "alpha" }],
        });

        expect(probe.probes()).toBe(2);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toMatchObject({ code: "CONFLICT", line: 1, table: "alpha" });
    });

    it("reports a conflict, not a collision, when the row's own table and another both hold the id", async () => {
        expect.assertions(2);

        const schema = schemaOf(["alpha", "beta"]);
        const writer = writerFor(schema);

        await writer.insert("alpha", { _id: "dup", label: "a" }, { allowExplicitId: true });
        await writer.insert("beta", { _id: "dup", label: "b" }, { allowExplicitId: true });

        const result = await importGlobalRows(writer, schema, { exec: counting().exec, rows: [{ doc: { _id: "dup", label: "c" }, table: "alpha" }] });

        expect(result).toMatchObject({ conflicts: 1, errors: [] });
        await expect(writer.get("alpha", "dup")).resolves.toMatchObject({ label: "a" });
    });

    it("keeps the insert error when a trigger throws after the base row landed", async () => {
        expect.assertions(2);

        const base = schemaOf(["alpha"]);
        const triggerSchema = {
            tables: {
                alpha: {
                    ...base.tables["alpha"]!,
                    triggerMap: {
                        boom: {
                            handler: async () => {
                                throw new Error("trigger blew up");
                            },
                            op: "insert",
                            timing: "after",
                        },
                    },
                },
            },
        } as never as SchemaLike;
        const result = await importGlobalRows(writerFor(triggerSchema), triggerSchema, {
            exec: counting().exec,
            rows: [{ doc: { _id: "t1", label: "a" }, table: "alpha" }],
        });

        expect(result.conflicts).toBe(0);
        expect(result.errors).toMatchObject([{ code: "INSERT_FAILED", line: 1 }]);
    });

    it("does not provision tables when no row carries an id, and fails closed when provisioning throws", async () => {
        expect.assertions(3);

        const schema = schemaOf(["alpha"]);
        const statements: string[] = [];
        let failProvision = false;
        const exec: Exec = {
            all: (query, parameters) => harness.exec.all(query, parameters),
            run: (query, parameters) => {
                statements.push(query);

                if (/CREATE TABLE/iu.test(query) && statements.length > 0 && failProvision) {
                    return Promise.reject(new Error("provision unavailable"));
                }

                return harness.exec.run(query, parameters);
            },
        };
        const idless = await importGlobalRows(writerFor(schema), schema, { exec, rows: [{ doc: { label: "a" }, table: "alpha" }] });

        expect(statements.filter((statement) => /CREATE TABLE/iu.test(statement))).toHaveLength(0);

        failProvision = true;

        const failed = await importGlobalRows(writerFor(schema), schema, { exec, rows: [{ doc: { _id: "q1", label: "a" }, table: "alpha" }] });

        expect(idless.errors).toEqual([]);
        expect(failed.errors).toMatchObject([{ code: "PROBE_FAILED", line: 1 }]);
    });
});
