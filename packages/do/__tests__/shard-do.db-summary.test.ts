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

    // `ctx.sql` (Hyperdrive) rides the same knob but keeps its own `sql.*`
    // tally, so an action's external-database time is not summed into the
    // shard's own SQLite counters.
    it("folds the ctx.sql tally as sql.* alongside db.* for a handler that touched both", async () => {
        expect.assertions(3);

        const database = createSqliteExec();
        const sqlClient = {
            dbSystem: "postgresql" as const,
            query: async (_text: string, _params?: ReadonlyArray<unknown>): Promise<unknown[]> => [{ id: 1 }],
        };

        try {
            const shard = new (class extends DatabaseOnlyShard {
                public override async handleRpc(functionPath: string): Promise<unknown> {
                    const anchor = this.resolveDispatchAnchor(false);
                    const instrumentedDb = this.instrumentDb(fakeDatabase, functionPath, anchor, this.sink);
                    const sql = this.instrumentSql(sqlClient, functionPath, anchor, this.sink);

                    await instrumentedDb.findMany();
                    await sql.query("select id from orders");
                    await sql.query("update orders set total = 0");

                    return { ok: true };
                }
            })(makeState(database), { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

            await shard.fetch(rpcRequest("orders:sync"));

            const response = await shard.fetch(adminRequest("__lunora_admin__:getTraces"));
            const body = await response.json<TracesResult>();
            const root = body.result.traces.flatMap((trace) => trace.spans).find((span) => span.name === "orders:sync");

            expect(root).toBeDefined();
            expect(root?.attributes).toMatchObject({ "db.calls": 1, "sql.calls": 2, "sql.op.SELECT": 1, "sql.op.UPDATE": 1 });
            // Summary mode: the counters, not a span per statement.
            expect(body.result.traces.flatMap((trace) => trace.spans).some((span) => span.name.startsWith("sql."))).toBe(false);
        } finally {
            database.close();
        }
    });

    it("records the dispatch root span for a handler that only touched ctx.sql, and per-statement spans in spans mode", async () => {
        expect.assertions(3);

        const database = createSqliteExec();
        const sqlClient = { dbSystem: "mysql" as const, query: async (_text: string, _params?: ReadonlyArray<unknown>): Promise<unknown[]> => [] };

        try {
            const shard = new (class extends ShardDO {
                public readonly sink: TelemetrySink = { instrumentDatabase: "spans" };

                public override async handleRpc(functionPath: string): Promise<unknown> {
                    await this.instrumentSql(sqlClient, functionPath, this.resolveDispatchAnchor(false), this.sink).query("insert into t values (?)", [1]);

                    return { ok: true };
                }
            })(makeState(database), { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

            await shard.fetch(rpcRequest("orders:push"));

            const response = await shard.fetch(adminRequest("__lunora_admin__:getTraces"));
            const body = await response.json<TracesResult>();
            const spans = body.result.traces.flatMap((trace) => trace.spans);

            expect(spans.find((span) => span.name === "orders:push")?.attributes).toMatchObject({ "sql.calls": 1, "sql.op.INSERT": 1 });
            expect(spans.find((span) => span.name === "sql.INSERT")?.attributes).toMatchObject({ "db.operation.name": "INSERT", "db.system.name": "mysql" });
            expect(JSON.stringify(spans)).not.toContain("insert into t");
        } finally {
            database.close();
        }
    });

    it("hands ctx.sql back untouched with no sink configured", async () => {
        expect.assertions(1);

        const database = createSqliteExec();
        const sqlClient = { query: async (_text: string, _params?: ReadonlyArray<unknown>): Promise<unknown[]> => [] };
        let seen: unknown;

        try {
            const shard = new (class extends ShardDO {
                public override async handleRpc(functionPath: string): Promise<unknown> {
                    seen = this.instrumentSql(sqlClient, functionPath, this.resolveDispatchAnchor(false));

                    return { ok: true };
                }
            })(makeState(database), { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

            await shard.fetch(rpcRequest("orders:noop"));

            expect(seen).toBe(sqlClient);
        } finally {
            database.close();
        }
    });

    // The span is built after the network await; reading the acting user then
    // would pick up whatever a concurrent request set on the shared instance.
    it("stamps a ctx.sql span with the user current when the client was instrumented, not when the query settled", async () => {
        expect.assertions(1);

        const database = createSqliteExec();
        const recorded: { name: string; userId?: string }[] = [];

        try {
            const shard = new (class extends ShardDO {
                public actingUser: string | undefined = "user-a";

                public override async handleRpc(functionPath: string): Promise<unknown> {
                    const sql = this.instrumentSql(
                        {
                            query: async (_text: string, _params?: ReadonlyArray<unknown>): Promise<unknown[]> => {
                                // A concurrent request re-sets the per-instance user mid-await.
                                this.actingUser = "user-b";

                                return [];
                            },
                        },
                        functionPath,
                        this.resolveDispatchAnchor(false),
                        {
                            instrumentDatabase: "spans",
                            onSpan: (span) => {
                                recorded.push(span);
                            },
                        },
                    );

                    await sql.query("select 1");

                    return { ok: true };
                }

                protected override getCurrentUserId(): string | undefined {
                    return this.actingUser;
                }
            })(makeState(database), { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

            await shard.fetch(rpcRequest("orders:who"));

            expect(recorded.find((span) => span.name === "sql.SELECT")?.userId).toBe("user-a");
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
