import type { ColumnMetaLike, SchemaLike, ValidatorLike } from "@cirrus/do";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { listGlobalTables, readGlobalTablePage } from "../src/introspect.js";
import { createD1Exec } from "./_helpers/node-sqlite-d1.js";

const col = (kind: string, column: Partial<ColumnMetaLike> = {}): ValidatorLike =>
    ({
        _meta: { column: { notNull: true, ...column } },
        kind,
    }) as unknown as ValidatorLike;

// Two globals (`organizations`, `plans`) and one shard-local table (`local`)
// that must never be surfaced by the introspector.
const schema: SchemaLike = {
    tables: {
        local: {
            indexes: [],
            shape: { value: col("string") },
        },
        organizations: {
            indexes: [],
            shape: { active: col("boolean"), name: col("string") },
            shardMode: { kind: "global" } as never,
        },
        plans: {
            indexes: [],
            shape: { tier: col("string") },
            shardMode: { kind: "global" } as never,
        },
    },
};

let harness: ReturnType<typeof createD1Exec>;

beforeEach(() => {
    harness = createD1Exec();
    harness.ddl(`CREATE TABLE "organizations" ("id" TEXT PRIMARY KEY, "_creationTime" INTEGER NOT NULL, "name" TEXT, "active" INTEGER)`);
    harness.ddl(`CREATE TABLE "plans" ("id" TEXT PRIMARY KEY, "_creationTime" INTEGER NOT NULL, "tier" TEXT)`);
    harness.ddl(`CREATE TABLE "local" ("id" TEXT PRIMARY KEY, "_creationTime" INTEGER NOT NULL, "value" TEXT)`);

    harness.exec.run(`INSERT INTO "organizations" VALUES ('o1', 1, 'Acme', 1), ('o2', 2, 'Globex', 0)`, []);
    harness.exec.run(`INSERT INTO "plans" VALUES ('p1', 1, 'free')`, []);
    harness.exec.run(`INSERT INTO "local" VALUES ('l1', 1, 'secret')`, []);
});

afterEach(() => {
    harness.close();
});

describe("listGlobalTables", () => {
    test("returns only global tables with row counts, sorted by name", async () => {
        await expect(listGlobalTables(harness.exec, schema)).resolves.toEqual([
            { name: "organizations", rowCount: 2 },
            { name: "plans", rowCount: 1 },
        ]);
    });
});

describe("readGlobalTablePage", () => {
    test("decodes rows (booleans, _id) and reports the column list", async () => {
        const page = await readGlobalTablePage(harness.exec, schema, { table: "organizations" });

        expect(page.total).toBe(2);
        expect(page.columns).toEqual(["_id", "_creationTime", "active", "name"]);
        expect(page.rows[0]).toEqual({ _creationTime: 1, _id: "o1", active: true, name: "Acme" });
        expect(page.rows[1]).toMatchObject({ _id: "o2", active: false });
    });

    test("honours limit / offset", async () => {
        const page = await readGlobalTablePage(harness.exec, schema, { limit: 1, offset: 1, table: "organizations" });

        expect(page.rows).toHaveLength(1);
        expect(page.rows[0]).toMatchObject({ _id: "o2" });
        expect(page.total).toBe(2);
    });

    test("rejects a non-global table", async () => {
        await expect(readGlobalTablePage(harness.exec, schema, { table: "local" })).rejects.toMatchObject({ code: "UNKNOWN_TABLE" });
    });
});
