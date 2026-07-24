import { describe, expect, it } from "vitest";

import { createDispatchSpanContext, extractTraceContext, injectTraceContext, isSampled, SAMPLED_FLAG, UNSAMPLED_FLAG } from "../src/otel-trace";

describe("otel-trace", () => {
    describe("extractTraceContext", () => {
        it("returns undefined when no traceparent header is present", () => {
            expect.hasAssertions();

            const request = new Request("https://app.example/_lunora/rpc", { method: "POST" });

            expect(extractTraceContext(request)).toBeUndefined();
        });

        it("extracts trace id, parent span id, and sampled flag from a valid traceparent", () => {
            expect.hasAssertions();

            const request = new Request("https://app.example/_lunora/rpc", {
                headers: { traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" },
                method: "POST",
            });
            const context = extractTraceContext(request);

            expect(context).toBeDefined();
            expect(context!.traceId).toBe("0af7651916cd43dd8448eb211c80319c");
            expect(context!.spanId).toBe("b7ad6b7169203331");
            expect(isSampled(context!.traceFlags)).toBe(true);
        });

        it("rejects a malformed traceparent", () => {
            expect.hasAssertions();

            const request = new Request("https://app.example/_lunora/rpc", {
                headers: { traceparent: "00-invalid-01" },
                method: "POST",
            });

            expect(extractTraceContext(request)).toBeUndefined();
        });
    });

    describe("createDispatchSpanContext", () => {
        it("inherits the trace id and trace flags from an upstream context", () => {
            expect.hasAssertions();

            const upstream = extractTraceContext(
                new Request("https://app.example/_lunora/rpc", {
                    headers: { traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00" },
                    method: "POST",
                }),
            )!;
            const dispatch = createDispatchSpanContext(upstream);

            expect(dispatch.traceId).toBe("0af7651916cd43dd8448eb211c80319c");
            expect(dispatch.traceFlags).toBe(UNSAMPLED_FLAG);
            expect(dispatch.spanId).toHaveLength(16);
            expect(dispatch.spanId).not.toBe("b7ad6b7169203331");
        });

        it("mints a fresh trace id and span id when there is no upstream context", () => {
            expect.hasAssertions();

            const dispatch = createDispatchSpanContext();

            expect(dispatch.traceId).toHaveLength(32);
            expect(dispatch.spanId).toHaveLength(16);
            expect(dispatch.traceFlags).toBe(SAMPLED_FLAG);
        });

        it("carries the upstream tracestate through to the dispatch span", () => {
            expect.hasAssertions();

            const upstream = extractTraceContext(
                new Request("https://app.example/_lunora/rpc", {
                    headers: {
                        traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
                        // eslint-disable-next-line no-secrets/no-secrets -- verbatim `tracestate` example from the W3C Trace Context spec, not a credential. Vendor keys must be lowercase or the propagator drops them, so the literal cannot be simplified into something the entropy check likes.
                        tracestate: "congo=t61rcWkgMzE,rojo=00f067aa0ba902b7",
                    },
                    method: "POST",
                }),
            )!;
            const dispatch = createDispatchSpanContext(upstream);

            expect(dispatch.traceState?.get("congo")).toBe("t61rcWkgMzE");
            expect(dispatch.traceState?.get("rojo")).toBe("00f067aa0ba902b7");
            // The local dispatch span is ours to run, not the extracted remote one.
            expect(dispatch.isRemote).toBe(false);
        });
    });

    describe("injectTraceContext", () => {
        it("writes a W3C traceparent into the header bag", () => {
            expect.hasAssertions();

            const dispatch = createDispatchSpanContext();
            const headers: Record<string, string> = {};

            injectTraceContext(dispatch, headers);

            expect(headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
        });

        it("preserves existing headers", () => {
            expect.hasAssertions();

            const dispatch = createDispatchSpanContext();
            const headers: Record<string, string> = { "content-type": "application/json" };

            injectTraceContext(dispatch, headers);

            expect(headers["content-type"]).toBe("application/json");
            expect(headers.traceparent).toBeDefined();
        });

        // The end-to-end reason `createDispatchSpanContext` carries `traceState`:
        // without it the propagator emits no `tracestate` and the vendor
        // correlation chain dies at this hop.
        it("propagates the upstream tracestate to the next hop", () => {
            expect.hasAssertions();

            const upstream = extractTraceContext(
                new Request("https://app.example/_lunora/rpc", {
                    headers: {
                        traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
                        tracestate: "congo=t61rcWkgMzE",
                    },
                    method: "POST",
                }),
            )!;
            const headers: Record<string, string> = {};

            injectTraceContext(createDispatchSpanContext(upstream), headers);

            expect(headers.tracestate).toBe("congo=t61rcWkgMzE");
        });
    });
});
