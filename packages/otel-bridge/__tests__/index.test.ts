import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";

import type { LunoraTraceContext } from "../src/index";
import { createOtelTracer } from "../src/index";

/**
 * The bridge's contract is narrow but load-bearing: a third-party library's
 * spans must land in the SAME trace as the request, with real timings, and must
 * not be able to break the handler that happens to use that library.
 */

const DISPATCH = { spanId: "b7ad6b7169203331", traceId: "0af7651916cd43dd8448eb211c80319c" };

/** An 8-byte span id, hex-encoded per the OTLP/JSON `span_id` exception. */
const SPAN_ID_HEX = /^[0-9a-f]{16}$/;

/** One span as the fake `ctx.trace` recorded it. */
interface Recorded {
    attributes: Record<string, unknown>;
    events: string[];
    kind?: string;
    links: { spanId: string }[];
    name: string;
    ok: boolean;
}

/**
 * A `ctx` double whose `trace` behaves like the real one: it runs the body,
 * records when the body settles, and marks the span failed if the body threw.
 */
const fakeContext = (): { ctx: LunoraTraceContext; recorded: Recorded[] } => {
    const recorded: Recorded[] = [];

    const ctx: LunoraTraceContext = {
        span: { spanContext: () => DISPATCH },
        trace: async (name, function_, options) => {
            const entry: Recorded = {
                attributes: { ...(options as { attributes?: Record<string, unknown> } | undefined)?.attributes },
                events: [],
                ...((options as { kind?: string } | undefined)?.kind === undefined ? {} : { kind: (options as { kind: string }).kind }),
                links: [...((options as { links?: { spanId: string }[] } | undefined)?.links ?? [])],
                name,
                ok: true,
            };

            const handle = {
                addEvent: (eventName: string) => {
                    entry.events.push(eventName);
                },
                addLink: (link: { spanId: string }) => {
                    entry.links.push(link);
                },
                recordException: () => {
                    entry.events.push("exception");
                },
                setAttribute: (key: string, value: unknown) => {
                    entry.attributes[key] = value;
                },
                setAttributes: (fields: Record<string, unknown>) => {
                    Object.assign(entry.attributes, fields);
                },
                spanContext: () => DISPATCH,
            };

            try {
                return await function_(undefined, handle);
            } catch (error) {
                entry.ok = false;

                throw error;
            } finally {
                recorded.push(entry);
            }
        },
    };

    return { ctx, recorded };
};

/** Let the microtask queue drain so the suspended `ctx.trace` body can settle. */
const settle = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
};

describe(createOtelTracer, () => {
    it("records nothing until the span is ended", async () => {
        expect.assertions(2);

        const { ctx, recorded } = fakeContext();
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

        const { ctx } = fakeContext();
        const span = createOtelTracer(ctx).startSpan("doGenerate");

        // The whole point: a library's span joins the request's trace instead of
        // starting an orphan one nobody can correlate.
        expect(span.spanContext().traceId).toBe(DISPATCH.traceId);
        // Its own id is fresh, and readable synchronously so a caller can build a
        // `traceparent` from it immediately.
        expect(span.spanContext().spanId).toMatch(SPAN_ID_HEX);
    });

    it("replays attributes written before the trace body attached its handle", async () => {
        expect.assertions(1);

        const { ctx, recorded } = fakeContext();
        const span = createOtelTracer(ctx).startSpan("doGenerate");

        // Written synchronously, before `ctx.trace` has invoked its body — the
        // gap that a naive implementation drops on the floor.
        span.setAttribute("gen_ai.request.model", "gpt-4o");
        span.end();

        await settle();

        expect(recorded[0]?.attributes["gen_ai.request.model"]).toBe("gpt-4o");
    });

    it("translates start options: attributes, kind, and links", async () => {
        expect.assertions(3);

        const { ctx, recorded } = fakeContext();
        const span = createOtelTracer(ctx).startSpan("call", {
            attributes: { "gen_ai.system": "openai" },
            kind: SpanKind.CLIENT,
            links: [{ context: { spanId: "aaaaaaaaaaaaaaaa", traceFlags: 1, traceId: "b".repeat(32) } }],
        });

        span.end();
        await settle();

        expect(recorded[0]?.attributes["gen_ai.system"]).toBe("openai");
        expect(recorded[0]?.kind).toBe("client");
        expect(recorded[0]?.links[0]?.spanId).toBe("aaaaaaaaaaaaaaaa");
    });

    it("flattens an array attribute rather than dropping it", async () => {
        expect.assertions(1);

        const { ctx, recorded } = fakeContext();
        const span = createOtelTracer(ctx).startSpan("call");

        span.setAttributes({ "gen_ai.request.stop_sequences": ["\n", "END"] });
        span.end();
        await settle();

        expect(recorded[0]?.attributes["gen_ai.request.stop_sequences"]).toBe("\n,END");
    });

    it("marks the Lunora span failed when the library sets an ERROR status", async () => {
        expect.assertions(1);

        const { ctx, recorded } = fakeContext();
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

        const { ctx } = fakeContext();
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

        const { ctx, recorded } = fakeContext();
        const span = createOtelTracer(ctx).startSpan("call");

        span.recordException(new Error("upstream 500"));
        span.end();
        await settle();

        expect(recorded[0]?.events).toStrictEqual(["exception"]);
    });

    it("hands the span to a startActiveSpan callback and returns its value", async () => {
        expect.assertions(2);

        const { ctx, recorded } = fakeContext();

        const result = createOtelTracer(ctx).startActiveSpan("work", (span) => {
            span.setAttribute("step", 1);
            span.end();

            return "done";
        });

        await settle();

        expect(result).toBe("done");
        expect(recorded[0]?.attributes["step"]).toBe(1);
    });

    it("applies a name prefix when configured", async () => {
        expect.assertions(1);

        const { ctx, recorded } = fakeContext();
        const span = createOtelTracer(ctx, { namePrefix: "ai." }).startSpan("doGenerate");

        span.end();
        await settle();

        expect(recorded[0]?.name).toBe("ai.doGenerate");
    });

    it("ignores a second end() rather than double-recording", async () => {
        expect.assertions(2);

        const { ctx, recorded } = fakeContext();
        const span = createOtelTracer(ctx).startSpan("call");

        span.end();
        span.end();
        await settle();

        expect(recorded).toHaveLength(1);
        expect(span.isRecording()).toBe(false);
    });
});
