import type { ColumnMetaLike, SchemaLike, ValidatorLike } from "@cirrus/do";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listGlobalTables, readGlobalTablePage } from "../src/introspect";
import createD1Exec from "./_helpers/node-sqlite-d1";

const col = (kind: string, column: Partial<ColumnMetaLike> = {}): ValidatorLike => {
    return {
        _meta: { column: { notNull: true, ...column } },
        kind,
    };
};

// Two schema `.global()` tables; `local` is a shard-local schema table (never
// created in D1, so it never surfaces). The browser also shows external D1
// tables (e.g. better-auth's) that aren't in the schema at all.
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

describe("d1 introspect", () => {
    beforeEach(async () => {
        harness = createD1Exec();
        harness.ddl(`CREATE TABLE "organizations" ("id" TEXT PRIMARY KEY, "_creationTime" INTEGER NOT NULL, "name" TEXT, "active" INTEGER)`);
        harness.ddl(`CREATE TABLE "plans" ("id" TEXT PRIMARY KEY, "_creationTime" INTEGER NOT NULL, "tier" TEXT)`);
        // An external (non-schema) table, e.g. better-auth's — must surface, with secrets redacted.
        harness.ddl(`CREATE TABLE "user" ("id" TEXT PRIMARY KEY, "email" TEXT, "passwordHash" TEXT)`);
        // Internal/companion tables that must never surface.
        harness.ddl(`CREATE TABLE "_cf_KV" ("k" TEXT, "v" BLOB)`);
        harness.ddl(`CREATE TABLE "organizations__agg_byActive" ("__key__" TEXT, "__value__" REAL)`);

        await harness.exec.run(`INSERT INTO "organizations" VALUES ('o1', 1, 'Acme', 1), ('o2', 2, 'Globex', 0)`, []);
        await harness.exec.run(`INSERT INTO "plans" VALUES ('p1', 1, 'free')`, []);
        await harness.exec.run(`INSERT INTO "user" VALUES ('u1', 'ada@example.com', 'super-secret-hash')`, []);
    });

    afterEach(() => {
        harness.close();
    });

    describe("listGlobalTables", () => {
        it("returns every browsable table (schema globals + external), excluding internal/companion tables", async () => {
            expect.assertions(1);

            await expect(listGlobalTables(harness.exec, schema)).resolves.toEqual([
                { name: "organizations", rowCount: 2 },
                { name: "plans", rowCount: 1 },
                { name: "user", rowCount: 1 },
            ]);
        });
    });

    describe("readGlobalTablePage", () => {
        it("decodes schema-global rows (booleans, _id) and reports the column list", async () => {
            expect.assertions(4);

            const page = await readGlobalTablePage(harness.exec, schema, { table: "organizations" });

            expect(page.total).toBe(2);
            expect(page.columns).toEqual(["_id", "_creationTime", "active", "name"]);
            expect(page.rows[0]).toEqual({ _creationTime: 1, _id: "o1", active: true, name: "Acme" });
            expect(page.rows[1]).toMatchObject({ _id: "o2", active: false });
        });

        it("reads an external table with its real columns and redacts sensitive values", async () => {
            expect.assertions(3);

            const page = await readGlobalTablePage(harness.exec, schema, { table: "user" });

            expect(page.columns).toEqual(["id", "email", "passwordHash"]);
            expect(page.rows[0]).toEqual({ email: "ada@example.com", id: "u1", passwordHash: "•••" });
            // The real secret never leaves the worker.
            expect(JSON.stringify(page.rows)).not.toContain("super-secret-hash");
        });

        it("honours limit / offset", async () => {
            expect.assertions(3);

            const page = await readGlobalTablePage(harness.exec, schema, { limit: 1, offset: 1, table: "organizations" });

            expect(page.rows).toHaveLength(1);
            expect(page.rows[0]).toMatchObject({ _id: "o2" });
            expect(page.total).toBe(2);
        });

        it("rejects an internal table", async () => {
            expect.assertions(1);

            await expect(readGlobalTablePage(harness.exec, schema, { table: "_cf_KV" })).rejects.toMatchObject({ code: "UNKNOWN_TABLE" });
        });
    });
});
