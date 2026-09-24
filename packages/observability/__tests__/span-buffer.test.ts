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

    it("counts evicted spans so a truncated waterfall reads as truncated", () => {
        expect.assertions(3);

        const buffer = new SpanBuffer(2);

        for (let index = 0; index < 10; index += 1) {
            buffer.push(span({ spanId: `s${String(index)}` }));
        }

        expect(buffer.size).toBe(2);
        expect(buffer.dropped).toBe(8);

        buffer.clear();

        expect(buffer.dropped).toBe(0);
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

describe("spanBuffer capacity normalization", () => {
    it("falls back to the default for a capacity that would truncate to zero", () => {
        expect.assertions(2);

        // `> 0` accepted this and `Math.trunc` then made it 0, so the ring
        // evicted every span it was handed — trace capture silently off.
        const buffer = new SpanBuffer(0.5);

        buffer.push(span());

        expect(buffer.size).toBe(1);
        expect(buffer.dropped).toBe(0);
    });

    it("falls back to the default for a non-finite capacity", () => {
        expect.assertions(1);

        // Infinity truncates to itself, removing the memory bound the ring
        // exists to impose on a buffer that lives as long as the DO does.
        const buffer = new SpanBuffer(Number.POSITIVE_INFINITY);

        for (let index = 0; index < 1200; index += 1) {
            buffer.push(span({ spanId: String(index) }));
        }

        expect(buffer.size).toBeLessThan(1200);
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

    it("carries a span's kind and recorded events through to the folded row", () => {
        expect.assertions(2);

        // Both are recorded by `ctx.trace` and were dropped by the fold, so a
        // handled exception (`span.recordException`) reached the buffer and then
        // vanished before anything could render it.
        const { traces } = foldTraces([
            span({
                events: [{ attributes: { "exception.type": "TimeoutError" }, name: "exception", ts: 1002 }],
                kind: "client",
            }),
        ]);

        expect(traces[0]?.spans[0]?.kind).toBe("client");
        expect(traces[0]?.spans[0]?.events).toStrictEqual([{ attributes: { "exception.type": "TimeoutError" }, name: "exception", ts: 1002 }]);
    });

    it("omits kind and events entirely for a span that recorded neither", () => {
        expect.assertions(2);

        // Absent rather than `undefined`-valued: these ride every admin `getTraces`
        // payload, and the common `ctx.trace` span has neither.
        const [row] = foldTraces([span()]).traces[0]?.spans ?? [];

        expect(row).not.toHaveProperty("kind");
        expect(row).not.toHaveProperty("events");
    });

    it("emits nested parallel subtrees in pre-order when every span shares an offset", () => {
        expect.assertions(2);

        // Two sibling subtrees, each one level deep, all starting at the same
        // instant — the normal case on Workers, where `Date.now()` is pinned to
        // the last I/O and so does not advance across pure computation.
        //
        // Ordering by `(offsetMs, depth)` groups the tree by LEVEL rather than
        // by branch: `root, a, b, a1, b1`. Indenting by `depth` then draws `a1`
        // beneath `b`, a parent it does not belong to.
        const { traces } = foldTraces([
            span({ name: "a1", parentSpanId: "a", spanId: "a1" }),
            span({ name: "b1", parentSpanId: "b", spanId: "b1" }),
            span({ name: "a", parentSpanId: "root", spanId: "a" }),
            span({ name: "b", parentSpanId: "root", spanId: "b" }),
            span({ name: "root", spanId: "root" }),
        ]);

        expect(traces[0]?.spans.map((row) => row.name)).toStrictEqual(["root", "a", "a1", "b", "b1"]);
        expect(traces[0]?.spans.map((row) => row.depth)).toStrictEqual([0, 1, 2, 1, 2]);
    });

    it("orders siblings by start time", () => {
        expect.assertions(1);

        // Within one parent, the earlier branch comes first — the walk restores
        // the tree, it must not discard the timeline inside a level.
        const { traces } = foldTraces([
            span({ name: "late", parentSpanId: "root", spanId: "late", startTs: 1020 }),
            span({ name: "early", parentSpanId: "root", spanId: "early", startTs: 1005 }),
            span({ name: "root", spanId: "root" }),
        ]);

        expect(traces[0]?.spans.map((row) => row.name)).toStrictEqual(["root", "early", "late"]);
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
