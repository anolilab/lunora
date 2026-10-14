import type { SchemaLike, ValidatorLike } from "@lunora/shard-engine";
import { bigintSqlKey } from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { D1Exec } from "../src/d1-ctx-db";
import { createD1CtxDb } from "../src/d1-ctx-db";
import { createD1Exec } from "./_helpers/node-sqlite-d1";

/**
 * What provisioning does to a `.global()` table that already exists.
 *
 * `CREATE TABLE IF NOT EXISTS` leaves one exactly as it is, so adding a field to
 * a shipped schema used to provision nothing: every `insert` died with the
 * driver's own `table p has no column named slug` — untyped, never naming
 * `lunora migrate` — while reads and unrelated patches kept working, so the
 * deploy looked half-healthy. Both sibling migrations in `@lunora/sql-store`
 * already reshape their own tables; only the user-facing one was left out.
 *
 * The second half is the `v.bigint()` storage-format change. Decimal text sorts
 * `"9"` after `"10"`, so it was replaced by an order-preserving key — and a table
 * holding both forms is WORSE than one holding only the old one, because an
 * equality filter binds the key and no longer matches a legacy row. Converting
 * the stragglers is what keeps the change from being a silent read break.
 */
const col = (kind: string, notNull = true): ValidatorLike => {
    return { _meta: { column: { notNull } }, kind };
};

const before: SchemaLike = {
    tables: {
        posts: {
            indexes: [],
            shape: { title: col("string") },
            shardMode: { kind: "global" },
        },
    },
};

const after: SchemaLike = {
    tables: {
        posts: {
            indexes: [{ fields: ["slug"], name: "by_slug", unique: true }],
            shape: { slug: col("string", false), title: col("string") },
            shardMode: { kind: "global" },
        },
    },
};

const ledger: SchemaLike = {
    tables: {
        entries: {
            indexes: [{ fields: ["cents"], name: "by_cents" }],
            shape: { cents: col("bigint") },
            shardMode: { kind: "global" },
        },
    },
};

let harness: ReturnType<typeof createD1Exec>;

const ids = (documents: ReadonlyArray<Record<string, unknown>>): unknown[] => documents.map((document_) => document_["_id"]);

/** The `entries` table as a build that predates the key encoding left it: plain decimal text in the bigint column. */
const seedLegacyLedger = (rows: ReadonlyArray<[string, string]>): void => {
    harness.ddl(`CREATE TABLE "entries" ("id" TEXT PRIMARY KEY, "_creationTime" INTEGER NOT NULL, "_version" INTEGER, "cents" TEXT)`);

    for (const [id, legacy] of rows) {
        harness.ddl(`INSERT INTO "entries" ("id", "_creationTime", "cents") VALUES ('${id}', 1700000000000, '${legacy}')`);
    }
};

/** `harness.exec` with every statement it runs recorded, so a migration probe can be asserted on. */
const recordingExec = (): { exec: D1Exec; statements: string[] } => {
    const statements: string[] = [];

    return {
        exec: {
            all: (query, parameters) => {
                statements.push(query);

                return harness.exec.all(query, parameters);
            },
            run: (query, parameters) => {
                statements.push(query);

                return harness.exec.run(query, parameters);
            },
        },
        statements,
    };
};

