import type { CdcChange, SqlExec } from "@lunora/shard-engine";
import { applyCdcChanges, createShardCtxDb, runShardMigrations } from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import messagesSchema from "./_helpers/messages-schema";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * A replica applies a pulled changelog page through `runShardApplyCdc`. The page
 * is the unit of progress (the follow cursor only moves past a whole page), so a
 * change that throws halfway must not leave the rows before it behind: they would
 * be visible to reads while the cursor says they were never applied.
 *
 * The page goes through the same `createShardCtxDb` writer the generated override
 * uses, so this also pins that its operations run fine inside the open transaction.
 */
class ApplyShard extends ShardDO {
    /** Hold a transaction open on this DO until `release` settles, as a concurrent dispatch would. */
    public hold(release: Promise<void>): Promise<void> {
        return this.runInTransaction(async () => release);
    }

    // eslint-disable-next-line class-methods-use-this -- abstract stub: only the replica apply path is exercised
    public override async handleRpc(): Promise<unknown> {
        return undefined;
    }

    protected override async runShardApplyCdc(args: { changes: ReadonlyArray<CdcChange> }): Promise<{ applied: number }> {
        const writer = createShardCtxDb({ inTransaction: () => this.isInTransaction(), schema: messagesSchema, sql: this.sql as SqlExec });

        await applyCdcChanges(writer, args.changes);

        return { applied: args.changes.length };
    }
}

const insert = (seq: number, id: string, table = "messages"): CdcChange => {
    return { doc: { _id: id, authorId: "u1", channelId: "c1", text: `text-${id}` }, id, op: "insert", seq, table, ts: seq };
};

describe("shardDO replica page apply", () => {
    let harness: ReturnType<typeof createSqliteExec>;
    let shard: ApplyShard;
    let host: { applyChanges: (changes: CdcChange[]) => Promise<number> };

    beforeEach(() => {
        harness = createSqliteExec();
        runShardMigrations(harness.sql, messagesSchema);

        // `transaction` rolls back on throw, as the platform's does.
        const transaction = async <R>(closure: () => Promise<R>): Promise<R> => {
            harness.raw("SAVEPOINT page");

            try {
                const result = await closure();

                harness.raw("RELEASE page");

                return result;
            } catch (error) {
                harness.raw("ROLLBACK TO page");
                harness.raw("RELEASE page");

                throw error;
            }
        };

        // The single-writer gate: one closure at a time, as `blockConcurrencyWhile` delays the next.
        let gateTail: Promise<unknown> = Promise.resolve();
        const blockConcurrencyWhile = async <R>(closure: () => Promise<R>): Promise<R> => {
            const run = gateTail.then(closure, closure);

            gateTail = run.catch(() => undefined);

            return run;
        };

        shard = new ApplyShard(
            {
                blockConcurrencyWhile,
                getWebSockets: () => [],
                id: { name: "tenant-7::replica::weur" },
                storage: { sql: harness.sql, transaction },
            } as unknown as ShardDOState,
            {},
        );
        // The follow loop's host, reached the way `ensureFresh` reaches it.
        ({ host } = (shard as unknown as { replica: { host: typeof host } }).replica);
    });

    afterEach(() => {
        harness.close();
    });

    it("applies a whole page through the real writer inside the transaction", async () => {
        expect.assertions(2);

        await expect(host.applyChanges([insert(1, "a"), insert(2, "b")])).resolves.toBe(2);
        expect(harness.raw("SELECT COUNT(*) AS n FROM messages")).toEqual([{ n: 2 }]);
    });

    it("rolls back the rows already applied when a later change in the page throws", async () => {
        expect.assertions(2);

        await expect(host.applyChanges([insert(1, "a"), insert(2, "b"), insert(3, "c", "no_such_table")])).rejects.toThrow(/no_such_table|unknown table/u);
        expect(harness.raw("SELECT COUNT(*) AS n FROM messages")).toEqual([{ n: 0 }]);
    });

    it("queues behind a transaction already open on the DO instead of failing the page", async () => {
        expect.assertions(2);

        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const holding = shard.hold(gate);

        // Let that transaction actually open before the page arrives.
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });

        // The page arrives while that transaction is open.
        const applying = host.applyChanges([insert(1, "a")]);

        release();
        await holding;

        await expect(applying).resolves.toBe(1);
        expect(harness.raw("SELECT COUNT(*) AS n FROM messages")).toEqual([{ n: 1 }]);
    });
});
