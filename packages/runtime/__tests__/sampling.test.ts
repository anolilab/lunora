import { describe, expect, it } from "vitest";

import { isTraceHeadSampled, resolveTraceSampling, shouldExportTrace, traceIdToUnitInterval } from "../../../shared/sampling";
import type { ObservabilityEvent, ObservabilitySink } from "../src/observability";
import { emitRpcEvent } from "../src/observability";
import { beginDispatchTrace } from "../src/otel-trace";

// A trace id whose first 8 hex chars are `19999999` → ~0.1 on the unit interval,
// so it is kept at headRate 0.2 and dropped at 0.05. The suffix is padding to a
// full 32-hex id and never read by the sampler.
const LOW_TRACE_ID = "19999999000000000000000000000000";
// First 8 hex `e6666666` → ~0.9, the mirror image: dropped at 0.2, kept at 0.95.
const HIGH_TRACE_ID = "e6666666000000000000000000000000";

describe("shared/sampling — deterministic head decision", () => {
    it("derives a stable [0,1) value from the first 8 hex chars of the trace id", () => {
        expect.assertions(3);

        expect(traceIdToUnitInterval("00000000ffffffffffffffffffffffff")).toBe(0);
        // 0x80000000 / 2^32 = exactly one half.
        expect(traceIdToUnitInterval("80000000ffffffffffffffffffffffff")).toBe(0.5);
        // A malformed / empty id leans keep (0), never silently dropped.
        expect(traceIdToUnitInterval("")).toBe(0);
    });

    it("returns the same verdict for the same id across repeated calls", () => {
        expect.assertions(2);

        const first = isTraceHeadSampled(LOW_TRACE_ID, 0.5);
        const second = isTraceHeadSampled(LOW_TRACE_ID, 0.5);

        expect(first).toBe(second);
        // And the mirror id lands on the opposite side of the same rate.
        expect(isTraceHeadSampled(HIGH_TRACE_ID, 0.5)).not.toBe(isTraceHeadSampled(LOW_TRACE_ID, 0.5));
    });

    it("keeps every trace at headRate 1 (the default) and drops every trace at headRate 0", () => {
        expect.assertions(4);

        expect(isTraceHeadSampled(LOW_TRACE_ID)).toBe(true);
        expect(isTraceHeadSampled(HIGH_TRACE_ID, 1)).toBe(true);
        expect(isTraceHeadSampled(LOW_TRACE_ID, 0)).toBe(false);
        // The all-`f` id (unit value at the very top) is still kept at rate 1.
        expect(isTraceHeadSampled("ffffffffffffffffffffffffffffffff", 1)).toBe(true);
    });

    it("keeps a trace below the rate and drops one above it", () => {
        expect.assertions(2);

        expect(isTraceHeadSampled(LOW_TRACE_ID, 0.2)).toBe(true);
        expect(isTraceHeadSampled(HIGH_TRACE_ID, 0.2)).toBe(false);
    });
});

describe("shared/sampling — export decision", () => {
    it("resolves defaults: keep-all head rate and errors force-kept", () => {
        expect.assertions(2);

        const decision = resolveTraceSampling(undefined, LOW_TRACE_ID);

        expect(decision.isTraced).toBe(true);
        expect(decision.keepErrors).toBe(true);
    });

    it("keeps a sampled-out trace only when it errored and errors are force-kept", () => {
        expect.assertions(4);

        const sampledOut = resolveTraceSampling({ headRate: 0 }, LOW_TRACE_ID);

        // No error → dropped; error → kept by the tail bias.
        expect(shouldExportTrace(sampledOut, false)).toBe(false);
        expect(shouldExportTrace(sampledOut, true)).toBe(true);

        // With errors NOT force-kept, even an error trace is dropped.
        const noErrorKeep = resolveTraceSampling({ alwaysSampleErrors: false, headRate: 0 }, LOW_TRACE_ID);

        expect(shouldExportTrace(noErrorKeep, true)).toBe(false);

        // A head-sampled trace is always kept regardless of error status.
        expect(shouldExportTrace(resolveTraceSampling({ headRate: 1 }, LOW_TRACE_ID), false)).toBe(true);
    });
});

