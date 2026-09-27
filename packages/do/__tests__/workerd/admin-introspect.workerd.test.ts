/**
 * The admin introspection reads against real workerd SQLite, whose limits
 * `node:sqlite` cannot reproduce: at most 100 bound parameters per statement, and
 * a function allowlist that decides whether `json_tree`/`json_each` may run.
 */
import type { SqlExec } from "@lunora/shard-engine";
import { findStorageReferences, readTablePage } from "@lunora/shard-engine";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/** Run `body` inside a real Durable Object, handing it that object's SQLite. */
const withSql = async (name: string, body: (sql: SqlExec) => void): Promise<void> => {
    const stub = env.SHARD.get(env.SHARD.idFromName(name));

    await runInDurableObject(stub, (_instance, state) => {
        body(state.storage.sql as unknown as SqlExec);
    });
};

const createDocTable = (sql: SqlExec, table: string): void => {
    sql.exec(`CREATE TABLE IF NOT EXISTS "${table}" (id TEXT PRIMARY KEY, _creationTime REAL NOT NULL, "__doc__" TEXT NOT NULL)`);
};

describe("admin introspection on workerd", () => {
    it("resolves storage references for a page wider than the bound-parameter cap", async () => {
        expect.assertions(3);

        await withSql("admin-storage-refs", (sql) => {
            createDocTable(sql, "files");
            sql.exec(`INSERT INTO "files" VALUES ('r1', 1, '{"avatar":"k1"}'), ('r2', 1, '{"avatar":"k250"}')`);

            const keys = Array.from({ length: 250 }, (_, index) => `k${String(index + 1)}`);
            const result = findStorageReferences(sql, { files: ["avatar"] }, keys);

            expect(result.references["k1"]).toStrictEqual([{ column: "avatar", id: "r1", table: "files" }]);
            expect(result.references["k250"]).toStrictEqual([{ column: "avatar", id: "r2", table: "files" }]);
            expect(result.references["k2"]).toStrictEqual([]);
        });
    });

    it("searches document values at any depth without matching field names", async () => {
        expect.assertions(1);

        await withSql("admin-search-values", (sql) => {
            createDocTable(sql, "tickets");
            sql.exec(
                `INSERT INTO "tickets" VALUES ('a', 1, '{"status":"open","note":"check status page"}'), ('b', 1, '{"status":"open","note":"jam"}'), ('c', 1, '{"meta":{"deep":["STATUS"]},"flag":true}')`,
            );

            expect(readTablePage(sql, { search: "status", table: "tickets" }).total).toBe(2);
        });
    });

    it("skips the wire-tagged originals of projected fields, however this SQLite spells their path", async () => {
        expect.assertions(3);

        await withSql("admin-search-originals", (sql) => {
            createDocTable(sql, "ledger");
            sql.exec(
                `INSERT INTO "ledger" VALUES ('a', 1, ?), ('b', 1, ?)`,
                JSON.stringify({ __originals__: { amount: ["$lunora.wire$", "bigint", "123"] }, amount: "000123", memo: "rent" }),
                JSON.stringify({ memo: 'say "hi"' }),
            );

            expect(readTablePage(sql, { search: "bigint", table: "ledger" }).total).toBe(0);
            expect(readTablePage(sql, { search: "rent", table: "ledger" }).total).toBe(1);
            expect(readTablePage(sql, { search: '"hi"', table: "ledger" }).total).toBe(1);
        });
    });

    it("keeps a date search under the parameter cap however many date fields a table declares", async () => {
        expect.assertions(1);

        await withSql("admin-search-dates", (sql) => {
            createDocTable(sql, "events");
            sql.exec(`INSERT INTO "events" VALUES ('a', 1, ?)`, JSON.stringify({ f59: Date.UTC(2026, 6, 15) }));

            const columnKinds = Object.fromEntries(Array.from({ length: 120 }, (_, index) => [`f${String(index)}`, "timestamp"]));

            expect(readTablePage(sql, { columnKinds, search: "2026-07", table: "events" }).total).toBe(1);
        });
    });
});
