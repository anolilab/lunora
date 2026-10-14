import { describe, expect, it } from "vitest";

import type { MetricEvent } from "../../../shared/metric-event";
import type { SpanEvent } from "../../../shared/span-event";
import { otlpMetricBody, otlpSpanBody } from "../src/otlp-export";

const TRACE_ID = "0af7651916cd43dd8448eb211c80319c";

/**
 * Two wire-level correlation details that are invisible until a collector drops
 * the data: a span with no `flags` reads as UNSAMPLED (0), and a metric point
 * with no exemplar cannot be navigated back to the trace that produced it.
 */

const span = (overrides: Partial<SpanEvent> = {}): SpanEvent => {
    return {
        durationMs: 12,
        functionPath: "orders:checkout",
        name: "stripe.charge",
        ok: true,
        parentSpanId: "b7ad6b7169203331",
        spanId: "00f067aa0ba902b7",
        startTs: 1_700_000_000_000,
        traceId: TRACE_ID,
        ...overrides,
    };
};

const metric = (overrides: Partial<MetricEvent> = {}): MetricEvent => {
    return { functionPath: "orders:checkout", kind: "counter", name: "orders.placed", traceId: TRACE_ID, ts: 1_700_000_000_000, value: 3, ...overrides };
};

describe("otlpSpanBody — W3C trace flags", () => {
    it("marks a span of a sampled trace as SAMPLED", () => {
        expect.assertions(1);

        expect(otlpSpanBody(span({ sampled: true }))).toMatchObject({ flags: 1 });
    });

    // A trace kept only by the tail bias (head-sampled out, then errored) is
    // exported with the flag CLEAR — that is what the bit says, and claiming
    // `sampled` on it would misreport the trace's verdict to the collector.
    it("marks a span the tail bias rescued as UNSAMPLED", () => {
        expect.assertions(1);

        expect(otlpSpanBody(span({ ok: false, sampled: false }))).toMatchObject({ flags: 0 });
    });

    // A span recorded on a tier that never saw a verdict (no inbound
    // `traceparent`) reads as keep, exactly like every other sampling decision.
    it("defaults to SAMPLED when no verdict reached this span", () => {
        expect.assertions(1);

        expect(otlpSpanBody(span())).toMatchObject({ flags: 1 });
    });
});

describe("otlpMetricBody — trace exemplars", () => {
    it("attaches the recording dispatch's trace id as an exemplar on a counter", () => {
        expect.assertions(1);

        const body = otlpMetricBody(metric()) as { sum: { dataPoints: { exemplars?: { traceId: string }[] }[] } };

        expect(body.sum.dataPoints[0]!.exemplars).toStrictEqual([{ asDouble: 3, timeUnixNano: "1700000000000000000", traceId: TRACE_ID }]);
    });

    it("attaches one on a gauge and on a histogram too", () => {
        expect.assertions(2);

        const gauge = otlpMetricBody(metric({ kind: "gauge" })) as { gauge: { dataPoints: { exemplars?: unknown[] }[] } };
        const histogram = otlpMetricBody(metric({ kind: "histogram" })) as { histogram: { dataPoints: { exemplars?: unknown[] }[] } };

        expect(gauge.gauge.dataPoints[0]!.exemplars).toHaveLength(1);
        expect(histogram.histogram.dataPoints[0]!.exemplars).toHaveLength(1);
    });

    it("omits the exemplar when the measurement ran outside a trace", () => {
        expect.assertions(1);

        const body = otlpMetricBody(metric({ traceId: undefined })) as { sum: { dataPoints: Record<string, unknown>[] } };

        expect(body.sum.dataPoints[0]).not.toHaveProperty("exemplars");
    });
});
