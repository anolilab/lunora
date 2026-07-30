import { describe, expect, it } from "vitest";

import type { SpanEvent } from "../../../shared/span-event";
import { DEFAULT_TRACE_LIMIT, foldTraces, SpanBuffer } from "../src/span-buffer";

/** A span with everything the fold reads, so each test varies only what it is about. */
const span = (overrides: Partial<SpanEvent> = {}): SpanEvent => {
    return {
        durationMs: 10,
        functionPath: "posts:list",
        name: "posts:list",
        ok: true,
        parentSpanId: "",
        spanId: "s1",
        startTs: 1000,
        traceId: "t1",
        ...overrides,
    };
};

describe("spanBuffer", () => {
    it("keeps the newest spans once capacity is reached", () => {
        expect.assertions(3);

        const buffer = new SpanBuffer(2);

        for (const id of ["a", "b", "c"]) {
            buffer.push(span({ spanId: id }));
        }

        // A ring buffer on a live instance: the oldest is what a request can
        // afford to lose, so the newest must be what survives.
        expect(buffer.size).toBe(2);
        expect(buffer.entries().map((entry) => entry.spanId)).toStrictEqual(["b", "c"]);
        expect(buffer.entries()).not.toBe(buffer.entries());
    });

    it("empties on clear", () => {
        expect.assertions(2);

        const buffer = new SpanBuffer(4);

        buffer.push(span());

        expect(buffer.size).toBe(1);

        buffer.clear();

        expect(buffer.size).toBe(0);
    });
});

describe("foldTraces", () => {
    it("returns nothing for an empty buffer", () => {
        expect.assertions(2);

        const { total, traces } = foldTraces([]);

        expect(total).toBe(0);
        expect(traces).toStrictEqual([]);
    });

    it("groups spans by trace and nests them by parent", () => {
        expect.assertions(4);

        const { total, traces } = foldTraces([
            span({ durationMs: 30, name: "root", spanId: "root" }),
            span({ name: "child", parentSpanId: "root", spanId: "child", startTs: 1005 }),
        ]);

        expect(total).toBe(1);
        expect(traces[0]?.spans).toHaveLength(2);

        // Depth is what renders the waterfall's indentation; a child that reads
        // as depth 0 draws as a sibling of its own parent.
        expect(traces[0]?.spans[0]?.depth).toBe(0);
        expect(traces[0]?.spans[1]?.depth).toBe(1);
    });

    it("offsets each span from the trace root, not from the epoch", () => {
        expect.assertions(2);

        const { traces } = foldTraces([
            span({ name: "root", spanId: "root", startTs: 5000 }),
            span({ name: "child", parentSpanId: "root", spanId: "child", startTs: 5025 }),
        ]);

        // `offsetMs` is what positions a bar in the waterfall. Absolute
        // timestamps would push every bar off the right edge.
        expect(traces[0]?.spans[0]?.offsetMs).toBe(0);
        expect(traces[0]?.spans[1]?.offsetMs).toBe(25);
    });

    it("marks a trace failed when any span failed", () => {
        expect.assertions(2);

        const { traces } = foldTraces([
            span({ name: "root", spanId: "root" }),
            span({ error: { message: "boom", type: "Error" }, name: "child", ok: false, parentSpanId: "root", spanId: "child" }),
        ]);

        // A trace whose root succeeded but whose child threw is a failed
        // request; reporting it green is how a broken call goes unnoticed.
        expect(traces[0]?.ok).toBe(false);
        expect(traces[0]?.spans.some((entry) => entry.error?.message === "boom")).toBe(true);
    });

    it("caps returned traces at the limit while still counting the rest", () => {
        expect.assertions(2);

        const spans = Array.from({ length: 5 }, (_unused, index) => span({ spanId: `s${String(index)}`, startTs: 1000 + index, traceId: `t${String(index)}` }));
        const { total, traces } = foldTraces(spans, 2);

        // `total > traces.length` is what lets the UI say "showing 2 of 5"
        // instead of silently implying the buffer held two.
        expect(traces).toHaveLength(2);
        expect(total).toBe(5);
    });

    it("defaults the limit rather than returning everything", () => {
        expect.assertions(1);

        expect(DEFAULT_TRACE_LIMIT).toBeGreaterThan(0);
    });

    it("still folds a trace whose root span is missing", () => {
        expect.assertions(2);

        // The ring can evict a root while its children remain. Dropping the
        // orphans would lose the very spans a truncated trace still has.
        const { total, traces } = foldTraces([span({ name: "orphan", parentSpanId: "evicted-root", spanId: "child" })]);

        expect(total).toBe(1);
        expect(traces[0]?.spans).toHaveLength(1);
    });
});
