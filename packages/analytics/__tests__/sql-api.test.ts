import { describe, expect, it, vi } from "vitest";

import { AnalyticsSqlError, createAnalyticsSqlClient } from "../src/sql-api";

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
});
