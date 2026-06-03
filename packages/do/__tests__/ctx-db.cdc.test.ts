import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DatabaseWriterLike } from "../src/ctx-db.js";
import { createShardCtxDb as createShardContextDatabase, readCdcChanges, runShardMigrations, trimCdcChanges } from "../src/ctx-db.js";
import { messagesSchema } from "./_helpers/fake-sql.js";
import createSqliteExec from "./_helpers/node-sqlite.js";

/**
 * Change-data-capture changelog, driven through a real SQLite engine. CDC is
 * opt-in: `runShardMigrations(..., { cdc: true })` creates `__cdc_log` and
 * `createShardCtxDb({ cdc: true })` appends a post-image on every committed
 * write. These are the entries streaming-export and replay-PITR page through.
 */

let harness: ReturnType<typeof createSqliteExec>;

const setupWriter = (cdc: boolean): DatabaseWriterLike => {
    runShardMigrations(harness.sql, messagesSchema, { cdc });

    return createShardContextDatabase({
        broadcast: () => undefined,
        clock: () => 1_700_000_000_000,
        cdc,
        schema: messagesSchema,
        sql: harness.sql,
    });
};

const tableExists = (name: string): boolean => harness.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", name).toArray().length > 0;

describe("ctx-db change-data-capture", () => {
    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    it("does not create the changelog table when CDC is disabled", () => {
        expect.assertions(1);

        setupWriter(false);

        expect(tableExists("__cdc_log")).toBe(false);
    });

    it("records insert / update / delete in monotonic seq order with post-images", async () => {
        expect.assertions(6);

        const writer = setupWriter(true);

        await writer.insert("messages", { _id: "m_1", authorId: "u1", channelId: "c1", text: "hi" }, { allowExplicitId: true });
        await writer.patch("m_1", { text: "edited" });
        await writer.delete("m_1");

        const { changes, cursor } = readCdcChanges(harness.sql);

        expect(changes.map((change) => change.op)).toStrictEqual(["insert", "update", "delete"]);
        // seq is strictly increasing and never reused.
        expect(changes.map((change) => change.seq)).toStrictEqual([1, 2, 3]);
        expect(cursor).toBe(3);
        // insert/update carry the post-image; the text reflects the patch.
        expect(changes[0]?.doc).toMatchObject({ _id: "m_1", text: "hi" });
        expect(changes[1]?.doc).toMatchObject({ text: "edited" });
        // delete carries no document — the id identifies the removed row.
        expect(changes[2]?.doc).toBeUndefined();
    });

    it("pages from a cursor via sinceSeq", async () => {
        expect.assertions(2);

        const writer = setupWriter(true);

        await writer.insert("messages", { _id: "a", authorId: "u1", channelId: "c1", text: "1" }, { allowExplicitId: true });
        await writer.insert("messages", { _id: "b", authorId: "u1", channelId: "c1", text: "2" }, { allowExplicitId: true });
        await writer.insert("messages", { _id: "c", authorId: "u1", channelId: "c1", text: "3" }, { allowExplicitId: true });

        const firstPage = readCdcChanges(harness.sql, { limit: 2 });

        expect(firstPage.changes.map((change) => change.id)).toStrictEqual(["a", "b"]);

        const secondPage = readCdcChanges(harness.sql, { sinceSeq: firstPage.cursor });

        expect(secondPage.changes.map((change) => change.id)).toStrictEqual(["c"]);
    });

    it("returns the prior cursor unchanged when the page is empty", async () => {
        expect.assertions(2);

        const writer = setupWriter(true);

        await writer.insert("messages", { _id: "a", authorId: "u1", channelId: "c1", text: "1" }, { allowExplicitId: true });

        const drained = readCdcChanges(harness.sql, { sinceSeq: 5 });

        expect(drained.changes).toStrictEqual([]);
        expect(drained.cursor).toBe(5);
    });

    it("trims entries at or below a checkpointed seq", async () => {
        expect.assertions(2);

        const writer = setupWriter(true);

        await writer.insert("messages", { _id: "a", authorId: "u1", channelId: "c1", text: "1" }, { allowExplicitId: true });
        await writer.insert("messages", { _id: "b", authorId: "u1", channelId: "c1", text: "2" }, { allowExplicitId: true });

        trimCdcChanges(harness.sql, 1);

        const remaining = readCdcChanges(harness.sql);

        expect(remaining.changes.map((change) => change.id)).toStrictEqual(["b"]);
        // Trimming does not reset the monotonic cursor — `b` keeps seq 2.
        expect(remaining.changes[0]?.seq).toBe(2);
    });
});
