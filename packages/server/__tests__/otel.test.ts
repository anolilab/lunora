import type { SpanEvent } from "@lunora/observability";
import { createSpanCollector, createTracer } from "@lunora/observability";
import { context as otelContext, SpanKind, SpanStatusCode, trace as otelTrace, TraceFlags } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";

import type { LunoraTraceContext } from "../src/otel";
import { createOtelTracer } from "../src/otel";

/**
 * The bridge's contract is narrow but load-bearing: a third-party library's
 * spans must land in the SAME trace as the request, with real timings, and must
 * not be able to break the handler that happens to use that library.
 *
 * Every case drives the REAL `@lunora/observability` span factory rather than a
 * double, because the defect this file exists to catch is a DIVERGENCE between
 * the ids the bridge hands a library and the ids the tracer records. A fake whose
 * `spanContext()` echoes back whatever it was handed can only assert that a span
 * id looks like hex — which is exactly how the bridge got away with minting a
 * private id it announced to callers and never put on the wire.
 */

const DISPATCH = { spanId: "b7ad6b7169203331", traceId: "0af7651916cd43dd8448eb211c80319c" };

/** An 8-byte span id, hex-encoded per the OTLP/JSON `span_id` exception. */
const SPAN_ID_HEX = /^[0-9a-f]{16}$/;

/**
 * A `ctx` double backed by the real span factory: `ctx.trace` is
 * `createTracer(...)` bound to a dispatch anchor and `ctx.span` is the dispatch's
 * own handle, assembled exactly as `@lunora/do` assembles them.
 */
const realContext = (sampled?: boolean): { ctx: LunoraTraceContext; recorded: SpanEvent[] } => {
    const recorded: SpanEvent[] = [];
    const verdict = sampled === undefined ? {} : { sampled };
    const anchor = { ...verdict, rootSpanId: DISPATCH.spanId, traceId: DISPATCH.traceId };

    const ctx: LunoraTraceContext = {
        span: createSpanCollector({ ...verdict, spanId: anchor.rootSpanId, traceId: anchor.traceId }).handle,
        trace: createTracer({
            anchor,
            functionPath: "messages:list",
            record: (span) => {
                recorded.push(span);
            },
            shardKey: undefined,
            userId: () => undefined,
        }),
    };

    return { ctx, recorded };
};

/** Let the microtask queue drain so the suspended `ctx.trace` body can settle. */
const settle = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
};

/** The recorded span called `name`. */
const spanNamed = (recorded: SpanEvent[], name: string): SpanEvent | undefined => recorded.find((span) => span.name === name);

