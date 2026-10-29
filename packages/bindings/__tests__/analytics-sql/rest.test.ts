import { describe, expect, it, vi } from "vitest";

import { AnalyticsSqlQueryError, createAnalyticsSql, createAnalyticsSqlRest } from "../../src/analytics-sql";

type FetchMock = (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const okResponse = (body: unknown): Response => Response.json(body, { status: 200 });

describe("createAnalyticsSqlRest", () => {
    it("pOSTs { query, params, scope.accountTag } as JSON to the Analytics SQL endpoint with a bearer token", async () => {
        expect.assertions(4);

        const fetchMock = vi.fn<FetchMock>(async () => okResponse({ data: [], rows: 0, statistics: { bytes_read: 0, elapsed_ms: 1, rows_read: 0 } }));
        const transport = createAnalyticsSqlRest({ accountId: "acct-123", apiToken: "tok-secret", fetch: fetchMock });

        await transport.query({ params: ["2026-10-01T00:00:00Z"], query: "SELECT 1 FROM events.analyticsEngine.app WHERE timestamp >= $1" });

        const [url, init] = fetchMock.mock.calls[0]!;

        expect(url).toBe("https://api.cloudflare.com/client/v4/analytics/sql");
        expect(init?.method).toBe("POST");
        expect(JSON.parse(init?.body as string)).toStrictEqual({
            params: ["2026-10-01T00:00:00Z"],
            query: "SELECT 1 FROM events.analyticsEngine.app WHERE timestamp >= $1",
            scope: { accountTag: "acct-123" },
        });
        expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer tok-secret");
    });

    it("leaves params out of the body when none are given", async () => {
        expect.assertions(1);

        const fetchMock = vi.fn<FetchMock>(async () => okResponse({ data: [], rows: 0 }));

        await createAnalyticsSqlRest({ accountId: "a", apiToken: "t", fetch: fetchMock }).query({ query: "SELECT 1" });

        expect(JSON.parse(fetchMock.mock.calls[0]![1]?.body as string)).toStrictEqual({ query: "SELECT 1", scope: { accountTag: "a" } });
    });

    it("plugs into createAnalyticsSql as the binding-shaped fallback", async () => {
        expect.assertions(1);

        const statistics = { bytes_read: 720, elapsed_ms: 12, rows_read: 10 };
        const fetchMock = vi.fn<FetchMock>(async () => okResponse({ data: [{ calls: 2 }], rows: 1, statistics }));
        const client = createAnalyticsSql({ binding: createAnalyticsSqlRest({ accountId: "a", apiToken: "t", fetch: fetchMock }) });

        await expect(client.query("SELECT COUNT(*) AS calls FROM …")).resolves.toStrictEqual({ rowCount: 1, rows: [{ calls: 2 }], statistics });
    });

    it("falls back to the data length when the body omits rows, and omits absent statistics", async () => {
        expect.assertions(1);

        const fetchMock = vi.fn<FetchMock>(async () => okResponse({ data: [{ a: 1 }, { a: 2 }] }));

        await expect(createAnalyticsSqlRest({ accountId: "a", apiToken: "t", fetch: fetchMock }).query({ query: "SELECT 1" })).resolves.toStrictEqual({
            data: [{ a: 1 }, { a: 2 }],
            rows: 2,
        });
    });

    it.each([
        [429, true],
        [500, true],
        [503, true],
        [507, true],
        [400, false],
        [403, false],
        [422, false],
        [501, false],
    ])("maps a %i response to a status-carrying AnalyticsSqlQueryError (retryable: %s)", async (status, retryable) => {
        expect.assertions(4);

        const fetchMock = vi.fn<FetchMock>(async () => new Response("the statement needs a lower timestamp bound", { status }));

        const error = (await createAnalyticsSqlRest({ accountId: "a", apiToken: "t", fetch: fetchMock })
            .query({ query: "SELECT 1" })
            .catch((error_: unknown) => error_)) as AnalyticsSqlQueryError;

        expect(error).toBeInstanceOf(AnalyticsSqlQueryError);
        expect(error.status).toBe(status);
        expect(error.retryable).toBe(retryable);
        expect(error.message).toContain("lower timestamp bound");
    });

    it("rejects a 2xx body that is not JSON", async () => {
        expect.assertions(2);

        const fetchMock = vi.fn<FetchMock>(async () => new Response("<html>gateway</html>", { status: 200 }));

        const error = (await createAnalyticsSqlRest({ accountId: "a", apiToken: "t", fetch: fetchMock })
            .query({ query: "SELECT 1" })
            .catch((error_: unknown) => error_)) as AnalyticsSqlQueryError;

        expect(error).toBeInstanceOf(AnalyticsSqlQueryError);
        expect(error.retryable).toBe(false);
    });

    it("rejects a JSON body without a data array", async () => {
        expect.assertions(1);

        const fetchMock = vi.fn<FetchMock>(async () => okResponse({ errors: [], success: false }));

        await expect(createAnalyticsSqlRest({ accountId: "a", apiToken: "t", fetch: fetchMock }).query({ query: "SELECT 1" })).rejects.toBeInstanceOf(
            AnalyticsSqlQueryError,
        );
    });

    it("wraps a request that never reaches the API (DNS, reset) as a retryable query error", async () => {
        expect.assertions(4);

        const cause = new TypeError("fetch failed");
        const fetchMock = vi.fn<FetchMock>(async () => {
            throw cause;
        });

        const error = (await createAnalyticsSqlRest({ accountId: "a", apiToken: "t", fetch: fetchMock })
            .query({ query: "SELECT 1" })
            .catch((error_: unknown) => error_)) as AnalyticsSqlQueryError;

        expect(error).toBeInstanceOf(AnalyticsSqlQueryError);
        expect(error.retryable).toBe(true);
        expect(error.status).toBe(502);
        expect(error.cause).toBe(cause);
    });

    it("keeps the real status when the deadline fires while reading an error body", async () => {
        expect.assertions(3);

        const fetchMock = vi.fn<FetchMock>(
            async (_url, init) =>
                ({
                    ok: false,
                    status: 429,
                    text: async () =>
                        new Promise<string>((_resolve, reject) => {
                            init?.signal?.addEventListener("abort", () => {
                                reject(new DOMException("aborted", "AbortError"));
                            });
                        }),
                }) as unknown as Response,
        );

        const error = (await createAnalyticsSqlRest({ accountId: "a", apiToken: "t", fetch: fetchMock, timeoutMs: 5 })
            .query({ query: "SELECT 1" })
            .catch((error_: unknown) => error_)) as AnalyticsSqlQueryError;

        expect(error.status).toBe(429);
        expect(error.retryable).toBe(true);
        expect(error.message).not.toMatch(/timed out/);
    });

    it("aborts a stalled query after timeoutMs as a retryable 504", async () => {
        expect.assertions(3);

        const fetchMock = vi.fn<FetchMock>(
            async (_url, init) =>
                new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener("abort", () => {
                        reject(new DOMException("aborted", "AbortError"));
                    });
                }),
        );

        const error = (await createAnalyticsSqlRest({ accountId: "a", apiToken: "t", fetch: fetchMock, timeoutMs: 5 })
            .query({ query: "SELECT 1" })
            .catch((error_: unknown) => error_)) as AnalyticsSqlQueryError;

        expect(error).toBeInstanceOf(AnalyticsSqlQueryError);
        expect(error.status).toBe(504);
        expect(error.retryable).toBe(true);
    });
});
