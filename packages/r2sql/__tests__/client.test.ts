import { describe, expect, it, vi } from "vitest";

import { createR2Sql, R2SqlError } from "../src/client";
import { sql } from "../src/sql";

interface FakeResponseInit {
    body?: unknown;
    nonJson?: boolean;
    ok?: boolean;
    status?: number;
}

const fakeResponse = (init: FakeResponseInit = {}): Response => {
    const { body = { result: { rows: [], schema: [] }, success: true }, nonJson = false, ok = true, status = 200 } = init;

    return {
        ok,
        status,
        json: async () => {
            if (nonJson) {
                throw new SyntaxError("not json");
            }

            return body;
        },
        text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    } as unknown as Response;
};

const setup = (responseInit?: FakeResponseInit) => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>(async () => fakeResponse(responseInit));
    const client = createR2Sql({ accountId: "acc/123", apiToken: "secret-token", bucket: "my bucket", fetch: fetchImpl });

    return { client, fetchImpl };
};

describe("createR2Sql request", () => {
    it("sends a POST to the bucket endpoint with the bearer token, query and warehouse", async () => {
        const { client, fetchImpl } = setup({ body: { result: { rows: [{ n: 1 }] }, success: true } });

        await client.query(sql`SELECT 1 AS n`);

        const [url, requestInit] = fetchImpl.mock.calls[0]!;

        // Account id + bucket are URL-encoded as single path segments.
        // eslint-disable-next-line no-secrets/no-secrets -- a deterministic test URL, not a credential
        expect(url).toBe("https://api.sql.cloudflarestorage.com/api/v1/accounts/acc%2F123/r2-sql/query/my%20bucket");
        expect(requestInit?.method).toBe("POST");
        expect((requestInit?.headers as Record<string, string>).Authorization).toBe("Bearer secret-token");
        expect((requestInit?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
        // The body carries the query plus the `<accountId>_<bucket>` warehouse name.
        expect(JSON.parse(requestInit?.body as string)).toEqual({ query: "SELECT 1 AS n", warehouse: "acc/123_my bucket" });
    });

    it("honours a custom endpoint override", async () => {
        const fetchImpl = vi.fn<typeof globalThis.fetch>(async () => fakeResponse());
        const client = createR2Sql({ accountId: "a", apiToken: "t", bucket: "b", endpoint: "https://example.test/v1/accounts", fetch: fetchImpl });

        await client.query("SELECT 1");

        expect(fetchImpl.mock.calls[0]![0]).toBe("https://example.test/v1/accounts/a/r2-sql/query/b");
    });
});

describe("response normalisation", () => {
    it("reads rows from `result.rows` and infers columns when no schema is echoed", async () => {
        const { client } = setup({ body: { errors: [], result: { rows: [{ id: "x", total: 5 }] }, success: true } });

        const out = await client.query<{ id: string; total: number }>("SELECT id, total FROM s.orders");

        expect(out.rows).toEqual([{ id: "x", total: 5 }]);
        expect(out.rowCount).toBe(1);
        expect(out.columns).toEqual([{ name: "id" }, { name: "total" }]);
    });

    it("returns an empty result when `result` is absent", async () => {
        const { client } = setup({ body: { success: true } });
        const result = await client.query("SELECT 1");

        expect(result.rows).toEqual([]);
        expect(result.rowCount).toBe(0);
        expect(result.columns).toEqual([]);
    });

    it("prefers the echoed `result.schema` over inference", async () => {
        const { client } = setup({ body: { result: { rows: [{ id: "x" }], schema: [{ name: "id", type: "string" }] }, success: true } });
        const result = await client.query("SELECT id FROM s.orders");

        expect(result.columns).toEqual([{ name: "id", type: "string" }]);
    });
});

describe("errors", () => {
    it("throws R2SqlError on a non-2xx status", async () => {
        const { client } = setup({ body: "rate limited", ok: false, status: 429 });

        await expect(client.query("SELECT 1")).rejects.toBeInstanceOf(R2SqlError);
        await expect(client.query("SELECT 1")).rejects.toMatchObject({ status: 429 });
    });

    it("throws on a success:false envelope with a 2xx status", async () => {
        const { client } = setup({ body: { errors: [{ message: "syntax error" }], success: false } });

        await expect(client.query("SELECT bad")).rejects.toThrow(/syntax error/);
    });

    it("throws a normalised error on a non-JSON 2xx body", async () => {
        const { client } = setup({ nonJson: true });

        await expect(client.query("SELECT 1")).rejects.toThrow(/non-JSON body/);
    });
});

describe("helpers", () => {
    it("explain prefixes EXPLAIN (and FORMAT JSON)", async () => {
        const { client, fetchImpl } = setup();

        await client.explain(sql`SELECT 1`);

        expect(JSON.parse(fetchImpl.mock.calls[0]![1]?.body as string).query).toBe("EXPLAIN SELECT 1");

        await client.explain("SELECT 2", { format: "json" });

        expect(JSON.parse(fetchImpl.mock.calls[1]![1]?.body as string).query).toBe("EXPLAIN FORMAT JSON SELECT 2");
    });

    it("schema-discovery helpers emit the right statements", async () => {
        const { client, fetchImpl } = setup();

        await client.showDatabases();
        await client.showTables("sales");
        await client.describe("sales.orders");

        const queries = fetchImpl.mock.calls.map((call) => JSON.parse(call[1]?.body as string).query);

        expect(queries).toEqual(["SHOW DATABASES", "SHOW TABLES IN sales", "DESCRIBE sales.orders"]);
    });

    it("from() builds a runnable query bound to the client", async () => {
        const { client, fetchImpl } = setup({ body: { result: { rows: [{ region: "North" }] }, success: true } });

        const out = await client.from("sales.orders").select("region").distinct().limit(10).run();

        expect(JSON.parse(fetchImpl.mock.calls[0]![1]?.body as string).query).toBe("SELECT DISTINCT region FROM sales.orders LIMIT 10");
        expect(out.rows).toEqual([{ region: "North" }]);
    });
});
