import { describe, expect, it } from "vitest";

import type { SpanEvent } from "../../../shared/span-event";
import type { ContextTracer } from "../src/context-telemetry";
import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import createSqliteExec from "./_helpers/node-sqlite";

// A fixed W3C trace id + parent span id used to build the inbound `traceparent`.
const TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
// A second, distinct trace id for the interleaved-dispatch race test.
const TRACE_ID_B = "1bb7652917de54ee9559fc322d91420d";
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
    // an arrow default (which trips `class-methods-use-this`). `functionPath` lets a
    // plan branch per dispatch (used by the interleaved-dispatch race test).
    public plan!: (trace: ContextTracer, functionPath: string) => Promise<void>;

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

        await this.plan(trace, functionPath);

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
const request = (functionPath: string, options: { keepErrors?: boolean; sampled: boolean; traceId?: string }): Request => {
    const headers: Record<string, string> = {
        "content-type": "application/json",
        traceparent: `00-${options.traceId ?? TRACE_ID}-${PARENT_SPAN_ID}-${options.sampled ? "01" : "00"}`,
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

    it("keeps a slow sampled-out error trace even when a sibling dispatch's finally interleaves", async () => {
        expect.assertions(2);

        const database = createSqliteExec();

        try {
            const shard = new SamplingShard(makeState(database), {});

            let markRecorded!: () => void;
            const slowRecorded = new Promise<void>((resolve) => {
                markRecorded = resolve;
            });
            let releaseSlow!: () => void;
            const slowGate = new Promise<void>((resolve) => {
                releaseSlow = resolve;
            });

            shard.plan = async (trace, functionPath) => {
                if (functionPath === "slow:out") {
                    // Sampled out + errors: the span is held and the sink captured.
                    await trace("slow-error", () => {
                        throw new Error("boom");
                    }).catch(() => undefined);
                    markRecorded();
                    // Park before returning, so this dispatch's `finally` (which
                    // flushes the held error span) runs AFTER the sibling below.
                    await slowGate;

                    return;
                }

                await trace("fast-ok", () => undefined);
            };

            // Start the slow sampled-out+error dispatch (its own traceId) and let it
            // hold its error span, then park on the gate.
            const slow = shard.fetch(request("slow:out", { keepErrors: true, sampled: false, traceId: TRACE_ID }));

            await slowRecorded;

            // Run a sibling sampled-in dispatch (a DIFFERENT traceId) to completion.
            // Its `finally` must not wipe the slow trace's held sink/verdict — the
            // race the per-instance fields used to lose. It streams its own span live.
            await shard.fetch(request("fast:in", { sampled: true, traceId: TRACE_ID_B }));

            // Now let the slow dispatch finish; its `finally` must still flush its
            // own held error span (keyed by its traceId), not silently drop it.
            releaseSlow();
            await slow;

            expect(shard.exportedSpans.filter((span) => span.traceId === TRACE_ID).map((span) => span.name)).toContain("slow-error");
            expect(shard.exportedSpans.filter((span) => span.traceId === TRACE_ID_B).map((span) => span.name)).toContain("fast-ok");
        } finally {
            database.close();
        }
    });

    it("flushes a sampled-out trace's held error span even after the ring evicted it (eviction race closed)", async () => {
        expect.assertions(1);

        const database = createSqliteExec();

        try {
            const shard = new SamplingShard(makeState(database), {});

            let markRecorded!: () => void;
            const slowRecorded = new Promise<void>((resolve) => {
                markRecorded = resolve;
            });
            let releaseSlow!: () => void;
            const slowGate = new Promise<void>((resolve) => {
                releaseSlow = resolve;
            });

            shard.plan = async (trace, functionPath) => {
                if (functionPath === "slow:out") {
                    // Sampled out + errors: the span is held on the per-trace entry.
                    await trace("slow-error", () => {
                        throw new Error("boom");
                    }).catch(() => undefined);
                    markRecorded();
                    // Park so this dispatch's `finally` (which flushes the held error
                    // span) runs AFTER the flood below has evicted it from the ring.
                    await slowGate;

                    return;
                }

                // Flood a DIFFERENT (sampled-in) trace with more spans than the span
                // ring can hold, so the slow trace's held error span is evicted FROM
                // THE RING while its dispatch is parked. The held spans now live on the
                // per-trace entry, not the ring, so the flush must still find it — the
                // ring-copy implementation would silently drop it here.
                for (let index = 0; index < 550; index += 1) {
                    // eslint-disable-next-line no-await-in-loop -- ordering is the point: fill the ring sequentially so the oldest (slow-error) is evicted.
                    await trace(`filler-${index.toString()}`, () => undefined);
                }
            };

            const slow = shard.fetch(request("slow:out", { keepErrors: true, sampled: false, traceId: TRACE_ID }));

            await slowRecorded;

            // Sampled-in flood on its own trace: streams live AND fills the ring past
            // capacity, evicting the slow trace's held error span from the ring.
            await shard.fetch(request("flood:in", { sampled: true, traceId: TRACE_ID_B }));

            releaseSlow();
            await slow;

            expect(shard.exportedSpans.filter((span) => span.traceId === TRACE_ID).map((span) => span.name)).toContain("slow-error");
        } finally {
            database.close();
        }
    });

    it("does not export a span that ends after its sampled-out dispatch tore down (late-span verdict snapshot)", async () => {
        expect.assertions(2);

        const database = createSqliteExec();

        try {
            const shard = new SamplingShard(makeState(database), {});

            let markStarted!: () => void;
            const started = new Promise<void>((resolve) => {
                markStarted = resolve;
            });
            let releaseLate!: () => void;
            const lateGate = new Promise<void>((resolve) => {
                releaseLate = resolve;
            });
            let latePromise!: Promise<void>;

            shard.plan = async (trace) => {
                // Detached: the body parks on the gate, so the dispatch returns — and
                // its `finally` deletes the traceSampling entry — while the span is
                // still open. This is the streaming-AI-SDK / detached-hook shape.
                latePromise = trace("late", async () => {
                    markStarted();
                    await lateGate;
                });
                await started;
            };

            await shard.fetch(request("a:b", { keepErrors: true, sampled: false }));

            // Dispatch settled, entry gone; the span has not recorded yet.
            expect(shard.exportedSpans).toHaveLength(0);

            releaseLate();
            await latePromise;

            // The late span records now, with NO live traceSampling entry. The verdict
            // snapshotted when it opened (sampled out) is honoured — it is dropped, not
            // exported. Before the fix a missing entry fell through to an unconditional
            // export, leaking an orphan child of a sampled-out trace.
            expect(shard.exportedSpans).toHaveLength(0);
        } finally {
            database.close();
        }
    });

    it("still exports a span that ends after a sampled-in dispatch tore down", async () => {
        expect.assertions(2);

        const database = createSqliteExec();

        try {
            const shard = new SamplingShard(makeState(database), {});

            let markStarted!: () => void;
            const started = new Promise<void>((resolve) => {
                markStarted = resolve;
            });
            let releaseLate!: () => void;
            const lateGate = new Promise<void>((resolve) => {
                releaseLate = resolve;
            });
            let latePromise!: Promise<void>;

            shard.plan = async (trace) => {
                latePromise = trace("late", async () => {
                    markStarted();
                    await lateGate;
                });
                await started;
            };

            await shard.fetch(request("a:b", { sampled: true }));

            // Parked span hasn't recorded yet.
            expect(shard.exportedSpans).toHaveLength(0);

            releaseLate();
            await latePromise;

            // No live entry now, but the open-time snapshot (sampled in) keeps it — a
            // kept trace's late span still exports.
            expect(shard.exportedSpans.map((span) => span.name)).toContain("late");
        } finally {
            database.close();
        }
    });
});
