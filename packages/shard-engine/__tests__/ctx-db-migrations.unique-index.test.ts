import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SchemaLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
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
