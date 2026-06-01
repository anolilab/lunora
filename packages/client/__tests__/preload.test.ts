import { describe, expect, it, vi } from "vitest";

import { CirrusClient } from "../src/cirrus-client.js";
import { preloadedQueryResult, preloadQuery } from "../src/preload.js";
import type { FunctionReference, Preloaded } from "../src/types.js";

const fnRef = (ref: string): FunctionReference => {
    return { __cirrusRef: ref };
};

const jsonResponse = (body: unknown): Response => Response.json(body, { headers: { "content-type": "application/json" }, status: 200 });

describe("preloadQuery", () => {
    it("executes the query over HTTP and captures a JSON-serializable token", async () => {
        expect.assertions(7);

        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ result: { rows: [1, 2, 3] } }));
        const client = new CirrusClient({ fetch: fetchMock, url: "https://app.example" });

        const preloaded = await preloadQuery(client, fnRef("posts:list"), { limit: 3 });

        expect(preloaded.__cirrusPreloaded).toBe(true);
        expect(preloaded.functionPath).toBe("posts:list");
        expect(preloaded.args).toEqual({ limit: 3 });
        expect(preloaded.value).toEqual({ rows: [1, 2, 3] });

        // The token must survive JSON serialization (it travels in the HTML).
        const serialized = JSON.stringify(preloaded);
        const roundTripped = JSON.parse(serialized) as unknown;

        expect(roundTripped).toEqual({
            __cirrusPreloaded: true,
            args: { limit: 3 },
            functionPath: "posts:list",
            value: { rows: [1, 2, 3] },
        });

        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];

        expect(url).toBe("https://app.example/_cirrus/rpc");
        expect(JSON.parse(init.body as string)).toEqual({ args: { limit: 3 }, functionPath: "posts:list", shardKey: undefined });
    });

    it("carries the shardKey when one is supplied", async () => {
        expect.assertions(2);

        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ result: 7 }));
        const client = new CirrusClient({ fetch: fetchMock, url: "https://app.example" });

        const preloaded = await preloadQuery(client, fnRef("rooms:count"), {}, { shardKey: "room-1" });

        expect(preloaded.shardKey).toBe("room-1");
        expect(preloaded.value).toBe(7);
    });

    it("surfaces a server error instead of producing a token", async () => {
        expect.assertions(1);

        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ error: { code: "BOOM", message: "fail" } }));
        const client = new CirrusClient({ fetch: fetchMock, url: "https://app.example" });

        await expect(preloadQuery(client, fnRef("posts:list"), {})).rejects.toMatchObject({ code: "BOOM", message: "fail" });
    });
});

describe("preloadedQueryResult", () => {
    it("returns the captured value", () => {
        expect.assertions(1);

        const token: Preloaded<{ ok: boolean }> = { __cirrusPreloaded: true, args: {}, functionPath: "x:y", value: { ok: true } };

        expect(preloadedQueryResult(token)).toEqual({ ok: true });
    });
});
