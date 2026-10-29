import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SchemaLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import type { DataMigrationLike } from "../src/data-migration";
import { runDataMigration } from "../src/data-migration";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * Declaring a `.unique()` index over a table that already holds duplicates is a
 * migration that cannot succeed. It has to fail as a diagnostic naming the
 * remedy, not as a raw `UNIQUE constraint failed` from the middle of a shard's
 * cold-start migration — `ensureMigrated()` leaves `migrated` false after the
 * throw, so every later dispatch re-runs and re-throws, the shard never opens,
 * and the de-dup data migration that would fix it cannot run either (it goes
 * through `ensureMigrated()` first).
 */
const withoutIndex: SchemaLike = {
    tables: { notes: { indexes: [], shape: { slug: { kind: "string" } } } },
};

const withUniqueIndex: SchemaLike = {
    tables: { notes: { indexes: [{ fields: ["slug"], name: "by_slug", unique: true }], shape: { slug: { kind: "string" } } } },
};

const withUniqueColumn: SchemaLike = {
    tables: { notes: { indexes: [], shape: { slug: { _meta: { column: { unique: true } }, kind: "string" } } } },
};

let harness: ReturnType<typeof createSqliteExec>;

/** Provision the index-free shape and write two rows sharing a slug. */
const seedDuplicates = async (): Promise<void> => {
    runShardMigrations(harness.sql, withoutIndex);

    const writer = createShardContextDatabase({ clock: () => 1_700_000_000_000, schema: withoutIndex, sql: harness.sql });

    await writer.insert("notes", { slug: "dup" });
    await writer.insert("notes", { slug: "dup" });
};

describe("runShardMigrations — adding a UNIQUE index over existing rows", () => {
    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    it("refuses a declared unique index whose column list already has duplicates", async () => {
        expect.assertions(1);

        await seedDuplicates();

        expect(() => {
            runShardMigrations(harness.sql, withUniqueIndex);
        }).toThrow(/duplicate/iu);
    });

    it("refuses a `.unique()` column whose values already have duplicates", async () => {
        expect.assertions(1);

        await seedDuplicates();

        expect(() => {
            runShardMigrations(harness.sql, withUniqueColumn);
        }).toThrow(/duplicate/iu);
    });

    it("still creates the index when the column list is duplicate-free", async () => {
        expect.assertions(1);

        runShardMigrations(harness.sql, withoutIndex);

        const writer = createShardContextDatabase({ clock: () => 1_700_000_000_000, schema: withoutIndex, sql: harness.sql });

        await writer.insert("notes", { slug: "a" });
        await writer.insert("notes", { slug: "b" });

        runShardMigrations(harness.sql, withUniqueIndex);

        expect(harness.raw(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'notes_by_slug'`)).toHaveLength(1);
    });
});

describe("runShardMigrations — recovering a shard wedged by a UNIQUE index over duplicates", () => {
    const schemaWithSibling = (base: SchemaLike): SchemaLike => {
        return { tables: { ...base.tables, sibling: { indexes: [], shape: { label: { kind: "string" } } } } };
    };

    const dedupSlugs: DataMigrationLike = {
        id: "dedup-slugs",
        table: "notes",
        up: (document) => {
            return { ...document, slug: `${String(document["slug"])}-${String(document["_id"])}` };
        },
    };

    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    it("lets the base pass complete and reports the blocked index instead of throwing", async () => {
        expect.assertions(4);

        await seedDuplicates();

        const blocked = runShardMigrations(harness.sql, schemaWithSibling(withUniqueIndex), { deferBlockedUniqueIndexes: true });

        expect(blocked).toHaveLength(1);
        expect(blocked[0]).toMatch(/duplicate/iu);
        // Everything declared AFTER the blocked index still got provisioned.
        expect(harness.raw(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sibling'`)).toHaveLength(1);
        // The blocked index itself is not half-built.
        expect(harness.raw(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'notes_by_slug'`)).toHaveLength(0);
    });

    it("still throws by default, so a normal dispatch refuses until the index exists", async () => {
        expect.assertions(1);

        await seedDuplicates();

        expect(() => {
            runShardMigrations(harness.sql, withUniqueIndex);
        }).toThrow(/duplicate/iu);
    });

    it("lets a de-dup data migration run, after which the index builds and is enforced", async () => {
        expect.assertions(5);

        await seedDuplicates();

        expect(runShardMigrations(harness.sql, withUniqueIndex, { deferBlockedUniqueIndexes: true })).toHaveLength(1);

        const writer = createShardContextDatabase({ clock: () => 1_700_000_000_000, schema: withUniqueIndex, sql: harness.sql });
        const result = await runDataMigration({ migration: dedupSlugs, sql: harness.sql, writer });

        expect(result.status).toBe("completed");
        expect(runShardMigrations(harness.sql, withUniqueIndex, { deferBlockedUniqueIndexes: true })).toHaveLength(0);
        expect(() => {
            runShardMigrations(harness.sql, withUniqueIndex);
        }).not.toThrow();

        const { page } = await writer.findMany("notes", {});
        const [first] = page;

        await expect(writer.insert("notes", { slug: `dup-${String(first?.["_id"])}` })).rejects.toThrow(/unique|conflict/iu);
    });
});
