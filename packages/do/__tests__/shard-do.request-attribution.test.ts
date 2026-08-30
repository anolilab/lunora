import { readRequestLog } from "@lunora/observability";
import { describe, expect, it } from "vitest";

import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * The durable request log's `tablesRead` / `cacheHit` are produced deep inside
 * the cached-query path and consumed at the end of the dispatch — on both sides
 * of the handler's awaits. A Durable Object serves concurrent `/rpc` dispatches,
 * so holding them on instance fields filed one request's read set and cache-hit
 * flag under ANOTHER request's row. They are threaded per dispatch instead; this
 * suite pins that.
 */

/**
 * A shard whose handlers stamp a read through the real ctx-db read hook, park on
 * a per-path gate, and expose one seam (`parkOnFlush`) that runs after a
 * dispatch has written its request-log row but before its `finally` clears the
 * per-request state — the window a concurrent dispatch resumes in.
 */
class AttributionShard extends ShardDO {
    /** functionPath -> the gate its handler parks on, resolved by the test. */
    public gates = new Map<string, Promise<void>>();

    /** functionPath -> resolver fired as its handler enters, so the test can sequence the interleave. */
    public entered = new Map<string, () => void>();

    /** Ran once, from inside the post-response subscription drain of whichever dispatch flushes first. */
    public parkOnFlush: (() => Promise<void>) | undefined;

    public override async handleRpc(functionPath: string): Promise<unknown> {
        const table = functionPath.split(":")[0] ?? "";

        // Real wiring: this is the hook a generated subclass hands to
        // `createShardCtxDb` as `onRead`, so the dep lands in whichever tracker
        // the base class installed.
        this.getCtxDbReadHook()(table, `${table}-1`);
        // Gives the tail of the dispatch a non-empty change set, so
        // `flushChangedTables` actually runs the drain that `dispatchReactors`
        // (and with it `parkOnFlush`) sits in.
        this.recordChangedTable(table);
        this.entered.get(functionPath)?.();

        await this.gates.get(functionPath);

        return { ok: true };
    }

    protected override isQueryFunction(): boolean {
        return this.reactiveCache !== undefined;
    }

    protected override async dispatchReactors(changed: Set<string>, runs: Map<string, number>): Promise<void> {
        const park = this.parkOnFlush;

        this.parkOnFlush = undefined;

        await park?.();

        return super.dispatchReactors(changed, runs);
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

const rpc = (functionPath: string): Request =>
    new Request("https://shard.internal/rpc", {
        body: JSON.stringify({ args: {}, functionPath }),
        headers: { "content-type": "application/json" },
        method: "POST",
    });

/** A gate plus its resolver, for parking a handler until the test releases it. */
const gate = (): { open: () => void; wait: Promise<void> } => {
    let open!: () => void;
    const wait = new Promise<void>((resolve) => {
        open = resolve;
    });

    return { open, wait };
};

describe("shardDO request-log attribution", () => {
    it("files cache-hit and read tables under the dispatch that produced them, not the one that finished last", async () => {
        expect.assertions(3);

        const database = createSqliteExec();

        try {
            const shard = new AttributionShard(makeState(database), {}, { reactiveCache: {} });

            const gateA = gate();
            const gateB = gate();
            const enteredA = gate();
            const enteredB = gate();

            shard.gates.set("notes:list", gateA.wait);
            shard.gates.set("other:list", gateB.wait);
            shard.entered.set("notes:list", enteredA.open);
            shard.entered.set("other:list", enteredB.open);

            // A holds the cached-query slot; B arrives while A is parked, so it
            // passes straight through the re-entry guard and is never memoized.
            const a = shard.fetch(rpc("notes:list"));

            await enteredA.wait;

            const b = shard.fetch(rpc("other:list"));

            await enteredB.wait;

            // Resume B only once A has resolved its cached query AND written its
            // own request-log row — the window where the shared fields still held
            // A's numbers and B was about to read them as its own.
            shard.parkOnFlush = async () => {
                gateB.open();

                await b;
            };
            gateA.open();

            await a;

            const rows = readRequestLog(database.sql);
            const byPath = new Map(rows.map((row) => [row.functionPath, row]));

            expect(byPath.get("notes:list")?.tablesRead).toContain("notes");
            // B never reached the cache, so it has nothing to report — and must
            // not inherit A's read set or A's cache-hit verdict.
            expect(byPath.get("other:list")?.tablesRead).toStrictEqual([]);
            expect(byPath.get("other:list")?.cacheHit).toBeUndefined();
        } finally {
            database.close();
        }
    });
});
