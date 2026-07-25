import { describe, expect, it, vi } from "vitest";

import type { SpanEvent, SpanHandle } from "../../../shared/span-event";
import { instrumentDatabase } from "../src/database-telemetry";

/**
 * Automatic `ctx.db` instrumentation.
 *
 * The behaviour worth pinning is the TIERING, not the wrapping: `"summary"` must
 * stay flat-cost no matter how many calls a handler makes (that is what makes it
 * safe as a default), `"spans"` must stay bounded (that is what stops a query
 * loop from destroying a trace), and `"off"` must be a genuine no-op rather than
 * a cheap-but-present proxy.
 */

/** A recording {@link SpanHandle} standing in for `ctx.span`. */
const recordingSpan = (): { handle: SpanHandle; recorded: Record<string, unknown> } => {
    const recorded: Record<string, unknown> = {};

    return {
        handle: {
            addEvent: () => undefined,
            addLink: () => undefined,
            recordException: () => undefined,
            setAttribute: (key, value) => {
                recorded[key] = value;
            },
            setAttributes: (fields) => {
                Object.assign(recorded, fields);
            },
            spanContext: () => {
                return { spanId: "0000000000000001", traceId: "00000000000000000000000000000001" };
            },
        },
        recorded,
    };
};

const deps = (mode: "off" | "spans" | "summary", span: SpanHandle, record: (span: SpanEvent) => void) => {
    return {
        anchor: { rootSpanId: "b7ad6b7169203331", traceId: "0af7651916cd43dd8448eb211c80319c" },
        functionPath: "orders:checkout",
        mode,
        record,
        shardKey: "tenant-1",
        span,
        userId: () => "u-1",
    };
};

/** A minimal `ctx.db` stand-in: the methods the instrumenter knows, plus a passthrough builder. */
const fakeDatabase = () => {
    return {
        findMany: vi.fn<(table: string) => Promise<{ rows: unknown[] }>>(async () => {
            return { rows: [] };
        }),
        insert: vi.fn<(table: string, document: Record<string, unknown>) => Promise<string>>(async () => "id-1"),
        normalizeId: (_table: string, id: string) => id,
        query: (table: string) => {
            return { table };
        },
    };
};

describe("instrumentDatabase", () => {
    it("returns the database untouched when off", () => {
        expect.assertions(1);

        const database = fakeDatabase();
        const span = recordingSpan();

        // Identity, not an equivalent proxy: a deployment collecting nothing
        // should not pay even for the indirection.
        expect(
            instrumentDatabase(
                database,
                deps("off", span.handle, () => undefined),
            ),
        ).toBe(database);
    });

    it("folds aggregate counters onto the wide event in summary mode", async () => {
        expect.assertions(4);

        const database = fakeDatabase();
        const span = recordingSpan();
        const spans: SpanEvent[] = [];
        const instrumented = instrumentDatabase(
            database,
            deps("summary", span.handle, (recorded) => {
                spans.push(recorded);
            }),
        );

        await instrumented.findMany("orders");
        await instrumented.findMany("orders");
        await instrumented.insert("orders", { total: 1 });

        expect(span.recorded["db.calls"]).toBe(3);
        expect(span.recorded["db.op.findMany"]).toBe(2);
        expect(span.recorded["db.op.insert"]).toBe(1);
        // The defining property of summary mode: no spans, however many calls.
        expect(spans).toHaveLength(0);
    });

    it("counts a failed call and re-throws it untouched", async () => {
        expect.assertions(3);

        const database = fakeDatabase();

        database.insert.mockRejectedValueOnce(new Error("constraint violated"));

        const span = recordingSpan();
        const instrumented = instrumentDatabase(
            database,
            deps("summary", span.handle, () => undefined),
        );

        // Instrumentation, never flow control — the original error reaches the caller.
        await expect(instrumented.insert("orders", {})).rejects.toThrow("constraint violated");

        expect(span.recorded["db.errors"]).toBe(1);
        expect(span.recorded["db.calls"]).toBe(1);
    });

    it("emits one CLIENT span per call in spans mode, named without row ids", async () => {
        expect.assertions(4);

        const database = fakeDatabase();
        const span = recordingSpan();
        const spans: SpanEvent[] = [];
        const instrumented = instrumentDatabase(
            database,
            deps("spans", span.handle, (recorded) => {
                spans.push(recorded);
            }),
        );

        await instrumented.findMany("orders");

        expect(spans).toHaveLength(1);
        // CLIENT so a collector renders the datastore as a dependency edge.
        expect(spans[0]?.kind).toBe("client");
        expect(spans[0]?.name).toBe("db.findMany orders");
        expect(spans[0]?.attributes?.["db.collection.name"]).toBe("orders");
    });

    it("caps spans per ctx and reports the truncation instead of hiding it", async () => {
        expect.assertions(3);

        const database = fakeDatabase();
        const span = recordingSpan();
        const spans: SpanEvent[] = [];
        const instrumented = instrumentDatabase(
            database,
            deps("spans", span.handle, (recorded) => {
                spans.push(recorded);
            }),
        );

        for (let index = 0; index < 150; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential on purpose: the cap is about cumulative count, not concurrency
            await instrumented.findMany("orders");
        }

        expect(spans).toHaveLength(100);
        // Every call still counts toward the summary — only the individual spans
        // are dropped, so the totals stay honest.
        expect(span.recorded["db.calls"]).toBe(150);
        // A silently partial waterfall is worse than a labelled one.
        expect(span.recorded["db.spans_truncated"]).toBe(true);
    });

    it("passes non-storage members through untouched", () => {
        expect.assertions(2);

        const database = fakeDatabase();
        const span = recordingSpan();
        const instrumented = instrumentDatabase(
            database,
            deps("spans", span.handle, () => undefined),
        );

        // `query` returns a chainable builder and does no I/O; wrapping it would
        // break the chain and produce a span measuring nothing.
        expect(instrumented.query("orders")).toStrictEqual({ table: "orders" });
        expect(instrumented.normalizeId("orders", "x")).toBe("x");
    });

    it("returns a stable function identity for a wrapped method", () => {
        expect.assertions(1);

        const database = fakeDatabase();
        const span = recordingSpan();
        const instrumented = instrumentDatabase(
            database,
            deps("spans", span.handle, () => undefined),
        );

        // Repeated property access must not mint a new closure each time —
        // callers legitimately destructure or compare these.
        expect(instrumented.findMany).toBe(instrumented.findMany);
    });
});
