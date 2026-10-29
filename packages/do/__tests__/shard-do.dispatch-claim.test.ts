import { readRequestLog } from "@lunora/observability";
import { runShardMigrations } from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IN_FLIGHT_CLAIM_CEILING_MS, InFlightClaims } from "../src/in-flight-claims";
import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import messagesSchema from "./_helpers/messages-schema";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * The receiver half of the at-least-once scheduled-dispatch guarantee (#803),
 * driven through `ShardDO.fetch` on the UNGATED (non-mutation) path where
 * nothing but the in-flight claim serialises two deliveries of one id. The
 * claim's own rules (ceiling, owner-checked release) are unit-tested in
 * `in-flight-claims.test.ts`; this file pins how the dispatch path uses them.
 */

/**
 * An action shard whose handler parks until released, standing in for a long
 * outbound call.
 *
 * Only runs with an index at or below {@link ParkingActionShard.parkUpToRun}
 * park. That is deliberate: if EVERY run parked, an unfixed shard's second
 * (concurrent) run would park too and the test would fail as a timeout instead
 * of as a run COUNT — which is the assertion that actually distinguishes
 * "declined" from "ran alongside".
 */
class ParkingActionShard extends ShardDO {
    public runs = 0;

    public parkUpToRun = 0;

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

    /** Test-only view of the private error counter the error branch bumps. */
    public get errorCount(): number {
        return (this as unknown as { metrics: { errors: number } }).metrics.errors;
    }

    /** Test-only view of the private in-memory log buffer the error branch appends to. */
    public get logCount(): number {
        return (this as unknown as { logs: { size: number } }).logs.size;
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

const rpc = (headers: Record<string, string>): Request =>
    new Request("https://shard.internal/rpc", {
        body: JSON.stringify({ args: {}, functionPath: "messages:slowAction" }),
        headers: { "content-type": "application/json", ...headers },
        method: "POST",
    });

/** The shape `dispatchToShard` sends for a scheduled action: the record id as the dedup id, under the `"system:"` namespace. */
const scheduledDispatch = (recordId: string): Request => rpc({ "x-lunora-mutation-id": recordId, "x-lunora-system": "1" });

/** Yield to the timer queue so a just-started dispatch reaches its park. */
const settle = async (): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, 0);
    });

