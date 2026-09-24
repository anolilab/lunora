import { afterEach, describe, expect, it, vi } from "vitest";

import { AnalyticsSqlError, createAnalyticsSqlClient } from "../../src/analytics/sql-api";

const okResponse = (body: unknown): Response => Response.json(body, { headers: { "Content-Type": "application/json" }, status: 200 });

describe("createAnalyticsSqlClient", () => {
    it("pOSTs the raw SQL to the account endpoint with a bearer token", async () => {
        expect.assertions(4);

        const fetchMock = vi.fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (_url, _init) =>
            okResponse({ data: [], meta: [], rows: 0 }),
        );
        const client = createAnalyticsSqlClient({ accountId: "acct-123", apiToken: "tok-secret", fetch: fetchMock });

        await client.query("SELECT 1");

        const [url, init] = fetchMock.mock.calls[0]!;

        expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/acct-123/analytics_engine/sql");
        expect(init?.method).toBe("POST");
        expect(init?.body).toBe("SELECT 1");
        expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer tok-secret");
    });

    it("normalises AE's { meta, data, rows } body into columns/rows/rowCount", async () => {
        expect.assertions(3);

        const fetchMock = vi.fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (_url, _init) =>
            okResponse({
                data: [{ fn: "messages:list", p95: 42 }],
                meta: [
                    { name: "fn", type: "String" },
                    { name: "p95", type: "Float64" },
                ],
                rows: 1,
            }),
        );
        const client = createAnalyticsSqlClient({ accountId: "a", apiToken: "t", fetch: fetchMock });

        const result = await client.query("SELECT blob1 AS fn, quantileWeighted(0.95)(double1) AS p95 FROM ANALYTICS");

        expect(result.rowCount).toBe(1);
        expect(result.columns).toStrictEqual([
            { name: "fn", type: "String" },
            { name: "p95", type: "Float64" },
        ]);
        expect(result.rows).toStrictEqual([{ fn: "messages:list", p95: 42 }]);
    });

    it("encodes the account id as a single URL path segment", async () => {
        expect.assertions(1);

        const fetchMock = vi.fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (_url, _init) =>
            okResponse({ data: [], meta: [], rows: 0 }),
        );
        const accountId = "ev/il?x=1";
        const client = createAnalyticsSqlClient({ accountId, apiToken: "t", fetch: fetchMock });

        await client.query("SELECT 1");

        const [url] = fetchMock.mock.calls[0]!;

        expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/analytics_engine/sql`);
    });

    it("falls back to the row array length when the body omits rows", async () => {
        expect.assertions(1);

        const fetchMock = vi.fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (_url, _init) =>
            okResponse({ data: [{ a: 1 }, { a: 2 }], meta: [{ name: "a", type: "Float64" }] }),
        );
        const client = createAnalyticsSqlClient({ accountId: "a", apiToken: "t", fetch: fetchMock });

        const result = await client.query("SELECT 1");

        expect(result.rowCount).toBe(2);
    });

    it("normalises a 2xx non-JSON body into an AnalyticsSqlError", async () => {
        expect.assertions(2);

        const fetchMock = vi.fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
            async (_url, _init) => new Response("<html>not json</html>", { headers: { "Content-Type": "text/html" }, status: 200 }),
        );
        const client = createAnalyticsSqlClient({ accountId: "a", apiToken: "t", fetch: fetchMock });

        const error = await client.query("SELECT 1").catch((error_: unknown) => error_);

        expect(error).toBeInstanceOf(AnalyticsSqlError);
        expect((error as AnalyticsSqlError).status).toBe(200);
    });

    it("throws AnalyticsSqlError carrying the status + body on a non-2xx response", async () => {
        expect.assertions(2);

        const fetchMock = vi.fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
            async (_url, _init) => new Response("unauthorized", { status: 403 }),
        );
        const client = createAnalyticsSqlClient({ accountId: "a", apiToken: "bad", fetch: fetchMock });

        const error = await client.query("SELECT 1").catch((error_: unknown) => error_);

        expect(error).toBeInstanceOf(AnalyticsSqlError);
        expect((error as AnalyticsSqlError).status).toBe(403);
    });

    it("caps the upstream body in the message and keeps the whole of it on cause", async () => {
        expect.assertions(5);

        // `ANALYTICS_SQL_ERROR` is a catalogued (non-internal) code, so
        // `toErrorBody` echoes this message VERBATIM to whoever called the
        // action. An uncapped body puts a multi-KB gateway page — or AE's SQL
        // error text, which quotes the query — on the wire to a browser.
        const body = `<html>${"A".repeat(10_000)}</html>`;
        const fetchMock = vi.fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => new Response(body, { status: 502 }));
        const client = createAnalyticsSqlClient({ accountId: "a", apiToken: "t", fetch: fetchMock });

        const error = (await client.query("SELECT 1").catch((error_: unknown) => error_)) as AnalyticsSqlError;

        expect(error).toBeInstanceOf(AnalyticsSqlError);
        expect(error.status).toBe(502);
        // Status preserved, body preview bounded well under the 10 KB it read.
        expect(error.message).toContain("502");
        expect(error.message.length).toBeLessThan(400);
        // The full text is still available server-side, on `cause` — which
        // `toErrorBody` never serialises.
        expect(error.cause).toBe(body);
    });
});

describe("timeout", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    // A fetch that never settles until its signal aborts — the stalled-endpoint shape.
    const hungFetch = () =>
        vi.fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
            async (_url, init) =>
                new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener("abort", () => {
                        reject(new DOMException("The operation was aborted.", "AbortError"));
                    });
                }),
        );

    it("aborts a hung fetch after the default 60s as a 504 AnalyticsSqlError naming the deadline", async () => {
        expect.assertions(3);

        vi.useFakeTimers();

        const client = createAnalyticsSqlClient({ accountId: "a", apiToken: "t", fetch: hungFetch() });
        const caught = client.query("SELECT 1").catch((error_: unknown) => error_);

        await vi.advanceTimersByTimeAsync(60_000);

        const error = await caught;

        expect(error).toBeInstanceOf(AnalyticsSqlError);
        expect((error as AnalyticsSqlError).status).toBe(504);
        expect(String(error)).toMatch(/timed out after 60000ms/);
    });

    it("honours a timeoutMs override", async () => {
        expect.assertions(1);

        vi.useFakeTimers();

        const client = createAnalyticsSqlClient({ accountId: "a", apiToken: "t", fetch: hungFetch(), timeoutMs: 5 });
        const caught = client.query("SELECT 1").catch((error_: unknown) => error_);

        await vi.advanceTimersByTimeAsync(5);

        expect(String(await caught)).toMatch(/timed out after 5ms/);
    });

    it("leaves no pending timer behind a fast response", async () => {
        expect.assertions(2);

        vi.useFakeTimers();

        const fetchMock = vi.fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (_url, _init) =>
            okResponse({ data: [], meta: [], rows: 0 }),
        );
        const client = createAnalyticsSqlClient({ accountId: "a", apiToken: "t", fetch: fetchMock });

        await expect(client.query("SELECT 1")).resolves.toBeDefined();
        expect(vi.getTimerCount()).toBe(0);
    });
});
