import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DatabaseWriterLike, SchemaLike } from "../src/ctx-db.js";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db.js";
import type { DataMigrationLike } from "../src/data-migration.js";
import { DATA_MIGRATION_STATE_TABLE, runDataMigration } from "../src/data-migration.js";
import { createSqliteExec } from "./_helpers/node-sqlite.js";

/**
 * Exercises the online data-migration runner against a real SQLite engine (per
 * AGENTS.md — never the SQL-string fake), so keyset resumption, idempotent
 * completion, and the `__cirrus_migrations` state round-trip behave the way
 * they would inside a Durable Object. A fixed clock makes every row share a
 * `_creationTime`, forcing iteration to lean on the id tiebreak — the same
 * stress the runner faces when it rewrites a row mid-scan.
 */
const usersSchema: SchemaLike = {
    tables: {
        users: {
            indexes: [],
            shape: {
                name: { kind: "string" },
                score: { kind: "number" },
                version: { kind: "number" },
            },
        },
    },
};

let harness: ReturnType<typeof createSqliteExec>;

const setupWriter = (): DatabaseWriterLike => {
    runShardMigrations(harness.sql, usersSchema);

    return createShardContextDatabase({
        clock: () => 1_700_000_000_000,
        schema: usersSchema,
        sql: harness.sql,
    });
};

/** Seed five users (u1..u5), each at version 0, with ascending scores 10..50. */
const seed = async (writer: DatabaseWriterLike): Promise<void> => {
    for (let index = 1; index <= 5; index += 1) {
        await writer.insert("users", { _id: `u${String(index)}`, name: `user ${String(index)}`, score: index * 10, version: 0 }, { allowExplicitId: true });
    }
};

/** Read every user ordered by id, decoded from the document column. */
const allUsers = async (writer: DatabaseWriterLike): Promise<Record<string, unknown>[]> => {
    const result = await writer.findMany("users", { orderBy: [{ _id: "asc" }] });

    return result.page;
};

/** The persisted state row for `id`, or undefined when none exists. */
const stateRow = (id: string): Record<string, unknown> | undefined => harness.raw(`SELECT * FROM "${DATA_MIGRATION_STATE_TABLE}" WHERE id = ?`, id)[0];

/** Increment every row's `version` by one. */
const bumpVersion: DataMigrationLike = {
    id: "bump-version",
    table: "users",
    up: (document) => {
        return { ...document, version: Number(document["version"] ?? 0) + 1 };
    },
};