describe("emitRpcEvent — trace sampling of the SERVER span", () => {
    const rpcEvent = (overrides: Partial<ObservabilityEvent> = {}): ObservabilityEvent => {
        return { durationMs: 5, functionPath: "a:b", ok: true, traceId: LOW_TRACE_ID, ...overrides };
    };

    const sinkInto = (seen: ObservabilityEvent[]): ObservabilitySink => {
        return { onRpc: (event) => seen.push(event) };
    };

    it("keeps every RPC span at headRate 1 (and when no sampling is configured)", () => {
        expect.assertions(2);

        const seen: ObservabilityEvent[] = [];

        emitRpcEvent(sinkInto(seen), rpcEvent(), undefined, { headRate: 1 });
        emitRpcEvent(sinkInto(seen), rpcEvent());

        expect(seen).toHaveLength(2);
        expect(seen[0]?.functionPath).toBe("a:b");
    });

    it("drops a non-error RPC span at headRate 0 but keeps the error one (tail bias)", () => {
        expect.assertions(2);

        const seen: ObservabilityEvent[] = [];

        emitRpcEvent(sinkInto(seen), rpcEvent({ ok: true }), undefined, { headRate: 0 });
        emitRpcEvent(sinkInto(seen), rpcEvent({ error: { code: "BAD_REQUEST", message: "nope", status: 400 }, ok: false }), undefined, { headRate: 0 });

        expect(seen).toHaveLength(1);
        expect(seen[0]?.ok).toBe(false);
    });

    it("drops even an error RPC span when alwaysSampleErrors is off", () => {
        expect.assertions(1);

        const seen: ObservabilityEvent[] = [];

        emitRpcEvent(sinkInto(seen), rpcEvent({ ok: false }), undefined, { alwaysSampleErrors: false, headRate: 0 });

        expect(seen).toHaveLength(0);
    });

    it("always keeps an event with no trace id (a fan-out aggregation)", () => {
        expect.assertions(1);

        const seen: ObservabilityEvent[] = [];

        emitRpcEvent(sinkInto(seen), rpcEvent({ ok: true, traceId: undefined }), undefined, { headRate: 0 });

        expect(seen).toHaveLength(1);
    });
});

describe("sampling verdict coherence — the propagated bit and the export gate agree", () => {
    const sinkInto = (seen: ObservabilityEvent[]): ObservabilitySink => {
        return { onRpc: (event) => seen.push(event) };
    };

    // Replay the dispatch call site exactly: settle the verdict once via
    // `beginDispatchTrace`, then gate the SERVER-span export on that same settled
    // verdict (`trace.sampled`, NOT `decision.isTraced`).
    const exportsServerSpan = (
        trace: { sampled: boolean; traceId: string },
        decision: { keepErrors: boolean },
        ok: boolean,
    ): boolean => {
        const seen: ObservabilityEvent[] = [];

        emitRpcEvent(
            sinkInto(seen),
            { durationMs: 5, functionPath: "a:b", ok, traceId: trace.traceId },
            undefined,
            undefined,
            { isTraced: trace.sampled, keepErrors: decision.keepErrors },
        );

        return seen.length === 1;
    };

    it("untrusted path: the exported SERVER span matches the propagated sampled bit for every request", () => {
        expect.assertions(3);

        // No `traceparent` → untrusted, so `beginDispatchTrace` keys the head
        // decision on the freshly-minted span id. headRate 0.5 gives a mix.
        const mismatches: number[] = [];
        let kept = 0;
        let dropped = 0;

        for (let index = 0; index < 200; index += 1) {
            const { decision, trace } = beginDispatchTrace(new Request("https://worker.internal/rpc", { method: "POST" }), {
                sampling: { headRate: 0.5 },
            });

            // (a) the bit we would propagate in the outbound `traceparent`.
            const propagated = trace.sampled;
            // (b) whether the export gate keeps this dispatch's SERVER span (no error).
            const exported = exportsServerSpan(trace, decision, true);

            if (propagated !== exported) {
                mismatches.push(index);
            }

            if (propagated) {
                kept += 1;
            } else {
                dropped += 1;
            }
        }

        // Every request agrees, and the batch actually exercised both outcomes
        // (otherwise a trivially-constant gate would pass this vacuously).
        expect(mismatches).toStrictEqual([]);
        expect(kept).toBeGreaterThan(0);
        expect(dropped).toBeGreaterThan(0);
    });

    it("trusted sampled-out upstream (flags 00): the SERVER span stays out, even at headRate 1", () => {
        expect.assertions(3);

        // A well-formed inbound trace sampled OUT by a trusted upstream.
        const request = new Request("https://worker.internal/rpc", {
            headers: { traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00" },
            method: "POST",
        });

        const { decision, trace } = beginDispatchTrace(request, { sampling: { headRate: 1 }, trustInbound: true });

        // The trace is kept or dropped whole: a trusted `00` propagates as unsampled
        // regardless of our own head rate.
        expect(trace.sampled).toBe(false);
        // Non-error dispatch → the SERVER span is held back, no orphan on the collector.
        expect(exportsServerSpan(trace, decision, true)).toBe(false);
        // But an errored dispatch is still force-kept by the tail bias (alwaysSampleErrors default).
        expect(exportsServerSpan(trace, decision, false)).toBe(true);
    });
});
