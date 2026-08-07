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

const mutationRequest = (mutationId?: string, userId?: string, clientId?: string): Request =>
    new Request("https://shard.internal/rpc", {
        body: JSON.stringify({ args: {}, functionPath: "messages:send" }),
        headers: {
            "content-type": "application/json",
            ...(clientId === undefined ? {} : { "x-lunora-client-id": clientId }),
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

            const first = await shard.fetch(mutationRequest("m-1", "u1"));

            await expect(first.json()).resolves.toEqual({ result: { runs: 1 } });

            const second = await shard.fetch(mutationRequest("m-1", "u1"));

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

            const a = await shard.fetch(mutationRequest("m-1", "u1"));

            await expect(a.json()).resolves.toEqual({ result: { runs: 1 } });

            const b = await shard.fetch(mutationRequest("m-2", "u1"));

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

    it("namespaces ANONYMOUS callers by client id — one cannot suppress another's mutation", async () => {
        expect.assertions(3);

        const database = createSqliteExec();

        try {
            runShardMigrations(database.sql, messagesSchema);

            const shard = new CountingMutationShard(makeState(database), {});

            // An anonymous caller has no server-minted user id. Namespacing them all
            // under one key would let a colliding (reused / guessed) mutation id make
            // client B's write short-circuit to client A's cached result — suppressed
            // without ever running. The per-device client id keeps them apart.
            const a = await shard.fetch(mutationRequest("shared", undefined, "device-a"));

            await expect(a.json()).resolves.toEqual({ result: { runs: 1 } });

            const b = await shard.fetch(mutationRequest("shared", undefined, "device-b"));

            await expect(b.json()).resolves.toEqual({ result: { runs: 2 } });

            // Each still dedups its OWN replay.
            const aReplay = await shard.fetch(mutationRequest("shared", undefined, "device-a"));

            await expect(aReplay.json()).resolves.toEqual({ result: { runs: 1 } });
        } finally {
            database.close();
        }
    });

    it("skips the cache entirely for an anonymous caller with no client id (fails OPEN, never suppresses)", async () => {
        expect.assertions(1);

        const database = createSqliteExec();

        try {
            runShardMigrations(database.sql, messagesSchema);

            const shard = new CountingMutationShard(makeState(database), {});

            // No identity and no client id → no namespace that is safe to share, so
            // the handler re-runs (the pre-idempotency behaviour) rather than risk
            // serving — or suppressing — some other client's mutation.
            await shard.fetch(mutationRequest("shared"));
            await shard.fetch(mutationRequest("shared"));

            expect(shard.runs).toBe(2);
        } finally {
            database.close();
        }
    });
});
