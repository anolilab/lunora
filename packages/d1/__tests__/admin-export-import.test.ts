import type { ColumnMetaLike, DatabaseWriterLike, SchemaLike, ValidatorLike } from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { exportGlobalRows, importGlobalRows, selectGlobalTables } from "../src/admin-export-import";
import { createD1CtxDb as createD1ContextDatabase } from "../src/d1-ctx-db";
import { createD1Exec } from "./_helpers/node-sqlite-d1";

const FIXED_CLOCK = 1_700_000_000_000;

const col = (kind: string, column: Partial<ColumnMetaLike> = {}): ValidatorLike => {
    const meta: ColumnMetaLike = { notNull: true, ...column };

    return {
        _meta: { column: meta },
        kind,

        parse(value: unknown) {
            // `.nullable()` (which is the only thing that clears `notNull`) makes
            // SQL NULL a value the column holds. Without this the double rejected
            // its own legitimate storage form, so a nullable column could not be
            // round-tripped through the fixture at all.

            if (value === null && !meta.notNull) {
                return value;
            }

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

/**
 * `v.optional(inner)` as the runtime shapes it: kind `"optional"`, the wrapped
 * validator on `_meta.inner`, and a parser that accepts absence and NOTHING else
 * the inner one would refuse — `optional(string).parse(null)` throws, which is
 * exactly what made an unset optional column unrestorable.
 */
const optional = (inner: ValidatorLike): ValidatorLike =>
    ({
        _meta: { column: { notNull: true }, inner },
        kind: "optional",

        parse(value: unknown) {
            return value === undefined ? value : inner.parse?.(value);
        },
    }) as unknown as ValidatorLike;

// The D1 writer is the global-tables view; only the `.global()` table is in
// its schema (the DO ctx-db owns shard-local tables). The import helper still
// inspects shardMode and skips non-globals, which we exercise via a richer
// `mergedSchema` passed only to `importGlobalRows`.
const schema: SchemaLike = {
    tables: {
        settings: {
            indexes: [],
            shape: {
                name: col("string"),
                // An unset optional column and a genuinely-nullable one are both
                // SQL NULL on disk and must NOT round-trip the same way: the first
                // is an absence, the second is a value.
                nickname: optional(col("string")),
                // The `v.optional(v.string().nullable())` shape (`softDelete` uses
                // it verbatim): absent OR null, and null is a value.
                note: optional(col("string", { notNull: false })),
                value: col("string"),
            },
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
            "nickname" TEXT,
            "note" TEXT,
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

        it("reports a row with no usable `table` as BAD_ROW rather than skipping it", async () => {
            expect.assertions(3);

            // The global/shard routing check ran first, so
            // `schema.tables[undefined]?.shardMode?.kind !== "global"` bucketed a
            // corrupt row as "shard-local, not mine". The import then reported
            // success with zero errors and an operator could not tell a malformed
            // line from a legitimately-elsewhere one. The shard-engine twin
            // reports BAD_ROW for the identical input.
            const result = await importGlobalRows(writer, schema, {
                rows: [{ doc: { _id: "s1", name: "theme", value: "dark" } } as never, { doc: { _id: "s2" }, table: 123 } as never],
            });

            expect(result.errors).toHaveLength(2);
            expect(result.errors[0]?.code).toBe("BAD_ROW");
            expect(result.errors[0]?.message).toContain("missing `table`");
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

        /**
         * A `.global()` table stores real columns, so a key it does not declare
         * has nowhere to go — the writer dropped it and the import still answered
         * `{"conflicts":0,"errors":[],"inserted":{"settings":1}}`. A snapshot
         * taken before a `title → heading` rename therefore restored as
         * `{"heading": null}` and reported success. The shard twin errors with
         * `unexpected field "…"` on the identical input; this half now does too.
         */
        it("rejects a field the table does not declare rather than dropping it and reporting success", async () => {
            expect.assertions(3);

            const result = await importGlobalRows(writer, schema, {
                rows: [
                    { doc: { _id: "s1", name: "ok", title: "renamed away", value: "x" }, table: "settings" },
                    { doc: { _id: "s2", name: "ok2", value: "y" }, table: "settings" },
                ],
            });

            expect(result.inserted).toEqual({ settings: 1 });
            expect(result.errors).toHaveLength(1);
            expect(result.errors[0]).toMatchObject({
                code: "VALIDATION_ERROR",
                message: 'unexpected field "title": not declared in table "settings"',
                table: "settings",
            });
        });

        it("rejects a prototype-named field the table does not declare", async () => {
            expect.assertions(2);

            // `key in definition.shape` walks the prototype chain, so `constructor`
            // (and `toString`, `valueOf`) passed as "declared". The validation loop
            // iterates `Object.entries(shape)` and never sees such a key, so it went
            // straight to `writer.insert` — dropped on the floor, still answered 200.
            const result = await importGlobalRows(writer, schema, {
                rows: [{ doc: { _id: "s3", constructor: "injected", name: "ok", value: "x" }, table: "settings" }],
            });

            expect(result.inserted).toEqual({});
            expect(result.errors[0]).toMatchObject({
                message: 'unexpected field "constructor": not declared in table "settings"',
                table: "settings",
            });
        });

        it("attributes errors to each row's own `line` when non-contiguous (interspersed shard-local rows filtered out upstream)", async () => {
            expect.assertions(1);

            // Simulates `@lunora/runtime`'s import stream: these three global rows
            // actually sat at NDJSON lines 2, 5, and 6 — lines 1, 3, and 4 were
            // shard-local rows the caller already filtered out before reaching
            // here. Without `line` on each row, position-derived counting would
            // report 1, 2, 3 instead.
            const result = await importGlobalRows(writer, schema, {
                rows: [
                    { doc: { _id: "s1", name: "ok", value: "x" }, line: 2, table: "settings" },
                    { doc: { _id: "s2", name: 42, value: "x" }, line: 5, table: "settings" },
                    { doc: { _id: "s3", name: 42, value: "y" }, line: 6, table: "settings" },
                ],
            });

            expect(result.errors.map((error) => error.line)).toStrictEqual([5, 6]);
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

        it("roundtrip: a bigint / bytes row survives JSON egress and comes back real", async () => {
            expect.assertions(4);

            const wireSchema: SchemaLike = {
                tables: {
                    ledger: {
                        indexes: [],
                        shape: { blob: col("bytes"), cents: col("bigint") },
                        shardMode: { kind: "global" } as never,
                    },
                },
            };

            const source = createD1Exec();

            source.ddl(
                `CREATE TABLE "ledger" (
                "id" TEXT PRIMARY KEY,
                "_creationTime" INTEGER NOT NULL,
                "blob" BLOB,
                "cents" TEXT
            )`,
            );

            const sourceWriter = createD1ContextDatabase({ clock: () => FIXED_CLOCK, exec: source.exec, schema: wireSchema });

            await sourceWriter.insert(
                "ledger",
                { _id: "l1", blob: new Uint8Array([7, 8, 9]).buffer, cents: 9_007_199_254_740_993n },
                { allowExplicitId: true },
            );

            const exported: { doc: Record<string, unknown>; table: string }[] = [];

            for await (const row of exportGlobalRows(source.exec, wireSchema, {})) {
                exported.push(row);
            }

            // What the scheduled R2 backup and the NDJSON stream actually do to
            // these rows. Undecoded, this THREW on the bigint before writing a
            // single object, and the bytes serialized to `{}`.
            const ndjson = exported.map((row) => JSON.stringify(row)).join("\n");

            expect(ndjson).toContain("9007199254740993");

            const fresh = createD1Exec();

            fresh.ddl(
                `CREATE TABLE "ledger" (
                "id" TEXT PRIMARY KEY,
                "_creationTime" INTEGER NOT NULL,
                "blob" BLOB,
                "cents" TEXT
            )`,
            );

            const freshWriter = createD1ContextDatabase({ clock: () => FIXED_CLOCK, exec: fresh.exec, schema: wireSchema });

            const result = await importGlobalRows(freshWriter, wireSchema, {
                rows: ndjson.split("\n").map((line) => JSON.parse(line) as { doc: Record<string, unknown>; table: string }),
            });

            expect(result.errors).toEqual([]);

            const reload = await freshWriter.get("l1");

            expect(reload?.["cents"]).toBe(9_007_199_254_740_993n);
            expect([...new Uint8Array(reload?.["blob"] as ArrayBuffer)]).toStrictEqual([7, 8, 9]);

            source.close();
            fresh.close();
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
                "nickname" TEXT,
                "note" TEXT,
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

        /*
         * A `.global()` table stores real columns, so an unset `v.optional(...)`
         * field is a SQL NULL — which the export decoder emitted as
         * `"nickname": null` and the importer then fed to
         * `optional(string).parse(null)`. That throws, so EVERY row that simply
         * had no value for an optional column was reported as a validation error
         * and silently missing from the restored table.
         */
        it("round-trips a row whose optional column was never set", async () => {
            expect.assertions(4);

            await writer.insert("settings", { _id: "s1", name: "theme", value: "dark" }, { allowExplicitId: true });

            const exported: { doc: Record<string, unknown>; table: string }[] = [];

            for await (const row of exportGlobalRows(harness.exec, schema, {})) {
                exported.push(row);
            }

            // Absent, not null: `v.optional(v.string())` is `string | undefined`.
            expect(exported[0]?.doc).not.toHaveProperty("nickname");

            const fresh = createD1Exec();

            fresh.ddl(
                `CREATE TABLE "settings" (
                "id" TEXT PRIMARY KEY,
                "_creationTime" INTEGER NOT NULL,
                "name" TEXT,
                "nickname" TEXT,
                "note" TEXT,
                "value" TEXT
            )`,
            );

            const freshWriter = createD1ContextDatabase({ clock: () => FIXED_CLOCK, exec: fresh.exec, schema });
            const result = await importGlobalRows(freshWriter, schema, { rows: exported });

            expect(result.errors).toEqual([]);
            expect(result.inserted).toEqual({ settings: 1 });
            await expect(freshWriter.get("s1")).resolves.toMatchObject({ name: "theme", value: "dark" });

            fresh.close();
        });

        it("restores a snapshot line that carries `null` for an unset optional column", async () => {
            expect.assertions(3);

            // The shape every snapshot taken before the export decoder was fixed
            // has on disk. Those files still have to import.
            const result = await importGlobalRows(writer, schema, {
                rows: [{ doc: { _id: "s1", name: "theme", nickname: null, value: "dark" }, table: "settings" }],
            });

            expect(result.errors).toEqual([]);
            expect(result.inserted).toEqual({ settings: 1 });
            // Restored as the absence it was, not as a null.
            await expect(writer.get("s1")).resolves.not.toHaveProperty("nickname");
        });

        it("keeps a nullable column's null through the round trip", async () => {
            expect.assertions(3);

            await writer.insert("settings", { _id: "s1", name: "theme", note: null, value: "dark" }, { allowExplicitId: true });

            const exported: { doc: Record<string, unknown>; table: string }[] = [];

            for await (const row of exportGlobalRows(harness.exec, schema, {})) {
                exported.push(row);
            }

            expect(exported[0]?.doc["note"]).toBeNull();

            const fresh = createD1Exec();

            fresh.ddl(
                `CREATE TABLE "settings" (
                "id" TEXT PRIMARY KEY,
                "_creationTime" INTEGER NOT NULL,
                "name" TEXT,
                "nickname" TEXT,
                "note" TEXT,
                "value" TEXT
            )`,
            );

            const freshWriter = createD1ContextDatabase({ clock: () => FIXED_CLOCK, exec: fresh.exec, schema });
            const result = await importGlobalRows(freshWriter, schema, { rows: exported });

            expect(result.errors).toEqual([]);

            const restored = await freshWriter.get("s1");

            expect(restored?.["note"]).toBeNull();

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