describe("d1 ctx-db reshapes an existing .global() table", () => {
    beforeEach(() => {
        harness = createD1Exec();
    });

    afterEach(() => {
        harness.close();
    });

    it("adds a field declared after the table was created, and indexes it", async () => {
        expect.assertions(3);

        const v1 = createD1CtxDb({ clock: () => 1_700_000_000_000, exec: harness.exec, idGenerator: () => "p1", schema: before });

        await v1.insert("posts", { title: "first" });

        // A second ctx-db on the widened schema — a redeploy, not a fresh database.
        const v2 = createD1CtxDb({ clock: () => 1_700_000_001_000, exec: harness.exec, idGenerator: () => "p2", schema: after });

        await v2.insert("posts", { slug: "second", title: "second" });

        const found = await v2.findMany("posts", { where: { slug: "second" } });

        expect(ids(found.page)).toStrictEqual(["p2"]);

        const columns = await harness.exec.all(`PRAGMA table_info("posts")`, []);

        expect(columns.map((column) => String(column["name"])).toSorted((a, b) => a.localeCompare(b))).toStrictEqual([
            "_creationTime",
            "_version",
            "id",
            "slug",
            "title",
        ]);

        // The row that predates the column reads back with the field absent, not
        // as a failure: an added column is nullable whatever the field declares,
        // because `ADD COLUMN … NOT NULL` without a default is rejected outright
        // on a non-empty table.
        const original = await v2.get("p1");

        expect(original?.["title"]).toBe("first");
    });

    it("converts a bigint column still holding the decimal text an earlier build wrote", async () => {
        expect.assertions(3);

        // The rows have to PREDATE the ctx-db that converts them, which is what
        // a binding deployed before the encoding change actually holds: the
        // table and its rows are planted directly, and the first ctx-db to touch
        // the binding is the one carrying the new encoding.
        seedLegacyLedger([
            ["e1", "1"],
            ["e2", "2"],
            ["e9", "9"],
            ["e10", "10"],
            ["e100", "100"],
        ]);

        const stored = await harness.exec.all(`SELECT "cents" FROM "entries" WHERE "id" = 'e10'`, []);

        expect(stored[0]?.["cents"]).toBe("10");

        // A fresh ctx-db runs provisioning, which converts them.
        const db = createD1CtxDb({ clock: () => 1_700_000_002_000, exec: harness.exec, idGenerator: () => "e0", schema: ledger });

        const above = await db.findMany("entries", { orderBy: [{ cents: "asc" }], where: { cents: { gt: 9n } } });

        expect(ids(above.page)).toStrictEqual(["e10", "e100"]);

        const all = await db.findMany("entries", { orderBy: [{ cents: "asc" }] });

        expect(all.page.map((document_) => document_["cents"])).toStrictEqual([1n, 2n, 9n, 10n, 100n]);
    });

    it("does not re-scan a table it has already converted", async () => {
        expect.assertions(3);

        seedLegacyLedger([
            ["e2", "2"],
            ["e10", "10"],
        ]);

        const first = recordingExec();
        const converted = createD1CtxDb({ clock: () => 1_700_000_002_000, exec: first.exec, idGenerator: () => "e0", schema: ledger });

        await converted.findMany("entries", {});

        // The probe cannot use an index (`LENGTH` over the column), so it is a
        // full scan of the table — and `ensureMigrated` runs once per ctx-db,
        // which on a Hyperdrive binding is once per request. Paying it forever on
        // a table that will never match again is the cost this closes; the rows
        // it CANNOT convert used to keep matching, so every cold start paged
        // through them from the top.
        expect(first.statements.filter((statement) => statement.includes("LENGTH(")).length).toBeGreaterThan(0);

        const second = recordingExec();

        await createD1CtxDb({ clock: () => 1_700_000_003_000, exec: second.exec, idGenerator: () => "e1", schema: ledger }).findMany("entries", {});

        expect(second.statements.filter((statement) => statement.includes("LENGTH("))).toStrictEqual([]);

        // …and the conversion the first pass did is still in place.
        const all = await createD1CtxDb({ clock: () => 1_700_000_004_000, exec: harness.exec, idGenerator: () => "e2", schema: ledger }).findMany("entries", {
            orderBy: [{ cents: "asc" }],
        });

        expect(all.page.map((document_) => document_["cents"])).toStrictEqual([2n, 10n]);
    });

    it("leaves a write that commits mid-conversion alone instead of reverting it", async () => {
        expect.assertions(2);

        seedLegacyLedger([
            ["e10", "10"],
            ["e100", "100"],
        ]);

        // A user write lands between the pass reading its page and applying the
        // page's UPDATEs — the interleaving the second round trip opens. It
        // writes the CURRENT encoding, so an unguarded `WHERE id = ?` overwrote
        // it with the re-encoded legacy value: a committed 42 silently back to 10.
        let raced = false;
        const racing: D1Exec = {
            all: async (query, parameters) => {
                const rows = await harness.exec.all(query, parameters);

                if (!raced && query.includes("LENGTH(")) {
                    raced = true;

                    await harness.exec.all(`UPDATE "entries" SET "cents" = ? WHERE "id" = 'e10'`, [bigintSqlKey(42n)]);
                }

                return rows;
            },
            run: (query, parameters) => harness.exec.run(query, parameters),
        };

        await createD1CtxDb({ clock: () => 1_700_000_002_000, exec: racing, idGenerator: () => "e0", schema: ledger }).findMany("entries", {});

        expect(raced).toBe(true);

        const all = await createD1CtxDb({ clock: () => 1_700_000_003_000, exec: harness.exec, idGenerator: () => "e1", schema: ledger }).findMany("entries", {
            orderBy: [{ cents: "asc" }],
        });

        expect(all.page.map((document_) => document_["cents"])).toStrictEqual([42n, 100n]);
    });
});