describe(createOtelTracer, () => {
    it("records nothing until the span is ended", async () => {
        expect.assertions(2);

        const { ctx, recorded } = realContext();
        const span = createOtelTracer(ctx).startSpan("ai.generateText");

        await settle();

        // An unended span is not exported — matching OTel's own contract, and
        // better than inventing an end time.
        expect(recorded).toHaveLength(0);

        span.end();
        await settle();

        expect(recorded[0]?.name).toBe("ai.generateText");
    });

    it("puts the bridged span in the dispatch's trace", () => {
        expect.assertions(2);

        const { ctx } = realContext();
        const span = createOtelTracer(ctx).startSpan("doGenerate");

        // The whole point: a library's span joins the request's trace instead of
        // starting an orphan one nobody can correlate.
        expect(span.spanContext().traceId).toBe(DISPATCH.traceId);
        // Its own id is fresh, and readable synchronously so a caller can build a
        // `traceparent` from it immediately.
        expect(span.spanContext().spanId).toMatch(SPAN_ID_HEX);
    });

    it("records the span under the very id it handed the caller", async () => {
        expect.assertions(2);

        const { ctx, recorded } = realContext();
        const span = createOtelTracer(ctx).startSpan("doGenerate");
        // Read the way a library reads it: synchronously, to build a `traceparent`
        // for the call it is about to make.
        const announced = span.spanContext().spanId;

        span.end();
        await settle();

        // The id announced downstream MUST be the id the collector receives. When
        // these diverge every callee parents to a span that never existed.
        expect(recorded[0]?.spanId).toBe(announced);
        expect(recorded[0]?.parentSpanId).toBe(DISPATCH.spanId);
    });

    it("parents to the span named by the threaded Context", async () => {
        expect.assertions(3);

        const { ctx, recorded } = realContext();
        const tracer = createOtelTracer(ctx);
        const parent = tracer.startSpan("outer");
        const child = tracer.startSpan("inner", {}, otelTrace.setSpan(otelContext.active(), parent));

        child.end();
        parent.end();
        await settle();

        // A threaded parent is the only nesting available without an ambient span
        // stack, so ignoring it flattens every library that does thread one.
        expect(spanNamed(recorded, "inner")?.parentSpanId).toBe(parent.spanContext().spanId);
        expect(spanNamed(recorded, "outer")?.parentSpanId).toBe(DISPATCH.spanId);
        expect(spanNamed(recorded, "inner")?.spanId).toBe(child.spanContext().spanId);
    });

    it("parents a startActiveSpan child to the Context it was scoped with", async () => {
        expect.assertions(1);

        const { ctx, recorded } = realContext();
        const tracer = createOtelTracer(ctx);
        const parent = tracer.startSpan("outer");

        tracer.startActiveSpan("inner", {}, otelTrace.setSpan(otelContext.active(), parent), (span) => {
            span.end();
        });

        parent.end();
        await settle();

        expect(spanNamed(recorded, "inner")?.parentSpanId).toBe(parent.spanContext().spanId);
    });

    it("ignores a threaded Context that names a span in ANOTHER trace", async () => {
        expect.assertions(1);

        const { ctx, recorded } = realContext();
        const foreign = otelTrace.setSpanContext(otelContext.active(), {
            spanId: "aaaaaaaaaaaaaaaa",
            traceFlags: TraceFlags.SAMPLED,
            traceId: "b".repeat(32),
        });

        const span = createOtelTracer(ctx).startSpan("inner", {}, foreign);

        span.end();
        await settle();

        // Parenting across traces invents an edge that does not exist; the
        // dispatch is the honest answer. (A cross-trace relationship is a LINK.)
        expect(recorded[0]?.parentSpanId).toBe(DISPATCH.spanId);
    });

    it("announces the trace's real sampling verdict rather than a hardcoded SAMPLED", () => {
        expect.assertions(3);

        // Telling a callee "sampled" for a trace that was sampled OUT upstream
        // makes it record spans for a trace nobody kept, and the collector is left
        // holding the middle of one.
        expect(createOtelTracer(realContext(false).ctx).startSpan("call").spanContext().traceFlags).toBe(TraceFlags.NONE);
        expect(createOtelTracer(realContext(true).ctx).startSpan("call").spanContext().traceFlags).toBe(TraceFlags.SAMPLED);
        // No verdict propagated to this tier reads as keep, like everywhere else.
        expect(createOtelTracer(realContext().ctx).startSpan("call").spanContext().traceFlags).toBe(TraceFlags.SAMPLED);
    });

    it("replays attributes written before the trace body attached its handle", async () => {
        expect.assertions(1);

        const { ctx, recorded } = realContext();
        const span = createOtelTracer(ctx).startSpan("doGenerate");

        // Written synchronously, before `ctx.trace` has invoked its body — the
        // gap that a naive implementation drops on the floor.
        span.setAttribute("gen_ai.request.model", "gpt-4o");
        span.end();

        await settle();

        expect(recorded[0]?.attributes?.["gen_ai.request.model"]).toBe("gpt-4o");
    });

    it("translates start options: attributes, kind, and links", async () => {
        expect.assertions(3);

        const { ctx, recorded } = realContext();
        const span = createOtelTracer(ctx).startSpan("call", {
            attributes: { "gen_ai.system": "openai" },
            kind: SpanKind.CLIENT,
            links: [{ context: { spanId: "aaaaaaaaaaaaaaaa", traceFlags: 1, traceId: "b".repeat(32) } }],
        });

        span.end();
        await settle();

        expect(recorded[0]?.attributes?.["gen_ai.system"]).toBe("openai");
        expect(recorded[0]?.kind).toBe("client");
        expect(recorded[0]?.links?.[0]?.spanId).toBe("aaaaaaaaaaaaaaaa");
    });

    it("flattens an array attribute rather than dropping it", async () => {
        expect.assertions(1);

        const { ctx, recorded } = realContext();
        const span = createOtelTracer(ctx).startSpan("call");

        span.setAttributes({ "gen_ai.request.stop_sequences": ["\n", "END"] });
        span.end();
        await settle();

        expect(recorded[0]?.attributes?.["gen_ai.request.stop_sequences"]).toBe("\n,END");
    });

    it("marks the Lunora span failed when the library sets an ERROR status", async () => {
        expect.assertions(1);

        const { ctx, recorded } = realContext();
        const span = createOtelTracer(ctx).startSpan("call");

        span.setStatus({ code: SpanStatusCode.ERROR, message: "rate limited" });
        span.end();
        await settle();

        // `ok: false` is what makes the span survive error-biased tail sampling
        // and show red — an attribute would not.
        expect(recorded[0]?.ok).toBe(false);
    });

    it("does not surface a library's error status to the caller", async () => {
        expect.assertions(1);

        const { ctx } = realContext();
        const span = createOtelTracer(ctx).startSpan("call");

        span.setStatus({ code: SpanStatusCode.ERROR, message: "rate limited" });

        // The bridge re-throws internally to mark the span; that rejection must
        // die inside the bridge rather than becoming an unhandled rejection.
        await expect(
            (async () => {
                span.end();
                await settle();

                return "no throw";
            })(),
        ).resolves.toBe("no throw");
    });

    it("records an exception as a span event", async () => {
        expect.assertions(1);

        const { ctx, recorded } = realContext();
        const span = createOtelTracer(ctx).startSpan("call");

        span.recordException(new Error("upstream 500"));
        span.end();
        await settle();

        expect(recorded[0]?.events?.map((event) => event.name)).toStrictEqual(["exception"]);
    });

    it("hands the span to a startActiveSpan callback and returns its value", async () => {
        expect.assertions(2);

        const { ctx, recorded } = realContext();

        const result = createOtelTracer(ctx).startActiveSpan("work", (span) => {
            span.setAttribute("step", 1);
            span.end();

            return "done";
        });

        await settle();

        expect(result).toBe("done");
        expect(recorded[0]?.attributes?.["step"]).toBe(1);
    });

    it("applies a name prefix when configured", async () => {
        expect.assertions(1);

        const { ctx, recorded } = realContext();
        const span = createOtelTracer(ctx, { namePrefix: "ai." }).startSpan("doGenerate");

        span.end();
        await settle();

        expect(recorded[0]?.name).toBe("ai.doGenerate");
    });

    it("ignores a second end() rather than double-recording", async () => {
        expect.assertions(2);

        const { ctx, recorded } = realContext();
        const span = createOtelTracer(ctx).startSpan("call");

        span.end();
        span.end();
        await settle();

        expect(recorded).toHaveLength(1);
        expect(span.isRecording()).toBe(false);
    });
});
