/* eslint-disable unicorn/prefer-single-call -- `buffer.push` is SpanBuffer's single-arg method, not Array#push; combining the calls would silently drop all but the first event */
import { LunoraError } from "@lunora/errors";
import { describe, expect, it } from "vitest";

import type { MetricEvent } from "../../../shared/metric-event";
import type { SpanEvent } from "../../../shared/span-event";
import type { ContextMetrics, ContextTracer } from "../src/context-telemetry";
import { createMetrics, createTracer } from "../src/context-telemetry";
import { ADMIN_FUNCTIONS } from "../src/introspect";
import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import { foldTraces, SpanBuffer } from "../src/span-buffer";

const ADMIN_TOKEN = "test-admin-token-that-is-long-enough";

/**
 * Drives the shard's own `makeTracer` wiring — used only by the `getTraces`
 * integration test below. The span and measurement *semantics* are tested
 * directly against `createTracer` / `createMetrics`, which need no shard at all.
 */
class TracingShard extends ShardDO {
    // eslint-disable-next-line class-methods-use-this -- override stub; this shard only exercises the admin RPC path
    public override async handleRpc(): Promise<unknown> {
        return { ok: true };
    }

    public metricRecorder(functionPath: string): ReturnType<TracingShard["makeMetrics"]> {
        return this.makeMetrics(functionPath);
    }

    public tracer(functionPath: string): ReturnType<TracingShard["makeTracer"]> {
        return this.makeTracer(functionPath);
    }
}

/**
 * A tracer that appends every finished span to `seen`. The injected `record` is
 * where the shard would buffer + fan out to a sink; the factory itself only
 * decides what a span *is*, so a test needs no Durable Object.
 */
const tracerInto = (seen: SpanEvent[]): ContextTracer =>
    createTracer({
        anchor: { rootSpanId: "00000000000000a1", traceId: "0af7651916cd43dd8448eb211c80319c" },
        functionPath: "a:b",
        record: (span) => seen.push(span),
        shardKey: "tenant-1",
        userId: () => "u1",
    });

const stateDouble = (): ShardDOState => {
    return {
        acceptWebSocket() {},
        getWebSockets() {
            return [];
        },
        storage: {
            sql: {
                exec: () => {
                    return { toArray: () => [] };
                },
            },
        },
    };
};

/** Minimal span, overridable per case. */
const span = (overrides: Partial<SpanEvent> & Pick<SpanEvent, "name" | "spanId">): SpanEvent => {
    return {
        durationMs: 10,
        functionPath: "a:b",
        ok: true,
        parentSpanId: "",
        startTs: 1000,
        traceId: "t1",
        ...overrides,
    };
};

describe("spanBuffer", () => {
    it("evicts the oldest span once past capacity", () => {
        expect.assertions(2);

        const buffer = new SpanBuffer(2);

        buffer.push(span({ name: "one", spanId: "s1" }));
        buffer.push(span({ name: "two", spanId: "s2" }));
        buffer.push(span({ name: "three", spanId: "s3" }));

        expect(buffer.size).toBe(2);
        expect(buffer.entries().map((entry) => entry.name)).toStrictEqual(["two", "three"]);
    });

    it("answers trace membership without copying the ring", () => {
        expect.assertions(2);

        const buffer = new SpanBuffer();

        buffer.push(span({ name: "one", spanId: "s1", traceId: "t1" }));

        expect(buffer.hasTrace("t1")).toBe(true);
        expect(buffer.hasTrace("t2")).toBe(false);
    });
});

