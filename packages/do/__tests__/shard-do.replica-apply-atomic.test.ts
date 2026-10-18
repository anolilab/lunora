import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * A replica applies a pulled changelog page through `runShardApplyCdc`. The page
 * is the unit of progress (the follow cursor only moves past a whole page), so a
 * change that throws halfway must not leave the rows before it behind: they would
 * be visible to reads while the cursor says they were never applied.
 */
class ApplyShard extends ShardDO {
    protected override async runShardApplyCdc(args: { changes: ReadonlyArray<{ id: string }> }): Promise<{ applied: number }> {
        for (const change of args.changes) {
            if (change.id === "poison") {
                throw new Error("change would not replay");
            }

            (this.sql as { exec: (query: string, ...params: unknown[]) => unknown }).exec("INSERT INTO replayed (id) VALUES (?)", change.id);
        }

        return { applied: args.changes.length };
    }
}

describe("shardDO replica page apply", () => {
    let harness: ReturnType<typeof createSqliteExec>;

    beforeEach(() => {
        harness = createSqliteExec();
        harness.raw("CREATE TABLE replayed (id TEXT PRIMARY KEY)");
    });

    afterEach(() => {
        harness.close();
    });

    it("rolls back the rows already applied when a later change in the page throws", async () => {
        expect.assertions(2);

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
        const shard = new ApplyShard(
            { getWebSockets: () => [], id: { name: "tenant-7::replica::weur" }, storage: { sql: harness.sql, transaction } } as unknown as ShardDOState,
            {},
        );

        // The follow loop's host, reached the way `ensureFresh` reaches it.
        const { host } = (shard as unknown as { replica: { host: { applyChanges: (changes: unknown[]) => Promise<number> } } }).replica;

        await expect(host.applyChanges([{ id: "a" }, { id: "b" }, { id: "poison" }])).rejects.toThrow("change would not replay");
        expect(harness.raw("SELECT id FROM replayed")).toStrictEqual([]);
    });
});
