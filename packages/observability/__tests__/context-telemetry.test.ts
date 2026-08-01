import { describe, expect, it } from "vitest";

import type { SpanEvent } from "../../../shared/span-event";
import type { TracerDeps } from "../src/context-telemetry";
import { createSpanCollector, createTracer, dispatchRootSpan } from "../src/context-telemetry";

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
