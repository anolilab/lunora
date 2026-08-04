import { readClientWatermark, runShardMigrations } from "@lunora/shard-engine";
import { describe, expect, it } from "vitest";

import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import messagesSchema from "./_helpers/messages-schema";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * Characterization tests for the custom-mutator watermark self-healing contract.
 *
 * Core invariants exercised:
 *
 * 1. A handler that throws does NOT advance `__client_watermark` — the sequence is not consumed; the retry re-runs.
 * 2. A succeeded write is idempotent: a re-sent push with seq <= watermark is ack'd without re-running the handler.
 * 3. Out-of-order pushes (seq > watermark + 1) are halted before the handler runs.
 * 4. Advance-gap self-heal: if the dedup row committed but the watermark is stale, a retry re-advances via the idempotency cache.
 *
 * These tests drive the full dispatch path through a real in-memory SQLite engine.
 */

/**
 * A custom-mutator shard that counts handler invocations and fails until
 * `failsRemaining` reaches zero. Failure rolls back the entire transaction
 * (including any `commitMutationBookkeeping` that would have advanced the watermark),
 * so a failed push leaves the watermark unchanged.
 */
class FailThenSucceedShard extends ShardDO {
    public failsRemaining = 0;
    public runs = 0;

    public override handleRpc(): Promise<unknown> {
        return this.runInTransaction(() => {
            this.runs += 1;

            if (this.failsRemaining > 0) {
                this.failsRemaining -= 1;
                throw new Error("handler boom");
            }

            const result = { runs: this.runs };

            // Commits the dedup row + watermark advance atomically with the writes.
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

/**
 * Build a push request carrying the watermark headers. Pass `mutationId` to
 * also include `x-lunora-mutation-id` so the dispatch path writes a dedup row
 * (needed for the advance-gap idempotency self-heal test).
 */
const push = (clientId: string, seq: number, opts: { functionPath?: string; mutationId?: string } = {}): Request =>
    new Request("https://shard.internal/rpc", {
        body: JSON.stringify({ args: {}, functionPath: opts.functionPath ?? "messages:sendMutator" }),
        headers: {
            "content-type": "application/json",
            "x-lunora-client-id": clientId,
            "x-lunora-client-seq": String(seq),
            ...(opts.mutationId === undefined ? {} : { "x-lunora-mutation-id": opts.mutationId }),
        },
        method: "POST",
    });

describe("shardDO custom-mutator watermark self-healing", () => {
    it("case 1: handler throws — watermark unchanged, sequence not consumed", async () => {
        expect.assertions(4);

        const database = createSqliteExec();

        try {
            runShardMigrations(database.sql, messagesSchema, { cdc: true });

            const shard = new FailThenSucceedShard(makeState(database), {});

            shard.failsRemaining = 1;

            const failed = await shard.fetch(push("c1", 1));

            // Handler ran once (and threw).
            expect(shard.runs).toBe(1);
            // Response is an error — the push was not applied.
            expect(failed.status).toBe(500);
            // Watermark stays at 0 because the transaction rolled back.
            expect(readClientWatermark(database.sql, "", "c1")).toBe(0);
            // failsRemaining was decremented inside the rolled-back transaction, but
            // since it is a JavaScript field on `this` (not a SQL value), it has been
            // decremented — reset it explicitly to show the pre-condition for the retry.
            expect(shard.failsRemaining).toBe(0);
        } finally {
            database.close();
        }
    });

    it("case 2: retry after failure re-runs handler and heals the watermark", async () => {
        expect.assertions(5);

        const database = createSqliteExec();

        try {
            runShardMigrations(database.sql, messagesSchema, { cdc: true });

            const shard = new FailThenSucceedShard(makeState(database), {});

            // First push: handler throws, watermark stays at 0.
            shard.failsRemaining = 1;
            const failed = await shard.fetch(push("c1", 1));

            expect(failed.status).toBe(500);
            expect(readClientWatermark(database.sql, "", "c1")).toBe(0);

            // Retry same seq: failsRemaining is now 0, so the handler succeeds.
            const retry = await shard.fetch(push("c1", 1));

            await expect(retry.json()).resolves.toEqual({ lastMutationId: 1, result: { runs: 2 } });
            // Watermark advanced exactly once: to seq 1.
            expect(readClientWatermark(database.sql, "", "c1")).toBe(1);

            // Next in-order sequence is 2.
            const next = await shard.fetch(push("c1", 2));

            await expect(next.json()).resolves.toEqual({ lastMutationId: 2, result: { runs: 3 } });
        } finally {
            database.close();
        }
    });

    it("case 3: replay of a succeeded write is ack'd without re-running the handler", async () => {
        expect.assertions(5);

        const database = createSqliteExec();

        try {
            runShardMigrations(database.sql, messagesSchema, { cdc: true });

            const shard = new FailThenSucceedShard(makeState(database), {});

            // seq=1 succeeds; watermark advances to 1.
            const first = await shard.fetch(push("c1", 1));

            await expect(first.json()).resolves.toEqual({ lastMutationId: 1, result: { runs: 1 } });
            expect(readClientWatermark(database.sql, "", "c1")).toBe(1);

            // Re-send seq=1: watermark=1, seq=1 ≤ watermark → "already" short-circuit.
            const replay = await shard.fetch(push("c1", 1));

            // Ack echoes the current watermark; result is null (the on-the-wire sentinel: no fresh handler result).
            await expect(replay.json()).resolves.toEqual({ lastMutationId: 1, result: null });
            // Handler ran exactly once — the replay short-circuited before `handleRpc`.
            expect(shard.runs).toBe(1);
            // Watermark is still 1; not advanced by the ack path.
            expect(readClientWatermark(database.sql, "", "c1")).toBe(1);
        } finally {
            database.close();
        }
    });

    it("case 4: out-of-order push halted before handler runs, watermark unchanged", async () => {
        expect.assertions(5);

        const database = createSqliteExec();

        try {
            runShardMigrations(database.sql, messagesSchema, { cdc: true });

            const shard = new FailThenSucceedShard(makeState(database), {});

            // Establish watermark at 1.
            await shard.fetch(push("c1", 1));

            expect(readClientWatermark(database.sql, "", "c1")).toBe(1);
            expect(shard.runs).toBe(1);

            // seq=3 skips seq=2 → gap → OUT_OF_ORDER halt.
            const gap = await shard.fetch(push("c1", 3));

            expect(gap.status).toBe(409);

            const body = await gap.json();

            expect((body as { error: { code: string; expectedMutationId: number } }).error).toMatchObject({
                code: "OUT_OF_ORDER",
                expectedMutationId: 2,
            });
            // Handler never ran for the gap push; watermark still at 1.
            expect(shard.runs).toBe(1);
        } finally {
            database.close();
        }
    });

    it("case 5: multiple sequential failures do not consume the sequence; success self-heals", async () => {
        expect.assertions(8);

        const database = createSqliteExec();

        try {
            runShardMigrations(database.sql, messagesSchema, { cdc: true });

            const shard = new FailThenSucceedShard(makeState(database), {});

            // Attempt 1: fail.
            shard.failsRemaining = 1;
            const attempt1 = await shard.fetch(push("c1", 1));

            expect(attempt1.status).toBe(500);
            expect(readClientWatermark(database.sql, "", "c1")).toBe(0);
            expect(shard.runs).toBe(1);

            // Attempt 2: fail again.
            shard.failsRemaining = 1;
            const attempt2 = await shard.fetch(push("c1", 1));

            expect(attempt2.status).toBe(500);
            expect(readClientWatermark(database.sql, "", "c1")).toBe(0);
            expect(shard.runs).toBe(2);

            // Attempt 3: succeed — watermark heals to 1 and seq 2 becomes next.
            const attempt3 = await shard.fetch(push("c1", 1));

            await expect(attempt3.json()).resolves.toEqual({ lastMutationId: 1, result: { runs: 3 } });
            expect(readClientWatermark(database.sql, "", "c1")).toBe(1);
        } finally {
            database.close();
        }
    });

    it("case 6: idempotency self-heal — fail once, succeed on retry, replay is exactly-once", async () => {
        expect.assertions(11);

        const database = createSqliteExec();

        try {
            runShardMigrations(database.sql, messagesSchema, { cdc: true });

            const shard = new FailThenSucceedShard(makeState(database), {});

            // Step A: push seq=1 fails → watermark=0, dedup row absent.
            shard.failsRemaining = 1;
            const fail1 = await shard.fetch(push("c1", 1, { mutationId: "m1" }));

            expect(fail1.status).toBe(500);
            expect(readClientWatermark(database.sql, "", "c1")).toBe(0);
            expect(shard.runs).toBe(1);

            // Step B: retry seq=1 succeeds → watermark=1, dedup row committed.
            const ok1 = await shard.fetch(push("c1", 1, { mutationId: "m1" }));

            await expect(ok1.json()).resolves.toEqual({ lastMutationId: 1, result: { runs: 2 } });
            expect(readClientWatermark(database.sql, "", "c1")).toBe(1);
            expect(shard.runs).toBe(2);

            // Step C: replay seq=1 (same mutation-id) — watermark ack short-circuits.
            // seq=1 <= watermark=1 → "already" → result: null ack (on-the-wire sentinel), handler not re-run.
            const replay1 = await shard.fetch(push("c1", 1, { mutationId: "m1" }));

            await expect(replay1.json()).resolves.toEqual({ lastMutationId: 1, result: null });
            expect(shard.runs).toBe(2);
            // Watermark exactly at 1: no stuck watermark, no over-advance.
            expect(readClientWatermark(database.sql, "", "c1")).toBe(1);

            // Step D: seq=2 (next in order) runs cleanly after the self-heal.
            const ok2 = await shard.fetch(push("c1", 2, { mutationId: "m2" }));

            await expect(ok2.json()).resolves.toEqual({ lastMutationId: 2, result: { runs: 3 } });
            expect(readClientWatermark(database.sql, "", "c1")).toBe(2);
        } finally {
            database.close();
        }
    });

    it("advance-gap self-heal: stale watermark re-advanced via idempotency cache on retry", async () => {
        expect.assertions(7);

        const database = createSqliteExec();

        try {
            runShardMigrations(database.sql, messagesSchema, { cdc: true });

            const shard = new FailThenSucceedShard(makeState(database), {});

            // First push: seq=1 with a mutation-id so the dedup row is committed.
            const first = await shard.fetch(push("c1", 1, { mutationId: "m-gap-1" }));

            await expect(first.json()).resolves.toEqual({ lastMutationId: 1, result: { runs: 1 } });
            expect(readClientWatermark(database.sql, "", "c1")).toBe(1);
            expect(shard.runs).toBe(1);

            // Simulate the advance-gap crash window: the dedup row committed but the
            // watermark row is stale. Reset the watermark back to 0 directly so the
            // next classification sees seq=1 as "next" again.
            database.raw("UPDATE __client_watermark SET last_mutation_id = 0 WHERE identity = '' AND client_id = ?", "c1");

            expect(readClientWatermark(database.sql, "", "c1")).toBe(0);

            // Retry the same push (same mutation-id, same seq):
            //   - classifyClientMutation: watermark=0, seq=1 → "next"
            //   - rejectNonNextMutation: "next" → pass-through
            //   - readIdempotentResult("m-gap-1"): finds the committed dedup row
            //   - respondFromIdempotencyCache: mutatorClass.kind="next" → re-advances watermark
            //   - handler NOT re-run
            const gap = await shard.fetch(push("c1", 1, { mutationId: "m-gap-1" }));

            await expect(gap.json()).resolves.toEqual({ lastMutationId: 1, result: { runs: 1 } });
            // Watermark self-healed to 1 without re-running the handler.
            expect(readClientWatermark(database.sql, "", "c1")).toBe(1);
            expect(shard.runs).toBe(1);
        } finally {
            database.close();
        }
    });
});
