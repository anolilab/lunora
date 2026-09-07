import { describe, expect, it } from "vitest";

import type { SpanEvent } from "../../../shared/span-event";
import type { TracerDeps } from "../src/context-telemetry";
import { createSpanCollector, createTracedFetch, createTracer, dispatchRootSpan } from "../src/context-telemetry";

/**
 * Span redaction (finding b/b′ of plan 276): the span pipeline is the one
 * sink with third-party fan-out (`otlpSink`/`webhookSink`), so its error
 * messages and exception stacktraces must default to the same redacted
 * posture the request log and function-metrics sinks already have —
 * `captureRaw` (dev-only, mirroring `isDevEnvironment`) is the one escape
 * hatch, exactly as `request-log.ts` already established.
 */

const anchor = { rootSpanId: "root0000root0000", traceId: "trace00000000000000000000000000" };

/** Build a tracer over a captured `record`, with deps merged in. */
const setup = (overrides: Partial<TracerDeps> = {}) => {
    const recorded: SpanEvent[] = [];

    const trace = createTracer({
        anchor,
        functionPath: "messages:list",
        record: (span) => {
            recorded.push(span);
        },
        shardKey: "room-1",
        userId: () => "user-42",
        ...overrides,
    });

    return { recorded, trace };
};

describe("createTracer span options", () => {
    it("reads a bag with an UNKNOWN kind as attributes, not options", async () => {
        expect.assertions(3);

        const { recorded, trace } = setup();

        await trace("charge", () => undefined, { kind: "premium" });

        // `"premium"` is not a span kind. Read as options it produced a span with
        // NO kind on the wire (the encoder maps an unknown kind to `undefined`)
        // AND silently swallowed the caller's attribute — the value was simply
        // gone. Read as what it is, an attribute bag, both facts survive.
        expect(recorded[0]?.kind).toBeUndefined();
        expect(recorded[0]?.attributes?.["kind"]).toBe("premium");

        // A real kind still discriminates as options.
        await trace("stripe", () => undefined, { kind: "client" });

        expect(recorded[1]?.kind).toBe("client");
    });

    it("records a span under a caller-supplied identity", async () => {
        expect.assertions(2);

        const { recorded, trace } = setup();

        await trace("bridged", () => undefined, undefined, { parentSpanId: "aaaaaaaaaaaaaaaa", spanId: "bbbbbbbbbbbbbbbb" });

        // The `@opentelemetry/api` bridge publishes a span's `SpanContext`
        // synchronously, so the span has to be recorded under the id it published
        // or every downstream span parents to an id that never reaches a collector.
        expect(recorded[0]?.spanId).toBe("bbbbbbbbbbbbbbbb");
        expect(recorded[0]?.parentSpanId).toBe("aaaaaaaaaaaaaaaa");
    });

    it("puts the trace's sampling verdict on a span handle's context", async () => {
        expect.assertions(2);

        const sampledOut = createTracer({
            anchor: { ...anchor, sampled: false },
            functionPath: "messages:list",
            record: () => undefined,
            shardKey: undefined,
            userId: () => undefined,
        });

        let seen: { sampled?: boolean } | undefined;

        await sampledOut("span", (_trace, span) => {
            seen = span.spanContext();
        });

        // Anything that announces this span downstream from its ids alone — a
        // hand-built `traceparent`, an OTel `SpanContext` — needs the verdict in
        // the same breath, or it claims SAMPLED on a trace nobody kept.
        expect(seen?.sampled).toBe(false);
        expect(createSpanCollector({ sampled: true, spanId: "a".repeat(16), traceId: "b".repeat(32) }).handle.spanContext().sampled).toBe(true);
    });
});

