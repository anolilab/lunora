import { describe, expect, it, vi } from "vitest";

import { parseTraceparent } from "../../../shared/otlp";
import type { SpanEvent } from "../../../shared/span-event";
import { createTracedFetch } from "../src/context-telemetry";

/**
 * The instrumented `ctx.fetch`.
 *
 * Two properties carry the whole feature. The header must name the span that is
 * actually recorded — otherwise the callee parents itself to a span that never
 * existed and the trace is silently broken at the hop this exists to bridge. And
 * the span must never change what the caller observes: same response, same
 * throw, no matter what the telemetry does.
 */

const anchor = { rootSpanId: "b7ad6b7169203331", traceId: "0af7651916cd43dd8448eb211c80319c" };

const makeDeps = (spans: SpanEvent[], propagate?: ((url: URL) => boolean) | boolean, anchorOverride?: typeof anchor & { sampled?: boolean }) => {
    return {
        anchor: anchorOverride ?? anchor,
        functionPath: "orders:checkout",
        ...(propagate === undefined ? {} : { propagate }),
        record: (span: SpanEvent) => {
            spans.push(span);
        },
        shardKey: "tenant-1",
        userId: () => "u-1",
    };
};

describe("createTracedFetch", () => {
    it("injects a traceparent naming the span it actually records", async () => {
        expect.assertions(3);

        const spans: SpanEvent[] = [];
        const base = vi.fn<(request: Request) => Promise<Response>>(
            async (request) => new Response("ok", { headers: { seen: request.headers.get("traceparent") ?? "" } }),
        );
        const traced = createTracedFetch(makeDeps(spans), base as never);

        const response = await traced("https://api.stripe.com/v1/charges");
        const sent = parseTraceparent(response.headers.get("seen"));

        expect(sent?.traceId).toBe(anchor.traceId);
        // The id in the header IS the recorded span's id. Anything else leaves the
        // callee parented to a span that was never exported.
        expect(sent?.parentSpanId).toBe(spans[0]?.spanId);
        expect(spans[0]?.traceId).toBe(anchor.traceId);
    });

    it("propagates the anchor's sampled verdict rather than always claiming sampled", async () => {
        expect.assertions(2);

        const spans: SpanEvent[] = [];
        const seen: (null | string)[] = [];
        const base = vi.fn<(request: Request) => Promise<Response>>(async (request) => {
            seen.push(request.headers.get("traceparent"));

            return new Response("ok");
        });

        // An upstream that sampled this trace OUT. Telling the callee otherwise
        // makes it record spans for a trace nobody kept.
        const unsampled = createTracedFetch(makeDeps(spans, undefined, { ...anchor, sampled: false }), base as never);

        await unsampled("https://api.stripe.com/v1/charges");

        expect(parseTraceparent(seen[0])?.sampled).toBe(false);

        // No inbound verdict to honour — the shard is the trace root, so it samples.
        const sampled = createTracedFetch(makeDeps(spans, undefined, { ...anchor, sampled: true }), base as never);

        await sampled("https://api.stripe.com/v1/charges");

        expect(parseTraceparent(seen[1])?.sampled).toBe(true);
    });

    it("records a CLIENT span with a low-cardinality name", async () => {
        expect.assertions(3);

        const spans: SpanEvent[] = [];
        const traced = createTracedFetch(makeDeps(spans), async () => new Response("ok"));

        await traced("https://api.stripe.com/v1/charges/ch_12345");

        // CLIENT is what draws the edge to the downstream service in a service map.
        expect(spans[0]?.kind).toBe("client");
        // Host, never the path: a name carrying `ch_12345` makes every charge its
        // own group in a collector and destroys the aggregate views.
        expect(spans[0]?.name).toBe("GET api.stripe.com");
        expect(spans[0]?.attributes?.["http.response.status_code"]).toBe(200);
    });

    it("strips the query string from the recorded url", async () => {
        expect.assertions(1);

        const spans: SpanEvent[] = [];
        const traced = createTracedFetch(makeDeps(spans), async () => new Response("ok"));

        await traced("https://api.example.com/search?api_key=sk_live_secret&q=hat");

        // A query string routinely carries API keys and signed-URL signatures, and
        // a span is exactly the thing shipped to a third party and kept for months.
        expect(spans[0]?.attributes?.["url.full"]).toBe("https://api.example.com/search");
    });

    it("marks a non-2xx response as an error span but still returns it", async () => {
        expect.assertions(3);

        const spans: SpanEvent[] = [];
        const traced = createTracedFetch(makeDeps(spans), async () => new Response("nope", { status: 503 }));

        const response = await traced("https://api.example.com/thing");

        // Failed from the caller's point of view, so the span says so — but the
        // response is handed back untouched, because this is instrumentation.
        expect(response.status).toBe(503);
        expect(spans[0]?.ok).toBe(false);
        expect(spans[0]?.error?.type).toBe("HTTP_503");
    });

    it("records a network failure and re-throws it untouched", async () => {
        expect.assertions(2);

        const spans: SpanEvent[] = [];
        const traced = createTracedFetch(makeDeps(spans), async () => {
            throw new TypeError("network unreachable");
        });

        await expect(traced("https://api.example.com/thing")).rejects.toThrow("network unreachable");
        expect(spans[0]?.ok).toBe(false);
    });

    it("honours a propagation predicate, still recording the span", async () => {
        expect.assertions(3);

        const spans: SpanEvent[] = [];
        const seen: (null | string)[] = [];
        const base = vi.fn<(request: Request) => Promise<Response>>(async (request) => {
            seen.push(request.headers.get("traceparent"));

            return new Response("ok");
        });
        const traced = createTracedFetch(
            makeDeps(spans, (url) => url.host.endsWith(".internal")),
            base as never,
        );

        await traced("https://billing.internal/charge");
        await traced("https://api.stripe.com/v1/charges");

        expect(seen[0]).not.toBeNull();
        // Opting out of leaking trace ids to a third party must not also opt out
        // of MEASURING the call — those are separate concerns.
        expect(seen[1]).toBeNull();
        expect(spans).toHaveLength(2);
    });
});