describe("runDataMigration", () => {
    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    describe("runDataMigration — up", () => {
        it("rewrites every row and reports completed with cumulative counts", async () => {
            expect.assertions(2);

            const writer = setupWriter();

            await seed(writer);

            const result = await runDataMigration({ migration: bumpVersion, sql: harness.sql, writer });

            expect(result).toEqual({ changed: 5, cursor: null, direction: "up", dryRun: false, id: "bump-version", processed: 5, status: "completed" });

            const snapshot = await allUsers(writer);

            expect(snapshot.map((document) => document["version"])).toEqual([1, 1, 1, 1, 1]);
        });

        it("counts a row whose transform returns undefined as processed but not changed", async () => {
            expect.assertions(3);

            const writer = setupWriter();

            await seed(writer);

            const flagHighScores: DataMigrationLike = {
                id: "flag-high",
                table: "users",
                up: (document) => (Number(document["score"]) >= 30 ? { ...document, flagged: true } : undefined),
            };

            const result = await runDataMigration({ migration: flagHighScores, sql: harness.sql, writer });

            expect(result.processed).toBe(5);
            expect(result.changed).toBe(3);

            const snapshot = await allUsers(writer);

            expect(snapshot.map((document) => document["flagged"])).toEqual([undefined, undefined, true, true, true]);
        });

        it("persists progress to the reserved state table", async () => {
            expect.assertions(3);

            const writer = setupWriter();

            await seed(writer);

            await runDataMigration({ clock: () => 1_800_000_000_000, migration: bumpVersion, sql: harness.sql, writer });

            const row = stateRow("bump-version");

            expect(row).toMatchObject({ changed: 5, cursor: null, direction: "up", id: "bump-version", processed: 5, status: "completed" });
            expect(row?.["started_at"]).toBe(1_800_000_000_000);
            expect(row?.["updated_at"]).toBe(1_800_000_000_000);
        });

        it("invokes onBatch once per persisted batch with climbing progress", async () => {
            expect.assertions(1);

            const writer = setupWriter();

            await seed(writer);

            const progress: { changed: number; processed: number }[] = [];

            // 5 rows at batchSize 2 → batches of 2, 2, 1.
            await runDataMigration({
                batchSize: 2,
                migration: bumpVersion,
                onBatch: ({ changed, processed }) => {
                    progress.push({ changed, processed });
                },
                sql: harness.sql,
                writer,
            });

            expect(progress).toEqual([
                { changed: 2, processed: 2 },
                { changed: 4, processed: 4 },
                { changed: 5, processed: 5 },
            ]);
        });

        it("does not invoke onBatch on a dry run (nothing is persisted)", async () => {
            expect.assertions(1);

            const writer = setupWriter();

            await seed(writer);

            let calls = 0;

            await runDataMigration({
                batchSize: 2,
                dryRun: true,
                migration: bumpVersion,
                onBatch: () => {
                    calls += 1;
                },
                sql: harness.sql,
                writer,
            });

            expect(calls).toBe(0);
        });

        it("a throwing onBatch is swallowed: the run completes and is not marked failed", async () => {
            expect.assertions(3);

            const writer = setupWriter();

            await seed(writer);

            // The flush/push that onBatch performs is best-effort; its failure must
            // not abort the run nor flip the final (completed) batch to failed.
            const result = await runDataMigration({
                batchSize: 2,
                migration: bumpVersion,
                onBatch: () => {
                    throw new Error("flush boom");
                },
                sql: harness.sql,
                writer,
            });

            expect(result.status).toBe("completed");
            expect(result.processed).toBe(5);
            expect(stateRow("bump-version")).toMatchObject({ cursor: null, status: "completed" });
        });
    });

    describe("runDataMigration — resume", () => {
        it("a maxBatches-limited run resumes and visits each row exactly once", async () => {
            expect.assertions(7);

            const writer = setupWriter();

            await seed(writer);

            const first = await runDataMigration({ batchSize: 2, maxBatches: 1, migration: bumpVersion, sql: harness.sql, writer });

            expect(first.status).toBe("in_progress");
            expect(first.processed).toBe(2);
            expect(first.cursor).not.toBeNull();

            // Resume with no maxBatches — drains the rest from the stored cursor.
            const second = await runDataMigration({ batchSize: 2, migration: bumpVersion, sql: harness.sql, writer });

            expect(second.status).toBe("completed");
            expect(second.processed).toBe(5);
            expect(second.changed).toBe(5);

            // Every row bumped exactly once — a re-scan of the first batch would show 2.
            const snapshot = await allUsers(writer);

            expect(snapshot.map((document) => document["version"])).toEqual([1, 1, 1, 1, 1]);
        });

        it("re-running a completed migration is a no-op that returns the stored counts", async () => {
            expect.assertions(2);

            const writer = setupWriter();

            await seed(writer);

            await runDataMigration({ migration: bumpVersion, sql: harness.sql, writer });
            const again = await runDataMigration({ migration: bumpVersion, sql: harness.sql, writer });

            expect(again).toEqual({ changed: 5, cursor: null, direction: "up", dryRun: false, id: "bump-version", processed: 5, status: "completed" });

            // No rescan: versions stay at 1 rather than climbing to 2.
            const snapshot = await allUsers(writer);

            expect(snapshot.map((document) => document["version"])).toEqual([1, 1, 1, 1, 1]);
        });
    });

    describe("runDataMigration — down", () => {
        it("reverses via the down transform, discarding the completed up state", async () => {
            expect.assertions(3);

            const writer = setupWriter();

            await seed(writer);

            const migration: DataMigrationLike = {
                down: (document) => {
                    return { ...document, version: Number(document["version"]) - 1 };
                },
                id: "versioned",
                table: "users",
                up: (document) => {
                    return { ...document, version: Number(document["version"]) + 1 };
                },
            };

            await runDataMigration({ migration, sql: harness.sql, writer });
            const down = await runDataMigration({ direction: "down", migration, sql: harness.sql, writer });

            expect(down).toEqual({ changed: 5, cursor: null, direction: "down", dryRun: false, id: "versioned", processed: 5, status: "completed" });

            const snapshot = await allUsers(writer);

            expect(snapshot.map((document) => document["version"])).toEqual([0, 0, 0, 0, 0]);
            expect(stateRow("versioned")?.["direction"]).toBe("down");
        });

        it("throws when the requested direction has no transform", async () => {
            expect.assertions(1);

            const writer = setupWriter();

            await seed(writer);

            await expect(runDataMigration({ direction: "down", migration: bumpVersion, sql: harness.sql, writer })).rejects.toThrow(/has no `down` transform/);
        });
    });

    describe("runDataMigration — dryRun", () => {
        it("previews counts without rewriting rows or creating the state table", async () => {
            expect.assertions(3);

            const writer = setupWriter();

            await seed(writer);

            const result = await runDataMigration({ dryRun: true, migration: bumpVersion, sql: harness.sql, writer });

            expect(result).toEqual({ changed: 5, cursor: null, direction: "up", dryRun: true, id: "bump-version", processed: 5, status: "completed" });

            // Rows untouched...
            const snapshot = await allUsers(writer);

            expect(snapshot.map((document) => document["version"])).toEqual([0, 0, 0, 0, 0]);

            // ...and no state table was created.
            const tables = harness.raw(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, DATA_MIGRATION_STATE_TABLE);

            expect(tables).toHaveLength(0);
        });
    });

    describe("runDataMigration — failure", () => {
        it("persists a failed state with partial counts and rethrows", async () => {
            expect.assertions(3);

            const writer = setupWriter();

            await seed(writer);

            const explodeOnU3: DataMigrationLike = {
                id: "explode",
                table: "users",
                up: (document) => {
                    if (document["_id"] === "u3") {
                        throw new Error("boom");
                    }

                    return { ...document, version: 1 };
                },
            };

            await expect(runDataMigration({ batchSize: 10, migration: explodeOnU3, sql: harness.sql, writer })).rejects.toThrow("boom");

            const row = stateRow("explode");

            expect(row).toMatchObject({ changed: 2, error: "boom", id: "explode", processed: 3, status: "failed" });

            // Only the rows before the failure were rewritten.
            const snapshot = await allUsers(writer);

            expect(snapshot.map((document) => document["version"])).toEqual([1, 1, 0, 0, 0]);
        });
    });
});