describe("foldTraces", () => {
    it("computes depth and offset for a nested trace", () => {
        expect.assertions(3);

        // root ─ outer ─ inner, each starting 5ms after its parent.
        const {
            traces: [trace],
        } = foldTraces([
            span({ durationMs: 30, name: "inner", parentSpanId: "outer", spanId: "inner", startTs: 1010 }),
            span({ durationMs: 40, name: "outer", parentSpanId: "root", spanId: "outer", startTs: 1005 }),
            span({ durationMs: 50, name: "a:b", dispatch: true, spanId: "root", startTs: 1000 }),
        ]);

        expect(trace?.spans.map((entry) => entry.name)).toStrictEqual(["a:b", "outer", "inner"]);
        expect(trace?.spans.map((entry) => entry.depth)).toStrictEqual([0, 1, 2]);
        expect(trace?.spans.map((entry) => entry.offsetMs)).toStrictEqual([0, 5, 10]);
    });

    it("orders a parent above its child when both share a startTs", () => {
        expect.assertions(2);

        // The common case, not an edge case: spans are recorded on *completion*,
        // so the child is buffered first, and `startTs` has millisecond
        // resolution — a fast parent/child pair looks simultaneous. Ordering must
        // come from the structure, not from arrival order or timing.
        const {
            traces: [trace],
        } = foldTraces([
            span({ durationMs: 0, name: "inner", parentSpanId: "outer", spanId: "inner", startTs: 1000 }),
            span({ durationMs: 0, name: "outer", parentSpanId: "dispatch", spanId: "outer", startTs: 1000 }),
        ]);

        expect(trace?.spans.map((entry) => entry.name)).toStrictEqual(["outer", "inner"]);
        expect(trace?.spans.map((entry) => entry.depth)).toStrictEqual([0, 1]);
    });

    it("marks a trace failed when any descendant span errored", () => {
        expect.assertions(2);

        const {
            traces: [trace],
        } = foldTraces([
            span({ name: "a:b", dispatch: true, spanId: "root" }),
            span({ error: { message: "nope", type: "BAD_REQUEST" }, name: "child", ok: false, parentSpanId: "root", spanId: "child" }),
        ]);

        expect(trace?.ok).toBe(false);
        expect(trace?.spans.find((entry) => entry.name === "child")?.error?.type).toBe("BAD_REQUEST");
    });

    it("re-parents an orphan onto the anchor rather than dropping it", () => {
        expect.assertions(2);

        // The ring evicted `outer`, so `inner` names a parent that isn't here.
        const {
            traces: [trace],
        } = foldTraces([
            span({ name: "a:b", dispatch: true, spanId: "root" }),
            span({ name: "inner", parentSpanId: "evicted", spanId: "inner", startTs: 1010 }),
        ]);

        expect(trace?.spans).toHaveLength(2);
        expect(trace?.spans.find((entry) => entry.name === "inner")?.depth).toBe(1);
    });

    it("terminates on a cyclic parent chain", () => {
        expect.assertions(1);

        // Not producible by the tracer, but a replayed/hand-built stream could
        // carry it — depth resolution must not spin.
        const {
            traces: [trace],
        } = foldTraces([span({ name: "a", parentSpanId: "b", spanId: "a" }), span({ name: "b", parentSpanId: "a", spanId: "b" })]);

        expect(trace?.spans).toHaveLength(2);
    });

    it("renders a trace whose root has not been recorded yet", () => {
        expect.assertions(2);

        // Read mid-dispatch: children exist, the synthetic root span does not.
        const {
            traces: [trace],
        } = foldTraces([span({ name: "first", parentSpanId: "pending", spanId: "s1", startTs: 1000 })]);

        expect(trace?.rootName).toBe("first");
        expect(trace?.spans[0]?.offsetMs).toBe(0);
    });

    it("groups by trace, newest first, honours the limit, and reports the total", () => {
        expect.assertions(3);

        const { total, traces } = foldTraces(
            [
                span({ name: "old", spanId: "s1", startTs: 1000, traceId: "t1" }),
                span({ name: "mid", spanId: "s2", startTs: 2000, traceId: "t2" }),
                span({ name: "new", spanId: "s3", startTs: 3000, traceId: "t3" }),
            ],
            2,
        );

        expect(traces.map((entry) => entry.traceId)).toStrictEqual(["t3", "t2"]);
        expect(traces).toHaveLength(2);
        // Three distinct traces present, only two returned — the panel's "of M" total.
        expect(total).toBe(3);
    });
});

