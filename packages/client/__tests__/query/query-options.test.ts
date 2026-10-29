import { describe, expect, it, vi } from "vitest";

import { LunoraClient } from "../../src/lunora-client";
import { lunoraQueryKey, lunoraQueryKeyFromArgsKey, lunoraQueryOptions } from "../../src/query";
import type { FunctionReference } from "../../src/types";

const fnRef = (ref: string): FunctionReference<"query", Record<string, unknown>, { count: number }> => {
    return { __lunoraRef: ref };
};

const jsonResponse = (body: unknown): Response => Response.json(body, { headers: { "content-type": "application/json" }, status: 200 });

describe(lunoraQueryKey, () => {
    it("namespaces the key and keeps an absent shardKey distinct from an empty one", () => {
        expect.assertions(2);

        expect(lunoraQueryKey(fnRef("posts:list"), { a: 1 }, undefined)).toStrictEqual(["lunora", "posts:list", expect.any(String), null]);
        expect(lunoraQueryKey(fnRef("posts:list"), {}, "")).not.toStrictEqual(lunoraQueryKey(fnRef("posts:list"), {}, undefined));
    });

    it("encodes args into a string slot independent of property order", () => {
        expect.assertions(3);

        const forward = lunoraQueryKey(fnRef("posts:list"), { a: 1, b: 2 }, undefined);

        expect(typeof forward[2]).toBe("string");
        expect(lunoraQueryKey(fnRef("posts:list"), { b: 2, a: 1 }, undefined)).toStrictEqual(forward);
        expect(lunoraQueryKeyFromArgsKey("posts:list", forward[2] as string, undefined)).toStrictEqual(forward);
    });

    it("keeps args TanStack's JSON hashing would conflate apart", () => {
        expect.assertions(1);

        // JSON.stringify maps NaN to null, so a raw-args key would share one entry.
        expect(lunoraQueryKey(fnRef("q"), { n: Number.NaN }, undefined)).not.toStrictEqual(lunoraQueryKey(fnRef("q"), { n: null }, undefined));
    });
});

describe(lunoraQueryOptions, () => {
    it("keys like lunoraQueryKey, never goes stale, and fetches once over HTTP", async () => {
        expect.assertions(3);

        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ result: { count: 5 } }));
        const client = new LunoraClient({ fetch: fetchMock, url: "https://app.example" });
        const reference = fnRef("posts:count");

        const options = lunoraQueryOptions(client, reference, {});

        expect(options.queryKey).toStrictEqual(lunoraQueryKey(reference, {}, undefined));
        expect(options.staleTime).toBe(Number.POSITIVE_INFINITY);
        await expect(options.queryFn()).resolves.toStrictEqual({ count: 5 });

        client.close();
    });

    it("threads shardKey into both the key and the call", async () => {
        expect.assertions(2);

        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ result: { count: 1 } }));
        const client = new LunoraClient({ fetch: fetchMock, url: "https://app.example" });
        const reference = fnRef("rooms:get");

        const options = lunoraQueryOptions(client, reference, {}, { shardKey: "room-7" });

        expect(options.queryKey).toStrictEqual(lunoraQueryKey(reference, {}, "room-7"));

        await options.queryFn();

        const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string) as { shardKey?: string };

        expect(body.shardKey).toBe("room-7");

        client.close();
    });
});
