import { describe, expect, it, vi } from "vitest";

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
    it("sends the RPC envelope to /_cirrus/rpc and unwraps result", async () => {
        expect.assertions(4);

        const { calls, fetch } = stubFetch({ result: [{ id: 1 }] });
        const cirrus = createContainerBridge({ baseUrl: "https://app.example.com/", fetch, token: "svc-token" });

        const result = await cirrus.query("messages:list", { limit: 5 });

        expect(result).toStrictEqual([{ id: 1 }]);
        expect(calls[0]!.url).toBe("https://app.example.com/_cirrus/rpc");
        expect(JSON.parse(calls[0]!.body)).toStrictEqual({ args: { limit: 5 }, functionPath: "messages:list" });
        expect(calls[0]!.headers.authorization).toBe("Bearer svc-token");
    });

    it("omits the Authorization header when no token is given", async () => {
        expect.assertions(1);

        const { calls, fetch } = stubFetch({ result: null });
        const cirrus = createContainerBridge({ baseUrl: "https://app.example.com", fetch });

        await cirrus.call("ping:ping");

        expect(calls[0]!.headers.authorization).toBeUndefined();
    });

    it("forwards a shardKey when provided", async () => {
        expect.assertions(1);

        const { calls, fetch } = stubFetch({ result: true });
        const cirrus = createContainerBridge({ baseUrl: "https://app.example.com", fetch });

        await cirrus.mutation("rooms:join", { room: "x" }, "tenant-7");

        expect((JSON.parse(calls[0]!.body) as { shardKey: string }).shardKey).toBe("tenant-7");
    });

    it("throws a ContainerBridgeError carrying the wire code on an error envelope", async () => {
        expect.assertions(2);

        const { fetch } = stubFetch({ error: { code: "NOT_FOUND", message: "function not found" } }, { ok: false, status: 404 });
        const cirrus = createContainerBridge({ baseUrl: "https://app.example.com", fetch });

        const error = await cirrus.query("nope:nope").catch((error_: unknown) => error_);

        expect(error).toBeInstanceOf(ContainerBridgeError);
        expect((error as ContainerBridgeError).code).toBe("NOT_FOUND");
    });

    it("throws on a non-ok response without an error envelope", async () => {
        expect.assertions(1);

        const { fetch } = stubFetch({ result: undefined }, { ok: false, status: 502 });
        const cirrus = createContainerBridge({ baseUrl: "https://app.example.com", fetch });

        await expect(cirrus.query("x:y")).rejects.toThrow("status 502");
    });

    it("throws a non-JSON error on a malformed success body", async () => {
        expect.assertions(1);

        const cirrus = createContainerBridge({ baseUrl: "https://app.example.com", fetch: stubFetchInvalidJson({ ok: true, status: 200 }) });

        await expect(cirrus.query("x:y")).rejects.toThrow("non-JSON response");
    });

    it("throws a status error on a malformed non-ok body", async () => {
        expect.assertions(1);

        const cirrus = createContainerBridge({ baseUrl: "https://app.example.com", fetch: stubFetchInvalidJson({ ok: false, status: 502 }) });

        await expect(cirrus.query("x:y")).rejects.toThrow("status 502");
    });

    it("throws a clear error (not ContainerBridgeError) on a malformed error envelope", async () => {
        expect.assertions(2);

        const { fetch } = stubFetch({ error: { code: 123 } }, { ok: false, status: 500 });
        const cirrus = createContainerBridge({ baseUrl: "https://app.example.com", fetch });

        const error = await cirrus.query("x:y").catch((error_: unknown) => error_);

        expect(error).not.toBeInstanceOf(ContainerBridgeError);
        expect((error as Error).message).toContain("malformed error envelope");
    });

    it("surfaces the partial error payload on a malformed error envelope", async () => {
        expect.assertions(2);

        const { fetch } = stubFetch({ error: { code: "NOT_FOUND" } }, { ok: false, status: 404 });
        const cirrus = createContainerBridge({ baseUrl: "https://app.example.com", fetch });

        const error = await cirrus.query("nope:nope").catch((error_: unknown) => error_);

        expect(error).not.toBeInstanceOf(ContainerBridgeError);
        expect((error as Error).message).toContain("NOT_FOUND");
    });

    it("query/mutation/action are aliases of the same call", () => {
        expect.assertions(1);

        const { fetch } = stubFetch({ result: 1 });
        const cirrus = createContainerBridge({ baseUrl: "https://app.example.com", fetch });

        expect(new Set([cirrus.action, cirrus.call, cirrus.mutation, cirrus.query]).size).toBe(1);
    });

    it("run() sends a generated function reference's __cirrusRef with inferred arg/result types", async () => {
        expect.assertions(2);

        const { calls, fetch } = stubFetch({ result: { id: "m1" } });
        const cirrus = createContainerBridge({ baseUrl: "https://app.example.com", fetch });

        // Shaped like a generated `api.messages.send` reference (phantom args/returns).
        const reference = { __cirrusPhantom: undefined as unknown as { args: { text: string }; returns: { id: string } }, __cirrusRef: "messages:send" };

        const result = await cirrus.run(reference, { text: "hi" });

        // `result` is typed `{ id: string }` and `args` is typed `{ text: string }` — a wrong shape is a compile error.
        expect(result.id).toBe("m1");
        expect(JSON.parse(calls[0]!.body)).toStrictEqual({ args: { text: "hi" }, functionPath: "messages:send" });
    });

    it("errors when no fetch is available", async () => {
        expect.assertions(1);

        const original = globalThis.fetch;

        // @ts-expect-error -- deliberately remove the global for this case
        delete globalThis.fetch;
        const cirrus = createContainerBridge({ baseUrl: "https://app.example.com" });

        await expect(cirrus.query("x:y")).rejects.toThrow("no `fetch` available");

        globalThis.fetch = original;
        vi.restoreAllMocks();
    });
});
