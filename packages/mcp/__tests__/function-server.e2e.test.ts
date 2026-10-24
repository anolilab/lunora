import { LunoraClient } from "@lunora/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { describe, expect, it, vi } from "vitest";

import { createFunctionMcpServer } from "../src/function-server";
import { serveStateless } from "../src/serve-stateless";
import method from "./_helpers/openrpc";
import { openRpcSpec as codegenSpec } from "./fixtures/messages-openrpc";

/**
 * A real SDK client talks to `createFunctionMcpServer` over an in-memory transport,
 * and a `fetch` double stands in for the deployment. The SDK client validates
 * `structuredContent` against each tool's `outputSchema`, so these tests see what a
 * model sees: a failure must arrive as a readable error, not as a client-side
 * validation error.
 */

const CALLER_TOKEN = "test-caller";

const BILLING_OUTPUT = { properties: { id: { type: "string" }, total: { type: "number" } }, required: ["id", "total"], type: "object" };
const SEND_OUTPUT = { properties: { id: { type: "string" } }, required: ["id"], type: "object" };

const SPEC = {
    methods: [
        method("billing:get", "query", { args: { id: { type: "string" } }, argsRequired: true, result: BILLING_OUTPUT }),
        method("messages:send", "mutation", { args: { text: { type: "string" } }, argsRequired: true, result: SEND_OUTPUT }),
    ],
    openrpc: "1.3.2",
};

interface Reply {
    body: unknown;
    status: number;
}

/** A deployment double. `reply` decides each response from the function path, and every call is recorded. */
const deployment = (reply: (functionPath: string) => Reply) => {
    const calls: { args: unknown; authorization: string | null; functionPath: string; shardKey: unknown }[] = [];
    const fetch = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(async (_input, init) => {
        const sent: unknown = init?.body;
        const body = JSON.parse(typeof sent === "string" ? sent : "null") as { args: unknown; functionPath: string; shardKey: unknown };
        const authorization = new Headers(init?.headers).get("authorization");

        calls.push({ args: body.args, authorization, functionPath: body.functionPath, shardKey: body.shardKey });

        const { body: payload, status } = reply(body.functionPath);

        return Response.json(payload, { headers: { "content-type": "application/json" }, status });
    });

    return { calls, fetch };
};

/** Connect a real SDK client to the server and list tools once, as a session does, so output validators are primed. */
const connected = async (server: Server): Promise<Client> => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);

    const client = new Client({ name: "function-server-test", version: "1.0.0" });

    await client.connect(clientTransport);
    await client.listTools();

    return client;
};

const serverFor = (fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>): Server =>
    createFunctionMcpServer({ allowWrites: true, fetch, openRpcSpec: SPEC, token: CALLER_TOKEN, url: "https://app.example" });