describe("ctx.trace", () => {
    it("returns the body's value and records a span", async () => {
        expect.assertions(3);

        const seen: SpanEvent[] = [];
        const trace = tracerInto(seen);

        await expect(trace("work", () => 42)).resolves.toBe(42);
        expect(seen[0]?.name).toBe("work");
        expect(seen[0]?.ok).toBe(true);
    });

    it("nests a span under the enclosing span via the tracer its body receives", async () => {
        expect.assertions(3);

        const seen: SpanEvent[] = [];
        const trace = tracerInto(seen);

        await trace("outer", async (child) => {
            await child("inner", () => undefined);
        });

        // Completion order: the inner span settles first.
        const [inner, outer] = seen;

        expect(inner?.name).toBe("inner");
        expect(inner?.parentSpanId).toBe(outer?.spanId);
        // Both sides of one dispatch share the trace.
        expect(inner?.traceId).toBe(outer?.traceId);
    });

    it("keeps concurrent siblings siblings instead of nesting them", async () => {
        expect.assertions(3);

        const seen: SpanEvent[] = [];
        const trace = tracerInto(seen);
        const sleep = async (ms: number): Promise<void> => {
            await new Promise((resolve) => {
                setTimeout(resolve, ms);
            });
        };

        // The case an ambient "currently open span" stack cannot express: `slow`
        // is still open when `fast` starts, so a stack would record `fast` as a
        // CHILD of `slow` rather than its sibling. Parallel fan-out is a mainline
        // use of a tracer, so this has to be right.
        await trace("outer", async (child) => {
            await Promise.all([child("slow", () => sleep(20)), child("fast", () => sleep(1))]);
        });

        const outer = seen.find((event) => event.name === "outer");
        const slow = seen.find((event) => event.name === "slow");
        const fast = seen.find((event) => event.name === "fast");

        expect(slow?.parentSpanId).toBe(outer?.spanId);
        expect(fast?.parentSpanId).toBe(outer?.spanId);
        // Specifically NOT parented to the sibling that happened to be open.
        expect(fast?.parentSpanId).not.toBe(slow?.spanId);
    });

    it("records a failed span and re-throws the original error untouched", async () => {
        expect.assertions(4);

        const seen: SpanEvent[] = [];
        const trace = tracerInto(seen);
        const thrown = new LunoraError("BAD_REQUEST", "bad input");

        await expect(
            trace("work", () => {
                throw thrown;
            }),
        ).rejects.toBe(thrown);

        expect(seen[0]?.ok).toBe(false);
        expect(seen[0]?.error?.message).toBe("bad input");
        // A LunoraError classifies by its stable catalog code, not its class name.
        expect(seen[0]?.error?.type).toBe("BAD_REQUEST");
    });

    it("does not mis-parent a sibling that follows a throwing span", async () => {
        expect.assertions(1);

        const seen: SpanEvent[] = [];
        const trace = tracerInto(seen);

        await trace("outer", async (child) => {
            await child("failing", () => {
                throw new Error("boom");
            }).catch(() => undefined);

            await child("sibling", () => undefined);
        });

        const sibling = seen.find((event) => event.name === "sibling");
        const outer = seen.find((event) => event.name === "outer");

        // The failed span must not still be on the stack.
        expect(sibling?.parentSpanId).toBe(outer?.spanId);
    });

    it("snapshots attributes so a later mutation cannot alter the recorded span", async () => {
        expect.assertions(2);

        const seen: SpanEvent[] = [];
        const trace = tracerInto(seen);
        const attributes: Record<string, unknown> = { step: "start" };

        await trace("work", () => undefined, attributes);
        attributes.step = "mutated";

        expect(seen[0]?.attributes).toStrictEqual({ step: "start" });

        // Non-primitives are coerced to JSON-safe values, like log fields.
        await trace("other", () => undefined, { count: 1n });

        expect(seen[1]?.attributes).toStrictEqual({ count: "1" });
    });

    it("merges post-hoc attributes set through the span handle after an await", async () => {
        expect.assertions(2);

        const seen: SpanEvent[] = [];
        const trace = tracerInto(seen);

        // Token usage / cost is only known after the async body resolves — the
        // classic case the span handle exists for.
        await trace(
            "ai.embed",
            async (_child, handle) => {
                await Promise.resolve();
                handle.setAttribute("gen_ai.usage.input_tokens", 12);
                handle.setAttributes({ cost: 0.0004, ok: true });
            },
            { "gen_ai.request.model": "@cf/baai/bge-base-en-v1.5" },
        );

        expect(seen[0]?.attributes).toStrictEqual({
            "gen_ai.request.model": "@cf/baai/bge-base-en-v1.5",
            "gen_ai.usage.input_tokens": 12,
            cost: 0.0004,
            ok: true,
        });
        // Non-primitive post-hoc values are coerced to JSON-safe primitives, exactly like start attributes.
        expect(seen[0]?.attributes?.["cost"]).toBe(0.0004);
    });

    it("lets a post-hoc attribute win over a start attribute on a key clash", async () => {
        expect.assertions(1);

        const seen: SpanEvent[] = [];
        const trace = tracerInto(seen);

        await trace(
            "work",
            (_child, handle) => {
                handle.setAttribute("status", "done");
            },
            { status: "pending" },
        );

        expect(seen[0]?.attributes).toStrictEqual({ status: "done" });
    });

    it("keeps a legacy body that ignores the span handle working unchanged", async () => {
        expect.assertions(2);

        const seen: SpanEvent[] = [];
        const trace = tracerInto(seen);

        // A `(trace) => …` body that never touches the second arg — the pre-existing
        // call shape — records exactly its start attributes and nothing more.
        await expect(trace("work", () => 7, { a: 1 })).resolves.toBe(7);
        expect(seen[0]?.attributes).toStrictEqual({ a: 1 });
    });

    it("survives a throwing recorder without failing the traced body", async () => {
        expect.assertions(1);

        const trace = createTracer({
            anchor: { rootSpanId: "0000000000000001", traceId: "t1" },
            functionPath: "a:b",
            record: () => {
                throw new Error("sink is down");
            },
            shardKey: undefined,
            userId: () => undefined,
        });

        // The body already succeeded; a telemetry failure must not undo that.
        await expect(trace("work", () => "value")).resolves.toBe("value");
    });

    it("serves folded traces over the getTraces admin RPC", async () => {
        expect.assertions(3);

        const shard = new TracingShard(stateDouble(), { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });
        const trace = shard.tracer("a:b");

        await trace("outer", async (child) => {
            await child("inner", () => undefined);
        });

        const response = await shard.fetch(
            new Request("https://shard.internal/rpc", {
                body: JSON.stringify({ args: {}, functionPath: ADMIN_FUNCTIONS.getTraces }),
                headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
                method: "POST",
            }),
        );
        const body = await response.json<{ result: { traces: { rootName: string; spans: { depth: number; name: string }[] }[] } }>();
        const [first] = body.result.traces;

        expect(body.result.traces).toHaveLength(1);
        expect(first?.spans.map((entry) => entry.name)).toStrictEqual(["outer", "inner"]);
        expect(first?.spans.map((entry) => entry.depth)).toStrictEqual([0, 1]);
    });
});

