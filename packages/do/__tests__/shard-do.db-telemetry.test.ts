import { describe, expect, it } from "vitest";

import type { LogEvent } from "../../../shared/log-event";
import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import createSqliteExec from "./_helpers/node-sqlite";

const TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const PARENT_SPAN_ID = "b7ad6b7169203331";
const WIDE_EVENT_NAME = "lunora.dispatch";

/**
 * The `ctx.db` tally, end to end through the real dispatch.
 *
 * The tally is folded onto the dispatch's wide event once, in the dispatch's
 * `finally`, rather than republished after every `ctx.db` call. That fold has to
 * happen BEFORE the gate that decides whether the dispatch produced telemetry
 * worth recording: a handler that touched only the database has no span
 * collector of its own, so a gate-first ordering would drop both the tally and
 * the wide event carrying it.
 *
 * The unit tests for `instrumentDatabase` drive `registerFlush` by hand, so only
 * a test at this level can catch the shard wiring the fold up wrongly — or, as
 * was the case before this suite existed, not wiring it at all. Breaking the
 * fold previously left the entire `@lunora/do` suite green.
 */
class DbTelemetryShard extends ShardDO {
    /** Wide-event log records the sink received for this dispatch. */
    public readonly wideEvents: LogEvent[] = [];

    /** How many `ctx.db` calls the handler makes. Zero exercises the empty-tally path. */
    public plannedCalls = 0;

    public override async handleRpc(functionPath: string): Promise<unknown> {
        const sink = {
            onLog: (event: LogEvent) => {
                if (event.eventName === WIDE_EVENT_NAME) {
                    this.wideEvents.push(event);
                }
            },
        };

        const anchor = this.resolveDispatchAnchor(false);
        const span = this.makeDispatchSpan(anchor, sink);
        const database = this.instrumentDb(
            {
                findMany: async () => {
                    return { rows: [] };
                },
            },
            functionPath,
            anchor,
            span,
            sink,
        );

        for (let index = 0; index < this.plannedCalls; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential on purpose: the tally is about cumulative count
            await database.findMany();
        }

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

const request = (functionPath: string): Request =>
    new Request("https://shard.internal/rpc", {
        body: JSON.stringify({ args: {}, functionPath }),
        headers: {
            "content-type": "application/json",
            traceparent: `00-${TRACE_ID}-${PARENT_SPAN_ID}-01`,
        },
        method: "POST",
    });

describe("shardDO ctx.db telemetry", () => {
    it("folds the db tally onto the wide event for a handler that touched nothing else", async () => {
        expect.assertions(3);

        const database = createSqliteExec();

        try {
            const shard = new DbTelemetryShard(makeState(database), {});

            shard.plannedCalls = 3;

            await shard.fetch(request("orders:list"));

            // No `ctx.trace`, no `ctx.span` — the db tally is the only reason this
            // dispatch produced telemetry, and it has to be reason enough.
            expect(shard.wideEvents).toHaveLength(1);
            expect(shard.wideEvents[0]?.fields?.["db.calls"]).toBe(3);
            expect(shard.wideEvents[0]?.fields?.["db.op.findMany"]).toBe(3);
        } finally {
            database.close();
        }
    });

    it("records no db attributes for a dispatch that never touched the database", async () => {
        expect.assertions(1);

        const database = createSqliteExec();

        try {
            const shard = new DbTelemetryShard(makeState(database), {});

            shard.plannedCalls = 0;

            await shard.fetch(request("orders:list"));

            // An empty tally must not publish: `db.calls: 0` is noise, and writing
            // it would force a collector into existence for a dispatch with
            // nothing to report — which is what the gate reads to decide whether
            // there is any telemetry at all.
            expect(shard.wideEvents.some((event) => event.fields?.["db.calls"] !== undefined)).toBe(false);
        } finally {
            database.close();
        }
    });
});
