import { describe, expect, it } from "vitest";

import { beginDispatchTrace, extractTraceContext, injectTraceContext, isSampled, SAMPLED_FLAG, sanitizeTraceState, UNSAMPLED_FLAG } from "../src/otel-trace";

/** A well-formed, sampled inbound traceparent. */
const UPSTREAM_TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const UPSTREAM_SPAN_ID = "b7ad6b7169203331";
const SAMPLED_TRACEPARENT = `00-${UPSTREAM_TRACE_ID}-${UPSTREAM_SPAN_ID}-01`;
const UNSAMPLED_TRACEPARENT = `00-${UPSTREAM_TRACE_ID}-${UPSTREAM_SPAN_ID}-00`;

const requestWith = (headers: Record<string, string>): Request => new Request("https://app.example/_lunora/rpc", { headers, method: "POST" });

describe("otel-trace", () => {
    describe("extractTraceContext", () => {
        it("returns undefined when no traceparent header is present", () => {
            expect.assertions(1);

            expect(extractTraceContext(new Request("https://app.example/_lunora/rpc", { method: "POST" }))).toBeUndefined();
        });

        it("extracts trace id, parent span id, and sampled flag from a valid traceparent", () => {
            expect.assertions(4);

            const context = extractTraceContext(requestWith({ traceparent: SAMPLED_TRACEPARENT }));

            expect(context).toBeDefined();
            expect(context!.traceId).toBe(UPSTREAM_TRACE_ID);
            expect(context!.parentSpanId).toBe(UPSTREAM_SPAN_ID);
            expect(context!.sampled).toBe(true);
        });

        it("rejects a malformed traceparent", () => {
            expect.assertions(1);

            expect(extractTraceContext(requestWith({ traceparent: "00-invalid-01" }))).toBeUndefined();
        });

        it("rejects the all-zero trace id the spec forbids", () => {
            expect.assertions(1);

            expect(extractTraceContext(requestWith({ traceparent: `00-${"0".repeat(32)}-${UPSTREAM_SPAN_ID}-01` }))).toBeUndefined();
        });

        // The shared parser is deliberately forward-compatible where an OTel SDK
        // propagator is not: a future version may append fields, and the spec says
        // to parse off the first four rather than drop the header.
        it("accepts a future version that appends fields", () => {
            expect.assertions(1);

            const context = extractTraceContext(requestWith({ traceparent: `01-${UPSTREAM_TRACE_ID}-${UPSTREAM_SPAN_ID}-01-extra` }));

            expect(context?.traceId).toBe(UPSTREAM_TRACE_ID);
        });
    });

    describe("sanitizeTraceState", () => {
        it("accepts a well-formed vendor list", () => {
            expect.assertions(1);

            // The W3C spec's own example list; the entropy heuristic reads it as a
            // credential, but vendor keys must stay lowercase or the grammar rejects them.
            // eslint-disable-next-line no-secrets/no-secrets -- see above
            const spec = "congo=congosSecondPosition,rojo=00f067aa0ba902b7";

            expect(sanitizeTraceState(spec)).toBe(spec);
        });

        it.each([
            ["an uppercase key", "Congo=value"],
            ["a member with no value", "congo="],
            ["a comma-only payload", ",,,"],
            ["an oversize header", `congo=${"a".repeat(600)}`],
            ["more than 32 members", Array.from({ length: 33 }, (_, index) => `k${String(index)}=v`).join(",")],
        ])("rejects %s", (_label, header) => {
            expect.assertions(1);

            expect(sanitizeTraceState(header)).toBeUndefined();
        });
    });

    describe("beginDispatchTrace", () => {
        // The security property: the trace id is what `shared/sampling` hashes into
        // a keep/drop verdict, so a caller-chosen id would let a client pick its own
        // sampling outcome. Untrusted, we must not adopt it at all.
        it("ignores the inbound trace context by default", () => {
            expect.assertions(4);

            const { trace } = beginDispatchTrace(requestWith({ traceparent: SAMPLED_TRACEPARENT, tracestate: "congo=t61rcWkgMzE" }));

            expect(trace.traceId).not.toBe(UPSTREAM_TRACE_ID);
            expect(trace.traceId).toHaveLength(32);
            expect(trace.parentSpanId).toBeUndefined();
            expect(trace.traceState).toBeUndefined();
        });

        it("continues the inbound trace when the upstream is trusted", () => {
            expect.assertions(3);

            const { trace } = beginDispatchTrace(requestWith({ traceparent: SAMPLED_TRACEPARENT }), { trustInbound: true });

            expect(trace.traceId).toBe(UPSTREAM_TRACE_ID);
            expect(trace.parentSpanId).toBe(UPSTREAM_SPAN_ID);
            expect(trace.spanId).not.toBe(UPSTREAM_SPAN_ID);
        });

        it("carries a trusted upstream tracestate onto the dispatch span", () => {
            expect.assertions(1);

            const { trace } = beginDispatchTrace(requestWith({ traceparent: SAMPLED_TRACEPARENT, tracestate: "congo=t61rcWkgMzE" }), { trustInbound: true });

            expect(trace.traceState).toBe("congo=t61rcWkgMzE");
        });

        it("drops a malformed tracestate rather than echoing it downstream", () => {
            expect.assertions(1);

            const { trace } = beginDispatchTrace(requestWith({ traceparent: SAMPLED_TRACEPARENT, tracestate: "NOT A VALID LIST" }), { trustInbound: true });

            expect(trace.traceState).toBeUndefined();
        });

        it("mints a fresh trace when there is no inbound context", () => {
            expect.assertions(4);

            const { trace } = beginDispatchTrace(new Request("https://app.example/_lunora/rpc", { method: "POST" }));

            expect(trace.traceId).toHaveLength(32);
            expect(trace.spanId).toHaveLength(16);
            expect(trace.sampled).toBe(true);
            expect(trace.traceFlags).toBe(SAMPLED_FLAG);
        });

        it("honours a trusted upstream that already sampled the trace out", () => {
            expect.assertions(2);

            const { trace } = beginDispatchTrace(requestWith({ traceparent: UNSAMPLED_TRACEPARENT }), { trustInbound: true });

            expect(trace.sampled).toBe(false);
            expect(trace.traceFlags).toBe(UNSAMPLED_FLAG);
        });

        // `traceFlags` is what the OTLP span reports and `sampled` is what goes on
        // the wire; these were two independent values before and could disagree.
        it("keeps the span flags and the propagated header in agreement", () => {
            expect.assertions(2);

            const headers: Record<string, string> = {};
            const { trace } = beginDispatchTrace(requestWith({ traceparent: UNSAMPLED_TRACEPARENT }), { trustInbound: true });

            injectTraceContext(trace, headers);

            expect(isSampled(trace.traceFlags)).toBe(false);
            expect(headers.traceparent).toMatch(/-00$/);
        });

        // The attack: `traceIdToUnitInterval` maps the last 8 hex chars onto
        // [0, 1), so an all-`f` id lands at ~1.0 and is dropped by any headRate < 1.
        // A client that could choose the id could opt itself out of every trace.
        it("does not let an untrusted caller steer the head-sampling verdict", () => {
            expect.assertions(1);

            const evasive = `00-${"f".repeat(32)}-${UPSTREAM_SPAN_ID}-01`;
            const kept = Array.from({ length: 40 }, () => beginDispatchTrace(requestWith({ traceparent: evasive }), { sampling: { headRate: 0.5 } })).filter(
                (result) => result.decision.isTraced,
            );

            // Keyed on the server-minted span id, ~half survive; keyed on the
            // caller's id, none would.
            expect(kept.length).toBeGreaterThan(0);
        });

        it("lets a trusted upstream's trace id drive sampling so a trace stays whole", () => {
            expect.assertions(1);

            const evasive = `00-${"f".repeat(32)}-${UPSTREAM_SPAN_ID}-01`;
            const results = Array.from({ length: 10 }, () =>
                beginDispatchTrace(requestWith({ traceparent: evasive }), { sampling: { headRate: 0.5 }, trustInbound: true }),
            );

            // Same trusted trace id → same verdict every time, so no half traces.
            expect(new Set(results.map((result) => result.decision.isTraced)).size).toBe(1);
        });
    });

    describe("injectTraceContext", () => {
        it("writes a W3C traceparent into the header bag", () => {
            expect.assertions(1);

            const headers: Record<string, string> = {};

            injectTraceContext(beginDispatchTrace(requestWith({})).trace, headers);

            expect(headers.traceparent).toMatch(/^00-[\da-f]{32}-[\da-f]{16}-01$/);
        });

        it("preserves existing headers", () => {
            expect.assertions(2);

            const headers: Record<string, string> = { "content-type": "application/json" };

            injectTraceContext(beginDispatchTrace(requestWith({})).trace, headers);

            expect(headers["content-type"]).toBe("application/json");
            expect(headers.traceparent).toBeDefined();
        });

        it("propagates a trusted tracestate to the next hop", () => {
            expect.assertions(1);

            const headers: Record<string, string> = {};
            const { trace } = beginDispatchTrace(requestWith({ traceparent: SAMPLED_TRACEPARENT, tracestate: "congo=t61rcWkgMzE" }), { trustInbound: true });

            injectTraceContext(trace, headers);

            expect(headers.tracestate).toBe("congo=t61rcWkgMzE");
        });

        it("omits tracestate entirely when there is none", () => {
            expect.assertions(1);

            const headers: Record<string, string> = {};

            injectTraceContext(beginDispatchTrace(requestWith({})).trace, headers);

            expect(headers.tracestate).toBeUndefined();
        });
    });
});