describe("ctx.metrics", () => {
    const recorderFor = (): { metrics: ContextMetrics; seen: MetricEvent[] } => {
        const seen: MetricEvent[] = [];

        return {
            metrics: createMetrics({ functionPath: "orders:checkout", record: (event) => seen.push(event), shardKey: undefined }),
            seen,
        };
    };

    it("records each instrument kind with the value the caller passed", () => {
        expect.assertions(4);

        const { metrics, seen } = recorderFor();

        metrics.count("orders.placed");
        metrics.gauge("cart.items", 3);
        metrics.record("checkout.latency_ms", 128);

        expect(seen.map((event) => event.kind)).toStrictEqual(["counter", "gauge", "histogram"]);
        // `count` defaults to an increment of 1.
        expect(seen[0]?.value).toBe(1);
        expect(seen[1]?.value).toBe(3);
        expect(seen[2]?.value).toBe(128);
    });

    it("attributes the measurement to the dispatched function", () => {
        expect.assertions(2);

        const { metrics, seen } = recorderFor();

        metrics.count("orders.placed", 2, { plan: "pro" });

        expect(seen[0]?.functionPath).toBe("orders:checkout");
        expect(seen[0]?.attributes).toStrictEqual({ plan: "pro" });
    });

    it("normalizes attributes to JSON-safe primitives and snapshots them", () => {
        expect.assertions(2);

        const { metrics, seen } = recorderFor();
        const attributes: Record<string, unknown> = { size: 10n, tier: "gold" };

        metrics.count("orders.placed", 1, attributes);
        attributes.tier = "mutated";

        expect(seen[0]?.attributes).toStrictEqual({ size: "10", tier: "gold" });
        expect(seen).toHaveLength(1);
    });

    it("drops a non-finite measurement instead of poisoning the aggregate", () => {
        expect.assertions(1);

        const { metrics, seen } = recorderFor();

        // e.g. a latency computed from a missing start time.
        metrics.record("checkout.latency_ms", Number.NaN);
        metrics.gauge("cart.items", Number.POSITIVE_INFINITY);

        expect(seen).toHaveLength(0);
    });

    it("survives a throwing recorder without failing the handler", () => {
        expect.assertions(1);

        const metrics = createMetrics({
            functionPath: "orders:checkout",
            record: () => {
                throw new Error("sink is down");
            },
            shardKey: undefined,
        });

        expect(() => {
            metrics.count("orders.placed");
        }).not.toThrow();
    });

    it("serves aggregated series over the getMetricSeries admin RPC", async () => {
        expect.assertions(4);

        const shard = new TracingShard(stateDouble(), { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });
        const metrics = shard.metricRecorder("orders:checkout");

        metrics.count("orders.placed", 2);
        metrics.count("orders.placed", 3);
        metrics.gauge("cart.items", 7);

        const response = await shard.fetch(
            new Request("https://shard.internal/rpc", {
                body: JSON.stringify({ args: {}, functionPath: ADMIN_FUNCTIONS.getMetricSeries }),
                headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
                method: "POST",
            }),
        );
        const body = await response.json<{ result: { series: { count: number; kind: string; name: string; sum: number }[] } }>();
        const { series } = body.result;

        expect(series).toHaveLength(2);

        const placed = series.find((s) => s.name === "orders.placed");

        expect(placed?.kind).toBe("counter");
        expect(placed?.count).toBe(2);
        expect(placed?.sum).toBe(5);
    });
});
