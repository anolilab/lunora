import { describe, expect, it } from "vitest";

import type { SpanEvent } from "../../../shared/span-event";
import type { ContextTracer } from "../src/context-telemetry";
import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import createSqliteExec from "./_helpers/node-sqlite";

// A fixed W3C trace id + parent span id used to build the inbound `traceparent`.
const TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const PARENT_SPAN_ID = "b7ad6b7169203331";

/**
 * A shard whose real `handleRpc` runs a caller-supplied trace `plan` against a
 * `ctx.trace` factory wired to a span-collecting sink, so the full base-class
 * dispatch machinery — inbound `traceparent` sampled flag, `recordSpan` gating,
 * and the `finally` error-keep flush — decides what reaches `onSpan`.
 */
class SamplingShard extends ShardDO {
    public readonly exportedSpans: SpanEvent[] = [];

    // Assigned by each test before `fetch`; a definite-assignment field rather than
    // an arrow default (which trips `class-methods-use-this`).
    public plan!: (trace: ContextTracer) => Promise<void>;

    public override async handleRpc(functionPath: string): Promise<unknown> {
        const trace = this.makeTracer(
            functionPath,
            {
                onSpan: (span: SpanEvent) => {
                    this.exportedSpans.push(span);
                },
            },
            this.getCurrentTrace(),
        );

        await this.plan(trace);

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

/**
 * A `/rpc` request carrying the runtime's sampling signals: the `traceparent`
 * sampled flag (`01` in / `00` out) and the `x-lunora-sample-errors` tail-bias
 * header. Omitting `keepErrors` leaves the header off (defaulting to keep).
 */
const request = (functionPath: string, options: { keepErrors?: boolean; sampled: boolean }): Request => {
    const headers: Record<string, string> = {
        "content-type": "application/json",
        traceparent: `00-${TRACE_ID}-${PARENT_SPAN_ID}-${options.sampled ? "01" : "00"}`,
    };

    if (options.keepErrors !== undefined) {
        headers["x-lunora-sample-errors"] = options.keepErrors ? "1" : "0";
    }

    return new Request("https://shard.internal/rpc", {
        body: JSON.stringify({ args: {}, functionPath }),
        headers,
        method: "POST",
    });
};

describe("shardDO trace sampling", () => {
    it("streams spans live when the trace is head-sampled", async () => {
        expect.assertions(2);

        const database = createSqliteExec();

        try {
            const shard = new SamplingShard(makeState(database), {});

            shard.plan = async (trace) => {
                await trace("work", () => undefined);
            };

            await shard.fetch(request("a:b", { sampled: true }));

            expect(shard.exportedSpans).toHaveLength(1);
            expect(shard.exportedSpans[0]?.name).toBe("work");
        } finally {
            database.close();
        }
    });

    it("drops a sampled-out trace that produced no error span", async () => {
        expect.assertions(1);

        const database = createSqliteExec();

        try {
            const shard = new SamplingShard(makeState(database), {});

            shard.plan = async (trace) => {
                await trace("first", () => undefined);
                await trace("second", () => undefined);
            };

            await shard.fetch(request("a:b", { keepErrors: true, sampled: false }));

            // Head-sampled out, no error → nothing exported (still buffered locally
            // for the Studio panel, but never handed to the sink).
            expect(shard.exportedSpans).toHaveLength(0);
        } finally {
            database.close();
        }
    });

    it("keeps a sampled-out trace whole when a child span errored (tail bias)", async () => {
        expect.assertions(3);

        const database = createSqliteExec();

        try {
            const shard = new SamplingShard(makeState(database), {});

            shard.plan = async (trace) => {
                await trace("ok-child", () => undefined);
                // The handler catches so it returns ok, but the child span settled
                // `ok: false` — enough to keep the whole trace on export.
                await trace("bad-child", () => {
                    throw new Error("kaboom");
                }).catch(() => undefined);
            };

            await shard.fetch(request("a:b", { keepErrors: true, sampled: false }));

            const names = shard.exportedSpans.map((span) => span.name);

            expect(shard.exportedSpans).toHaveLength(2);
            // The whole trace is kept, including the sibling that settled BEFORE the error.
            expect(names).toContain("ok-child");
            expect(names).toContain("bad-child");
        } finally {
            database.close();
        }
    });

    it("drops a sampled-out error trace when alwaysSampleErrors is off", async () => {
        expect.assertions(1);

        const database = createSqliteExec();

        try {
            const shard = new SamplingShard(makeState(database), {});

            shard.plan = async (trace) => {
                await trace("bad-child", () => {
                    throw new Error("kaboom");
                }).catch(() => undefined);
            };

            await shard.fetch(request("a:b", { keepErrors: false, sampled: false }));

            expect(shard.exportedSpans).toHaveLength(0);
        } finally {
            database.close();
        }
    });
});
