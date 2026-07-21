import { describe, expect, it } from "vitest";

import type { TraceLogRow } from "../src/telemetry/traces";
import { foldTraces } from "../src/telemetry/traces";

/** One log row for the fold, with sensible defaults. */
const row = (overrides: Partial<TraceLogRow> = {}): TraceLogRow => {
    return { createdAt: 1000, functionPath: "messages:list", level: "info", traceId: "t1", ...overrides };
};

describe(foldTraces, () => {
    it("folds lines sharing a traceId into one trace with count + time span", () => {
        expect.assertions(4);

        const [trace] = foldTraces([row({ createdAt: 1000 }), row({ createdAt: 1200 }), row({ createdAt: 1050 })], 50);

        expect(trace?.lineCount).toBe(3);
        expect(trace?.startedAt).toBe(1000);
        expect(trace?.endedAt).toBe(1200);
        expect(trace?.traceId).toBe("t1");
    });

    it("takes the root function from the earliest line, regardless of input order", () => {
        expect.assertions(1);

        // The oldest line (createdAt 900) entered at `http:router`, later lines at `messages:list`.
        const [trace] = foldTraces([row({ createdAt: 1200 }), row({ createdAt: 900, functionPath: "http:router" }), row({ createdAt: 1000 })], 50);

        expect(trace?.functionPath).toBe("http:router");
    });

    it("reports the peak severity and flags a failure", () => {
        expect.assertions(4);

        const [ok] = foldTraces([row({ level: "info" }), row({ level: "warn" })], 50);

        expect(ok?.maxLevel).toBe("warn");
        expect(ok?.hasError).toBe(false);

        const [bad] = foldTraces([row({ level: "info" }), row({ level: "error" }), row({ level: "debug" })], 50);

        expect(bad?.maxLevel).toBe("error");
        expect(bad?.hasError).toBe(true);
    });

    it("skips lines with no traceId (they belong to the Logs view)", () => {
        expect.assertions(2);

        const traces = foldTraces([row({ traceId: undefined }), row({ traceId: "" }), row({ traceId: "t1" })], 50);

        expect(traces).toHaveLength(1);
        expect(traces[0]?.lineCount).toBe(1);
    });

    it("returns distinct traces newest-active first and honours the limit", () => {
        expect.assertions(3);

        const traces = foldTraces(
            [row({ createdAt: 100, traceId: "old" }), row({ createdAt: 3000, traceId: "new" }), row({ createdAt: 2000, traceId: "mid" })],
            2,
        );

        expect(traces).toHaveLength(2);
        // Ordered by last activity (endedAt) descending; the oldest is dropped by the limit.
        expect(traces[0]?.traceId).toBe("new");
        expect(traces[1]?.traceId).toBe("mid");
    });

    it("folds identically no matter the row order", () => {
        expect.assertions(1);

        const rows = [row({ createdAt: 1000, level: "info" }), row({ createdAt: 1200, level: "error" }), row({ createdAt: 900, functionPath: "http:router" })];
        const forward = foldTraces(rows, 50);
        const reversed = foldTraces([...rows].reverse(), 50);

        expect(reversed).toEqual(forward);
    });
});
