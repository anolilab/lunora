import { runShardMigrations } from "@lunora/shard-engine";
import { describe, expect, it } from "vitest";

import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import messagesSchema from "./_helpers/messages-schema";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * End-to-end custom-mutator ordering over the real dispatch path. A push that
 * carries a `clientId` + numeric `clientSeq` on a registered mutator is
 * classified against `__client_watermark` BEFORE the handler runs:
 * - `seq &lt;= watermark` → already processed (ack, handler not re-run);
 * - `seq == watermark + 1` → run authoritatively + advance the watermark;
 * - `seq > watermark + 1` → out-of-order halt (409, handler not run).
 *
 * The base `ShardDO` reports no mutators, so the test subclass overrides
 * `isCustomMutator` (the same hook the codegen subclass overrides) and counts
 * authoritative executions so a skip/halt is observable.
 */

class CountingMutatorShard extends ShardDO {
    public runs = 0;

    public override handleRpc(): Promise<unknown> {
        // Mirror the codegen subclass: a mutation commits its replay bookkeeping
        // (dedup row + watermark advance) INSIDE its own transaction.
        return this.runInTransaction(() => {
            this.runs += 1;

            const result = { runs: this.runs };

            this.commitMutationBookkeeping(result);

            return result;
        });
    }

    // eslint-disable-next-line class-methods-use-this -- test stub override: classifies by `functionPath` alone, no instance state.
    protected override isCustomMutator(functionPath: string): boolean {
        return functionPath === "messages:sendMutator";
    }
}

/**
 * Like {@link CountingMutatorShard} but its handler throws until `shouldThrow` is
 * cleared — so the transaction (and the watermark advance committed inside it via
 * `commitMutationBookkeeping`) rolls back together. Proves the watermark never
 * advances for a mutation that didn't commit, so the same seq re-runs on retry.
 */
class AtomicMutatorShard extends ShardDO {
    public shouldThrow = true;

    public override handleRpc(): Promise<unknown> {
        return this.runInTransaction(() => {
            if (this.shouldThrow) {
                throw new Error("mutator boom");
            }

            const result = { ok: true };

            this.commitMutationBookkeeping(result);

            return result;
        });
    }

