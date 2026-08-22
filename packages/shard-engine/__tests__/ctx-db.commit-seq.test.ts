import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DatabaseWriterLike, SchemaLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import { readCommitSeq } from "../src/ctx-db-commit-seq";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * `.commitOrdered()` → the `_commitSeq` system field.
 *
 * The contract under test, in one line: **one sequence per mutation, strictly
 * increasing, refreshed on every write to a row.** Each `createShardCtxDb(...)`
 * below stands for one mutation — that is literally true at runtime, where the
 * generated `buildCtx` builds a fresh writer per dispatch, and it is what makes
 * the memo a commit counter rather than a row counter.
 */
const schema: SchemaLike = {
    tables: {
        // Commit-ordered, and soft-deleting: the tombstone flip is a write and
        // must advance the sequence like any other.
        events: {
            commitOrderedMode: true,
            indexes: [],
            shape: { deletedAt: { kind: "number" }, kind: { kind: "string" } },
            softDeleteMode: { field: "deletedAt" },
        },
        // The control: no `.commitOrdered()`, so no `_commitSeq` anywhere.
        notes: {
            indexes: [],
            shape: { body: { kind: "string" } },
        },
    },
};

let harness: ReturnType<typeof createSqliteExec>;

/**
 * A fresh writer standing in for one MUTATION: `inTransaction` reports `true`,
 * as the DO does while a mutation dispatch is inside its storage transaction, so
 * every write shares one sequence.
 */
const mutation = (): DatabaseWriterLike => createShardContextDatabase({ clock: () => 1_700_000_000_000, inTransaction: () => true, schema, sql: harness.sql });

/**
 * A fresh writer standing in for one ACTION. An action dispatch is deliberately
 * NOT wrapped in a transaction (its external I/O cannot be rolled back), so each
 * write commits on its own and must get its own sequence.
 */
const action = (): DatabaseWriterLike => createShardContextDatabase({ clock: () => 1_700_000_000_000, inTransaction: () => false, schema, sql: harness.sql });

const tableExists = (name: string): boolean => harness.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", name).toArray().length > 0;

const seqOf = async (writer: DatabaseWriterLike, table: string, id: string): Promise<unknown> => {
    const row = await writer.get(id, table);

    return row?.["_commitSeq"];
};

