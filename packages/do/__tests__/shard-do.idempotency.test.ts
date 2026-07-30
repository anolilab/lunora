import { runShardMigrations } from "@lunora/shard-engine";
import { describe, expect, it } from "vitest";

import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import messagesSchema from "./_helpers/messages-schema";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * End-to-end mutation-replay dedup over the real dispatch path (`fetch` → read
 * short-circuit → `handleRpc`/`runInTransaction` → in-transaction write),
 * driven through a real SQLite engine. The ctx-db helper tests prove the
 * `__idempotency` round-trip in isolation; this proves the shard wires the
 * read and the write to the SAME source — the `x-lunora-mutation-id` header,
 * stashed into `currentRequestMutationId` — so a replay actually short-circuits
 * instead of re-running the handler.
 */

/**
 * A shard whose handler bumps a counter INSIDE a transaction, so a second
 * execution is observable in `runs`. The dedup must serve the first call's
 * cached `{ runs: 1 }` on a replay without ever reaching this body again.
 */
class CountingMutationShard extends ShardDO {
    public runs = 0;

    public override handleRpc(): Promise<unknown> {
        return this.runInTransaction(() => {
            this.runs += 1;

            return { runs: this.runs };
        });
    }
}

const makeState = (database: ReturnType<typeof createSqliteExec>): ShardDOState => {
    return {
        acceptWebSocket() {},
        getWebSockets() {
            return [];
        },
        storage: { sql: database.sql as unknown as ShardDOState["storage"]["sql"] },
    };
};

const mutationRequest = (mutationId?: string, userId?: string): Request =>
    new Request("https://shard.internal/rpc", {
        body: JSON.stringify({ args: {}, functionPath: "messages:send" }),
        headers: {
            "content-type": "application/json",
            ...(mutationId === undefined ? {} : { "x-lunora-mutation-id": mutationId }),
            ...(userId === undefined ? {} : { "x-lunora-userid": userId }),
        },
        method: "POST",
    });

describe("shardDO mutation-replay dedup (dispatch path)", () => {
    it("runs a mutation once and serves the cached result on replay of the same id", async () => {
        expect.assertions(3);

        const database = createSqliteExec();

        try {
            runShardMigrations(database.sql, messagesSchema);

            const shard = new CountingMutationShard(makeState(database), {});

            const first = await shard.fetch(mutationRequest("m-1"));

            await expect(first.json()).resolves.toEqual({ result: { runs: 1 } });

            const second = await shard.fetch(mutationRequest("m-1"));

            // The replay returns the FIRST result verbatim, not `{ runs: 2 }`,
            // because the handler never ran a second time.
            await expect(second.json()).resolves.toEqual({ result: { runs: 1 } });
            expect(shard.runs).toBe(1);
        } finally {
            database.close();
        }
    });

    it("re-executes every call when no mutation id is supplied (query / legacy client)", async () => {
        expect.assertions(1);

        const database = createSqliteExec();

        try {
            runShardMigrations(database.sql, messagesSchema);

            const shard = new CountingMutationShard(makeState(database), {});

            await shard.fetch(mutationRequest());
            await shard.fetch(mutationRequest());

            expect(shard.runs).toBe(2);
        } finally {
            database.close();
        }
    });

    it("treats distinct mutation ids as distinct writes", async () => {
        expect.assertions(2);

        const database = createSqliteExec();

        try {
            runShardMigrations(database.sql, messagesSchema);

            const shard = new CountingMutationShard(makeState(database), {});

            const a = await shard.fetch(mutationRequest("m-1"));

            await expect(a.json()).resolves.toEqual({ result: { runs: 1 } });

            const b = await shard.fetch(mutationRequest("m-2"));

            await expect(b.json()).resolves.toEqual({ result: { runs: 2 } });
        } finally {
            database.close();
        }
    });

    it("namespaces by identity: the same id under a different user runs independently", async () => {
        expect.assertions(3);

        const database = createSqliteExec();

        try {
            runShardMigrations(database.sql, messagesSchema);

            const shard = new CountingMutationShard(makeState(database), {});

            const u1 = await shard.fetch(mutationRequest("shared", "u1"));

            await expect(u1.json()).resolves.toEqual({ result: { runs: 1 } });

            // Same id, different user → a distinct dedup key → the handler runs.
            const u2 = await shard.fetch(mutationRequest("shared", "u2"));

            await expect(u2.json()).resolves.toEqual({ result: { runs: 2 } });

            // u1 replays its own id → cached, handler not re-run.
            const u1Replay = await shard.fetch(mutationRequest("shared", "u1"));

            await expect(u1Replay.json()).resolves.toEqual({ result: { runs: 1 } });
        } finally {
            database.close();
        }
    });
});
