import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CdcChange, DatabaseWriterLike, SchemaLike, SqlExec } from "../src/ctx-db";
import {
    applyCdcChanges,
    cdcCanVouchFor,
    cdcTouchesTables,
    createShardCtxDb as createShardContextDatabase,
    readCdcChanges,
    runShardMigrations,
    trimCdcChanges,
} from "../src/ctx-db";
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

    it("returns every table's changes in commit order", async () => {
        expect.assertions(2);

        // This is the whole-log reader: there is no table filter, and the
        // per-table path (`readCdcChangeKeys`) is a different function. The
        // interleaving matters — a reader that dropped a table would still look
        // right on a single-table log.
        const writer = setupWriter(true);

        await writer.insert("messages", { _id: "m1", authorId: "u1", channelId: "c1", text: "1" }, { allowExplicitId: true });
        await writer.insert("roomMembers", { _id: "rm1", roomId: "r1", userId: "u1" }, { allowExplicitId: true });
        await writer.insert("messages", { _id: "m2", authorId: "u1", channelId: "c1", text: "2" }, { allowExplicitId: true });

        const page = readCdcChanges(harness.sql);

        expect(page.changes.map((change) => change.id)).toStrictEqual(["m1", "rm1", "m2"]);
        expect(page.changes.map((change) => change.table)).toStrictEqual(["messages", "roomMembers", "messages"]);
    });

    it("returns the prior cursor unchanged when the page is empty", async () => {
        expect.assertions(2);

        const writer = setupWriter(true);

        await writer.insert("messages", { _id: "a", authorId: "u1", channelId: "c1", text: "1" }, { allowExplicitId: true });

        const drained = readCdcChanges(harness.sql, { sinceSeq: 5 });

        expect(drained.changes).toStrictEqual([]);
        expect(drained.cursor).toBe(5);
    });

    describe("cdcCanVouchFor", () => {
        it("vouches for a local table and refuses anything the changelog never records", () => {
            expect.assertions(3);

            setupWriter(true);

            // A real table: the changelog records every write to it, so "nothing
            // changed" is a claim it can support.
            expect(cdcCanVouchFor(harness.sql, new Set(["messages"]))).toBe(true);
            // A `.global()` table is never created locally, so it falls to the
            // default — as does the flags/admin wildcard, which is not a table.
            expect(cdcCanVouchFor(harness.sql, new Set(["messages", "profiles"]))).toBe(false);
            expect(cdcCanVouchFor(harness.sql, new Set(["*"]))).toBe(false);
        });

        it("picks up a table created after the catalog was first read", () => {
            expect.assertions(2);

            setupWriter(true);

            // Warm the memo, and record a miss for a table that does not exist yet.
            expect(cdcCanVouchFor(harness.sql, new Set(["late_arrival"]))).toBe(false);

            harness.sql.exec(`CREATE TABLE late_arrival (id TEXT PRIMARY KEY)`);

            // Only positive answers are cached: a dep the memo does not know
            // re-reads the catalog rather than refusing forever. Getting this
            // wrong would silently deny every resume for a table added by a later
            // migration, which no test would otherwise notice.
            expect(cdcCanVouchFor(harness.sql, new Set(["late_arrival"]))).toBe(true);
        });
    });

    it("trims entries at or below a checkpointed seq", async () => {
        expect.assertions(2);

        const writer = setupWriter(true);

        await writer.insert("messages", { _id: "a", authorId: "u1", channelId: "c1", text: "1" }, { allowExplicitId: true });
        await writer.insert("messages", { _id: "b", authorId: "u1", channelId: "c1", text: "2" }, { allowExplicitId: true });

        trimCdcChanges(harness.sql, 1, 100);

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

describe("cdc round-trip of a v.bigint() column (plan 265)", () => {
    // A dedicated schema — `messagesSchema` declares no bigint/bytes column,
    // and this regression is specifically about `recordCdc` (ctx-db-cdc.ts)
    // no longer throwing one line after a successful insert of such a row.
    const bigintSchema: SchemaLike = {
        tables: {
            accounts: {
                indexes: [],
                shape: { amount: { kind: "bigint" }, name: { kind: "string" } },
            },
        },
    };

    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    it("readCdcChanges yields a doc whose bigint survives (pre-fix: recordCdc throws)", async () => {
        expect.assertions(1);

        runShardMigrations(harness.sql, bigintSchema, { cdc: true });

        const writer = createShardContextDatabase({
            broadcast: () => undefined,
            cdc: true,
            clock: () => 1_700_000_000_000,
            schema: bigintSchema,
            sql: harness.sql,
        });

        await writer.insert("accounts", { _id: "a1", amount: 10n, name: "acme" }, { allowExplicitId: true });

        const { changes } = readCdcChanges(harness.sql);

        expect(changes[0]?.doc?.["amount"]).toBe(10n);
    });
});

/**
 * `cdcTouchesTables` binds one parameter per table in the read-set, and the
 * read-set is however many tables one query happened to read. Workerd caps a
 * statement at 100 bound parameters and `node:sqlite` does not, so the cap
 * cannot be reproduced by running the probe — assert the shape instead: no
 * single statement may bind more than the cap, whatever the read-set size.
 */
describe("cdcTouchesTables under a wide read-set", () => {
    /** Workerd's per-statement bound-parameter ceiling. */
    const WORKERD_BOUND_PARAM_CAP = 100;

    /** Wraps a real SQL handle, recording the bound-parameter count of every statement it runs. */
    const countingSql = (sql: SqlExec): { paramCounts: number[]; sql: SqlExec } => {
        const paramCounts: number[] = [];

        return {
            paramCounts,
            sql: {
                exec: (query: string, ...parameters: unknown[]) => {
                    paramCounts.push(parameters.length);

                    return sql.exec(query, ...parameters);
                },
            },
        };
    };

    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    it("answers a 250-table read-set without ever binding past the cap", async () => {
        expect.assertions(2);

        const writer = setupWriter(true);

        await writer.insert("messages", { body: "hi", channel: "general", id: "m1" });

        const readSet = new Set([...Array.from({ length: 249 }, (_, index) => `t${String(index)}`), "messages"]);
        const { paramCounts, sql } = countingSql(harness.sql);

        expect(cdcTouchesTables(sql, 0, readSet)).toBe(true);
        expect(Math.max(...paramCounts)).toBeLessThanOrEqual(WORKERD_BOUND_PARAM_CAP);
    });

    it("reports no touch when nothing in the wide read-set moved", async () => {
        expect.assertions(1);

        const writer = setupWriter(true);

        await writer.insert("messages", { body: "hi", channel: "general", id: "m1" });

        const readSet = new Set(Array.from({ length: 250 }, (_, index) => `t${String(index)}`));

        expect(cdcTouchesTables(harness.sql, 0, readSet)).toBe(false);
    });
});
