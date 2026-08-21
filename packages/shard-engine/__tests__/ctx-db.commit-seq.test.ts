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

/** A fresh writer — i.e. a fresh mutation, with its own `_commitSeq` allocation. */
const mutation = (): DatabaseWriterLike => createShardContextDatabase({ clock: () => 1_700_000_000_000, schema, sql: harness.sql });

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
});
