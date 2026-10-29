import { describe, expect, it, vi } from "vitest";

import { LunoraClient } from "../src/lunora-client";
import type { FunctionReference } from "../src/types";

const fnRef = (ref: string): FunctionReference => {
    return { __lunoraRef: ref };
};

// RPC-only tests never open a socket; this stub just satisfies the option type.
class NoopSocket {
    public readonly readyState = 0;
}

const client = (fetchImpl: typeof fetch): LunoraClient =>
    new LunoraClient({ fetch: fetchImpl, url: "https://app.example", WebSocket: NoopSocket as unknown as typeof WebSocket });

// A session cookie a reply may carry. It must reach the caller's `headers` record and nothing that serializes.
const SESSION_COOKIE = "lunora_session=sentinel-cookie-value";

describe("rpc error response headers", () => {
    it("carries the reply's headers, lowercased, on a coded envelope error", async () => {
        expect.assertions(2);

        const fetchMock = vi.fn<typeof fetch>(async () =>
            Response.json({ error: { code: "TOO_MANY_REQUESTS", message: "slow down" } }, { headers: { "Retry-After": "3", "X-Custom": "abc" }, status: 429 }),
        );

        const error = (await client(fetchMock)
            .mutation(fnRef("docs:write"), {})
            .catch((error_: unknown) => error_)) as { headers?: Record<string, string> };

        expect(error.headers).toMatchObject({ "retry-after": "3", "x-custom": "abc" });
        expect(Object.isFrozen(error.headers)).toBe(true);
    });

    it("carries the reply's headers on a 5xx with no envelope (a gateway page)", async () => {
        expect.assertions(2);

        const fetchMock = vi.fn<typeof fetch>(
            async () => new Response("<html>bad gateway</html>", { headers: { "retry-after": "2", "x-edge": "cf" }, status: 503 }),
        );

        const error = (await client(fetchMock)
            .query(fnRef("docs:get"), {})
            .catch((error_: unknown) => error_)) as { data?: { retryAfterMs?: number }; headers?: Record<string, string> };

        expect(error.headers).toMatchObject({ "retry-after": "2", "x-edge": "cf" });
        expect(error.data).toStrictEqual({ retryAfterMs: 2000 });
    });

    it("carries the reply's headers on a 4xx with no envelope", async () => {
        expect.assertions(1);

        const fetchMock = vi.fn<typeof fetch>(async () => new Response("nope", { headers: { "x-edge": "cf" }, status: 400 }));

        await expect(client(fetchMock).mutation(fnRef("docs:write"), {})).rejects.toMatchObject({ headers: { "x-edge": "cf" } });
    });

    it("carries the reply's headers when the body is JSON null", async () => {
        expect.assertions(1);

        const fetchMock = vi.fn<typeof fetch>(async () => Response.json(null, { headers: { "x-edge": "cf" }, status: 502 }));

        await expect(client(fetchMock).query(fnRef("docs:get"), {})).rejects.toMatchObject({ headers: { "x-edge": "cf" } });
    });

    it("leaves headers absent when no reply arrived (the fetch itself rejected)", async () => {
        expect.assertions(2);

        const fetchMock = vi.fn<typeof fetch>(async () => {
            throw new TypeError("fetch failed");
        });

        const error = (await client(fetchMock)
            .query(fnRef("docs:get"), {})
            .catch((error_: unknown) => error_)) as { headers?: unknown };

        expect(error).toBeInstanceOf(Error);
        expect(error).not.toHaveProperty("headers");
    });

    it("keeps headers out of the enumerable keys and out of JSON, so a cookie never reaches a log line", async () => {
        expect.assertions(3);

        const fetchMock = vi.fn<typeof fetch>(async () =>
            Response.json({ error: { code: "CONFLICT", message: "stale" } }, { headers: { "set-cookie": SESSION_COOKIE, "x-edge": "cf" }, status: 409 }),
        );

        const error = (await client(fetchMock)
            .mutation(fnRef("docs:write"), {})
            .catch((error_: unknown) => error_)) as Record<string, unknown> & { headers?: Record<string, string> };

        // Another header is present, so the negative assertions below cannot pass by the whole record being dropped.
        expect(error.headers?.["x-edge"]).toBe("cf");
        expect(error.headers).not.toHaveProperty("set-cookie");
        expect(JSON.stringify(error)).not.toContain(SESSION_COOKIE);
    });

    it("carries the reply's headers on a successful reply whose result does not decode", async () => {
        expect.assertions(1);

        const fetchMock = vi.fn<typeof fetch>(async () =>
            Response.json({ result: ["$lunora.wire$", "bigint", "not-a-number"] }, { headers: { "x-edge": "cf" }, status: 200 }),
        );

        await expect(client(fetchMock).query(fnRef("docs:read"), {})).rejects.toMatchObject({ code: "WIRE_DECODE_FAILED", headers: { "x-edge": "cf" } });
    });

    it("carries the reply's headers on a whole-batch rejection from client.batch", async () => {
        expect.assertions(1);

        const fetchMock = vi.fn<typeof fetch>(async () =>
            Response.json({ error: { code: "TOO_MANY_REQUESTS", message: "slow down" } }, { headers: { "x-edge": "cf" }, status: 429 }),
        );

        await expect(client(fetchMock).batch([{ fn: fnRef("docs:read") }])).rejects.toMatchObject({ headers: { "x-edge": "cf" } });
    });

    it("carries the reply's headers when a batch reply is not JSON, or is JSON with no results and no envelope", async () => {
        expect.assertions(2);

        const notJson = vi.fn<typeof fetch>(async () => new Response("<html>bad gateway</html>", { headers: { "x-edge": "cf" }, status: 502 }));
        const noEnvelope = vi.fn<typeof fetch>(async () => Response.json({ note: "proxy" }, { headers: { "x-edge": "cf" }, status: 502 }));

        await expect(client(notJson).batch([{ fn: fnRef("docs:read") }])).rejects.toMatchObject({ headers: { "x-edge": "cf" } });
        await expect(client(noEnvelope).batch([{ fn: fnRef("docs:read") }])).rejects.toMatchObject({ headers: { "x-edge": "cf" } });
    });

    it("carries the reply's headers on one failed slot of a batch that succeeded as a whole", async () => {
        expect.assertions(2);

        const fetchMock = vi.fn<typeof fetch>(async () =>
            Response.json(
                {
                    results: [
                        { body: { error: { code: "TOO_MANY_REQUESTS", message: "slow down" } }, id: 0 },
                        { body: { result: 1 }, id: 1 },
                    ],
                },
                { headers: { "retry-after": "3" }, status: 200 },
            ),
        );

        const [failed, succeeded] = await client(fetchMock).batch([{ fn: fnRef("docs:read") }, { fn: fnRef("docs:read") }]);

        expect(failed?.ok === false ? failed.error : undefined).toHaveProperty("headers.retry-after", "3");
        expect(succeeded).toStrictEqual({ ok: true, value: 1 });
    });
});
