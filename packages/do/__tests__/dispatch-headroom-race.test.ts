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
 *
 * The outbound D1 bookmark is the same shape of bug on the write side, so its
 * regression lives here too: an action reports its `.global()` write's bookmark,
 * parks on outbound I/O, and a sibling dispatch runs start to finish inside that
 * window. The bookmark is threaded the same way for the same reason.
 */
import type { SchemaLike, SqlExec, TransactionHeadroomTracker } from "@lunora/shard-engine";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "@lunora/shard-engine";
import { beforeEach, describe, expect, it } from "vitest";

import type { DispatchBookmark, QueryReadScope, ShardDOState } from "../src/shard-do";
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

/**
 * The same interleaving, one field over: the outbound D1 bookmark.
 *
 * `"slow"` is an ACTION — it reports its `.global()` write's bookmark through
 * the sink `handleRpc` hands it (exactly what the generated `buildCtx` binds
 * into the global database's `onBookmark`), then parks on outbound I/O. Nothing
 * gates an action, so `"fast"` runs a complete dispatch inside that window and
 * its `beginDispatch`/`endDispatch` clear every shared per-request field.
 */
class BookmarkRaceShard extends ShardDO {
    public started = deferred();

    public gate = deferred();

    public override async handleRpc(
        functionPath: string,
        _args: Record<string, unknown>,
        _headroom?: TransactionHeadroomTracker,
        _scope?: QueryReadScope,
        bookmarks?: DispatchBookmark,
    ): Promise<unknown> {
        if (functionPath === "slow") {
            if (bookmarks !== undefined) {
                // `Object.assign` because `no-param-reassign` forbids writing a
                // parameter's properties directly.
                Object.assign(bookmarks, { value: "bm-slow" });
            }
            this.started.resolve();

            // The third-party round trip an action awaits. A sibling dispatch
            // runs to completion right here.
            await this.gate.promise;

            return { ok: true };
        }

        return { ok: true };
    }
}

const rpcRequest = (functionPath: string, args: Record<string, unknown> = {}): Request =>
    new Request("https://shard.internal/rpc", {
        body: JSON.stringify({ args, functionPath }),
        headers: { "content-type": "application/json" },
        method: "POST",
    });

describe("dispatch-race: value-threaded per-dispatch state (plan 207 step 3)", () => {
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

    it("an action's outbound bookmark survives a sibling dispatch that completes inside its await", async () => {
        expect.assertions(3);

        const state: ShardDOState = {
            acceptWebSocket() {},
            getWebSockets() {
                return [];
            },
            storage: { sql: harness.sql as unknown as ShardDOState["storage"]["sql"] },
        };
        const bookmarkShard = new BookmarkRaceShard(state, {});

        const slow = bookmarkShard.fetch(rpcRequest("slow"));

        await bookmarkShard.started.promise;

        // A complete sibling dispatch, start to finish, while the action is
        // parked past its global write.
        const fast = await bookmarkShard.fetch(rpcRequest("fast"));

        expect(fast.status).toBe(200);
        // The sibling wrote nothing global, so it reports no bookmark of its own.
        expect(fast.headers.get("x-d1-bookmark")).toBeNull();

        bookmarkShard.gate.resolve();

        const slowResponse = await slow;

        // The action's own write is still the one its response pins. Read off a
        // shared field this came back `null`, and the client's next global read
        // was free to land on a replica that had never seen the write.
        expect(slowResponse.headers.get("x-d1-bookmark")).toBe("bm-slow");
    });
});