describe("ctx-db commit sequence", () => {
    beforeEach(() => {
        harness = createSqliteExec();
        runShardMigrations(harness.sql, schema);
    });

    afterEach(() => {
        harness.close();
    });

    it("creates the counter table only when a table declares .commitOrdered()", () => {
        expect.assertions(2);

        expect(tableExists("__commit_seq")).toBe(true);

        harness.close();
        harness = createSqliteExec();
        runShardMigrations(harness.sql, { tables: { notes: { indexes: [], shape: { body: { kind: "string" } } } } });

        expect(tableExists("__commit_seq")).toBe(false);
    });

    it("leaves rows on a non-commit-ordered table unstamped, and never allocates for them", async () => {
        expect.assertions(2);

        const writer = mutation();

        await writer.insert("notes", { _id: "n1", body: "hello" }, { allowExplicitId: true });

        await expect(seqOf(writer, "notes", "n1")).resolves.toBeUndefined();
        // The counter is untouched: a shard that writes only non-ordered tables
        // pays nothing, which is the whole point of gating on the schema.
        expect(readCommitSeq(harness.sql)).toBe(0);
    });

    it("gives every row written by one mutation the same sequence", async () => {
        expect.assertions(3);

        const writer = mutation();

        await writer.insert("events", { _id: "e1", kind: "a" }, { allowExplicitId: true });
        await writer.insert("events", { _id: "e2", kind: "b" }, { allowExplicitId: true });
        await writer.insertManyUnsafe?.("events", [{ _id: "e3", kind: "c" }], { allowExplicitId: true });

        const first = await seqOf(writer, "events", "e1");

        expect(first).toBe(1);
        await expect(seqOf(writer, "events", "e2")).resolves.toBe(first);
        await expect(seqOf(writer, "events", "e3")).resolves.toBe(first);
    });

    it("gives each write in one action its own sequence", async () => {
        expect.assertions(3);

        const writer = action();

        await writer.insert("events", { _id: "e1", kind: "a" }, { allowExplicitId: true });
        await writer.insert("events", { _id: "e2", kind: "b" }, { allowExplicitId: true });

        // The failure this prevents: an action's writes commit independently, so
        // sharing one sequence would let a consumer checkpoint after seeing `e1`
        // and never be offered `e2`, which carries a sequence it has passed.
        await expect(seqOf(writer, "events", "e1")).resolves.toBe(1);
        await expect(seqOf(writer, "events", "e2")).resolves.toBe(2);

        expect(readCommitSeq(harness.sql)).toBe(2);
    });

    it("defaults to per-write allocation when the host reports no transaction state", async () => {
        expect.assertions(1);

        // Absent `inTransaction` is read as "not in a transaction" — the
        // conservative direction. Extra sequences cost a consumer nothing; too few
        // silently drop rows.
        const writer = createShardContextDatabase({ clock: () => 1_700_000_000_000, schema, sql: harness.sql });

        await writer.insert("events", { _id: "e1", kind: "a" }, { allowExplicitId: true });
        await writer.insert("events", { _id: "e2", kind: "b" }, { allowExplicitId: true });

        await expect(seqOf(writer, "events", "e2")).resolves.toBe(2);
    });

    it("advances strictly across mutations", async () => {
        expect.assertions(3);

        const first = mutation();

        await first.insert("events", { _id: "e1", kind: "a" }, { allowExplicitId: true });

        const second = mutation();

        await second.insert("events", { _id: "e2", kind: "b" }, { allowExplicitId: true });

        await expect(seqOf(second, "events", "e1")).resolves.toBe(1);
        await expect(seqOf(second, "events", "e2")).resolves.toBe(2);
        expect(readCommitSeq(harness.sql)).toBe(2);
    });

    it("refreshes the sequence on patch and on replace", async () => {
        expect.assertions(2);

        const seed = mutation();

        await seed.insert("events", { _id: "e1", kind: "a" }, { allowExplicitId: true });

        const patcher = mutation();

        await patcher.patch("e1", { kind: "b" });

        await expect(seqOf(patcher, "events", "e1")).resolves.toBe(2);

        const replacer = mutation();

        await replacer.replace("e1", { kind: "c" });

        await expect(seqOf(replacer, "events", "e1")).resolves.toBe(3);
    });

    it("advances the sequence when a soft delete flips the tombstone", async () => {
        expect.assertions(2);

        const seed = mutation();

        await seed.insert("events", { _id: "e1", kind: "a" }, { allowExplicitId: true });

        const remover = mutation();

        await remover.delete("e1");

        // The row survives (soft delete), and its sequence moved — otherwise a
        // changefeed paging on `_commitSeq` would never learn about the delete.
        const row = await remover.get("e1", "events");

        expect(row?.["deletedAt"]).toBe(1_700_000_000_000);
        expect(row?.["_commitSeq"]).toBe(2);
    });

    it("pages a changefeed with no gaps and no repeats", async () => {
        expect.assertions(3);

        const seed = mutation();

        await seed.insert("events", { _id: "e1", kind: "a" }, { allowExplicitId: true });
        await seed.insert("events", { _id: "e2", kind: "b" }, { allowExplicitId: true });

        const cursor = readCommitSeq(harness.sql);

        // Drained: nothing has been written since the cursor was taken.
        const drained = await mutation().findMany("events", { orderBy: [{ _commitSeq: "asc" }], where: { _commitSeq: { gt: cursor } } });

        expect(drained.page).toHaveLength(0);

        const next = mutation();

        await next.patch("e1", { kind: "a2" });

        const changed = await mutation().findMany("events", { orderBy: [{ _commitSeq: "asc" }], where: { _commitSeq: { gt: cursor } } });

        // Only the row the second mutation touched — `e2` did not move.
        expect(changed.page.map((row) => row["_id"])).toStrictEqual(["e1"]);
        expect(changed.page[0]?.["_commitSeq"]).toBe(cursor + 1);
    });

    it("does not observe a hard delete — the documented ceiling", async () => {
        expect.assertions(3);

        const seed = mutation();

        await seed.insert("events", { _id: "e1", kind: "a" }, { allowExplicitId: true });

        const cursor = readCommitSeq(harness.sql);

        await mutation().delete("e1", undefined, { hard: true });

        // `_commitSeq` lives ON the row, so a physical removal takes it along.
        // No image is left to stamp, the counter therefore does not move, and a
        // changefeed sees the row stop appearing without ever being told it went
        // away. This is why `.commitOrdered()` wants `.softDelete()` whenever the
        // feed has to express deletes.
        await expect(mutation().get("e1", "events")).resolves.toBeNull();
        expect(readCommitSeq(harness.sql)).toBe(cursor);

        const feed = await mutation().findMany("events", { orderBy: [{ _commitSeq: "asc" }], where: { _commitSeq: { gt: cursor } } });

        expect(feed.page).toHaveLength(0);
    });

    it("gives every row of one batch insert the same sequence", async () => {
        expect.assertions(2);

        // `insertManyUnsafe` writes a multi-row INSERT — one atomic commit. An
        // action is the interesting case: it holds no transaction, so nothing
        // memoizes the sequence for it except the per-chunk allocation.
        // `insertManyUnsafe` is optional on `DatabaseWriterLike`; narrow it the same
        // way `ctx-db.batch-writes.test.ts` does rather than asserting per call.
        const writer = action() as DatabaseWriterLike & Required<Pick<DatabaseWriterLike, "insertManyUnsafe">>;

        await writer.insertManyUnsafe(
            "events",
            [
                { _id: "b1", kind: "a" },
                { _id: "b2", kind: "b" },
                { _id: "b3", kind: "c" },
            ],
            { allowExplicitId: true },
        );

        const seqs = await Promise.all(["b1", "b2", "b3"].map(async (id) => seqOf(writer, "events", id)));

        // Rows that commit together compare equal — that is what lets a consumer
        // treat one sequence as an indivisible unit.
        expect(new Set(seqs).size).toBe(1);
        expect(seqs[0]).toStrictEqual(expect.any(Number));
    });

    it("pages exactly on a composite (_commitSeq, _id) keyset cursor", async () => {
        expect.assertions(2);

        // Three rows sharing ONE sequence, so any page size below three splits the
        // group — the case group-boundary checkpointing has to special-case and a
        // keyset cursor does not.
        const seed = mutation();

        await seed.insert("events", { _id: "k1", kind: "a" }, { allowExplicitId: true });
        await seed.insert("events", { _id: "k2", kind: "b" }, { allowExplicitId: true });
        await seed.insert("events", { _id: "k3", kind: "c" }, { allowExplicitId: true });

        const drain = async (): Promise<string[]> => {
            const seen: string[] = [];
            let seq = 0;
            let id = "";

            for (let guard = 0; guard < 10; guard += 1) {
                // The exact predicate the docs hand the reader.
                // eslint-disable-next-line no-await-in-loop -- a cursor walk is inherently sequential
                const page = await mutation().findMany("events", {
                    limit: 2,
                    orderBy: [{ _commitSeq: "asc" }, { _id: "asc" }],
                    where: { OR: [{ _commitSeq: { gt: seq } }, { AND: [{ _commitSeq: seq }, { _id: { gt: id } }] }] },
                });

                if (page.page.length === 0) {
                    break;
                }

                for (const row of page.page) {
                    seen.push(row["_id"] as string);
                }

                const last = page.page.at(-1) as Record<string, unknown>;

                seq = last["_commitSeq"] as number;
                id = last["_id"] as string;
            }

            return seen;
        };

        // Every row exactly once, despite the page boundary landing mid-group.
        await expect(drain()).resolves.toStrictEqual(["k1", "k2", "k3"]);
        expect(new Set(await drain())).toStrictEqual(new Set(["k1", "k2", "k3"]));
    });
});
