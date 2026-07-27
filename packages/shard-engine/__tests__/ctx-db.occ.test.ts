import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DatabaseWriterLike, SchemaLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * Dedicated coverage for the OCC guarded write (`runGuardedWrite` in
 * `ctx-db.ts`) — the CAS-with-snapshot primitive every patch/replace/delete
 * relies on to turn a concurrent-write race into a `ConflictError` (409)
 * instead of a silent lost update.
 *
 * Each test runs two writers over the SAME real `node:sqlite` db. A before
 * trigger that spans an `await` parks the first writer in its read→decide
 * window; inside that window a SECOND writer commits a competing write on the
 * same row, clobbering the snapshot. When the parked writer's guarded
 * `UPDATE/DELETE ... AND __doc__ = ?` then matches zero rows, it must throw —
 * and the surviving row must reflect the winner's write exactly (no partial
 * merge, no lost update). The "different rows" case proves the guard does not
 * raise a false positive on non-overlapping writes.
 *
 * Per AGENTS.md these run on a real SQLite build (`node-sqlite`) because the
 * guard's `changes()` semantics must execute on a genuine engine.
 */

let harness: ReturnType<typeof createSqliteExec>;

const makeWriter = (schema: SchemaLike): DatabaseWriterLike => {
    runShardMigrations(harness.sql, schema);

    return createShardContextDatabase({ clock: () => 1_700_000_000_000, schema, sql: harness.sql });
};

/** A second writer over the same SQLite db (the "competitor" / racing write). */
const makeCompetitor = (schema: SchemaLike): DatabaseWriterLike => createShardContextDatabase({ clock: () => 1_700_000_000_000, schema, sql: harness.sql });

/**
 * Build a schema whose `tasks` table fires a `before` trigger for `op` that, on
 * its first invocation, commits `race()` — a competing write on the same row,
 * inside the parked writer's await window. Subsequent fires (e.g. the
 * competitor's own write triggering the same hook) are no-ops, so only the
 * single interleave under test is provoked.
 */
const schemaWithRace = (op: "delete" | "update", race: () => Promise<void>): SchemaLike => {
    let fired = false;

    return {
        tables: {
            tasks: {
                indexes: [],
                shape: { title: { kind: "string" }, weight: { kind: "number" } },
                triggerMap: {
                    raceWrite: {
                        handler: async () => {
                            if (!fired) {
                                fired = true;
                                await race();
                            }
                        },
                        op,
                        timing: "before",
                    },
                },
            },
        },
    };
};

const expectConflict = (error: unknown): void => {
    expect((error as { code?: unknown }).code).toBe("CONFLICT");
    expect((error as { status?: unknown }).status).toBe(409);
    expect((error as { name?: unknown }).name).toBe("ConflictError");
};

describe("ctx-db OCC guarded write — concurrent writers", () => {
    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    it("patch vs patch: the parked patch conflicts and the winner's write survives", async () => {
        expect.assertions(4);

        let competitor: DatabaseWriterLike | undefined;
        const schema = schemaWithRace("update", async () => {
            await competitor?.patch("t1", { title: "winner" });
        });

        const writer = makeWriter(schema);

        competitor = makeCompetitor(schema);

        await writer.insert("tasks", { _id: "t1", title: "orig", weight: 1 }, { allowExplicitId: true });

        // The parked patch reads its snapshot, fires the before-update trigger
        // (which commits the competitor's patch), then its guarded UPDATE must
        // match zero rows and raise ConflictError.
        let caught: unknown;

        try {
            await writer.patch("t1", { title: "loser" });
        } catch (error) {
            caught = error;
        }

        expectConflict(caught);

        // The winner's write survived intact; the loser's patch never landed.
        const row = await competitor.get("t1");

        expect(row).toMatchObject({ title: "winner", weight: 1 });
    });

    it("replace vs patch: the parked replace conflicts and the winner's write survives", async () => {
        expect.assertions(4);

        let competitor: DatabaseWriterLike | undefined;
        const schema = schemaWithRace("update", async () => {
            await competitor?.patch("t1", { title: "winner" });
        });

        const writer = makeWriter(schema);

        competitor = makeCompetitor(schema);

        await writer.insert("tasks", { _id: "t1", title: "orig", weight: 1 }, { allowExplicitId: true });

        let caught: unknown;

        try {
            await writer.replace("t1", { title: "replaced", weight: 99 });
        } catch (error) {
            caught = error;
        }

        expectConflict(caught);

        // The replace was rejected wholesale — the competitor's patch is the
        // sole surviving write (no partial merge of the replaced document).
        const row = await competitor.get("t1");

        expect(row).toMatchObject({ title: "winner", weight: 1 });
    });

    it("patch vs delete: the row is deleted while the patch is parked, so the patch conflicts", async () => {
        expect.assertions(4);

        let competitor: DatabaseWriterLike | undefined;
        const schema = schemaWithRace("update", async () => {
            await competitor?.delete("t1");
        });

        const writer = makeWriter(schema);

        competitor = makeCompetitor(schema);

        await writer.insert("tasks", { _id: "t1", title: "orig", weight: 1 }, { allowExplicitId: true });

        let caught: unknown;

        try {
            await writer.patch("t1", { title: "loser" });
        } catch (error) {
            caught = error;
        }

        expectConflict(caught);

        // The delete won — the row is gone, not resurrected by the patch.
        await expect(competitor.get("t1")).resolves.toBeNull();
    });

    it("delete vs patch: the row is patched while the delete is parked, so the delete conflicts", async () => {
        expect.assertions(4);

        let competitor: DatabaseWriterLike | undefined;
        const schema = schemaWithRace("delete", async () => {
            await competitor?.patch("t1", { title: "winner" });
        });

        const writer = makeWriter(schema);

        competitor = makeCompetitor(schema);

        await writer.insert("tasks", { _id: "t1", title: "orig", weight: 1 }, { allowExplicitId: true });

        // The delete reads its snapshot, fires the before-delete trigger (which
        // commits the competitor's patch), then its guarded DELETE must match
        // zero rows and raise ConflictError instead of removing the patched row.
        let caught: unknown;

        try {
            await writer.delete("t1");
        } catch (error) {
            caught = error;
        }

        expectConflict(caught);

        // The patch survived — the row was NOT deleted out from under it.
        const row = await competitor.get("t1");

        expect(row).toMatchObject({ title: "winner", weight: 1 });
    });

    it("no false positive: two writers patching DIFFERENT rows both succeed", async () => {
        expect.assertions(2);

        let competitor: DatabaseWriterLike | undefined;
        // The race patches a *different* row (t2) than the parked writer (t1),
        // so the guard's snapshot on t1 is untouched and must NOT conflict.
        const schema = schemaWithRace("update", async () => {
            await competitor?.patch("t2", { title: "two-updated" });
        });

        const writer = makeWriter(schema);

        competitor = makeCompetitor(schema);

        await writer.insert("tasks", { _id: "t1", title: "one", weight: 1 }, { allowExplicitId: true });
        await writer.insert("tasks", { _id: "t2", title: "two", weight: 2 }, { allowExplicitId: true });

        // Must resolve, not reject — disjoint rows are not a conflict.
        await expect(writer.patch("t1", { title: "one-updated" })).resolves.toBeUndefined();

        const rows = await Promise.all([competitor.get("t1"), competitor.get("t2")]);

        expect(rows).toMatchObject([
            { title: "one-updated", weight: 1 },
            { title: "two-updated", weight: 2 },
        ]);
    });
});
