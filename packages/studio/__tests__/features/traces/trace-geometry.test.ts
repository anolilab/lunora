import { describe, expect, it } from "vitest";

import { filterTraces, formatSpanDuration, spanBar } from "../../../src/features/traces/trace-geometry";
import type { TraceSpan, TraceSummary } from "../../../src/lib/admin";

const span = (overrides: Partial<TraceSpan> = {}): TraceSpan => {
    return {
        depth: 0,
        durationMs: 10,
        name: "root",
        offsetMs: 0,
        ok: true,
        parentSpanId: "",
        spanId: "aaaa",
        ...overrides,
    };
};

const trace = (overrides: Partial<TraceSummary> = {}): TraceSummary => {
    return {
        durationMs: 100,
        functionPath: "messages:list",
        ok: true,
        rootName: "dispatch",
        spans: [span()],
        startTs: 1_700_000_000_000,
        traceId: "abc123",
        ...overrides,
    };
};

describe("spanBar", () => {
    it("positions and sizes a span as a percentage of the trace duration", () => {
        expect.assertions(2);

        const bar = spanBar(span({ durationMs: 25, offsetMs: 50 }), 100);

        expect(bar.leftPercent).toBe(50);
        expect(bar.widthPercent).toBe(25);
    });

    it("lays every span out full-width when the trace duration is zero (avoids NaN%)", () => {
        expect.assertions(1);

        // A DO trace whose whole dispatch settled inside one wall-clock ms folds to
        // durationMs 0; dividing by it would yield NaN, so the whole trace goes full-width.
        expect(spanBar(span({ durationMs: 5, offsetMs: 3 }), 0)).toEqual({ leftPercent: 0, widthPercent: 100 });
    });

    it("lays out full-width when the trace duration is non-finite", () => {
        expect.assertions(2);

        expect(spanBar(span(), Number.NaN)).toEqual({ leftPercent: 0, widthPercent: 100 });
        expect(spanBar(span(), Number.POSITIVE_INFINITY)).toEqual({ leftPercent: 0, widthPercent: 100 });
    });

    it("clamps a bar so it cannot overflow the track to the right of its left edge", () => {
        expect.assertions(2);

        // A partial trace's anchor is a survivor, not the true root, so a span can end
        // past the trace end. Width is clipped to what remains to the right of leftPercent.
        const bar = spanBar(span({ durationMs: 90, offsetMs: 80 }), 100);

        expect(bar.leftPercent).toBe(80);
        expect(bar.widthPercent).toBe(20);
    });

    it("floors a sub-millisecond span to the minimum bar width so it never vanishes", () => {
        expect.assertions(1);

        // 0.1ms of a 1000ms trace = 0.01%, which would round to an invisible 0-width bar.
        expect(spanBar(span({ durationMs: 0.1, offsetMs: 0 }), 1000).widthPercent).toBe(0.5);
    });
});

describe("filterTraces", () => {
    const traces = [
        trace({ functionPath: "messages:list", rootName: "listMessages", traceId: "aaa111" }),
        trace({ functionPath: "auth:login", rootName: "signIn", traceId: "bbb222" }),
    ];

    it("returns every trace for an empty or whitespace-only term", () => {
        expect.assertions(2);

        expect(filterTraces(traces, "")).toHaveLength(2);
        expect(filterTraces(traces, "   ")).toHaveLength(2);
    });

    it("matches case-insensitively on rootName, functionPath, and traceId", () => {
        expect.assertions(3);

        expect(filterTraces(traces, "SIGNIN").map((t) => t.functionPath)).toEqual(["auth:login"]);
        expect(filterTraces(traces, "messages:").map((t) => t.functionPath)).toEqual(["messages:list"]);
        expect(filterTraces(traces, "bbb222").map((t) => t.functionPath)).toEqual(["auth:login"]);
    });

    it("returns a fresh array (does not alias the input) for the match-all case", () => {
        expect.assertions(2);

        const all = filterTraces(traces, "");

        expect(all).not.toBe(traces);
        expect(all).toEqual(traces);
    });
});

describe("formatSpanDuration", () => {
    it("shows sub-millisecond spans to two decimals so an instant span is not a bare 0ms", () => {
        expect.assertions(1);

        expect(formatSpanDuration(0.4)).toBe("0.40ms");
    });

    it("rounds a span of one millisecond or longer to a whole millisecond", () => {
        expect.assertions(2);

        expect(formatSpanDuration(12.6)).toBe("13ms");
        expect(formatSpanDuration(1)).toBe("1ms");
    });

    it("renders a non-finite duration as an em-dash", () => {
        expect.assertions(2);

        expect(formatSpanDuration(Number.NaN)).toBe("—");
        expect(formatSpanDuration(Number.POSITIVE_INFINITY)).toBe("—");
    });

    it("renders an exact-zero duration as 0ms (not the sub-ms decimal form)", () => {
        expect.assertions(1);

        expect(formatSpanDuration(0)).toBe("0ms");
    });
});
