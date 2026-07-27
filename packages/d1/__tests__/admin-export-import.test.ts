import type { ColumnMetaLike, DatabaseWriterLike, SchemaLike, ValidatorLike } from "@lunora/do";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { exportGlobalRows, importGlobalRows, selectGlobalTables } from "../src/admin-export-import";
import { createD1CtxDb as createD1ContextDatabase } from "../src/d1-ctx-db";
import { createD1Exec } from "./_helpers/node-sqlite-d1";

const FIXED_CLOCK = 1_700_000_000_000;

const col = (kind: string, column: Partial<ColumnMetaLike> = {}): ValidatorLike => {
    return {
        _meta: { column: { notNull: true, ...column } },
        kind,

        parse(value: unknown) {
            if (kind === "string" && typeof value !== "string") {
                throw new Error(`expected string, received ${typeof value}`);
            }

            if (kind === "number" && typeof value !== "number") {
                throw new Error(`expected number, received ${typeof value}`);
            }

            if (kind === "boolean" && typeof value !== "boolean") {
                throw new Error(`expected boolean, received ${typeof value}`);
            }

            return value;
        },
    };
};

// The D1 writer is the global-tables view; only the `.global()` table is in
// its schema (the DO ctx-db owns shard-local tables). The import helper still
// inspects shardMode and skips non-globals, which we exercise via a richer
// `mergedSchema` passed only to `importGlobalRows`.
const schema: SchemaLike = {
    tables: {
        settings: {
            indexes: [],
            shape: { name: col("string"), value: col("string") },
            shardMode: { kind: "global" } as never,
        },
    },
};

const mergedSchema: SchemaLike = {
    tables: {
        ...schema.tables,
        local: {
            indexes: [],
            shape: { value: col("string") },
        },
    },
};

let harness: ReturnType<typeof createD1Exec>;
let writer: DatabaseWriterLike;

