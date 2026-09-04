import type { ColumnMetaLike, SchemaLike, ValidatorLike } from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { decodeWire } from "../../../shared/wire-codec";
import { facetGlobalColumn, listGlobalTables, readGlobalTablePage } from "../src/introspect";
import { createD1Exec } from "./_helpers/node-sqlite-d1";

/**
 * Put a payload through the studio's JSON transport and back — what
 * `Response.json` on the worker and `decodeWire` on the client do between them.
 * Not a deep clone: the point is that the JSON hop is lossy for `bigint` and
 * bytes unless the payload was wire-encoded first.
 */
const overJson = (payload: unknown): unknown => {
    const wire = JSON.stringify(payload);

    return decodeWire(JSON.parse(wire));
};

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
        // An external table with a real FK constraint (better-auth emits these) — its
        // ref must surface via PRAGMA foreign_key_list so the diagram can draw the edge.
        harness.ddl(`CREATE TABLE "session" ("id" TEXT PRIMARY KEY, "token" TEXT, "userId" TEXT REFERENCES "user" ("id") ON DELETE CASCADE)`);
        // Internal/companion tables that must never surface.
        harness.ddl(`CREATE TABLE "_cf_KV" ("k" TEXT, "v" BLOB)`);
        harness.ddl(`CREATE TABLE "organizations__agg_byActive" ("__key__" TEXT, "__value__" REAL)`);
        // MigrationRunner's own tracking table, created by this same package — it is
        // Lunora bookkeeping, so the browser must not list it either.
        harness.ddl(`CREATE TABLE "__drizzle_migrations" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "hash" TEXT NOT NULL UNIQUE, "created_at" NUMERIC)`);

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
                { name: "session", rowCount: 0 },
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

        it("wire-encodes bigint / bytes columns so the JSON transport can carry them", async () => {
            expect.assertions(3);

            const wireSchema: SchemaLike = {
                tables: {
                    ledger: {
                        indexes: [],
                        shape: { blob: col("bytes"), cents: col("bigint") },
                        shardMode: { kind: "global" } as never,
                    },
                },
            };

            harness.ddl(`CREATE TABLE "ledger" ("id" TEXT PRIMARY KEY, "_creationTime" INTEGER NOT NULL, "blob" BLOB, "cents" TEXT)`);
            await harness.exec.run(`INSERT INTO "ledger" VALUES ('l1', 1, X'070809', '9007199254740993')`, []);

            const page = await readGlobalTablePage(harness.exec, wireSchema, { table: "ledger" });

            // `decodeGlobalRow` hands back a real `bigint` and `ArrayBuffer`.
            // Undecorated, the studio's JSON transport THREW on the former and
            // turned the latter into `{}`.
            const wireJson = JSON.stringify(page.rows);
            const roundTripped = decodeWire(JSON.parse(wireJson)) as Record<string, unknown>[];

            expect(roundTripped).toHaveLength(1);
            expect(roundTripped[0]?.["cents"]).toBe(9_007_199_254_740_993n);
            expect([...new Uint8Array(roundTripped[0]?.["blob"] as ArrayBuffer)]).toStrictEqual([7, 8, 9]);
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

        it("recovers an external table's foreign keys as a column→table ref map", async () => {
            expect.assertions(2);

            const page = await readGlobalTablePage(harness.exec, schema, { table: "session" });

            // `session.userId → user`, recovered from PRAGMA foreign_key_list, so the
            // schema diagram can draw the global→global edge.
            expect(page.refs).toEqual({ userId: "user" });
            expect(page.columns).toEqual(["id", "token", "userId"]);
        });

        it("omits refs for a schema-global table (its FK metadata flows through describeTables)", async () => {
            expect.assertions(1);

            const page = await readGlobalTablePage(harness.exec, schema, { table: "organizations" });

            expect(page.refs).toBeUndefined();
        });

        it("omits refs for an external table with no foreign keys", async () => {
            expect.assertions(1);

            const page = await readGlobalTablePage(harness.exec, schema, { table: "user" });

            expect(page.refs).toBeUndefined();
        });

        it("rejects an internal table", async () => {
            expect.assertions(1);

            await expect(readGlobalTablePage(harness.exec, schema, { table: "_cf_KV" })).rejects.toMatchObject({ code: "UNKNOWN_TABLE" });
        });

        it("aND-narrows the page by eq filters (a facet drill-down)", async () => {
            expect.assertions(3);

            const page = await readGlobalTablePage(harness.exec, schema, { filters: [{ column: "name", value: "Acme" }], table: "organizations" });

            expect(page.total).toBe(1);
            expect(page.rows).toHaveLength(1);
            expect(page.rows[0]).toMatchObject({ _id: "o1", name: "Acme" });
        });

        it("maps a displayed `_id` filter to the physical `id` column", async () => {
            expect.assertions(2);

            const page = await readGlobalTablePage(harness.exec, schema, { filters: [{ column: "_id", value: "o2" }], table: "organizations" });

            expect(page.total).toBe(1);
            expect(page.rows[0]).toMatchObject({ _id: "o2", name: "Globex" });
        });

        it("rejects an eq filter on an unknown column", async () => {
            expect.assertions(1);

            await expect(
                readGlobalTablePage(harness.exec, schema, { filters: [{ column: "nope", value: "x" }], table: "organizations" }),
            ).rejects.toMatchObject({ code: "UNKNOWN_COLUMN" });
        });

        it("rejects an eq filter on a sensitive external column (no equality oracle past the redaction)", async () => {
            expect.assertions(2);

            // A correct guess and a wrong guess both throw the same 403 — the `total`
            // never leaks whether `passwordHash = <guess>` matched a real row.
            await expect(
                readGlobalTablePage(harness.exec, schema, { filters: [{ column: "passwordHash", value: "super-secret-hash" }], table: "user" }),
            ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });

            await expect(
                readGlobalTablePage(harness.exec, schema, { filters: [{ column: "passwordHash", value: "wrong-guess" }], table: "user" }),
            ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
        });

        it("allows an eq filter on a non-sensitive external column", async () => {
            expect.assertions(2);

            const page = await readGlobalTablePage(harness.exec, schema, { filters: [{ column: "email", value: "ada@example.com" }], table: "user" });

            expect(page.total).toBe(1);
            expect(page.rows[0]).toMatchObject({ email: "ada@example.com", id: "u1", passwordHash: "•••" });
        });

        it("allows an eq filter on a schema `.global()` table (not redacted, so the guard is bypassed)", async () => {
            expect.assertions(2);

            const page = await readGlobalTablePage(harness.exec, schema, { filters: [{ column: "name", value: "Acme" }], table: "organizations" });

            expect(page.total).toBe(1);
            expect(page.rows[0]).toMatchObject({ _id: "o1", name: "Acme" });
        });
    });

    describe("facetGlobalColumn", () => {
        it("summarises a column's distinct values with their counts, ordered by frequency", async () => {
            expect.assertions(2);

            await harness.exec.run(`INSERT INTO "organizations" VALUES ('o3', 3, 'Acme', 1)`, []);

            const facet = await facetGlobalColumn(harness.exec, schema, { column: "name", table: "organizations" });

            expect(facet.truncated).toBe(false);
            expect(facet.values).toEqual([
                { count: 2, value: "Acme" },
                { count: 1, value: "Globex" },
            ]);
        });

        it("returns the raw stored value (boolean as 0/1) so a click feeds straight back as an eq filter", async () => {
            expect.assertions(1);

            const facet = await facetGlobalColumn(harness.exec, schema, { column: "active", table: "organizations" });

            // Two distinct stored values, one row each; raw 0/1, not decoded true/false.
            expect(facet.values).toEqual(
                expect.arrayContaining([
                    { count: 1, value: 1 },
                    { count: 1, value: 0 },
                ]),
            );
        });

        it("a bytes facet survives JSON transport instead of flattening to {}", async () => {
            expect.assertions(1);

            const wireSchema: SchemaLike = {
                tables: {
                    ledger: {
                        indexes: [],
                        shape: { blob: col("bytes"), cents: col("bigint") },
                        shardMode: { kind: "global" } as never,
                    },
                },
            };

            harness.ddl(`CREATE TABLE "ledger" ("id" TEXT PRIMARY KEY, "_creationTime" INTEGER NOT NULL, "blob" BLOB, "cents" TEXT)`);
            await harness.exec.run(`INSERT INTO "ledger" VALUES ('l1', 1, X'070809', '1')`, []);

            const facet = await facetGlobalColumn(harness.exec, wireSchema, { column: "blob", table: "ledger" });
            const overTheWire = overJson(facet) as { values: { count: number; value: unknown }[] };

            expect([...new Uint8Array(overTheWire.values[0]?.value as ArrayBuffer)]).toStrictEqual([7, 8, 9]);
        });

        it("a bytes facet value drills back down through the eq filter it came from", async () => {
            expect.assertions(2);

            const wireSchema: SchemaLike = {
                tables: {
                    ledger: {
                        indexes: [],
                        shape: { blob: col("bytes"), cents: col("bigint") },
                        shardMode: { kind: "global" } as never,
                    },
                },
            };

            harness.ddl(`CREATE TABLE "ledger" ("id" TEXT PRIMARY KEY, "_creationTime" INTEGER NOT NULL, "blob" BLOB, "cents" TEXT)`);
            await harness.exec.run(`INSERT INTO "ledger" VALUES ('l1', 1, X'070809', '1'), ('l2', 2, X'0a', '5')`, []);

            const facet = await facetGlobalColumn(harness.exec, wireSchema, { column: "blob", table: "ledger" });
            const clicked = (overJson(facet) as { values: { value: unknown }[] }).values.find(
                (entry) => [...new Uint8Array(entry.value as ArrayBuffer)].join(",") === "7,8,9",
            );

            // The whole reason the facet's value is the STORED scalar is that a
            // click sends it straight back as a filter. Flattened to `{}` by JSON
            // it bound an empty object and matched nothing.
            const page = await readGlobalTablePage(harness.exec, wireSchema, { filters: [{ column: "blob", value: clicked?.value }], table: "ledger" });

            expect(page.total).toBe(1);
            expect(page.rows[0]?.["_id"]).toBe("l1");
        });

        it("reflects the active view (eq filters)", async () => {
            expect.assertions(1);

            await harness.exec.run(`INSERT INTO "organizations" VALUES ('o3', 3, 'Acme', 0)`, []);

            const facet = await facetGlobalColumn(harness.exec, schema, {
                column: "active",
                filters: [{ column: "name", value: "Acme" }],
                table: "organizations",
            });

            expect(facet.values).toEqual(
                expect.arrayContaining([
                    { count: 1, value: 1 },
                    { count: 1, value: 0 },
                ]),
            );
        });

        it("caps distinct values at the limit and reports truncation", async () => {
            expect.assertions(2);

            const facet = await facetGlobalColumn(harness.exec, schema, { column: "name", limit: 1, table: "organizations" });

            expect(facet.values).toHaveLength(1);
            expect(facet.truncated).toBe(true);
        });

        it("collapses a sensitive external column to one redacted bucket", async () => {
            expect.assertions(1);

            const facet = await facetGlobalColumn(harness.exec, schema, { column: "passwordHash", table: "user" });

            // Never groups by the real secret — one masked bucket counting the rows.
            expect(facet.values).toEqual([{ count: 1, value: "•••" }]);
        });

        it("rejects an eq filter on a sensitive external column (facet path shares the guard, no count oracle)", async () => {
            expect.assertions(2);

            // Faceting a benign column while filtering on the redacted `passwordHash`
            // routes through buildEqPredicate — a correct and a wrong guess both 403,
            // so the masked-bucket count never confirms a value.
            await expect(
                facetGlobalColumn(harness.exec, schema, { column: "email", filters: [{ column: "passwordHash", value: "super-secret-hash" }], table: "user" }),
            ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });

            await expect(
                facetGlobalColumn(harness.exec, schema, { column: "email", filters: [{ column: "passwordHash", value: "wrong-guess" }], table: "user" }),
            ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
        });

        it("allows a facet filter on a non-sensitive external column", async () => {
            expect.assertions(1);

            const facet = await facetGlobalColumn(harness.exec, schema, {
                column: "email",
                filters: [{ column: "email", value: "ada@example.com" }],
                table: "user",
            });

            expect(facet.values).toEqual([{ count: 1, value: "ada@example.com" }]);
        });

        it("rejects an unknown column", async () => {
            expect.assertions(1);

            await expect(facetGlobalColumn(harness.exec, schema, { column: "nope", table: "organizations" })).rejects.toMatchObject({ code: "UNKNOWN_COLUMN" });
        });

        it("rejects an internal table", async () => {
            expect.assertions(1);

            await expect(facetGlobalColumn(harness.exec, schema, { column: "k", table: "_cf_KV" })).rejects.toMatchObject({ code: "UNKNOWN_TABLE" });
        });
    });
});
