import { describe, expect, expectTypeOf, it, vi } from "vitest";

import type { AnalyticsSqlBindingLike, AnalyticsSqlRawResult, AnalyticsSqlRequest } from "../../src/analytics-sql";
import { AnalyticsSqlQueryError, createAnalyticsSql } from "../../src/analytics-sql";

const STATISTICS = { bytes_read: 720, elapsed_ms: 12, rows_read: 10 };

/** A structural double of the Analytics SQL binding that answers every query with `result`. */
const fakeBinding = (result: AnalyticsSqlRawResult): { binding: AnalyticsSqlBindingLike; calls: AnalyticsSqlRequest[] } => {
    const calls: AnalyticsSqlRequest[] = [];
    const binding: AnalyticsSqlBindingLike = {
        query: async <T extends Record<string, unknown>>(request: AnalyticsSqlRequest) => {
            calls.push(request);

            return result as AnalyticsSqlRawResult<T>;
        },
    };

    return { binding, calls };
};

describe("createAnalyticsSql", () => {
    it("forwards the statement and named params to the binding as { query, params }", async () => {
        expect.assertions(1);

        const { binding, calls } = fakeBinding({ data: [], rows: 0, statistics: STATISTICS });

        await createAnalyticsSql({ binding }).query("SELECT COUNT(*) AS n FROM events.httpRequests WHERE timestamp >= $start", {
            start: "2026-10-01T00:00:00Z",
        });

        expect(calls).toStrictEqual([
            { params: { start: "2026-10-01T00:00:00Z" }, query: "SELECT COUNT(*) AS n FROM events.httpRequests WHERE timestamp >= $start" },
        ]);
    });

    it("omits params entirely when none are given", async () => {
        expect.assertions(1);

        const { binding, calls } = fakeBinding({ data: [], rows: 0, statistics: STATISTICS });

        await createAnalyticsSql({ binding }).query("SELECT 1");

        expect(calls[0]).toStrictEqual({ query: "SELECT 1" });
    });

    it("maps { data, rows, statistics } to { rows, rowCount, statistics }", async () => {
        expect.assertions(1);

        const { binding } = fakeBinding({ data: [{ calls: 3, fn: "messages:list" }], rows: 1, statistics: STATISTICS });

        const result = await createAnalyticsSql({ binding }).query<{ calls: number; fn: string }>("SELECT …", [1]);

        expect(result).toStrictEqual({ rowCount: 1, rows: [{ calls: 3, fn: "messages:list" }], statistics: STATISTICS });
    });

    it("leaves statistics off when the transport reports none", async () => {
        expect.assertions(1);

        const { binding } = fakeBinding({ data: [], rows: 0 });

        const result = await createAnalyticsSql({ binding }).query("SELECT 1");

        expect(result).toStrictEqual({ rowCount: 0, rows: [] });
    });

    it("types rows by the caller's row type", () => {
        expect.assertions(0);

        const client = createAnalyticsSql({ binding: fakeBinding({ data: [], rows: 0 }).binding });

        expectTypeOf<Awaited<ReturnType<typeof client.query<{ calls: number }>>>["rows"]>().toEqualTypeOf<{ calls: number }[]>();
    });

    it("rethrows a binding rejection as AnalyticsSqlQueryError, keeping its retryable flag", async () => {
        expect.assertions(5);

        const cause = Object.assign(new Error("query exceeded a resource limit"), { retryable: true });
        const binding: AnalyticsSqlBindingLike = { query: vi.fn<() => Promise<never>>().mockRejectedValue(cause) };

        const error = await createAnalyticsSql({ binding })
            .query("SELECT 1")
            .catch((error_: unknown) => error_);

        expect(error).toBeInstanceOf(AnalyticsSqlQueryError);
        expect((error as AnalyticsSqlQueryError).code).toBe("ANALYTICS_SQL_QUERY_ERROR");
        expect((error as AnalyticsSqlQueryError).retryable).toBe(true);
        expect((error as AnalyticsSqlQueryError).data).toStrictEqual({ retryable: true });
        expect((error as AnalyticsSqlQueryError).cause).toBe(cause);
    });

    it("treats a binding error without a retryable flag as not retryable", async () => {
        expect.assertions(1);

        const binding: AnalyticsSqlBindingLike = { query: vi.fn<() => Promise<never>>().mockRejectedValue(new Error("syntax error")) };

        await expect(createAnalyticsSql({ binding }).query("SELEC 1")).rejects.toMatchObject({ retryable: false });
    });

    it("caps the upstream text it puts in the client-safe message", async () => {
        expect.assertions(2);

        const binding: AnalyticsSqlBindingLike = { query: vi.fn<() => Promise<never>>().mockRejectedValue(new Error("x".repeat(1000))) };

        const error = (await createAnalyticsSql({ binding })
            .query("SELECT 1")
            .catch((error_: unknown) => error_)) as AnalyticsSqlQueryError;

        expect(error.message.length).toBeLessThan(400);
        expect(error.message).toContain("(truncated)");
    });

    it("passes an AnalyticsSqlQueryError from the REST transport through unwrapped", async () => {
        expect.assertions(1);

        const original = new AnalyticsSqlQueryError("429 slow down", { retryable: true, status: 429 });
        const binding: AnalyticsSqlBindingLike = { query: vi.fn<() => Promise<never>>().mockRejectedValue(original) };

        await expect(createAnalyticsSql({ binding }).query("SELECT 1")).rejects.toBe(original);
    });
});

describe("@lunora/bindings/analytics-sql types", () => {
    it("accepts the real Analytics SQL binding as AnalyticsSqlBindingLike", () => {
        expect.assertions(0);

        // `AnalyticsSQLBinding` is ambient from @cloudflare/workers-types (the
        // package tsconfig's `types`); drift from the mirror fails lint:types here.
        expectTypeOf<AnalyticsSQLBinding>().toExtend<AnalyticsSqlBindingLike>();
    });
});
