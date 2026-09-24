import { runShardMigrations } from "@lunora/shard-engine";
import { describe, expect, it } from "vitest";

import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import messagesSchema from "./_helpers/messages-schema";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * The receiver half of the at-least-once scheduled-dispatch guarantee (#803).
 *
 * `@lunora/scheduler`'s dispatch lease (#809) stops a SUCCESSOR SchedulerDO from
 * re-firing a record while the instance that claimed it is presumably still
 * alive. What no lease length can see is the other side of that fetch: a
 * receiver still executing after the dispatcher's side is gone. These tests
 * drive the four states a second delivery can land in, at the shard, on the
 * UNGATED (non-mutation) path where nothing else serialises the two.
 *
 * Staleness here is not a clock. A Durable Object is single-instance, so a claim
 * that is not held by the CURRENT instance is a claim whose writer no longer
 * exists — the "stale claim" case is therefore literally "a fresh instance over
 * the same storage", and it must run the handler.
 */

/**
 * An action shard whose handler parks until released, standing in for a long
 * outbound call.
 *
 * Only the first {@link ParkingActionShard.parkUpToRun} runs park. That is
 * deliberate: if EVERY run parked, an unfixed shard's second (concurrent) run
 * would park too and the test would fail as a 30s timeout instead of as a run
 * COUNT — which is the assertion that actually distinguishes "declined" from
 * "ran alongside".
 */
class ParkingActionShard extends ShardDO {
    public runs = 0;

    /** Runs with an index at or below this park until {@link ParkingActionShard.release}. */
    public parkUpToRun = 0;

    /** Resolved by {@link ParkingActionShard.release}; every parked handler awaits it. */
    private readonly hold: Promise<void>;

    private releaseHold: (() => void) | undefined;

    public constructor(state: ShardDOState, env: unknown) {
        super(state, env);
        this.hold = new Promise<void>((resolve) => {
            this.releaseHold = resolve;
        });
    }

    /** Let every parked handler on this instance finish. */
    public release(): void {
        this.releaseHold?.();
    }

    public override async handleRpc(functionPath: string): Promise<unknown> {
        this.runs += 1;

        const run = this.runs;

        if (run <= this.parkUpToRun) {
            await this.hold;
        }

        return { ran: functionPath, run };
    }

    // eslint-disable-next-line class-methods-use-this -- mirrors the codegen override: only `messages:send` is a mutation, so every path below is ungated
    protected override isMutationFunction(functionPath: string): boolean {
        return functionPath === "messages:send";
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

/** The shape `dispatchToShard` sends for a scheduled action: the record id as the dedup id, under the `"system:"` namespace. */
const scheduledDispatch = (recordId: string): Request =>
    new Request("https://shard.internal/rpc", {
        body: JSON.stringify({ args: {}, functionPath: "messages:slowAction" }),
        headers: {
            "content-type": "application/json",
            "x-lunora-mutation-id": recordId,
            "x-lunora-system": "1",
        },
        method: "POST",
    });

/** Yield to the timer queue so a just-started dispatch reaches its park. */
const settle = async (): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, 0);
    });

