import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CdcChange, DatabaseWriterLike } from "../src/ctx-db";
import { applyCdcChanges, createShardCtxDb as createShardContextDatabase, readCdcChanges, runShardMigrations, trimCdcChanges } from "../src/ctx-db";
import messagesSchema from "./_helpers/messages-schema";
import createSqliteExec from "./_helpers/node-sqlite";

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

    it("narrows the page to the requested tables when a filter is given", async () => {
        expect.assertions(3);

        const writer = setupWriter(true);

        await writer.insert("messages", { _id: "m1", authorId: "u1", channelId: "c1", text: "1" }, { allowExplicitId: true });
        await writer.insert("roomMembers", { _id: "rm1", roomId: "r1", userId: "u1" }, { allowExplicitId: true });
        await writer.insert("messages", { _id: "m2", authorId: "u1", channelId: "c1", text: "2" }, { allowExplicitId: true });

        const onlyMessages = readCdcChanges(harness.sql, { tables: new Set(["messages"]) });

        // Only the two `messages` rows come back; the `roomMembers` op is filtered out…
        expect(onlyMessages.changes.map((change) => change.id)).toStrictEqual(["m1", "m2"]);
        // …but the cursor still tracks the last *seq scanned for those tables*.
        expect(onlyMessages.changes.map((change) => change.table)).toStrictEqual(["messages", "messages"]);

        // An empty set means "no filter" — the full page, every table.
        const unfiltered = readCdcChanges(harness.sql, { tables: new Set() });

        expect(unfiltered.changes.map((change) => change.id)).toStrictEqual(["m1", "rm1", "m2"]);
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

describe("applyCdcChanges (replay-PITR engine)", () => {
    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    const change = (overrides: Partial<CdcChange> & Pick<CdcChange, "id" | "op">): CdcChange => {
        return { seq: 0, table: "messages", ts: 0, ...overrides };
    };

    it("replays an insert post-image as a fresh row", async () => {
        expect.assertions(1);

        const writer = setupWriter(false);

        await applyCdcChanges(writer, [change({ doc: { _id: "m_1", authorId: "u1", channelId: "c1", text: "hi" }, id: "m_1", op: "insert" })]);

        const row = await writer.get("m_1");

        expect(row).toMatchObject({ text: "hi" });
    });

    it("upserts (replaces) when the row already exists, preserving _creationTime", async () => {
        expect.assertions(2);

        const writer = setupWriter(false);

        await writer.insert("messages", { _id: "m_1", authorId: "u1", channelId: "c1", text: "original" }, { allowExplicitId: true });
        // The post-image carries the row's original _creationTime; a replay-upsert
        // must preserve it, not reset it to the replay-time clock.
        await applyCdcChanges(writer, [
            change({ doc: { _creationTime: 1_650_000_000_000, _id: "m_1", authorId: "u1", channelId: "c1", text: "replayed" }, id: "m_1", op: "update" }),
        ]);

        const row = await writer.get("m_1");

        expect(row).toMatchObject({ text: "replayed" });
        expect(row?.["_creationTime"]).toBe(1_650_000_000_000);
    });

    it("replays a delete by removing the row", async () => {
        expect.assertions(1);

        const writer = setupWriter(false);

        await writer.insert("messages", { _id: "m_1", authorId: "u1", channelId: "c1", text: "doomed" }, { allowExplicitId: true });
        await applyCdcChanges(writer, [change({ id: "m_1", op: "delete" })]);

        const row = await writer.get("m_1");

        expect(row).toBeNull();
    });

    it("reconstructs final state from a snapshot-less ordered changelog", async () => {
        expect.assertions(2);

        const writer = setupWriter(false);

        await applyCdcChanges(writer, [
            change({ doc: { _id: "m_1", authorId: "u1", channelId: "c1", text: "v1" }, id: "m_1", op: "insert" }),
            change({ doc: { _id: "m_2", authorId: "u1", channelId: "c1", text: "keep" }, id: "m_2", op: "insert" }),
            change({ doc: { _id: "m_1", authorId: "u1", channelId: "c1", text: "v2" }, id: "m_1", op: "update" }),
            change({ id: "m_2", op: "delete" }),
        ]);

        await expect(writer.get("m_1")).resolves.toMatchObject({ text: "v2" });
        await expect(writer.get("m_2")).resolves.toBeNull();
    });
});
