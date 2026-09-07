import type { ColumnMetaLike, DatabaseWriterLike, SchemaLike, ValidatorLike } from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createD1CtxDb as createD1ContextDatabase, readD1CdcChanges, sweepD1CdcRetention } from "../src/d1-ctx-db";
import { createD1Exec } from "./_helpers/node-sqlite-d1";

/**
 * Change-data-capture changelog for global (D1) tables, against a real
 * `node:sqlite` engine. CDC is opt-in via `createD1CtxDb({ cdc: true })`; the
 * `__cdc_log` table is created lazily by `ensureMigrated` alongside the other
 * companion tables, and every committed write appends a post-image.
 */
const FIXED_CLOCK = 1_700_000_000_000;

const col = (kind: string, column: Partial<ColumnMetaLike> = {}): ValidatorLike => {
    return { _meta: { column: { notNull: true, ...column } }, kind };
};

const todosSchema: SchemaLike = {
    tables: {
        todos: {
            indexes: [],
            shape: { text: col("string") },
        },
    },
};

let harness: ReturnType<typeof createD1Exec>;

/** Wall clock the writer stamps `ts` from — mutable so a test can age rows past a retention window. */
let clockNow: number;

const setupWriter = (cdc: boolean, retentionMs?: number): DatabaseWriterLike => {
    harness.ddl(
        `CREATE TABLE "todos" (
            "id" TEXT PRIMARY KEY,
            "_creationTime" INTEGER NOT NULL,
            "_version" INTEGER,
            "text" TEXT
        )`,
    );

    return createD1ContextDatabase({
        cdc,
        ...(retentionMs === undefined ? {} : { cdcRetentionMs: retentionMs }),
        clock: () => clockNow,
        exec: harness.exec,
        schema: todosSchema,
    });
};

const tableExists = async (name: string): Promise<boolean> => {
    const rows = await harness.exec.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [name]);

    return rows.length > 0;
};

describe("d1 ctx-db change-data-capture", () => {
    beforeEach(() => {
        harness = createD1Exec();
        // Reset the shared wall clock: the retention tests advance it, and a
        // leaked value would age the next test's rows past its window.
        clockNow = FIXED_CLOCK;
    });

    afterEach(() => {
        harness.close();
    });

    it("does not create the changelog table when CDC is disabled", async () => {
        expect.assertions(1);

        const writer = setupWriter(false);

        await writer.insert("todos", { _id: "t_1", text: "hi" }, { allowExplicitId: true });

        await expect(tableExists("__cdc_log")).resolves.toBe(false);
    });

    // The premise the codegen-emitted `syncGlobals` guard rests on. The admin CDC
    // sync endpoint runs against whatever global database the app configured, and
    // the changelog is only created when the writer runs with CDC enabled — so on
    // every non-CDC app there is no `__cdc_log` at all. Reading it straight would
    // turn "nothing has changed yet" into a 500, which is why the emitted helper
    // probes `sqlite_master` first (mirroring the shard-local `runShardCdcSync`).
    it("rejects rather than reporting an empty page when the changelog table was never created", async () => {
        expect.assertions(2);

        setupWriter(false);

        await expect(tableExists("__cdc_log")).resolves.toBe(false);
        await expect(readD1CdcChanges(harness.exec)).rejects.toThrow(/__cdc_log/);
    });

    it("records insert / update / delete in monotonic seq order with post-images", async () => {
        expect.assertions(5);

        const writer = setupWriter(true);

        await writer.insert("todos", { _id: "t_1", text: "hi" }, { allowExplicitId: true });
        await writer.patch("t_1", { text: "edited" });
        await writer.delete("t_1");

        const { changes, cursor } = await readD1CdcChanges(harness.exec);

        expect(changes.map((change) => change.op)).toStrictEqual(["insert", "update", "delete"]);
        expect(changes.map((change) => change.seq)).toStrictEqual([1, 2, 3]);
        expect(cursor).toBe(3);
        expect(changes[1]?.doc).toMatchObject({ text: "edited" });
        // delete carries no document — the id identifies the removed row.
        expect(changes[2]?.doc).toBeUndefined();
    });

    it("pages from a cursor and trims at a checkpoint", async () => {
        expect.assertions(3);

        const writer = setupWriter(true);

        await writer.insert("todos", { _id: "a", text: "1" }, { allowExplicitId: true });
        await writer.insert("todos", { _id: "b", text: "2" }, { allowExplicitId: true });
        await writer.insert("todos", { _id: "c", text: "3" }, { allowExplicitId: true });

        const firstPage = await readD1CdcChanges(harness.exec, { limit: 2 });

        expect(firstPage.changes.map((change) => change.id)).toStrictEqual(["a", "b"]);

        const secondPage = await readD1CdcChanges(harness.exec, { sinceSeq: firstPage.cursor });

        expect(secondPage.changes.map((change) => change.id)).toStrictEqual(["c"]);

        // `c` was written 10s after `a`/`b`, so a 5s window keeps only it.
        clockNow = FIXED_CLOCK + 10_000;
        await writer.insert("todos", { _id: "d", text: "4" }, { allowExplicitId: true });
        await sweepD1CdcRetention(harness.exec, 5000, clockNow);

        const remaining = await readD1CdcChanges(harness.exec, { sinceSeq: 3 });

        expect(remaining.changes.map((change) => change.id)).toStrictEqual(["d"]);
    });

    it("refuses a page that starts below the swept floor", async () => {
        expect.assertions(1);

        const writer = setupWriter(true);

        await writer.insert("todos", { _id: "a", text: "1" }, { allowExplicitId: true });
        clockNow = FIXED_CLOCK + 10_000;
        await writer.insert("todos", { _id: "b", text: "2" }, { allowExplicitId: true });
        await sweepD1CdcRetention(harness.exec, 5000, clockNow);

        // A warehouse consumer resuming from the beginning cannot be served the
        // surviving tail with an advanced cursor — that loses the swept range
        // permanently and reports nothing.
        await expect(readD1CdcChanges(harness.exec, { sinceSeq: 0 })).rejects.toThrow(/trimmed/u);
    });

    it("lets only one sweeper hold the lease per window", async () => {
        expect.assertions(2);

        const writer = setupWriter(true);

        await writer.insert("todos", { _id: "a", text: "1" }, { allowExplicitId: true });
        clockNow = FIXED_CLOCK + 10_000;
        await writer.insert("todos", { _id: "b", text: "2" }, { allowExplicitId: true });

        // The lease is the whole of the cross-shard coordination: every shard in
        // the fleet writes this log, and without it they would all sweep at once.
        await sweepD1CdcRetention(harness.exec, 5000, clockNow);

        const afterFirst = await readD1CdcChanges(harness.exec, { sinceSeq: 1 });

        expect(afterFirst.changes.map((change) => change.id)).toStrictEqual(["b"]);

        // A second sweeper in the same window finds the lease held and does
        // nothing — including not deleting `b`, which a 0ms window otherwise would.
        await sweepD1CdcRetention(harness.exec, 0, clockNow);

        const afterSecond = await readD1CdcChanges(harness.exec, { sinceSeq: 1 });

        expect(afterSecond.changes.map((change) => change.id)).toStrictEqual(["b"]);
    });
});
