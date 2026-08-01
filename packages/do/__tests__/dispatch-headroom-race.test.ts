/**
 * Plan 207 step 3: the per-transaction meter used to live entirely in the
 * shared `this.currentTransactionHeadroom` instance field — minted at the top
 * of `handleFetchCloudflare`'s `/rpc` dispatch, read back (via
 * `transactionHeadroom()`) when `buildCtx` builds the handler's `ctx.db`, and
 * cleared unconditionally in `finally`. Two overlapping dispatches on one DO
 * race that field: if dispatch B finishes (and clears the field) while
 * dispatch A is still parked mid-handler, A's LATER `ctx.db` writes would read
 * the field AFTER B's clear and run completely unmetered.
 *
 * The fix value-threads each dispatch's tracker as an explicit parameter
 * through `handleRpc` into `buildCtx`, so a dispatch's own metering never
 * depends on the shared field still holding the right value by the time its
 * handler actually runs. This test drives exactly that interleaving and
 * proves dispatch A (the slow one) is STILL metered against its own tracker
 * after dispatch B has completed and cleared the shared field out from under
 * it — the failure mode this fix exists to close.
 */
import type { SchemaLike, SqlExec, TransactionHeadroomTracker } from "@lunora/shard-engine";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "@lunora/shard-engine";
import { beforeEach, describe, expect, it } from "vitest";

import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import createSqliteExec from "./_helpers/node-sqlite";

const schema: SchemaLike = {
    tables: {
        items: {
            indexes: [],
            shape: { value: { kind: "string" } },
        },
    },
};

/** A resolve-from-outside deferred, used to pin down the exact interleaving order. */
const deferred = (): { promise: Promise<void>; resolve: () => void } => {
    let resolveFn!: () => void;
    const promise = new Promise<void>((resolve) => {
        resolveFn = resolve;
    });

    return { promise, resolve: resolveFn };
};

/**
 * `"slow"` mints its OWN tracker (via `handleRpc`'s new `headroom` parameter,
 * value-threaded from `handleFetchCloudflare`), signals `started`, then BLOCKS
 * on `gate` before writing — giving the test a window to run a second,
 * complete dispatch (`"fast"`) in between. `"fast"` writes immediately and
 * returns, letting its own dispatch's `finally` clear the shared
 * `currentTransactionHeadroom` field while `"slow"` is still parked.
 */
class RaceShard extends ShardDO {
    public started = deferred();

    public gate = deferred();

    public override async handleRpc(functionPath: string, args: Record<string, unknown>, headroom?: TransactionHeadroomTracker): Promise<unknown> {
        const writer = createShardContextDatabase({
            headroom,
            schema,
            sql: this.sql as SqlExec,
        });

        if (functionPath === "slow") {
            this.started.resolve();
            await this.gate.promise;

            // Two writes under a `maxWrittenRows: 1` ceiling (see
            // `transactionLimits` below). If this dispatch's OWN tracker
            // survived the race, the second write throws
            // TRANSACTION_LIMIT_EXCEEDED. If it were unmetered (the bug this
            // fix closes), both writes would silently succeed.
            await writer.insert("items", { value: "slow-1" });
            await writer.insert("items", { value: "slow-2" });

            return { ok: true };
        }

        const value = typeof args["value"] === "string" ? args["value"] : "fast";

        await writer.insert("items", { value });

        return { ok: true };
    }

    // eslint-disable-next-line class-methods-use-this -- deliberately tiny so a single dispatch's second write trips the ceiling
    protected override transactionLimits(): { maxWrittenRows: number } {
        return { maxWrittenRows: 1 };
    }
}

const rpcRequest = (functionPath: string, args: Record<string, unknown> = {}): Request =>
    new Request("https://shard.internal/rpc", {
        body: JSON.stringify({ args, functionPath }),
        headers: { "content-type": "application/json" },
        method: "POST",
    });

describe("dispatch-race: value-threaded transaction headroom (plan 207 step 3)", () => {
    let harness: ReturnType<typeof createSqliteExec>;
    let shard: RaceShard;

    beforeEach(() => {
        harness = createSqliteExec();
        runShardMigrations(harness.sql, schema);

        const state: ShardDOState = {
            acceptWebSocket() {},
            getWebSockets() {
                return [];
            },
            storage: { sql: harness.sql as unknown as ShardDOState["storage"]["sql"] },
        };

        shard = new RaceShard(state, {});
    });

    it("the earlier dispatch stays metered against its OWN tracker after a later, fully-completed dispatch clears the shared field", async () => {
        expect.assertions(3);

        // Start "slow" — it mints its own tracker, builds its ctx (capturing
        // that tracker BY VALUE via handleRpc's headroom parameter), then
        // blocks on the gate before writing.
        const slow = shard.fetch(rpcRequest("slow"));

        await shard.started.promise;

        // "fast" runs to completion WHILE "slow" is still parked: mints its
        // own tracker (overwriting the shared `currentTransactionHeadroom`
        // field), writes successfully, and its `finally` clears that field —
        // exactly the race that used to leave "slow" unmetered.
        const fast = await shard.fetch(rpcRequest("fast", { value: "fast-row" }));

        expect(fast.status).toBe(200);

        // Release "slow". Its second write must still be metered against ITS
        // OWN tracker, not the (now-cleared) shared field.
        shard.gate.resolve();

        const slowResponse = await slow;

        expect(slowResponse.status).toBe(413);

        const body = await slowResponse.json<{ error: { code: string } }>();

        expect(body.error.code).toBe("TRANSACTION_LIMIT_EXCEEDED");
    });
});