describe("d1 admin export/import globals", () => {
    beforeEach(() => {
        harness = createD1Exec();
        harness.ddl(
            `CREATE TABLE "settings" (
            "id" TEXT PRIMARY KEY,
            "_creationTime" INTEGER NOT NULL,
            "name" TEXT,
            "value" TEXT
        )`,
        );

        writer = createD1ContextDatabase({ clock: () => FIXED_CLOCK, exec: harness.exec, schema });
    });

    afterEach(() => {
        harness.close();
    });

    describe("selectGlobalTables", () => {
        it("returns only `.global()` tables", () => {
            expect.assertions(1);

            expect(selectGlobalTables(mergedSchema)).toEqual(["settings"]);
        });

        it("respects an allowlist (still only globals)", () => {
            expect.assertions(1);

            expect(selectGlobalTables(mergedSchema, ["settings", "local"])).toEqual(["settings"]);
        });
    });

    describe("exportGlobalRows", () => {
        it("yields every row of each global table", async () => {
            expect.assertions(2);

            await writer.insert("settings", { _id: "s1", name: "theme", value: "dark" }, { allowExplicitId: true });
            await writer.insert("settings", { _id: "s2", name: "lang", value: "en" }, { allowExplicitId: true });

            const rows: unknown[] = [];

            for await (const row of exportGlobalRows(harness.exec, schema, {})) {
                rows.push(row);
            }

            expect(rows).toHaveLength(2);
            expect(rows[0]).toMatchObject({ table: "settings" });
        });

        // Keyset paging (Finding 1): a small batch size forces several pages;
        // every row must surface exactly once, in ascending `id` order, with no
        // skip/duplicate — the property offset paging couldn't guarantee.
        it("keyset-paginates across multiple pages without skipping or duplicating rows", async () => {
            expect.assertions(3);

            for (let index = 0; index < 5; index += 1) {
                // eslint-disable-next-line no-await-in-loop -- sequential inserts to build a deterministic fixture
                await writer.insert("settings", { _id: `s${String(index)}`, name: `n${String(index)}`, value: `v${String(index)}` }, { allowExplicitId: true });
            }

            const ids: unknown[] = [];

            for await (const row of exportGlobalRows(harness.exec, schema, { batchSize: 2 })) {
                ids.push(row.doc["_id"]);
            }

            expect(ids).toHaveLength(5);
            expect(new Set(ids).size).toBe(5);
            expect(ids).toEqual(["s0", "s1", "s2", "s3", "s4"]);
        });

        // Finding 4: a `.global()` table that was never written is provisioned by
        // the export (idempotent CREATE … IF NOT EXISTS) and yields zero rows,
        // rather than aborting the stream with a raw `no such table`.
        it("exports a never-written global table as empty instead of throwing `no such table`", async () => {
            expect.assertions(1);

            const freshSchema: SchemaLike = {
                tables: {
                    widgets: {
                        indexes: [],
                        shape: { label: col("string") },
                        shardMode: { kind: "global" } as never,
                    },
                },
            };

            const fresh = createD1Exec();
            // Intentionally do NOT create the `widgets` table — exportGlobalRows
            // must provision it before selecting.
            const rows: unknown[] = [];

            for await (const row of exportGlobalRows(fresh.exec, freshSchema, {})) {
                rows.push(row);
            }

            expect(rows).toEqual([]);

            fresh.close();
        });
    });

    describe("importGlobalRows", () => {
        it("inserts a batch and returns per-table counts", async () => {
            expect.assertions(3);

            const result = await importGlobalRows(writer, schema, {
                rows: [
                    { doc: { _id: "s1", name: "theme", value: "dark" }, table: "settings" },
                    { doc: { _id: "s2", name: "lang", value: "en" }, table: "settings" },
                ],
            });

            expect(result.inserted).toEqual({ settings: 2 });
            expect(result.errors).toEqual([]);
            expect(result.conflicts).toBe(0);
        });

        it("skips non-global tables silently (someone else's responsibility)", async () => {
            expect.assertions(1);

            const result = await importGlobalRows(writer, mergedSchema, {
                rows: [
                    { doc: { _id: "l1", value: "x" }, table: "local" },
                    { doc: { _id: "s1", name: "theme", value: "dark" }, table: "settings" },
                ],
            });

            expect(result.inserted).toEqual({ settings: 1 });
        });

        it("reports schema-failed rows in `errors` and continues", async () => {
            expect.assertions(3);

            const result = await importGlobalRows(writer, schema, {
                rows: [
                    { doc: { _id: "s1", name: "ok", value: "x" }, table: "settings" },
                    { doc: { _id: "s2", name: 42, value: "x" }, table: "settings" },
                    { doc: { _id: "s3", name: "ok2", value: "y" }, table: "settings" },
                ],
            });

            expect(result.inserted).toEqual({ settings: 2 });
            expect(result.errors).toHaveLength(1);
            expect(result.errors[0]).toMatchObject({ code: "VALIDATION_ERROR", table: "settings" });
        });

        it("counts _id collisions as conflicts and skips them", async () => {
            expect.assertions(3);

            await writer.insert("settings", { _id: "s1", name: "theme", value: "dark" }, { allowExplicitId: true });

            const result = await importGlobalRows(writer, schema, {
                rows: [
                    { doc: { _id: "s1", name: "theme", value: "OVERWRITE" }, table: "settings" },
                    { doc: { _id: "s2", name: "lang", value: "en" }, table: "settings" },
                ],
            });

            expect(result.conflicts).toBe(1);
            expect(result.inserted).toEqual({ settings: 1 });

            const reloaded = await writer.get("s1");

            expect(reloaded).toMatchObject({ value: "dark" });
        });

        it("roundtrip: export then re-import into a fresh D1 produces identical rows", async () => {
            expect.assertions(3);

            await writer.insert("settings", { _id: "s1", name: "theme", value: "dark" }, { allowExplicitId: true });
            await writer.insert("settings", { _id: "s2", name: "lang", value: "en" }, { allowExplicitId: true });

            const exported: unknown[] = [];

            for await (const row of exportGlobalRows(harness.exec, schema, {})) {
                exported.push(row);
            }

            const fresh = createD1Exec();

            fresh.ddl(
                `CREATE TABLE "settings" (
                "id" TEXT PRIMARY KEY,
                "_creationTime" INTEGER NOT NULL,
                "name" TEXT,
                "value" TEXT
            )`,
            );

            const freshWriter = createD1ContextDatabase({ clock: () => FIXED_CLOCK, exec: fresh.exec, schema });

            const result = await importGlobalRows(freshWriter, schema, {
                rows: exported as { doc: Record<string, unknown>; table: string }[],
            });

            expect(result.inserted).toEqual({ settings: 2 });
            expect(result.errors).toEqual([]);

            const reload = await freshWriter.get("s1");

            expect(reload).toMatchObject({ name: "theme", value: "dark" });

            fresh.close();
        });

        // Plan 118: the insert-failure catch now routes through `toErrorBody`
        // instead of embedding a caught error's raw `.code`/`.message` directly —
        // pin that an unrecognized throw (no D1 driver error here carries a
        // `LunoraError`-shaped code/status) is redacted rather than leaking raw
        // error text into the admin import response.
        it("an unrecognized insert failure is redacted instead of leaking the raw error message", async () => {
            expect.assertions(2);

            const failingWriter: DatabaseWriterLike = {
                ...writer,
                insert: () => Promise.reject(new Error("driver error: connection reset")),
            };

            const result = await importGlobalRows(failingWriter, schema, {
                rows: [{ doc: { _id: "s1", name: "theme", value: "dark" }, table: "settings" }],
            });

            expect(result.errors).toHaveLength(1);
            expect(result.errors[0]).toMatchObject({ code: "INSERT_FAILED", message: "Internal error" });
        });
    });
});