describe("shardDO in-flight dispatch claim (ungated path)", () => {
    it("never started: the handler runs", async () => {
        expect.assertions(2);

        const database = createSqliteExec();

        try {
            runShardMigrations(database.sql, messagesSchema);

            const shard = new ParkingActionShard(makeState(database), {});
            const response = await shard.fetch(scheduledDispatch("job-1"));

            expect(response.status).toBe(200);
            expect(shard.runs).toBe(1);
        } finally {
            database.close();
        }
    });

    it("live claim: the second dispatch is declined and the handler does NOT run twice", async () => {
        expect.assertions(5);

        const database = createSqliteExec();

        try {
            runShardMigrations(database.sql, messagesSchema);

            const shard = new ParkingActionShard(makeState(database), {});

            shard.parkUpToRun = 1;

            // The first attempt: still running when its dispatcher dies.
            const first = shard.fetch(scheduledDispatch("job-1"));

            await settle();

            expect(shard.runs).toBe(1);

            // The re-delivery the expired lease mints.
            const second = await shard.fetch(scheduledDispatch("job-1"));

            // COUNT, not presence: the whole defect is a SECOND run, so
            // asserting "it ran" would pass over the bug.
            expect(shard.runs).toBe(1);
            expect(second.status).toBe(409);
            await expect(second.json()).resolves.toMatchObject({ error: { code: "DISPATCH_IN_PROGRESS" } });

            shard.release();
            await first;

            expect(shard.runs).toBe(1);
        } finally {
            database.close();
        }
    });

    it("live claim: the decline is temporary — the retry is served the first attempt's result", async () => {
        expect.assertions(4);

        const database = createSqliteExec();

        try {
            runShardMigrations(database.sql, messagesSchema);

            const shard = new ParkingActionShard(makeState(database), {});

            shard.parkUpToRun = 1;

            const first = shard.fetch(scheduledDispatch("job-1"));

            await settle();

            const declined = await shard.fetch(scheduledDispatch("job-1"));

            // NOT 2xx: `SchedulerDO.dispatch()` returns `response.ok`, so a 2xx
            // here would have `drainRecord` clear the record's `id:` header and
            // the job would never run again if the first attempt then died.
            expect(declined.ok).toBe(false);

            shard.release();
            await first;

            // The scheduler's `recordRetry` re-fires the same record id. Now the
            // first attempt has settled, so the dedup row serves it.
            const retry = await shard.fetch(scheduledDispatch("job-1"));

            expect(retry.ok).toBe(true);
            await expect(retry.json()).resolves.toEqual({ result: { ran: "messages:slowAction", run: 1 } });
            expect(shard.runs).toBe(1);
        } finally {
            database.close();
        }
    });

    it("stale claim: a fresh instance over the same storage takes over and the handler runs", async () => {
        expect.assertions(3);

        const database = createSqliteExec();

        try {
            runShardMigrations(database.sql, messagesSchema);

            const lost = new ParkingActionShard(makeState(database), {});

            // Never released: this instance is abandoned mid-handler, the way an
            // evicted isolate's in-flight work simply stops existing.
            lost.parkUpToRun = 1;

            // Deliberately unawaited: this attempt never finishes.
            // eslint-disable-next-line @typescript-eslint/no-floating-promises -- the abandoned attempt is the fixture; awaiting it would hang the test
            lost.fetch(scheduledDispatch("job-1"));
            await settle();

            expect(lost.runs).toBe(1);

            // The successor. Nothing durable says "claimed", because nothing
            // durable should: the isolate that held the claim is gone, so its
            // handler is gone with it and the job must run.
            const successor = new ParkingActionShard(makeState(database), {});
            const response = await successor.fetch(scheduledDispatch("job-1"));

            expect(response.ok).toBe(true);
            expect(successor.runs).toBe(1);
        } finally {
            database.close();
        }
    });

    it("completed: the cached result is returned and the handler does not re-run", async () => {
        expect.assertions(3);

        const database = createSqliteExec();

        try {
            runShardMigrations(database.sql, messagesSchema);

            const shard = new ParkingActionShard(makeState(database), {});

            await shard.fetch(scheduledDispatch("job-1"));

            const replay = await shard.fetch(scheduledDispatch("job-1"));

            expect(replay.status).toBe(200);
            await expect(replay.json()).resolves.toEqual({ result: { ran: "messages:slowAction", run: 1 } });
            expect(shard.runs).toBe(1);
        } finally {
            database.close();
        }
    });

    it("a handler that THROWS leaves no claim, so the next delivery runs it (at-least-once preserved)", async () => {
        expect.assertions(2);

        const database = createSqliteExec();

        try {
            runShardMigrations(database.sql, messagesSchema);

            class ThrowingShard extends ParkingActionShard {
                public override async handleRpc(functionPath: string): Promise<unknown> {
                    this.runs += 1;

                    await Promise.resolve();

                    throw new Error(`boom ${functionPath}`);
                }
            }

            const shard = new ThrowingShard(makeState(database), {});

            const first = await shard.fetch(scheduledDispatch("job-1"));

            expect(first.status).toBe(500);

            await shard.fetch(scheduledDispatch("job-1"));

            expect(shard.runs).toBe(2);
        } finally {
            database.close();
        }
    });

    it("declines only the SAME id — a different id dispatched alongside still runs", async () => {
        expect.assertions(2);

        const database = createSqliteExec();

        try {
            runShardMigrations(database.sql, messagesSchema);

            const shard = new ParkingActionShard(makeState(database), {});

            shard.parkUpToRun = 1;

            const first = shard.fetch(scheduledDispatch("job-1"));

            await settle();

            const sibling = await shard.fetch(scheduledDispatch("job-2"));

            expect(sibling.ok).toBe(true);

            shard.release();
            await first;

            expect(shard.runs).toBe(2);
        } finally {
            database.close();
        }
    });

    it("declines only within a dedup namespace — the same id under another identity still runs", async () => {
        expect.assertions(2);

        const database = createSqliteExec();

        try {
            runShardMigrations(database.sql, messagesSchema);

            const shard = new ParkingActionShard(makeState(database), {});

            shard.parkUpToRun = 1;

            const asUser = (userId: string): Request =>
                new Request("https://shard.internal/rpc", {
                    body: JSON.stringify({ args: {}, functionPath: "messages:slowAction" }),
                    headers: { "content-type": "application/json", "x-lunora-mutation-id": "shared", "x-lunora-userid": userId },
                    method: "POST",
                });

            const first = shard.fetch(asUser("u1"));

            await settle();

            const other = await shard.fetch(asUser("u2"));

            expect(other.ok).toBe(true);

            shard.release();
            await first;

            expect(shard.runs).toBe(2);
        } finally {
            database.close();
        }
    });
});
