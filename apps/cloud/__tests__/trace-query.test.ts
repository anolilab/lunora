import { describe, expect, it } from "vitest";

import type { TraceRollup } from "../src/telemetry/trace-tree";
import { filterTraces, matchesTraceFilter } from "../src/telemetry/trace-query";

/** One folded trace with sensible defaults. */
const trace = (overrides: Partial<TraceRollup> = {}): TraceRollup => ({
    durationMs: 100,
    endedAt: 1100,
    errorCount: 0,
    rootFunctionPath: "messages:send",
    rootName: "messages:send",
    spanCount: 3,
    startedAt: 1000,
    traceId: "t1",
    ...overrides,
});

describe(matchesTraceFilter, () => {
    it("passes every trace when the filter is empty", () => {
        expect(matchesTraceFilter(trace(), {})).toBe(true);
    });

    it("errorOnly keeps only traces with an errored span", () => {
        expect(matchesTraceFilter(trace({ errorCount: 0 }), { errorOnly: true })).toBe(false);
        expect(matchesTraceFilter(trace({ errorCount: 2 }), { errorOnly: true })).toBe(true);
    });

    it("minDurationMs keeps only traces at least that slow", () => {
        expect(matchesTraceFilter(trace({ durationMs: 40 }), { minDurationMs: 50 })).toBe(false);
        expect(matchesTraceFilter(trace({ durationMs: 80 }), { minDurationMs: 50 })).toBe(true);
    });

    it("functionPath matches a case-insensitive substring of the root op", () => {
        expect(matchesTraceFilter(trace({ rootFunctionPath: "billing:charge", rootName: "billing:charge" }), { functionPath: "CHARGE" })).toBe(true);
        expect(matchesTraceFilter(trace({ rootFunctionPath: "messages:send", rootName: "messages:send" }), { functionPath: "charge" })).toBe(false);
    });

    it("from/to keeps traces whose active window overlaps the range", () => {
        // Trace active 1000→1100.
        expect(matchesTraceFilter(trace(), { from: 1200 })).toBe(false); // ended before `from`
        expect(matchesTraceFilter(trace(), { to: 900 })).toBe(false); // started after `to`
        expect(matchesTraceFilter(trace(), { from: 1050, to: 1500 })).toBe(true); // overlaps
    });
});

describe(filterTraces, () => {
    it("keeps only matching traces, preserving order", () => {
        const traces = [trace({ errorCount: 0, traceId: "a" }), trace({ errorCount: 1, traceId: "b" }), trace({ errorCount: 3, traceId: "c" })];

        expect(filterTraces(traces, { errorOnly: true }).map((entry) => entry.traceId)).toEqual(["b", "c"]);
    });
});
