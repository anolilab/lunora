import type { ColumnMetaLike, DatabaseWriterLike, SchemaLike, ValidatorLike } from "@cirrus/do";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { exportGlobalRows, importGlobalRows, selectGlobalTables } from "../src/admin-export-import.js";
import { createD1CtxDb } from "../src/d1-ctx-db.js";
import { createD1Exec } from "./_helpers/node-sqlite-d1.js";

const FIXED_CLOCK = 1_700_000_000_000;

const col = (kind: string, column: Partial<ColumnMetaLike> = {}): ValidatorLike =>
    ({
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
    }) as unknown as ValidatorLike;

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

    writer = createD1CtxDb({ clock: () => FIXED_CLOCK, exec: harness.exec, schema });
});

afterEach(() => {
    harness.close();
});

describe("selectGlobalTables", () => {
    test("returns only `.global()` tables", () => {
        expect(selectGlobalTables(mergedSchema)).toEqual(["settings"]);
    });

    test("respects an allowlist (still only globals)", () => {
        expect(selectGlobalTables(mergedSchema, ["settings", "local"])).toEqual(["settings"]);
    });
});

describe("exportGlobalRows", () => {
    test("yields every row of each global table", async () => {
        await writer.insert("settings", { _id: "s1", name: "theme", value: "dark" }, { allowExplicitId: true });
        await writer.insert("settings", { _id: "s2", name: "lang", value: "en" }, { allowExplicitId: true });

        const rows: unknown[] = [];

        for await (const row of exportGlobalRows(harness.exec, schema, {})) {
            rows.push(row);
        }

        expect(rows).toHaveLength(2);
        expect(rows[0]).toMatchObject({ table: "settings" });
    });
});

describe("importGlobalRows", () => {
    test("inserts a batch and returns per-table counts", async () => {
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

    test("skips non-global tables silently (someone else's responsibility)", async () => {
        const result = await importGlobalRows(writer, mergedSchema, {
            rows: [
                { doc: { _id: "l1", value: "x" }, table: "local" },
                { doc: { _id: "s1", name: "theme", value: "dark" }, table: "settings" },
            ],
        });

        expect(result.inserted).toEqual({ settings: 1 });
    });

    test("reports schema-failed rows in `errors` and continues", async () => {
        const result = await importGlobalRows(writer, schema, {
            rows: [
                { doc: { _id: "s1", name: "ok", value: "x" }, table: "settings" },
                { doc: { _id: "s2", name: 42 as unknown as string, value: "x" }, table: "settings" },
                { doc: { _id: "s3", name: "ok2", value: "y" }, table: "settings" },
            ],
        });

        expect(result.inserted).toEqual({ settings: 2 });
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toMatchObject({ code: "VALIDATION_ERROR", table: "settings" });
    });

    test("counts _id collisions as conflicts and skips them", async () => {
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

    test("roundtrip: export then re-import into a fresh D1 produces identical rows", async () => {
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

        const freshWriter = createD1CtxDb({ clock: () => FIXED_CLOCK, exec: fresh.exec, schema });

        const result = await importGlobalRows(freshWriter, schema, {
            rows: exported as { doc: Record<string, unknown>; table: string }[],
        });

        expect(result.inserted).toEqual({ settings: 2 });
        expect(result.errors).toEqual([]);

        const reload = (await freshWriter.get("s1")) as Record<string, unknown> | null;

        expect(reload).toMatchObject({ name: "theme", value: "dark" });

        fresh.close();
    });
});