describe("createTracer error-message redaction", () => {
    it("redacts a span body's thrown message by default", async () => {
        expect.assertions(2);

        const { recorded, trace } = setup();

        await expect(
            trace("span", () => {
                throw new Error("User 12345 not found");
            }),
        ).rejects.toThrow("User 12345 not found");

        // Redacted like the request log's `errorMessage` by default —
        // `@visulima/redact`'s `standardRules` masks a bare 5-digit run as `<DL>`.
        expect(recorded[0]?.error?.message).toBe("User <DL> not found");
    });

    it("keeps the raw message when captureRaw is true (the dev escape hatch)", async () => {
        expect.assertions(2);

        const { recorded, trace } = setup({ captureRaw: true });

        await expect(
            trace("span", () => {
                throw new Error("User 12345 not found");
            }),
        ).rejects.toThrow("User 12345 not found");

        expect(recorded[0]?.error?.message).toBe("User 12345 not found");
    });

    it("re-throws the original error untouched regardless of redaction", async () => {
        expect.assertions(1);

        const boom = new Error("User 12345 not found");
        const { trace } = setup();

        await expect(
            trace("span", () => {
                throw boom;
            }),
        ).rejects.toBe(boom);
    });
});

describe("createSpanCollector recordException redaction and stacktrace gating", () => {
    it("redacts exception.message and omits exception.stacktrace by default", () => {
        expect.assertions(2);

        const { collected, handle } = createSpanCollector({ spanId: "span0000span0000", traceId: anchor.traceId });

        const error = new Error("User 12345 not found");

        handle.recordException(error);

        const event = collected.events[0];

        expect(event?.attributes?.["exception.message"]).toBe("User <DL> not found");
        expect(event?.attributes?.["exception.stacktrace"]).toBeUndefined();
    });

    it("keeps the raw message and attaches exception.stacktrace when captureRaw is true", () => {
        expect.assertions(2);

        const { collected, handle } = createSpanCollector({ spanId: "span0000span0000", traceId: anchor.traceId }, true);

        const error = new Error("User 12345 not found");

        handle.recordException(error);

        const event = collected.events[0];

        expect(event?.attributes?.["exception.message"]).toBe("User 12345 not found");
        expect(typeof event?.attributes?.["exception.stacktrace"]).toBe("string");
    });
});

describe("dispatchRootSpan error-message redaction", () => {
    it("redacts the thrown failure's message by default", () => {
        expect.assertions(1);

        const span = dispatchRootSpan({
            anchor,
            durationMs: 12,
            failure: { thrown: new Error("User 12345 not found") },
            functionPath: "messages:list",
            shardKey: "room-1",
            startTs: 1000,
            userId: "user-42",
        });

        expect(span.error?.message).toBe("User <DL> not found");
    });

    it("keeps the raw message when captureRaw is true", () => {
        expect.assertions(1);

        const span = dispatchRootSpan({
            anchor,
            captureRaw: true,
            durationMs: 12,
            failure: { thrown: new Error("User 12345 not found") },
            functionPath: "messages:list",
            shardKey: "room-1",
            startTs: 1000,
            userId: "user-42",
        });

        expect(span.error?.message).toBe("User 12345 not found");
    });

    it("carries no error field on a successful dispatch", () => {
        expect.assertions(1);

        const span = dispatchRootSpan({
            anchor,
            durationMs: 12,
            failure: undefined,
            functionPath: "messages:list",
            shardKey: "room-1",
            startTs: 1000,
            userId: "user-42",
        });

        expect(span.error).toBeUndefined();
    });
});

describe("createTracedFetch error-message redaction", () => {
    /** Build `ctx.fetch` over a `base` that always throws, capturing the recorded span. */
    const setupFetch = (thrown: Error, captureRaw?: boolean) => {
        const recorded: SpanEvent[] = [];

        const fetch = createTracedFetch(
            {
                anchor,
                ...(captureRaw === undefined ? {} : { captureRaw }),
                functionPath: "messages:list",
                record: (span) => {
                    recorded.push(span);
                },
                shardKey: "room-1",
                userId: () => "user-42",
            },
            () => {
                throw thrown;
            },
        );

        return { fetch, recorded };
    };

    it("redacts the thrown message by default", async () => {
        expect.assertions(2);

        // A `fetch` TypeError embeds the request URL, so an un-redacted message
        // ships whatever is in the query string to the collector — on the very
        // span whose `url.full` is scrubbed by `redactUrl`.
        const { fetch, recorded } = setupFetch(new TypeError("fetch failed for user 12345"));

        await expect(fetch("https://api.example.com/v1")).rejects.toThrow(TypeError);
        expect(recorded[0]?.error?.message).toBe("fetch failed for user <DL>");
    });

    it("keeps the raw message when captureRaw is true", async () => {
        expect.assertions(2);

        const { fetch, recorded } = setupFetch(new TypeError("fetch failed for user 12345"), true);

        await expect(fetch("https://api.example.com/v1")).rejects.toThrow(TypeError);

        expect(recorded[0]?.error?.message).toBe("fetch failed for user 12345");
    });
});

