import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { describe, expect, it, vi } from "vitest";

import { createFunctionMcpServer } from "../src/function-server";
import method from "./_helpers/openrpc";

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
    const calls: { authorization: string | null; functionPath: string }[] = [];
    const fetch = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(async (_input, init) => {
        const sent: unknown = init?.body;
        const body = JSON.parse(typeof sent === "string" ? sent : "null") as { functionPath: string };
        const authorization = new Headers(init?.headers).get("authorization");

        calls.push({ authorization, functionPath: body.functionPath });

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
        expect(tools.find((tool) => tool.name === "billing_get")?.outputSchema?.anyOf).toHaveLength(2);
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
        expect.assertions(3);

        const deployed = deployment(() => {
            return { body: { result: { id: "m1" } }, status: 200 };
        });
        const client = await connected(serverFor(deployed.fetch));
        const result = await client.callTool({ arguments: { args: { text: "hi" } }, name: "messages_send" });
        const [first] = result.content as { text: string }[];

        expect(result.isError ?? false).toBe(false);
        expect(first?.text).toContain("action_required");
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
        expect(deployed.calls).toEqual([{ authorization: `Bearer ${CALLER_TOKEN}`, functionPath: "messages:send" }]);
        expect(result.isError ?? false).toBe(false);

        await client.close();
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
