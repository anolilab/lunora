import { describe, expect, it } from "vitest";

import type { ShardDOState, TelemetrySink } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import createSqliteExec from "./_helpers/node-sqlite";

const ADMIN_TOKEN = "db-summary-admin";

/** The minimal `ctx.db` surface `instrumentDatabase` wraps — one instrumented method. */
const fakeDatabase = {
    findMany: async (): Promise<unknown[]> => [],
};

/**
 * A shard whose handler does nothing but read through an instrumented `ctx.db`:
 * no `ctx.trace`, no `ctx.span`. This is the common shape, and the one whose
 * `instrumentDatabase: "summary"` counters had nowhere to land.
 */
class DatabaseOnlyShard extends ShardDO {
    public readonly sink: TelemetrySink = { instrumentDatabase: "summary" };

    public override async handleRpc(functionPath: string): Promise<unknown> {
        const database = this.instrumentDb(fakeDatabase, functionPath, this.resolveDispatchAnchor(false), this.sink);

        await database.findMany();
        await database.findMany();

        return { ok: true };
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

const rpcRequest = (functionPath: string): Request =>
    new Request("https://shard.internal/rpc", {
        body: JSON.stringify({ args: {}, functionPath }),
        headers: { "content-type": "application/json" },
        method: "POST",
    });

const adminRequest = (functionPath: string): Request =>
    new Request("https://shard.internal/rpc", {
        body: JSON.stringify({ args: {}, functionPath }),
        headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
        method: "POST",
    });

interface TracesResult {
    result: { traces: { functionPath: string; spans: { attributes?: Record<string, unknown>; name: string }[] }[] };
}

describe('instrumentDatabase: "summary" — where the counters land', () => {
    it("records the dispatch root span with the db tally for a handler that only touched ctx.db", async () => {
        expect.assertions(2);

        const database = createSqliteExec();

        try {
            const shard = new DatabaseOnlyShard(makeState(database), { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

            await shard.fetch(rpcRequest("feed:list"));

            const response = await shard.fetch(adminRequest("__lunora_admin__:getTraces"));
            const body = await response.json<TracesResult>();
            const root = body.result.traces.flatMap((trace) => trace.spans).find((span) => span.name === "feed:list");

            expect(root).toBeDefined();
            expect(root?.attributes).toMatchObject({ "db.calls": 2, "db.op.findMany": 2 });
        } finally {
            database.close();
        }
    });

    // The gate is only half of it: the counters were also dropped from a root
    // span that WAS being recorded, because they were folded in only when the
    // handler had opened a `ctx.span` wide event.
    it("carries the tally on a root span minted by ctx.trace, with no ctx.span involved", async () => {
        expect.assertions(2);

        const database = createSqliteExec();

        try {
            const shard = new (class extends DatabaseOnlyShard {
                public override async handleRpc(functionPath: string): Promise<unknown> {
                    const anchor = this.resolveDispatchAnchor(false);
                    const tracer = this.makeTracer(functionPath, this.sink, anchor);
                    const instrumented = this.instrumentDb(fakeDatabase, functionPath, anchor, this.sink);

                    await tracer("work", async () => {
                        await instrumented.findMany();
                    });

                    return { ok: true };
                }
            })(makeState(database), { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

            await shard.fetch(rpcRequest("feed:traced"));

            const response = await shard.fetch(adminRequest("__lunora_admin__:getTraces"));
            const body = await response.json<TracesResult>();
            const root = body.result.traces.flatMap((trace) => trace.spans).find((span) => span.name === "feed:traced");

            expect(root).toBeDefined();
            expect(root?.attributes).toMatchObject({ "db.calls": 1 });
        } finally {
            database.close();
        }
    });

    it("still records no root span for a dispatch that touched nothing", async () => {
        expect.assertions(1);

        const database = createSqliteExec();

        try {
            const shard = new (class extends ShardDO {
                // eslint-disable-next-line class-methods-use-this -- override stub: a handler that produces no telemetry at all
                public override async handleRpc(): Promise<unknown> {
                    return { ok: true };
                }
            })(makeState(database), { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

            await shard.fetch(rpcRequest("feed:quiet"));

            const response = await shard.fetch(adminRequest("__lunora_admin__:getTraces"));
            const body = await response.json<TracesResult>();

            expect(body.result.traces.flatMap((trace) => trace.spans)).toStrictEqual([]);
        } finally {
            database.close();
        }
    });
});