describe("ctx.trace start-attribute bound", () => {
    // The other bypass: start attributes were spread into the recorded span
    // uncapped, so `ctx.trace(name, fn, req.body)` shipped whatever the client
    // sent — a high-cardinality bag is what destroys a collector's aggregates,
    // and the cap only ever covered the post-hoc writers.
    it("bounds the start attributes a ctx.trace span records", async () => {
        expect.assertions(3);

        const { recorded, trace } = setup();

        await trace("scan", () => undefined, Object.fromEntries(Array.from({ length: 500 }, (_, index) => [`row.${String(index)}`, "done"])));

        expect(Object.keys(recorded[0]!.attributes!)).toHaveLength(128);
        expect(recorded[0]!.attributes!["row.0"]).toBe("done");
        expect(recorded[0]!.attributes!["row.499"]).toBeUndefined();
    });

    it("lets a post-hoc write win on a key the start bag already claimed", async () => {
        expect.assertions(1);

        const { recorded, trace } = setup();

        await trace(
            "scan",
            (_span, handle) => {
                handle.setAttribute("status", "settled");
            },
            { status: "pending" },
        );

        expect(recorded[0]!.attributes!["status"]).toBe("settled");
    });
});

describe("createSpanCollector attribute bound", () => {
    it("keeps the first 128 attribute keys and drops the rest", () => {
        expect.assertions(3);

        const { collected, handle } = createSpanCollector({ spanId: "span0000span0000", traceId: anchor.traceId });

        // The `addEvent`/`addLink` failure through the other door: a loop stamping
        // one attribute per row builds an unbounded bag inside the request and then
        // tries to ship it to OTLP.
        for (let index = 0; index < 500; index += 1) {
            handle.setAttribute(`row.${String(index)}`, "done");
        }

        expect(Object.keys(collected.attributes)).toHaveLength(128);
        expect(collected.attributes["row.0"]).toBe("done");
        expect(collected.attributes["row.499"]).toBeUndefined();
    });

    // The per-item bags on `addEvent`/`addLink` used to skip the bound entirely:
    // a handler that forwards a request body as event attributes could mint
    // unbounded keys through a door the "shared by all three writers" claim did
    // not actually cover.
    it("bounds the per-item attribute bag on addEvent and addLink", () => {
        expect.assertions(4);

        const { collected, handle } = createSpanCollector({ spanId: "span0000span0000", traceId: anchor.traceId });
        const bag = Object.fromEntries(Array.from({ length: 500 }, (_, index) => [`row.${String(index)}`, "done"]));

        handle.addEvent("rows.scanned", bag);
        handle.addLink({ attributes: bag, spanId: "span1111span1111", traceId: anchor.traceId });

        expect(Object.keys(collected.events[0]!.attributes!)).toHaveLength(128);
        expect(collected.events[0]!.attributes!["row.0"]).toBe("done");
        expect(Object.keys(collected.links[0]!.attributes!)).toHaveLength(128);
        expect(collected.links[0]!.attributes!["row.499"]).toBeUndefined();
    });

    it("still updates a key already in the bag once full", () => {
        expect.assertions(2);

        const { collected, handle } = createSpanCollector({ spanId: "span0000span0000", traceId: anchor.traceId });

        handle.setAttribute("status", "pending");

        for (let index = 0; index < 500; index += 1) {
            handle.setAttribute(`row.${String(index)}`, "done");
        }

        handle.setAttributes({ overflow: "dropped", status: "settled" });

        expect(collected.attributes["status"]).toBe("settled");
        expect(collected.attributes["overflow"]).toBeUndefined();
    });
});