describe("createFunctionMcpServer over a real SDK client", () => {
    it("lists one tool per function, and the query's outputSchema admits an error", async () => {
        expect.assertions(3);

        const deployed = deployment(() => {
            return { body: {}, status: 200 };
        });
        const client = await connected(serverFor(deployed.fetch));
        const { tools } = await client.listTools();

        expect(tools.map((tool) => tool.name).toSorted((a, b) => a.localeCompare(b))).toEqual(["billing_get", "messages_send"]);
        expect(tools.find((tool) => tool.name === "billing_get")?.outputSchema?.anyOf).toHaveLength(3);
        expect(tools.find((tool) => tool.name === "messages_send")).not.toHaveProperty("outputSchema");

        await client.close();
    });

    it("returns a query's result as structured content, sent with the caller's bearer", async () => {
        expect.assertions(4);

        const deployed = deployment(() => {
            return { body: { result: { id: "b1", total: 3 } }, status: 200 };
        });
        const client = await connected(serverFor(deployed.fetch));
        const result = await client.callTool({ arguments: { args: { id: "b1" } }, name: "billing_get" });

        expect(result.isError ?? false).toBe(false);
        expect(result.structuredContent).toEqual({ id: "b1", total: 3 });
        expect(deployed.calls[0]?.functionPath).toBe("billing:get");
        expect(deployed.calls[0]?.authorization).toBe(`Bearer ${CALLER_TOKEN}`);

        await client.close();
    });

    it("delivers an optional output that returned undefined as an empty result, not a client-side validation error", async () => {
        expect.assertions(3);

        const optional = { methods: [method("notes:find", "query", { result: { type: "string" } })] };
        const deployed = deployment(() => {
            return { body: {}, status: 200 };
        });
        const client = await connected(
            createFunctionMcpServer({ fetch: deployed.fetch, openRpcSpec: optional, token: CALLER_TOKEN, url: "https://app.example" }),
        );
        const result = await client.callTool({ name: "notes_find" });

        expect(result.isError ?? false).toBe(false);
        expect(result.structuredContent).toEqual({});
        expect(deployed.calls[0]?.functionPath).toBe("notes:find");

        await client.close();
    });

    it("delivers an optional object output that returned undefined as an empty structured result", async () => {
        expect.assertions(2);

        const optional = { methods: [method("notes:get", "query", { result: { properties: { id: { type: "string" } }, required: ["id"], type: "object" } })] };
        const deployed = deployment(() => {
            return { body: {}, status: 200 };
        });
        const client = await connected(
            createFunctionMcpServer({ fetch: deployed.fetch, openRpcSpec: optional, token: CALLER_TOKEN, url: "https://app.example" }),
        );
        const result = await client.callTool({ name: "notes_get" });

        expect(result.isError ?? false).toBe(false);
        expect(result.structuredContent).toEqual({});

        await client.close();
    });

    it("delivers a query's failure as a readable error, not a client-side validation error", async () => {
        expect.assertions(2);

        const deployed = deployment(() => {
            return { body: { error: { code: "FORBIDDEN", message: "no access to this billing account" } }, status: 403 };
        });
        const client = await connected(serverFor(deployed.fetch));
        const result = await client.callTool({ arguments: { args: { id: "b1" } }, name: "billing_get" });

        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({ code: "FORBIDDEN" });

        await client.close();
    });

    it("delivers a write's proposal without a client-side validation error, and runs nothing", async () => {
        expect.assertions(5);

        const deployed = deployment(() => {
            return { body: { result: { id: "m1" } }, status: 200 };
        });
        const client = await connected(serverFor(deployed.fetch));
        const result = await client.callTool({ arguments: { args: { text: "hi" } }, name: "messages_send" });
        const [first] = result.content as { text: string }[];
        const { nextStep } = JSON.parse(first?.text ?? "{}") as { nextStep: string };

        expect(result.isError ?? false).toBe(false);
        expect(first?.text).toContain("action_required");
        expect(nextStep).toContain("IDENTICAL args, shardKey and idempotencyKey");
        expect(nextStep).not.toContain("functionPath");
        expect(deployed.calls).toHaveLength(0);

        await client.close();
    });

    it("runs a write once its proposal is confirmed, and returns the result", async () => {
        expect.assertions(3);

        const deployed = deployment(() => {
            return { body: { result: { id: "m1" } }, status: 200 };
        });
        const client = await connected(serverFor(deployed.fetch));
        const proposal = await client.callTool({ arguments: { args: { text: "hi" } }, name: "messages_send" });
        const { actionDigest } = JSON.parse((proposal.content as { text: string }[])[0]?.text ?? "{}") as { actionDigest: string };
        const result = await client.callTool({
            arguments: { actionDigest, args: { text: "hi" }, confirmed: true },
            name: "messages_send",
        });

        expect(result.structuredContent).toEqual({ id: "m1" });
        expect(deployed.calls).toMatchObject([{ authorization: `Bearer ${CALLER_TOKEN}`, functionPath: "messages:send" }]);
        expect(result.isError ?? false).toBe(false);

        await client.close();
    });

    it("sends the shard key with the call", async () => {
        expect.assertions(1);

        const deployed = deployment(() => {
            return { body: { result: { id: "b1", total: 3 } }, status: 200 };
        });
        const client = await connected(serverFor(deployed.fetch));

        await client.callTool({ arguments: { args: { id: "b1" }, shardKey: "tenant-a" }, name: "billing_get" });

        expect(deployed.calls[0]?.shardKey).toBe("tenant-a");

        await client.close();
    });

    it("sends a bigint argument in the wire form, and returns a bigint result as its decimal string", async () => {
        expect.assertions(2);

        const counter = { methods: [method("counter:add", "query", { args: { amount: { format: "int64", type: "string" } }, argsRequired: true })] };
        const deployed = deployment(() => {
            return { body: { result: ["$lunora.wire$", "bigint", "7"] }, status: 200 };
        });
        const client = await connected(
            createFunctionMcpServer({ fetch: deployed.fetch, openRpcSpec: counter, token: CALLER_TOKEN, url: "https://app.example" }),
        );
        const result = await client.callTool({ arguments: { args: { amount: "42" } }, name: "counter_add" });
        const [first] = result.content as { text: string }[];

        expect(deployed.calls[0]?.args).toEqual({ amount: ["$lunora.wire$", "bigint", "42"] });
        expect(JSON.parse(first?.text ?? "null")).toBe("7");

        await client.close();
    });

    it("serves the tools of a document the codegen emitted", async () => {
        expect.assertions(2);

        const deployed = deployment(() => {
            return { body: {}, status: 200 };
        });
        const client = await connected(
            createFunctionMcpServer({ allowWrites: true, fetch: deployed.fetch, openRpcSpec: codegenSpec, url: "https://app.example" }),
        );
        const { tools } = await client.listTools();

        expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["messages_list", "messages_send"]));
        expect(tools.find((tool) => tool.name === "messages_send")?.inputSchema.properties?.["args"]).toMatchObject({
            required: ["channelId", "text", "kind", "tags"],
        });

        await client.close();
    });

    it("serves the tools over stateless HTTP, from a server built for the request", async () => {
        expect.assertions(2);

        const deployed = deployment(() => {
            return { body: {}, status: 200 };
        });
        const request = new Request("https://worker.example/mcp", {
            body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/list" }),
            headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
            method: "POST",
        });
        const response = await serveStateless(serverFor(deployed.fetch), request);
        const body = (await response.json()) as { result: { tools: { name: string }[] } };

        expect(response.status).toBe(200);
        expect(body.result.tools.map((tool) => tool.name).toSorted((a, b) => a.localeCompare(b))).toEqual(["billing_get", "messages_send"]);
    });

    it("refuses to build a server from a document that is not OpenRPC, or whose names collide", () => {
        expect.assertions(2);

        expect(() => createFunctionMcpServer({ openRpcSpec: { info: {} }, url: "https://app.example" })).toThrow(/openRpcSpec must be the OpenRPC document/);
        expect(() =>
            createFunctionMcpServer({
                openRpcSpec: { methods: [method("a/b:c", "query"), method("a_b:c", "query")] },
                url: "https://app.example",
            }),
        ).toThrow(/both map to the MCP tool name "a_b_c"/);
    });
});

