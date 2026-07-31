import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SqlExec } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase } from "../src/ctx-db";
import { runShardMigrations } from "../src/ctx-db-migrations";
import type { DataMigrationLike } from "../src/data-migration";
import { DATA_MIGRATION_STATE_TABLE, runDataMigration } from "../src/data-migration";
import type { DatabaseWriterLike, SchemaLike } from "../src/schema-types";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * Exercises the online data-migration runner against a real SQLite engine (per
 * AGENTS.md — never the SQL-string fake), so keyset resumption, idempotent
 * completion, and the `__lunora_migrations` state round-trip behave the way
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
        // eslint-disable-next-line no-await-in-loop -- sequential seed writes into the same DB
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

        it("gives the transform a reader, so a backfill can denormalise a parent's field", async () => {
            expect.assertions(2);

            // The shape people actually write: read the parent, copy a field
            // down. A transform that only receives the row cannot express it at
            // all — e.g. reading `threads` to stamp `userId` onto its children.
            const schemaWithTeams: SchemaLike = {
                tables: {
                    members: { indexes: [], shape: { name: { kind: "string" }, teamId: { kind: "string" }, teamName: { kind: "optional" } } },
                    teams: { indexes: [], shape: { name: { kind: "string" } } },
                },
            };

            runShardMigrations(harness.sql, schemaWithTeams);

            const writer = createShardContextDatabase({ clock: () => 1_700_000_000_000, schema: schemaWithTeams, sql: harness.sql });

            await writer.insert("teams", { _id: "t1", name: "Platform" }, { allowExplicitId: true });
            await writer.insert("members", { _id: "m1", name: "ada", teamId: "t1" }, { allowExplicitId: true });
            await writer.insert("members", { _id: "m2", name: "grace", teamId: "t1" }, { allowExplicitId: true });

            const denormaliseTeamName: DataMigrationLike = {
                id: "denormalise-team-name",
                table: "members",
                up: async (document, context) => {
                    const team = await context.db.get(String(document["teamId"]), "teams");

                    return team ? { ...document, teamName: team["name"] } : undefined;
                },
            };

            const result = await runDataMigration({ migration: denormaliseTeamName, sql: harness.sql, writer });

            expect(result).toMatchObject({ changed: 2, processed: 2, status: "completed" });

            const members = await writer.findMany("members", { orderBy: [{ _id: "asc" }] });

            expect(members.page.map((document) => document["teamName"])).toEqual(["Platform", "Platform"]);
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

        it("a maxBatches pause still returns in_progress even when releaseClaim's UPDATE throws", async () => {
            expect.assertions(4);

            const writer = setupWriter();

            await seed(writer);

            // The swallowed failure is logged so repeated release failures are
            // observable rather than silently delaying every resume.
            const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

            // Wrap the real SqlExec so only the release-claim statement (the
            // `updated_at = 0` back-date, distinct from the heartbeat's
            // `updated_at = ?` touch) throws — every other statement (claim,
            // persistState, etc.) runs against the real SQLite engine
            // untouched, so the batch itself is unaffected.
            const throwingSql: SqlExec = {
                exec: (query, ...parameters) => {
                    if (query.includes("updated_at = 0")) {
                        throw new Error("simulated releaseClaim failure");
                    }

                    return harness.sql.exec(query, ...parameters);
                },
            };

            const result = await runDataMigration({ batchSize: 2, maxBatches: 1, migration: bumpVersion, sql: throwingSql, writer });

            expect(result.status).toBe("in_progress");
            expect(result.processed).toBe(2);

            // The claim was never released, so it's still marked in_progress
            // with a fresh (non-zero) updated_at — the stale-claim timeout is
            // the fallback path a later invocation relies on.
            expect(stateRow("bump-version")).toMatchObject({ status: "in_progress" });

            expect(warn).toHaveBeenCalledWith(expect.stringContaining('data migration "bump-version": releaseClaim failed'), expect.any(Error));

            warn.mockRestore();
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

    describe("runDataMigration — concurrent runners", () => {
        it("two simultaneous run() calls migrate the table exactly once (one wins, the loser no-ops)", async () => {
            expect.assertions(4);

            const writer = setupWriter();

            await seed(writer);

            // Gate the first `findMany` so the second runner can enter the
            // read-decide window before the first persists any progress — the
            // exact interleave two overlapping migrate requests hit on one DO.
            let release: () => void = () => {};
            const firstFindManyEntered = new Promise<void>((resolve) => {
                release = resolve;
            });
            let gated = false;

            const original = writer.findMany.bind(writer);
            const gatedWriter: DatabaseWriterLike = {
                ...writer,
                findMany: async (table, options) => {
                    if (!gated) {
                        gated = true;
                        // Let the second runner run up to its own claim before
                        // the first runner's first batch resolves.
                        await firstFindManyEntered;
                    }

                    return original(table, options);
                },
            };

            const first = runDataMigration({ migration: bumpVersion, sql: harness.sql, writer: gatedWriter });

            // Second runner races in while the first is parked on the gate. It
            // must lose the atomic claim and no-op without touching a row.
            const second = await runDataMigration({ migration: bumpVersion, sql: harness.sql, writer: gatedWriter });

            expect(second.status).toBe("in_progress");
            expect(second.processed).toBe(0);

            // Release the winner and let it finish.
            release();

            const winner = await first;

            expect(winner).toEqual({ changed: 5, cursor: null, direction: "up", dryRun: false, id: "bump-version", processed: 5, status: "completed" });

            // Each row bumped exactly once — double-processing would yield 2.
            const snapshot = await allUsers(writer);

            expect(snapshot.map((document) => document["version"])).toEqual([1, 1, 1, 1, 1]);
        });

        it("reclaims a stale in_progress claim (crashed runner) whose updated_at predates the timeout", async () => {
            expect.assertions(3);

            const writer = setupWriter();

            await seed(writer);

            // Simulate a runner that crashed mid-batch: it claimed and persisted
            // progress for the first 2 rows but never released the claim (no
            // maxBatches return, no failure). Its updated_at is then well past
            // the 30s reclaim window.
            const crashedAt = 1_700_000_000_000;

            await runDataMigration({ batchSize: 2, clock: () => crashedAt, maxBatches: 1, migration: bumpVersion, sql: harness.sql, writer });

            // Re-stamp it as a still-held (in_progress, non-zero updated_at)
            // claim, then age it past the timeout — the back-date overrides the
            // release-on-return marker, reproducing an orphaned in-flight claim.
            harness.raw(`UPDATE "${DATA_MIGRATION_STATE_TABLE}" SET status = 'in_progress', updated_at = ? WHERE id = ?`, crashedAt - 60_000, "bump-version");

            expect(stateRow("bump-version")).toMatchObject({ processed: 2, status: "in_progress" });

            // A fresh runner sees the stale claim, reclaims it, and resumes from
            // the persisted cursor — finishing the remaining rows exactly once.
            const resumed = await runDataMigration({ batchSize: 2, clock: () => crashedAt + 120_000, migration: bumpVersion, sql: harness.sql, writer });

            expect(resumed).toMatchObject({ processed: 5, status: "completed" });

            const snapshot = await allUsers(writer);

            expect(snapshot.map((document) => document["version"])).toEqual([1, 1, 1, 1, 1]);
        });

        it("heartbeats the claim mid-batch so a long single batch can't be reclaimed", async () => {
            expect.assertions(3);

            const writer = setupWriter();

            await seed(writer);

            // A clock that advances 8s on every read. With a 10s heartbeat
            // interval and a single batch of 5 rows, the runner must refresh
            // `updated_at` PARTWAY through the batch — not only at the end —
            // otherwise a batch longer than the 30s stale window would let a peer
            // steal the claim and double-process.
            let now = 1_700_000_000_000;
            const clock = (): number => {
                now += 8000;

                return now;
            };

            // After each row's rewrite, record the claim's persisted `updated_at`
            // so we can prove it climbed during the batch (before the end persist).
            const observedUpdatedAt: number[] = [];
            const original = writer.replace.bind(writer);
            const probingWriter: DatabaseWriterLike = {
                ...writer,
                replace: async (id, document) => {
                    await original(id, document);
                    observedUpdatedAt.push(Number(stateRow("bump-version")?.["updated_at"] ?? 0));
                },
            };

            const result = await runDataMigration({ clock, migration: bumpVersion, sql: harness.sql, writer: probingWriter });

            expect(result).toMatchObject({ processed: 5, status: "completed" });

            const snapshot = await allUsers(writer);

            expect(snapshot.map((document) => document["version"])).toEqual([1, 1, 1, 1, 1]);

            // The first observation is the claim stamp; a later one is greater,
            // proving an in-batch heartbeat fired (without it, every observation
            // would equal the claim stamp — the end persist runs after the loop).
            const claimStamp = observedUpdatedAt[0] ?? 0;

            expect(observedUpdatedAt.some((stamp) => stamp > claimStamp)).toBe(true);
        });

        it("an in-flight claim (parked mid-batch) blocks a second runner even at the same wall-clock", async () => {
            expect.assertions(2);

            const writer = setupWriter();

            await seed(writer);

            // Gate the first runner inside its first batch so its claim is held
            // (not yet released) when the second runner attempts to claim.
            let release: () => void = () => {};
            const firstFindManyEntered = new Promise<void>((resolve) => {
                release = resolve;
            });
            let gated = false;

            const original = writer.findMany.bind(writer);
            const gatedWriter: DatabaseWriterLike = {
                ...writer,
                findMany: async (table, options) => {
                    if (!gated) {
                        gated = true;
                        await firstFindManyEntered;
                    }

                    return original(table, options);
                },
            };

            // Same fixed clock for both — so the loser cannot win on a stale
            // timeout; it must lose purely because the claim is in-flight.
            const at = 1_700_000_000_000;
            const first = runDataMigration({ clock: () => at, migration: bumpVersion, sql: harness.sql, writer: gatedWriter });
            const blocked = await runDataMigration({ clock: () => at, migration: bumpVersion, sql: harness.sql, writer: gatedWriter });

            expect(blocked.status).toBe("in_progress");

            release();
            await first;

            // Migrated exactly once despite the overlap.
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