describe("shardDO in-flight dispatch claim (ungated path)", () => {
    let database: ReturnType<typeof createSqliteExec>;
    let shard: ParkingActionShard;

    beforeEach(() => {
        database = createSqliteExec();
        runShardMigrations(database.sql, messagesSchema);
        shard = new ParkingActionShard(makeState(database), {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        database.close();
    });

    it("never started: the handler runs", async () => {
        expect.assertions(2);

        const response = await shard.fetch(scheduledDispatch("job-1"));

        expect(response.status).toBe(200);
        expect(shard.runs).toBe(1);
    });

    it("live claim: the second dispatch is declined and the handler does NOT run twice", async () => {
        expect.assertions(6);

        shard.parkUpToRun = 1;

        // The first attempt: still running when its dispatcher dies.
        const first = shard.fetch(scheduledDispatch("job-1"));

        await settle();

        expect(shard.runs).toBe(1);

        // The re-delivery the expired lease mints.
        const second = await shard.fetch(scheduledDispatch("job-1"));

        // COUNT, not presence: the whole defect is a SECOND run.
        expect(shard.runs).toBe(1);
        expect(second.status).toBe(409);
        await expect(second.json()).resolves.toMatchObject({ error: { code: "DISPATCH_IN_PROGRESS" } });
        // The marker a caller keys on: only the claim path sets it, so a handler
        // that throws the same code cannot pass for a decline.
        expect(second.headers.get("x-lunora-dispatch-declined")).toBe("1");

        shard.release();
        await first;

        expect(shard.runs).toBe(1);
    });

    it("a decline is not a failure: no error metric, no error reqlog row, no error log entry", async () => {
        expect.assertions(2);

        shard.parkUpToRun = 1;

        const first = shard.fetch(scheduledDispatch("job-1"));

        await settle();

        const errorsBefore = shard.errorCount;
        const logsBefore = shard.logCount;
        const declined = await shard.fetch(scheduledDispatch("job-1"));

        // Counted, not probed for, and all three in one assertion so a
        // regression reports every sink it reached: the defect is an EXPECTED
        // re-delivery landing in the error-rate advisors and studio's Issues
        // view as a failed action.
        expect(declined.status).toBe(409);
        expect({
            errorLogEntries: shard.logCount - logsBefore,
            errorMetric: shard.errorCount - errorsBefore,
            errorReqlogRows: readRequestLog(database.sql).filter((row) => row.outcome === "error").length,
        }).toStrictEqual({ errorLogEntries: 0, errorMetric: 0, errorReqlogRows: 0 });

        shard.release();
        await first;
    });

    it("live claim: the decline is temporary — the retry is served the first attempt's result", async () => {
        expect.assertions(4);

        shard.parkUpToRun = 1;

        const first = shard.fetch(scheduledDispatch("job-1"));

        await settle();

        const declined = await shard.fetch(scheduledDispatch("job-1"));

        // NOT 2xx: `SchedulerDO.dispatch()` would otherwise clear the record and
        // the job would never run again if the first attempt then died.
        expect(declined.ok).toBe(false);

        shard.release();
        await first;

        const retry = await shard.fetch(scheduledDispatch("job-1"));

        expect(retry.ok).toBe(true);
        await expect(retry.json()).resolves.toEqual({ result: { ran: "messages:slowAction", run: 1 } });
        expect(shard.runs).toBe(1);
    });

    it("a claim older than the ceiling is stale: a live instance whose handler never settles lets the next delivery run", async () => {
        expect.assertions(3);

        const start = Date.now();
        const now = vi.spyOn(Date, "now").mockReturnValue(start);

        // Parked and never released: a handler awaiting an outbound call with no
        // timeout. The isolate stays alive, so its `finally` never runs.
        shard.parkUpToRun = 1;
        // eslint-disable-next-line @typescript-eslint/no-floating-promises -- the hung attempt is the fixture; awaiting it would hang the test
        shard.fetch(scheduledDispatch("job-1"));
        await settle();

        now.mockReturnValue(start + IN_FLIGHT_CLAIM_CEILING_MS - 1);

        const beforeCeiling = await shard.fetch(scheduledDispatch("job-1"));

        now.mockReturnValue(start + IN_FLIGHT_CLAIM_CEILING_MS);

        const atCeiling = await shard.fetch(scheduledDispatch("job-1"));

        expect(beforeCeiling.status).toBe(409);
        expect(atCeiling.status).toBe(200);
        expect(shard.runs).toBe(2);
    });

    it("stale claim: a fresh instance over the same storage takes over and the handler runs", async () => {
        expect.assertions(2);

        // Never released: this instance is abandoned mid-handler, the way an
        // evicted isolate's in-flight work simply stops existing.
        shard.parkUpToRun = 1;
        // eslint-disable-next-line @typescript-eslint/no-floating-promises -- the abandoned attempt is the fixture; awaiting it would hang the test
        shard.fetch(scheduledDispatch("job-1"));
        await settle();

        const successor = new ParkingActionShard(makeState(database), {});
        const response = await successor.fetch(scheduledDispatch("job-1"));

        expect(response.ok).toBe(true);
        expect(successor.runs).toBe(1);
    });

    it("releases the claim only AFTER the dedup row is written, so a re-delivery never finds neither", async () => {
        expect.assertions(2);

        // Released first, a re-delivery landing between the release and the row
        // write would find neither a claim nor a result and run the handler a
        // second time. So at the instant of release the row must already exist.
        const rowPresentAtRelease: boolean[] = [];
        const readRow = (): unknown => (shard as unknown as { readIdempotentResult: (id: string) => unknown }).readIdempotentResult("job-1");
        // Records its own observation first, then restores and delegates, so the
        // real release runs and nothing reads the spy's calls after the restore.
        const release = vi.spyOn(InFlightClaims.prototype, "release").mockImplementation(function releaseAfterCheck(this: InFlightClaims, claim) {
            rowPresentAtRelease.push(readRow() !== undefined);
            release.mockRestore();
            this.release(claim);
        });

        await shard.fetch(scheduledDispatch("job-1"));

        expect(rowPresentAtRelease).toStrictEqual([true]);
        expect(shard.runs).toBe(1);
    });

    it("fails open: a request with no dedup namespace takes no claim and is never declined", async () => {
        expect.assertions(3);

        shard.parkUpToRun = 1;

        // No `x-lunora-system`, no user, no client id — `idempotencyNamespace()`
        // is `undefined`, so there is nothing to dedup against and nothing to claim.
        const anonymous = (): Request => rpc({ "x-lunora-mutation-id": "job-1" });

        const first = shard.fetch(anonymous());

        await settle();

        const second = await shard.fetch(anonymous());

        expect(second.status).toBe(200);

        shard.release();

        const firstResponse = await first;

        expect(firstResponse.status).toBe(200);
        expect(shard.runs).toBe(2);
    });

    it("completed: the cached result is returned and the handler does not re-run", async () => {
        expect.assertions(3);

        await shard.fetch(scheduledDispatch("job-1"));

        const replay = await shard.fetch(scheduledDispatch("job-1"));

        expect(replay.status).toBe(200);
        await expect(replay.json()).resolves.toEqual({ result: { ran: "messages:slowAction", run: 1 } });
        expect(shard.runs).toBe(1);
    });

    it("a handler that THROWS leaves no claim, so the next delivery runs it (at-least-once preserved)", async () => {
        expect.assertions(2);

        class ThrowingShard extends ParkingActionShard {
            public override async handleRpc(functionPath: string): Promise<unknown> {
                this.runs += 1;

                await Promise.resolve();

                throw new Error(`boom ${functionPath}`);
            }
        }

        const throwing = new ThrowingShard(makeState(database), {});
        const first = await throwing.fetch(scheduledDispatch("job-1"));

        expect(first.status).toBe(500);

        await throwing.fetch(scheduledDispatch("job-1"));

        expect(throwing.runs).toBe(2);
    });

    it("declines only the SAME id — a different id dispatched alongside still runs", async () => {
        expect.assertions(2);

        shard.parkUpToRun = 1;

        const first = shard.fetch(scheduledDispatch("job-1"));

        await settle();

        const sibling = await shard.fetch(scheduledDispatch("job-2"));

        expect(sibling.ok).toBe(true);

        shard.release();
        await first;

        expect(shard.runs).toBe(2);
    });

    it("declines only within a dedup namespace — the same id under another identity still runs", async () => {
        expect.assertions(2);

        shard.parkUpToRun = 1;

        const asUser = (userId: string): Request => rpc({ "x-lunora-mutation-id": "shared", "x-lunora-userid": userId });

        const first = shard.fetch(asUser("u1"));

        await settle();

        const other = await shard.fetch(asUser("u2"));

        expect(other.ok).toBe(true);

        shard.release();
        await first;

        expect(shard.runs).toBe(2);
    });
});
