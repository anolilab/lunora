import type { SchemaLike, ValidatorLike } from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

/**
 * The `entries` table as a build that PREDATES the key encoding left it.
 *
 * Raw DDL rather than a seeding ctx-db, because provisioning is what runs the
 * conversion pass and records its completion: a table created through this
 * build's own ctx-db has, correctly, nothing legacy left to convert. The legacy
 * rows have to be there before the first current-build ctx-db touches it, which
 * is exactly the deployment this pass exists for.
 */
const createLegacyEntriesTable = async (): Promise<void> => {
    await harness.exec.all(`CREATE TABLE "entries" ("id" TEXT PRIMARY KEY, "_creationTime" REAL NOT NULL, "cents" TEXT)`, []);
};

/** Plant one row in the pre-key storage form (plain decimal text). */
const seedLegacyEntry = async (id: string, cents: string): Promise<void> => {
    await harness.exec.all(`INSERT INTO "entries" ("id", "_creationTime", "cents") VALUES (?, ?, ?)`, [id, 1_700_000_000_000, cents]);
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

        expect(columns.map((column) => String(column["name"])).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["_creationTime", "id", "slug", "title"]);

        // The row that predates the column reads back with the field absent, not
        // as a failure: an added column is nullable whatever the field declares,
        // because `ADD COLUMN … NOT NULL` without a default is rejected outright
        // on a non-empty table.
        const original = await v2.get("p1");

        expect(original?.["title"]).toBe("first");
    });

    it("converts a bigint column still holding the decimal text an earlier build wrote", async () => {
        expect.assertions(3);

        // A table left by a build that predates the encoding change, holding
        // rows in the pre-key storage form.
        await createLegacyEntriesTable();

        for (const [id, legacy] of [
            ["e1", "1"],
            ["e2", "2"],
            ["e9", "9"],
            ["e10", "10"],
            ["e100", "100"],
        ]) {
            // eslint-disable-next-line no-await-in-loop -- sequential seeding on one connection
            await seedLegacyEntry(id!, legacy!);
        }

        const stored = await harness.exec.all(`SELECT "cents" FROM "entries" WHERE "id" = 'e10'`, []);

        expect(stored[0]?.["cents"]).toBe("10");

        // A fresh ctx-db runs provisioning, which converts them.
        const db = createD1CtxDb({ clock: () => 1_700_000_002_000, exec: harness.exec, idGenerator: () => "e0", schema: ledger });

        const above = await db.findMany("entries", { orderBy: [{ cents: "asc" }], where: { cents: { gt: 9n } } });

        expect(ids(above.page)).toStrictEqual(["e10", "e100"]);

        const all = await db.findMany("entries", { orderBy: [{ cents: "asc" }] });

        expect(all.page.map((document_) => document_["cents"])).toStrictEqual([1n, 2n, 9n, 10n, 100n]);
    });

    it("converts a NEGATIVE legacy value whose decimal text is exactly one key wide", async () => {
        expect.assertions(2);

        await createLegacyEntriesTable();

        // A key is a sign character plus 39 digits = 40 characters, and `"-"`
        // plus a 39-digit magnitude is 40 too — so `LENGTH(col) <> 40` walked
        // straight past exactly the negative values it can still convert, and an
        // `eq` against one stopped matching once the encoding changed. A key
        // never starts with `-`, which is what tells the two apart.
        const wide = `-${"9".repeat(39)}`;

        await seedLegacyEntry("ewide", wide);
        await seedLegacyEntry("esmall", "1");

        const db = createD1CtxDb({ clock: () => 1_700_000_002_000, exec: harness.exec, idGenerator: () => "e0", schema: ledger });

        const found = await db.findMany("entries", { where: { cents: BigInt(wide) } });

        expect(ids(found.page)).toStrictEqual(["ewide"]);

        const all = await db.findMany("entries", { orderBy: [{ cents: "asc" }] });

        expect(ids(all.page)).toStrictEqual(["ewide", "esmall"]);
    });

    it("records the conversion pass as done so a later ctx-db does not re-walk the table", async () => {
        expect.assertions(2);

        await createLegacyEntriesTable();
        await seedLegacyEntry("e1", "1");

        // `ensureMigrated` is memoised per ctx-db — per REQUEST on a Hyperdrive
        // binding — and the probe is a scan that matches nothing only after
        // reading every row. Without a recorded completion every request paged
        // the whole table again.
        await createD1CtxDb({ clock: () => 1_700_000_002_000, exec: harness.exec, idGenerator: () => "e0", schema: ledger }).get("e1");

        const state = await harness.exec.all(`SELECT "done" FROM "__lunora_search_state" WHERE "companion" = 'bigint-rewrite:entries'`, []);

        expect(state.map((row) => Number(row["done"]))).toStrictEqual([1]);

        const statements: string[] = [];
        const counting: typeof harness.exec = {
            ...harness.exec,
            all: async (query, parameters) => {
                statements.push(query);

                return harness.exec.all(query, parameters);
            },
        };

        await createD1CtxDb({ clock: () => 1_700_000_003_000, exec: counting, idGenerator: () => "e2", schema: ledger }).insert("entries", { cents: 2n });

        expect(statements.some((query) => query.includes("SUBSTR"))).toBe(false);
    });
});
