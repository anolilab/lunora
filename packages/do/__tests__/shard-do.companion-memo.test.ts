import type { SqlExec } from "@lunora/shard-engine";
import { runShardMigrations } from "@lunora/shard-engine";
import { describe, expect, it } from "vitest";

import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import messagesSchema from "./_helpers/messages-schema";
import createSqliteExec from "./_helpers/node-sqlite";

/** Runs a transaction outside the RPC path, the way a reactor does, and exposes the shard-scoped memo. */
class MemoShard extends ShardDO {
    // eslint-disable-next-line class-methods-use-this -- the abstract dispatch is unused here; the transaction runs directly
    public override async handleRpc(): Promise<unknown> {
        return undefined;
    }

    public memo(): Set<string> {
        return this.ctxDbTuning().companionMemo.verified;
    }

    public async failingTransaction(): Promise<void> {
        await this.runInTransaction(() => {
            // A companion verified inside the transaction, then rolled back with it.
            this.memo().add("messages:byChannel");

            throw new Error("handler failed");
        });
    }
}

const makeState = (sql: SqlExec): ShardDOState => {
    return {
        acceptWebSocket() {},
        getWebSockets() {
            return [];
        },
        storage: { sql: sql as unknown as ShardDOState["storage"]["sql"] },
    };
};

describe("shardDO companion memo", () => {
    it("forgets companions verified by a transaction that rolled back outside the RPC path", async () => {
        expect.assertions(2);

        const database = createSqliteExec();

        try {
            runShardMigrations(database.sql, messagesSchema);

            const shard = new MemoShard(makeState(database.sql), {});

            await expect(shard.failingTransaction()).rejects.toThrow("handler failed");
            expect(shard.memo().size).toBe(0);
        } finally {
            database.close();
        }
    });
});
