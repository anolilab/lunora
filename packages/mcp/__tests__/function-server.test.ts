import type { LunoraClient } from "@lunora/client";
import { describe, expect, it, vi } from "vitest";

import { callFunctionTool, MAX_STREAM_CHUNKS } from "../src/function-server";
import { functionToolsFromOpenRpc } from "../src/function-tools";
import type { ToolResult } from "../src/tool-types";
import method from "./_helpers/openrpc";

const SPEC = {
    methods: [
        method("counter:get", "query", { args: { amount: { format: "int64", type: "string" } } }),
        method("messages:send", "mutation", { args: { text: { type: "string" } }, argsRequired: true }),
        method("messages:list", "query", { result: { items: { type: "string" }, type: "array" } }),
        method("billing:charge", "mutation", { args: { card: { type: "string", writeOnly: true } }, argsRequired: true }),
        method("ledger:credit", "mutation", {
            args: { amount: { format: "int64", type: "string" }, payload: { contentEncoding: "base64", type: "string" } },
            argsRequired: true,
        }),
        method("billing:nested", "mutation", {
            args: { card: { properties: { number: { type: "string", writeOnly: true } }, type: "object" } },
            argsRequired: true,
        }),
        method("feed:tail", "stream", { args: { room: { type: "string" } }, argsRequired: true }),
    ],
    openrpc: "1.3.2",
};

const textOf = (result: ToolResult): unknown => JSON.parse(result.content[0]?.text ?? "null");

/** A client that records every call. Each method resolves to a value the test controls. */
const mockClient = (token: string | null = "caller-token") => {
    const query = vi.fn<() => Promise<unknown>>(async () => {
        return { total: 7 };
    });
    const mutation = vi.fn<() => Promise<unknown>>(async () => {
        return { id: "m1" };
    });
    const action = vi.fn<() => Promise<unknown>>(async () => {
        return { ran: true };
    });
    const client = {
        action,
        getAuthToken: () => token,
        mutation,
        query,
        url: "https://app.example.workers.dev",
    } as unknown as LunoraClient;

    return { action, client, mutation, query };
};

const routesFor = (allowWrites: boolean) => functionToolsFromOpenRpc(SPEC, { allowWrites }).routes;

describe("callFunctionTool — queries", () => {
    it("runs the query as the caller with its arguments decoded, and returns the value", async () => {
        expect.assertions(2);

        const { client, query } = mockClient();
        const result = await callFunctionTool(client, routesFor(false), "counter_get", { args: { amount: "42" } }, false);

        expect(query).toHaveBeenCalledWith({ __lunoraRef: "counter:get" }, { amount: 42n }, { shardKey: undefined });
        expect(textOf(result)).toEqual({ total: 7 });
    });

    it("returns a non-object declared output as structuredContent wrapped in result", async () => {
        expect.assertions(1);

        const { client, query } = mockClient();

        query.mockResolvedValueOnce(["a", "b"]);
        const result = await callFunctionTool(client, routesFor(false), "messages_list", {}, false);

        expect(result.structuredContent).toEqual({ result: ["a", "b"] });
    });

    it("turns a thrown client error into an error result rather than rejecting", async () => {
        expect.assertions(1);

        const { client, query } = mockClient();

        query.mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "FORBIDDEN" }));
        const result = await callFunctionTool(client, routesFor(false), "counter_get", {}, false);

        expect(result.isError).toBe(true);
    });

    it("returns NOT_FOUND for a tool the spec does not list", async () => {
        expect.assertions(1);

        const { client } = mockClient();
        const result = await callFunctionTool(client, routesFor(false), "nope", {}, false);

        expect(result.content[0]?.text).toContain("NOT_FOUND");
    });
});