    // eslint-disable-next-line class-methods-use-this -- test stub override: classifies by `functionPath` alone, no instance state.
    protected override isCustomMutator(functionPath: string): boolean {
        return functionPath === "messages:sendMutator";
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

const push = (clientId: string, seq: number, functionPath = "messages:sendMutator"): Request =>
    new Request("https://shard.internal/rpc", {
        body: JSON.stringify({ args: {}, functionPath }),
        headers: {
            "content-type": "application/json",
            "x-lunora-client-id": clientId,
            "x-lunora-client-seq": String(seq),
        },
        method: "POST",
    });

describe("shardDO custom-mutator watermark (dispatch path)", () => {
    it("runs a mutator in order and advances the watermark", async () => {
        expect.assertions(4);

        const database = createSqliteExec();

        try {
            runShardMigrations(database.sql, messagesSchema, { cdc: true });
            const shard = new CountingMutatorShard(makeState(database), {});

            const first = await shard.fetch(push("c1", 1));

            await expect(first.json()).resolves.toEqual({ lastMutationId: 1, result: { runs: 1 } });

            const second = await shard.fetch(push("c1", 2));

            await expect(second.json()).resolves.toEqual({ lastMutationId: 2, result: { runs: 2 } });
            expect(shard.runs).toBe(2);

            // A third, in-order push keeps advancing.
            const third = await shard.fetch(push("c1", 3));

            await expect(third.json()).resolves.toEqual({ lastMutationId: 3, result: { runs: 3 } });
        } finally {
            database.close();
        }
    });

    it("acks a replayed (already-applied) sequence without re-running the handler", async () => {
        expect.assertions(3);

        const database = createSqliteExec();

        try {
            runShardMigrations(database.sql, messagesSchema, { cdc: true });
            const shard = new CountingMutatorShard(makeState(database), {});

            await shard.fetch(push("c1", 1));
            await shard.fetch(push("c1", 2));

            const replay = await shard.fetch(push("c1", 2));

            // Echoes the current watermark, returns null, never re-runs.
            await expect(replay.json()).resolves.toEqual({ lastMutationId: 2, result: null });
            expect(shard.runs).toBe(2);

            // A replay of an older sequence is likewise an ack.
            const olderReplay = await shard.fetch(push("c1", 1));

            await expect(olderReplay.json()).resolves.toEqual({ lastMutationId: 2, result: null });
        } finally {
            database.close();
        }
    });

    it("halts an out-of-order push with 409 and the expected sequence", async () => {
        expect.assertions(3);

        const database = createSqliteExec();

        try {
            runShardMigrations(database.sql, messagesSchema, { cdc: true });
            const shard = new CountingMutatorShard(makeState(database), {});

            await shard.fetch(push("c1", 1));

            // Watermark is 1; sending seq 3 skips 2 → halt.
            const gap = await shard.fetch(push("c1", 3));

            expect(gap.status).toBe(409);
            await expect(gap.json()).resolves.toEqual({
                error: { code: "OUT_OF_ORDER", expectedMutationId: 2, message: "out-of-order mutation; expected sequence 2" },
            });
            // The handler ran once (seq 1), never for the gap push.
            expect(shard.runs).toBe(1);
        } finally {
            database.close();
        }
    });

    it("isolates watermarks per client", async () => {
        expect.assertions(2);

        const database = createSqliteExec();

        try {
            runShardMigrations(database.sql, messagesSchema, { cdc: true });
            const shard = new CountingMutatorShard(makeState(database), {});

            await shard.fetch(push("c1", 1));
            // A different client starts at its own watermark 0 → seq 1 is "next".
            const other = await shard.fetch(push("c2", 1));

            await expect(other.json()).resolves.toEqual({ lastMutationId: 1, result: { runs: 2 } });
            expect(shard.runs).toBe(2);
        } finally {
            database.close();
        }
    });

    it("leaves ordinary mutations (not custom mutators) on the legacy path", async () => {
        expect.assertions(2);

        const database = createSqliteExec();

        try {
            runShardMigrations(database.sql, messagesSchema, { cdc: true });
            const shard = new CountingMutatorShard(makeState(database), {});

            // Same client headers but a non-mutator path → watermark logic is
            // skipped, the handler runs every time (no dedup without a
            // mutation-id header).
            await shard.fetch(push("c1", 1, "messages:send"));
            await shard.fetch(push("c1", 1, "messages:send"));

            expect(shard.runs).toBe(2);

            // The watermark table was never advanced by the legacy path.
            const next = await shard.fetch(push("c1", 1));

            await expect(next.json()).resolves.toEqual({ lastMutationId: 1, result: { runs: 3 } });
        } finally {
            database.close();
        }
    });

    it("rolls the watermark back with a failed mutator — the same seq re-runs", async () => {
        expect.assertions(3);

        const database = createSqliteExec();

        try {
            runShardMigrations(database.sql, messagesSchema, { cdc: true });
            const shard = new AtomicMutatorShard(makeState(database), {});

            // seq 1's handler throws → the transaction (and the watermark advance
            // committed inside it) rolls back, so the push fails and nothing sticks.
            const failed = await shard.fetch(push("c1", 1));

            expect(failed.status).toBe(500);

            // Retrying seq 1 is still "next" (the watermark never advanced past 0),
            // so it re-runs — never wrongly classified as an already-applied replay.
            shard.shouldThrow = false;
            const retry = await shard.fetch(push("c1", 1));

            await expect(retry.json()).resolves.toEqual({ lastMutationId: 1, result: { ok: true } });

            // And the watermark advanced exactly once: the next in-order push is 2.
            const next = await shard.fetch(push("c1", 2));

            await expect(next.json()).resolves.toEqual({ lastMutationId: 2, result: { ok: true } });
        } finally {
            database.close();
        }
    });
});
