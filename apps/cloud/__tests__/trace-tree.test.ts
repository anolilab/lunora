import { describe, expect, it } from "vitest";

import type { ObservationSpan } from "../src/telemetry/trace-tree";
import { buildTraceTree, foldObservationTraces } from "../src/telemetry/trace-tree";

/** One span with sensible defaults. */
const span = (overrides: Partial<ObservationSpan> = {}): ObservationSpan => {
    return { durationMs: 10, endedAt: 1010, level: "info", name: "messages:send", spanId: "s1", startedAt: 1000, traceId: "t1", ...overrides };
};

describe(foldObservationTraces, () => {
    it("folds spans into one trace with real latency + counts", () => {
        const [trace] = foldObservationTraces(
            [span({ endedAt: 1010, spanId: "a", startedAt: 1000 }), span({ endedAt: 1200, level: "error", spanId: "b", startedAt: 1050 })],
            50,
        );

        expect(trace).toMatchObject({ durationMs: 200, endedAt: 1200, errorCount: 1, spanCount: 2, startedAt: 1000, traceId: "t1" });
    });

    it("takes the root op from the earliest span, order-agnostic", () => {
        const [trace] = foldObservationTraces(
            [
                span({ name: "db:read", spanId: "child", startedAt: 1100 }),
                span({ functionPath: "http:router", name: "http:router", spanId: "root", startedAt: 900 }),
            ],
            50,
        );

        expect(trace?.rootName).toBe("http:router");
        expect(trace?.rootFunctionPath).toBe("http:router");
    });

    it("returns traces newest-active first and honours the limit", () => {
        const traces = foldObservationTraces(
            [
                span({ endedAt: 200, spanId: "x", startedAt: 100, traceId: "old" }),
                span({ endedAt: 3000, spanId: "y", startedAt: 2900, traceId: "new" }),
                span({ endedAt: 2000, spanId: "z", startedAt: 1900, traceId: "mid" }),
            ],
            2,
        );

        expect(traces.map((trace) => trace.traceId)).toEqual(["new", "mid"]);
    });
});

describe(buildTraceTree, () => {
    it("nests children under their parent and indents by depth", () => {
        const rows = buildTraceTree([
            span({ endedAt: 1200, spanId: "root", startedAt: 1000 }),
            span({ endedAt: 1150, parentSpanId: "root", spanId: "child", startedAt: 1050 }),
            span({ endedAt: 1120, parentSpanId: "child", spanId: "grandchild", startedAt: 1080 }),
        ]);

        expect(rows.map((row) => [row.spanId, row.depth])).toEqual([
            ["root", 0],
            ["child", 1],
            ["grandchild", 2],
        ]);
    });

    it("positions bars by real start offset + duration", () => {
        // Trace spans 1000→1200 (200ms). A child at +50ms lasting 100ms → 25% left, 50% wide.
        const rows = buildTraceTree([
            span({ endedAt: 1200, spanId: "root", startedAt: 1000 }),
            span({ durationMs: 100, endedAt: 1150, parentSpanId: "root", spanId: "child", startedAt: 1050 }),
        ]);
        const child = rows.find((row) => row.spanId === "child");

        expect(child?.offsetMs).toBe(50);
        expect(child?.startPct).toBeCloseTo(25);
        expect(child?.durationPct).toBeCloseTo(50);
    });

    it("treats a span whose parent is absent as a root, and is cycle-safe", () => {
        const rows = buildTraceTree([span({ parentSpanId: "missing", spanId: "a" }), span({ parentSpanId: "a", spanId: "b" })]);

        expect(rows).toHaveLength(2);
        expect(rows.map((row) => row.depth)).toEqual([0, 1]);
    });
});