describe("callFunctionTool — writes", () => {
    it("refuses a mutation with FORBIDDEN when writes are off, and never calls the client", async () => {
        expect.assertions(2);

        const { client, mutation } = mockClient();
        const result = await callFunctionTool(client, routesFor(false), "messages_send", { args: { text: "hi" } }, false);

        expect(result.content[0]?.text).toContain("FORBIDDEN");
        expect(mutation).not.toHaveBeenCalled();
    });

    it("returns a proposal on the first call and runs nothing", async () => {
        expect.assertions(3);

        const { client, mutation } = mockClient();
        const result = await callFunctionTool(client, routesFor(true), "messages_send", { args: { text: "hi" } }, true);
        const payload = textOf(result) as { actionDigest: string; status: string };

        expect(payload.status).toBe("action_required");
        expect(payload.actionDigest).toMatch(/^\d{13}\.[\w-]{20,}$/);
        expect(mutation).not.toHaveBeenCalled();
    });

    it("runs the mutation once the proposal's digest is confirmed, online only", async () => {
        expect.assertions(1);

        const { client, mutation } = mockClient();
        const routes = routesFor(true);
        const args = { text: "hi" };
        const proposal = textOf(await callFunctionTool(client, routes, "messages_send", { args }, true)) as { actionDigest: string };

        await callFunctionTool(client, routes, "messages_send", { args, actionDigest: proposal.actionDigest, confirmed: true }, true);

        expect(mutation).toHaveBeenCalledWith({ __lunoraRef: "messages:send" }, args, { onlineOnly: true, shardKey: undefined });
    });

    it("refuses a confirmation whose arguments changed since the proposal", async () => {
        expect.assertions(2);

        const { client, mutation } = mockClient();
        const routes = routesFor(true);
        const proposal = textOf(await callFunctionTool(client, routes, "messages_send", { args: { text: "hi" } }, true)) as { actionDigest: string };
        const result = await callFunctionTool(
            client,
            routes,
            "messages_send",
            { args: { text: "changed" }, actionDigest: proposal.actionDigest, confirmed: true },
            true,
        );

        expect(result.isError).toBe(true);
        expect(mutation).not.toHaveBeenCalled();
    });

    it("calls a sensitive-argument mutation through a sensitive reference, so it is never queued", async () => {
        expect.assertions(1);

        const { client, mutation } = mockClient();
        const routes = routesFor(true);
        const args = { card: "4242" };
        const proposal = textOf(await callFunctionTool(client, routes, "billing_charge", { args }, true)) as { actionDigest: string };

        await callFunctionTool(client, routes, "billing_charge", { args, actionDigest: proposal.actionDigest, confirmed: true }, true);

        expect(mutation).toHaveBeenCalledWith({ __lunoraRef: "billing:charge", sensitive: true }, args, { onlineOnly: true, shardKey: undefined });
    });

    it("refuses a write without a bearer token, and names the bearer rather than an admin token", async () => {
        expect.assertions(2);

        const { client, mutation } = mockClient(null);
        const result = await callFunctionTool(client, routesFor(true), "messages_send", { args: { text: "hi" } }, true);

        expect(result.content[0]?.text).toContain("bearer token");
        expect(mutation).not.toHaveBeenCalled();
    });

    it("runs a mutation with bigint and bytes arguments through both handshake steps, with the decoded values", async () => {
        expect.assertions(4);

        const { client, mutation } = mockClient();
        const routes = routesFor(true);
        const args = { amount: "9007199254740993", payload: "AQID" };
        const proposal = await callFunctionTool(client, routes, "ledger_credit", { args }, true);

        expect(proposal.isError).toBeUndefined();

        const { actionDigest } = textOf(proposal) as { actionDigest: string };

        await callFunctionTool(client, routes, "ledger_credit", { args, actionDigest, confirmed: true }, true);

        const [, sent] = mutation.mock.calls[0] as unknown as [unknown, { amount: bigint; payload: ArrayBuffer }];
        const { amount, payload } = sent;

        expect(amount).toBe(9_007_199_254_740_993n);
        expect(payload).toBeInstanceOf(ArrayBuffer);
        expect([...new Uint8Array(payload)]).toEqual([1, 2, 3]);
    });

    it("masks a sensitive value nested inside an argument in the proposal, not only one at the top level", async () => {
        expect.assertions(2);

        const { client } = mockClient();
        const result = await callFunctionTool(client, routesFor(true), "billing_nested", { args: { card: { number: "4242-4242" } } }, true);

        expect(result.content[0]?.text).not.toContain("4242");
        expect(textOf(result)).toMatchObject({ status: "action_required" });
    });
});