describe("createFunctionMcpServer when the deployment URL resolves per call", () => {
    it("answers that no deployment is available until the URL appears, then serves the call", async () => {
        expect.assertions(4);

        let url: string | undefined;
        const deployed = deployment(() => {
            return { body: { result: { id: "b1", total: 3 } }, status: 200 };
        });
        const client = await connected(createFunctionMcpServer({ fetch: deployed.fetch, openRpcSpec: SPEC, token: CALLER_TOKEN, url: () => url }));

        const before = await client.callTool({ arguments: { args: { id: "b1" } }, name: "billing_get" });

        expect(before).toMatchObject({ isError: true, structuredContent: { code: "SERVICE_UNAVAILABLE" } });
        expect(deployed.fetch).not.toHaveBeenCalled();

        url = "https://app.example";

        const after = await client.callTool({ arguments: { args: { id: "b1" } }, name: "billing_get" });

        expect(after.structuredContent).toEqual({ id: "b1", total: 3 });
        expect(deployed.fetch).toHaveBeenCalledTimes(1);

        await client.close();
    });

    it("sends the call to the new deployment when the URL moves, with the caller's bearer still attached", async () => {
        expect.assertions(3);

        let url = "https://first.example";
        const deployed = deployment(() => {
            return { body: { result: { id: "b1", total: 3 } }, status: 200 };
        });
        const client = await connected(createFunctionMcpServer({ fetch: deployed.fetch, openRpcSpec: SPEC, token: CALLER_TOKEN, url: () => url }));

        await client.callTool({ arguments: { args: { id: "b1" } }, name: "billing_get" });

        url = "https://second.example";

        await client.callTool({ arguments: { args: { id: "b1" } }, name: "billing_get" });

        expect(deployed.fetch.mock.calls[0]?.[0]).toStrictEqual(expect.stringContaining("first.example"));
        expect(deployed.fetch.mock.calls[1]?.[0]).toStrictEqual(expect.stringContaining("second.example"));
        expect(deployed.calls[1]?.authorization).toBe(`Bearer ${CALLER_TOKEN}`);

        await client.close();
    });

    it("answers a call with an error result when the URL resolver throws, rather than failing the request", async () => {
        expect.assertions(1);

        const deployed = deployment(() => {
            return { body: { result: { id: "b1", total: 3 } }, status: 200 };
        });
        const client = await connected(
            createFunctionMcpServer({
                fetch: deployed.fetch,
                openRpcSpec: SPEC,
                token: CALLER_TOKEN,
                url: () => {
                    throw new Error("resolver failed");
                },
            }),
        );
        const result = await client.callTool({ arguments: { args: { id: "b1" } }, name: "billing_get" });

        expect(result).toMatchObject({ isError: true, structuredContent: { code: "INTERNAL" } });

        await client.close();
    });

    it("closes the cached client when the server closes, so a per-request server leaves no socket behind", async () => {
        expect.assertions(2);

        const deployed = deployment(() => {
            return { body: { result: { id: "b1", total: 3 } }, status: 200 };
        });
        const server = serverFor(deployed.fetch);
        const client = await connected(server);

        await client.callTool({ arguments: { args: { id: "b1" } }, name: "billing_get" });

        const close = vi.spyOn(LunoraClient.prototype, "close");

        await server.close();

        expect(close).toHaveBeenCalledTimes(1);
        expect(deployed.fetch).toHaveBeenCalledTimes(1);

        close.mockRestore();
        await client.close();
    });

    it("closes the cached client when the URL goes away, and calls again through a fresh one when it returns", async () => {
        expect.assertions(4);

        let url: string | undefined = "https://app.example";
        const deployed = deployment(() => {
            return { body: { result: { id: "b1", total: 3 } }, status: 200 };
        });
        const close = vi.spyOn(LunoraClient.prototype, "close");
        const client = await connected(createFunctionMcpServer({ fetch: deployed.fetch, openRpcSpec: SPEC, token: CALLER_TOKEN, url: () => url }));

        await client.callTool({ arguments: { args: { id: "b1" } }, name: "billing_get" });

        url = undefined;
        const gone = await client.callTool({ arguments: { args: { id: "b1" } }, name: "billing_get" });
        const closedWhenGone = close.mock.calls.length;

        url = "https://app.example";

        const back = await client.callTool({ arguments: { args: { id: "b1" } }, name: "billing_get" });

        expect(gone).toMatchObject({ isError: true, structuredContent: { code: "SERVICE_UNAVAILABLE" } });
        expect(closedWhenGone).toBe(1);
        expect(back.structuredContent).toEqual({ id: "b1", total: 3 });
        expect(deployed.fetch).toHaveBeenCalledTimes(2);

        close.mockRestore();
        await client.close();
    });
});

