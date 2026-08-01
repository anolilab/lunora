import { describe, expect, it, vi } from "vitest";

import type { SpanEvent } from "../../../shared/span-event";
import type { DatabaseTally } from "../src/database-telemetry";
import { createDatabaseTally, formatTally, instrumentDatabase } from "../src/database-telemetry";

/**
 * Automatic `ctx.db` instrumentation.
 *
 * The behaviour worth pinning is the TIERING, not the wrapping: `"summary"` must
 * stay flat-cost no matter how many calls a handler makes (that is what makes it
 * safe as a default), `"spans"` must stay bounded (that is what stops a query
 * loop from destroying a trace), and `"off"` must be a genuine no-op rather than
 * a cheap-but-present proxy.
 */

const deps = (mode: "off" | "spans" | "summary", tally: DatabaseTally, record: (span: SpanEvent) => void, captureRaw?: boolean) => {
    return {
        anchor: { rootSpanId: "b7ad6b7169203331", traceId: "0af7651916cd43dd8448eb211c80319c" },
        ...(captureRaw === undefined ? {} : { captureRaw }),
        functionPath: "orders:checkout",
        mode,
        record,
        shardKey: "tenant-1",
        tally,
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
        const tally = createDatabaseTally();

        // Identity, not an equivalent proxy: a deployment collecting nothing
        // should not pay even for the indirection.
        expect(
            instrumentDatabase(
                database,
                deps("off", tally, () => undefined),
            ),
        ).toBe(database);
    });

    it("folds aggregate counters onto the wide event in summary mode", async () => {
        expect.assertions(4);

        const database = fakeDatabase();
        const tally = createDatabaseTally();
        const spans: SpanEvent[] = [];
        const instrumented = instrumentDatabase(
            database,
            deps("summary", tally, (recorded) => {
                spans.push(recorded);
            }),
        );

        await instrumented.findMany("orders");
        await instrumented.findMany("orders");
        await instrumented.insert("orders", { total: 1 });

        expect(formatTally(tally)["db.calls"]).toBe(3);
        expect(formatTally(tally)["db.op.findMany"]).toBe(2);
        expect(formatTally(tally)["db.op.insert"]).toBe(1);
        // The defining property of summary mode: no spans, however many calls.
        expect(spans).toHaveLength(0);
    });

    it("counts a failed call and re-throws it untouched", async () => {
        expect.assertions(3);

        const database = fakeDatabase();

        database.insert.mockRejectedValueOnce(new Error("constraint violated"));

        const tally = createDatabaseTally();
        const instrumented = instrumentDatabase(
            database,
            deps("summary", tally, () => undefined),
        );

        // Instrumentation, never flow control — the original error reaches the caller.
        await expect(instrumented.insert("orders", {})).rejects.toThrow("constraint violated");

        expect(formatTally(tally)["db.errors"]).toBe(1);
        expect(formatTally(tally)["db.calls"]).toBe(1);
    });

    it("emits one CLIENT span per call in spans mode, named without row ids", async () => {
        expect.assertions(4);

        const database = fakeDatabase();
        const tally = createDatabaseTally();
        const spans: SpanEvent[] = [];
        const instrumented = instrumentDatabase(
            database,
            deps("spans", tally, (recorded) => {
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
        const tally = createDatabaseTally();
        const spans: SpanEvent[] = [];
        const instrumented = instrumentDatabase(
            database,
            deps("spans", tally, (recorded) => {
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
        expect(formatTally(tally)["db.calls"]).toBe(150);
        // A silently partial waterfall is worse than a labelled one.
        expect(formatTally(tally)["db.spans_truncated"]).toBe(true);
    });

    it("passes non-storage members through untouched", () => {
        expect.assertions(2);

        const database = fakeDatabase();
        const tally = createDatabaseTally();
        const instrumented = instrumentDatabase(
            database,
            deps("spans", tally, () => undefined),
        );

        // `query` returns a chainable builder and does no I/O; wrapping it would
        // break the chain and produce a span measuring nothing.
        expect(instrumented.query("orders")).toStrictEqual({ table: "orders" });
        expect(instrumented.normalizeId("orders", "x")).toBe("x");
    });

    it("returns a stable function identity for a wrapped method", () => {
        expect.assertions(1);

        const database = fakeDatabase();
        const tally = createDatabaseTally();
        const instrumented = instrumentDatabase(
            database,
            deps("spans", tally, () => undefined),
        );

        // Repeated property access must not mint a new closure each time —
        // callers legitimately destructure or compare these.
        expect(instrumented.findMany).toBe(instrumented.findMany);
    });
});

describe("client-span error-message redaction (captureRaw)", () => {
    it("redacts a constraint error's message by default, matching the request-log posture", async () => {
        expect.assertions(2);

        const database = fakeDatabase();

        database.insert.mockRejectedValueOnce(new Error("User 12345 not found"));

        const tally = createDatabaseTally();
        const spans: SpanEvent[] = [];
        const instrumented = instrumentDatabase(
            database,
            deps("spans", tally, (recorded) => {
                spans.push(recorded);
            }),
        );

        await expect(instrumented.insert("orders", {})).rejects.toThrow("User 12345 not found");

        // Redacted like `@visulima/redact`'s `standardRules` masks a bare
        // 5-digit run as `<DL>` — same treatment the request log gives
        // `errorMessage` by default.
        expect(spans[0]?.error?.message).toBe("User <DL> not found");
    });

    it("keeps the raw message when captureRaw is true (the dev escape hatch)", async () => {
        expect.assertions(2);

        const database = fakeDatabase();

        database.insert.mockRejectedValueOnce(new Error("User 12345 not found"));

        const tally = createDatabaseTally();
        const spans: SpanEvent[] = [];
        const instrumented = instrumentDatabase(
            database,
            deps(
                "spans",
                tally,
                (recorded) => {
                    spans.push(recorded);
                },
                true,
            ),
        );

        await expect(instrumented.insert("orders", {})).rejects.toThrow("User 12345 not found");

        expect(spans[0]?.error?.message).toBe("User 12345 not found");
    });
});

describe("describeFailure fallback (a non-Error, non-string failure), exercised through instrumentDatabase", () => {
    // `describeFailure` is a private module helper (not exported) — reached
    // here through `instrumentDatabase`'s public surface, the only production
    // consumer. `JSON.stringify` is typed `=> string` but returns `undefined`
    // for a function/symbol/undefined value; `SpanEvent["error"].message` is
    // declared `string`, so the rendered message must still be a string —
    // never the literal `undefined` value — exactly like `request-log.ts`'s
    // `renderLogMessage` fallback.
    //
    // A bare `throw undefined` isn't exercised here: `buildDatabaseSpan`
    // treats `failure === undefined` as "no failure" (the same sentinel
    // `createTracer`'s `let error: SpanEvent["error"]` uses), so a literal
    // `undefined` rejection never reaches `describeFailure` through this
    // path — a separate, pre-existing limitation this plan doesn't touch.
    it.each([
        { label: "a function", value: () => "nope" },
        { label: "a symbol", value: Symbol("x") },
    ])("renders $label's message as a string, not undefined", async ({ value }) => {
        expect.assertions(2);

        const database = fakeDatabase();

        database.insert.mockRejectedValueOnce(value);

        const tally = createDatabaseTally();
        const spans: SpanEvent[] = [];
        const instrumented = instrumentDatabase(
            database,
            deps("spans", tally, (recorded) => {
                spans.push(recorded);
            }),
        );

        await expect(instrumented.insert("orders", {})).rejects.toBe(value);

        expect(typeof spans[0]?.error?.message).toBe("string");
    });

    it("still uses the raw Error.message for an Error rejection", async () => {
        expect.assertions(2);

        const database = fakeDatabase();

        database.insert.mockRejectedValueOnce(new Error("boom"));

        const tally = createDatabaseTally();
        const spans: SpanEvent[] = [];
        const instrumented = instrumentDatabase(
            database,
            deps("spans", tally, (recorded) => {
                spans.push(recorded);
            }),
        );

        await expect(instrumented.insert("orders", {})).rejects.toThrow("boom");

        expect(spans[0]?.error?.message).toBe("boom");
    });
});