describe("callFunctionTool — streams", () => {
    /** A stream that honours `cancel()` the way the client does: it stops yielding once cancelled. */
    const streamOf = (chunks: unknown[]) => {
        let cancelled = false;

        return {
            cancel: vi.fn<() => void>(() => {
                cancelled = true;
            }),
            [Symbol.asyncIterator]() {
                const pending = [...chunks];

                return {
                    next: async () => {
                        const value = pending.shift();

                        return cancelled || value === undefined ? { done: true, value: undefined } : { done: false, value };
                    },
                };
            },
        };
    };

    it("reports a stream cancelled before its first chunk as an error, not an empty success", async () => {
        expect.assertions(2);

        const stream = streamOf([{ n: 1 }]);
        const client = { stream: vi.fn<() => unknown>(() => stream), url: "https://app.example.workers.dev" } as unknown as LunoraClient;
        const controller = new AbortController();

        controller.abort();

        const result = await callFunctionTool(client, routesFor(false), "feed_tail", { args: { room: "r1" } }, false, { signal: controller.signal });

        expect(result).toMatchObject({ isError: true, structuredContent: { code: "CANCELLED" } });
        expect(stream.cancel).toHaveBeenCalledTimes(1);
    });

    it("reports a stream cancelled after a chunk as an error that says how many chunks arrived", async () => {
        expect.assertions(1);

        const stream = streamOf([{ n: 1 }, { n: 2 }]);
        const client = { stream: vi.fn<() => unknown>(() => stream), url: "https://app.example.workers.dev" } as unknown as LunoraClient;
        const controller = new AbortController();

        const result = await callFunctionTool(client, routesFor(false), "feed_tail", { args: { room: "r1" } }, false, {
            progress: async () => {
                controller.abort();
            },
            signal: controller.signal,
        });

        expect(result.content[0]?.text).toContain("after 1 chunk(s)");
    });

    it("returns every chunk of a stream that yields exactly the cap", async () => {
        expect.assertions(2);

        const stream = streamOf(
            Array.from({ length: MAX_STREAM_CHUNKS }, (_, index) => {
                return { index };
            }),
        );
        const client = { stream: vi.fn<() => unknown>(() => stream), url: "https://app.example.workers.dev" } as unknown as LunoraClient;
        const result = await callFunctionTool(client, routesFor(false), "feed_tail", { args: { room: "r1" } }, false);

        expect(result.isError).toBeUndefined();
        expect(JSON.parse(result.content[0]?.text ?? "null")).toHaveLength(MAX_STREAM_CHUNKS);
    });

    it("cancels a stream that yields one chunk past the cap, and refuses it with PAYLOAD_TOO_LARGE", async () => {
        expect.assertions(2);

        const stream = streamOf(
            Array.from({ length: MAX_STREAM_CHUNKS + 1 }, (_, index) => {
                return { index };
            }),
        );
        const client = { stream: vi.fn<() => unknown>(() => stream), url: "https://app.example.workers.dev" } as unknown as LunoraClient;
        const result = await callFunctionTool(client, routesFor(false), "feed_tail", { args: { room: "r1" } }, false);

        expect(result).toMatchObject({ isError: true, structuredContent: { code: "PAYLOAD_TOO_LARGE" } });
        expect(stream.cancel).toHaveBeenCalledTimes(1);
    });
});