describe("createFunctionMcpServer when the OpenRPC document is rewritten while it runs", () => {
    it("lists and calls the tools of the document as it is now, not as it was when the server started", async () => {
        expect.assertions(3);

        let spec: unknown = SPEC;
        const deployed = deployment(() => {
            return { body: { result: { id: "n1", total: 1 } }, status: 200 };
        });
        const client = await connected(
            createFunctionMcpServer({ fetch: deployed.fetch, openRpcSpec: () => spec, token: CALLER_TOKEN, url: "https://app.example" }),
        );

        const billing = method("billing:get", "query", { args: { id: { type: "string" } }, argsRequired: true, result: BILLING_OUTPUT });
        const notes = method("notes:list", "query", { args: { id: { type: "string" } }, argsRequired: true, result: BILLING_OUTPUT });

        spec = { methods: [billing], openrpc: "1.3.2" };

        const removed = await client.listTools();

        expect(removed.tools.map((tool) => tool.name)).toStrictEqual(["billing_get"]);

        spec = { methods: [billing, notes], openrpc: "1.3.2" };

        const added = await client.listTools();

        expect(added.tools.map((tool) => tool.name)).toStrictEqual(["billing_get", "notes_list"]);

        await client.callTool({ arguments: { args: { id: "n1" } }, name: "notes_list" });

        expect(deployed.calls[0]?.functionPath).toBe("notes:list");

        await client.close();
    });
});
