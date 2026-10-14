import { describe, expect, it, vi } from "vitest";

import { encodeWire } from "../../../shared/wire-codec";
import type { FetchLike } from "../src/bridge";
import { ContainerBridgeError, createContainerBridge } from "../src/bridge";

/** A fetch stub recording the request and returning a scripted JSON body. */
const stubFetch = (
    body: unknown,
    init: { ok?: boolean; status?: number } = {},
): { calls: { body: string; headers: Record<string, string>; url: string }[]; fetch: FetchLike } => {
    const calls: { body: string; headers: Record<string, string>; url: string }[] = [];

    const fetch: FetchLike = async (url, requestInit) => {
        calls.push({ body: requestInit.body, headers: requestInit.headers, url });

        return { json: async () => body, ok: init.ok ?? true, status: init.status ?? 200 };
    };

    return { calls, fetch };
};

/** A fetch stub whose `json()` rejects, simulating a non-JSON body. */
const stubFetchInvalidJson = (init: { ok?: boolean; status?: number } = {}): FetchLike => {
    const rejectJson = async (): Promise<never> => {
        throw new SyntaxError("Unexpected token < in JSON");
    };

    return async () => {
        return { json: rejectJson, ok: init.ok ?? true, status: init.status ?? 200 };
    };
};

describe(createContainerBridge, () => {
    it("sends the RPC envelope to /_lunora/rpc and unwraps result", async () => {
        expect.assertions(4);

        const { calls, fetch } = stubFetch({ result: [{ id: 1 }] });
        const lunora = createContainerBridge({ baseUrl: "https://app.example.com/", fetch, token: "svc-token" });

        const result = await lunora.query("messages:list", { limit: 5 });

        expect(result).toStrictEqual([{ id: 1 }]);
        expect(calls[0]!.url).toBe("https://app.example.com/_lunora/rpc");
        expect(JSON.parse(calls[0]!.body)).toStrictEqual({ args: { limit: 5 }, functionPath: "messages:list" });
        expect(calls[0]!.headers.authorization).toBe("Bearer svc-token");
    });

    it("brackets both directions with the wire codec", async () => {
        expect.assertions(2);

        // This bridge speaks the same `/_lunora/rpc` protocol as `LunoraClient`,
        // so it owes the same codec: the shard runs `decodeWire` over inbound
        // `args` and answers `encodeWire(result)`. Un-bracketed, a `bigint` arg
        // throws inside `JSON.stringify`, a `Date` arg arrives as an ISO string,
        // and a `v.bigint()` column comes back as a raw tag array instead of a
        // value.
        const { calls, fetch } = stubFetch({ result: encodeWire({ at: new Date("2024-01-01T00:00:00.000Z"), views: 9_007_199_254_740_993n }) });
        const lunora = createContainerBridge({ baseUrl: "https://app.example.com/", fetch });

        const result = await lunora.query("posts:get", { blob: new Uint8Array([1, 2, 3]).buffer, since: 7n });

        expect(result).toStrictEqual({ at: new Date("2024-01-01T00:00:00.000Z"), views: 9_007_199_254_740_993n });
        expect(JSON.parse(calls[0]!.body)).toStrictEqual({
            args: encodeWire({ blob: new Uint8Array([1, 2, 3]).buffer, since: 7n }),
            functionPath: "posts:get",
        });
    });

    it("omits the Authorization header when no token is given", async () => {
        expect.assertions(1);

        const { calls, fetch } = stubFetch({ result: null });
        const lunora = createContainerBridge({ baseUrl: "https://app.example.com", fetch });

        await lunora.call("ping:ping");

        expect(calls[0]!.headers.authorization).toBeUndefined();
    });

    it("forwards a shardKey when provided", async () => {
        expect.assertions(1);

        const { calls, fetch } = stubFetch({ result: true });
        const lunora = createContainerBridge({ baseUrl: "https://app.example.com", fetch });

        await lunora.mutation("rooms:join", { room: "x" }, "tenant-7");

        expect((JSON.parse(calls[0]!.body) as { shardKey: string }).shardKey).toBe("tenant-7");
    });

    it("throws a ContainerBridgeError carrying the wire code on an error envelope", async () => {
        expect.assertions(2);

        const { fetch } = stubFetch({ error: { code: "NOT_FOUND", message: "function not found" } }, { ok: false, status: 404 });
        const lunora = createContainerBridge({ baseUrl: "https://app.example.com", fetch });

        const error = await lunora.query("nope:nope").catch((error_: unknown) => error_);

        expect(error).toBeInstanceOf(ContainerBridgeError);
        expect((error as ContainerBridgeError).code).toBe("NOT_FOUND");
    });

    it("throws on a non-ok response without an error envelope", async () => {
        expect.assertions(1);

        const { fetch } = stubFetch({ result: undefined }, { ok: false, status: 502 });
        const lunora = createContainerBridge({ baseUrl: "https://app.example.com", fetch });

        await expect(lunora.query("x:y")).rejects.toThrow("status 502");
    });

    it("throws a non-JSON error on a malformed success body", async () => {
        expect.assertions(1);

        const lunora = createContainerBridge({ baseUrl: "https://app.example.com", fetch: stubFetchInvalidJson({ ok: true, status: 200 }) });

        await expect(lunora.query("x:y")).rejects.toThrow("non-JSON response");
    });

    it("throws a status error on a malformed non-ok body", async () => {
        expect.assertions(1);

        const lunora = createContainerBridge({ baseUrl: "https://app.example.com", fetch: stubFetchInvalidJson({ ok: false, status: 502 }) });

        await expect(lunora.query("x:y")).rejects.toThrow("status 502");
    });

    it("throws a clear error (not ContainerBridgeError) on a malformed error envelope", async () => {
        expect.assertions(2);

        const { fetch } = stubFetch({ error: { code: 123 } }, { ok: false, status: 500 });
        const lunora = createContainerBridge({ baseUrl: "https://app.example.com", fetch });

        const error = await lunora.query("x:y").catch((error_: unknown) => error_);

        expect(error).not.toBeInstanceOf(ContainerBridgeError);
        expect((error as Error).message).toContain("malformed error envelope");
    });

    it("surfaces the partial error payload on a malformed error envelope", async () => {
        expect.assertions(2);

        const { fetch } = stubFetch({ error: { code: "NOT_FOUND" } }, { ok: false, status: 404 });
        const lunora = createContainerBridge({ baseUrl: "https://app.example.com", fetch });

        const error = await lunora.query("nope:nope").catch((error_: unknown) => error_);

        expect(error).not.toBeInstanceOf(ContainerBridgeError);
        expect((error as Error).message).toContain("NOT_FOUND");
    });

    it("query/mutation/action are aliases of the same call", () => {
        expect.assertions(1);

        const { fetch } = stubFetch({ result: 1 });
        const lunora = createContainerBridge({ baseUrl: "https://app.example.com", fetch });

        expect(new Set([lunora.action, lunora.call, lunora.mutation, lunora.query]).size).toBe(1);
    });

    it("run() sends a generated function reference's __lunoraRef with inferred arg/result types", async () => {
        expect.assertions(2);

        const { calls, fetch } = stubFetch({ result: { id: "m1" } });
        const lunora = createContainerBridge({ baseUrl: "https://app.example.com", fetch });

        // Shaped like a generated `api.messages.send` reference (phantom args/returns).
        const reference = { __lunoraPhantom: undefined as unknown as { args: { text: string }; returns: { id: string } }, __lunoraRef: "messages:send" };

        const result = await lunora.run(reference, { text: "hi" });

        // `result` is typed `{ id: string }` and `args` is typed `{ text: string }` — a wrong shape is a compile error.
        expect(result.id).toBe("m1");
        expect(JSON.parse(calls[0]!.body)).toStrictEqual({ args: { text: "hi" }, functionPath: "messages:send" });
    });

    it("throws at construction on a missing or empty baseUrl", () => {
        expect.assertions(2);

        expect(() => createContainerBridge({ baseUrl: "" })).toThrow("`baseUrl` must be a non-empty");
        // @ts-expect-error -- deliberately omit baseUrl to mirror an unset env var
        expect(() => createContainerBridge({})).toThrow("`baseUrl` must be a non-empty");
    });

    it("errors when no fetch is available", async () => {
        expect.assertions(1);

        const original = globalThis.fetch;

        // @ts-expect-error -- deliberately remove the global for this case
        delete globalThis.fetch;
        const lunora = createContainerBridge({ baseUrl: "https://app.example.com" });

        await expect(lunora.query("x:y")).rejects.toThrow("no `fetch` available");

        globalThis.fetch = original;
        vi.restoreAllMocks();
    });
});
