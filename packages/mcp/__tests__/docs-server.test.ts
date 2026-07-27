import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { CallToolResult, ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";

import type { McpTool } from "../src/compose";
import { createToolServer } from "../src/compose";
import { createDocsMcpFetchHandler, createDocsMcpServer, DOCS_SERVER_NAME } from "../src/docs/server";
import type { DocsIndex } from "../src/docs/types";

const index: DocsIndex = {
    getPage: async (url) => (url === "/docs/sharding" ? { content: "Partition state.", title: "Sharding", url } : undefined),
    listPages: async () => [{ title: "Sharding", url: "/docs/sharding" }],
    search: async () => [{ title: "Sharding", url: "/docs/sharding" }],
};

/**
 * The low-level SDK `Server` stores request handlers in a private map keyed by
 * request method. We don't drive a transport here; we reach the handlers the
 * same way the SDK does — by looking them up via the request schema's method.
 */
const handlerFor = (server: Server, method: string): ((request: Record<string, unknown>) => unknown) => {
    // eslint-disable-next-line no-underscore-dangle -- reach into the SDK's private handler map; there is no public accessor for registered handlers.
    const handlers = (server as unknown as { _requestHandlers: Map<string, (request: unknown, extra: unknown) => unknown> })._requestHandlers;
    const handler = handlers.get(method);

    if (handler === undefined) {
        throw new Error(`no handler registered for ${method}`);
    }

    return (request: Record<string, unknown>) => handler({ method, ...request }, { signal: new AbortController().signal });
};

const tool = (name: string, handle: McpTool["handle"]): McpTool => {
    return { definition: { description: name, inputSchema: { properties: {}, type: "object" }, name }, handle };
};

describe("createToolServer", () => {
    it("advertises every tool it was given", async () => {
        expect.assertions(1);

        const server = createToolServer({ name: "test", version: "1.0.0" }, [
            tool("alpha", async () => {
                return { content: [{ text: "a", type: "text" }] };
            }),
            tool("beta", async () => {
                return { content: [{ text: "b", type: "text" }] };
            }),
        ]);

        const listed = (await handlerFor(server, ListToolsRequestSchema.shape.method.value)({ params: {} })) as ListToolsResult;

        expect(listed.tools.map((entry) => entry.name)).toStrictEqual(["alpha", "beta"]);
    });

    it("dispatches to the named tool", async () => {
        expect.assertions(2);

        const beta = vi.fn<McpTool["handle"]>(async () => {
            return { content: [{ text: "from beta", type: "text" }] };
        });
        const server = createToolServer({ name: "test", version: "1.0.0" }, [
            tool("alpha", async () => {
                return { content: [] };
            }),
            tool("beta", beta),
        ]);

        const result = (await handlerFor(
            server,
            CallToolRequestSchema.shape.method.value,
        )({
            params: { arguments: { x: 1 }, name: "beta" },
        })) as CallToolResult;

        expect(beta).toHaveBeenCalledWith({ x: 1 });
        expect(result.content).toStrictEqual([{ text: "from beta", type: "text" }]);
    });

    it("keeps the first registration when two surfaces claim a name", async () => {
        expect.assertions(3);

        const first = vi.fn<McpTool["handle"]>(async () => {
            return { content: [{ text: "first", type: "text" }] };
        });
        const second = vi.fn<McpTool["handle"]>(async () => {
            return { content: [{ text: "second", type: "text" }] };
        });
        const server = createToolServer({ name: "test", version: "1.0.0" }, [tool("dup", first), tool("dup", second)]);

        const listed = (await handlerFor(server, ListToolsRequestSchema.shape.method.value)({ params: {} })) as ListToolsResult;

        expect(listed.tools).toHaveLength(1);

        await handlerFor(server, CallToolRequestSchema.shape.method.value)({ params: { name: "dup" } });

        expect(first).toHaveBeenCalledTimes(1);
        expect(second).not.toHaveBeenCalled();
    });

    it("reports an unknown tool as an error result rather than rejecting", async () => {
        expect.assertions(2);

        const server = createToolServer({ name: "test", version: "1.0.0" }, []);

        const result = (await handlerFor(server, CallToolRequestSchema.shape.method.value)({ params: { name: "nope" } })) as CallToolResult;

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("unknown tool: nope");
    });

    it("converts a thrown handler error into an error result", async () => {
        expect.assertions(2);

        const server = createToolServer({ name: "test", version: "1.0.0" }, [
            tool("boom", async () => {
                throw new Error("handler exploded");
            }),
        ]);

        const result = (await handlerFor(server, CallToolRequestSchema.shape.method.value)({ params: { name: "boom" } })) as CallToolResult;

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("handler exploded");
    });
});

describe("createDocsMcpServer", () => {
    it("exposes the documentation tools and nothing else by default", async () => {
        expect.assertions(1);

        const server = createDocsMcpServer({ index });
        const listed = (await handlerFor(server, ListToolsRequestSchema.shape.method.value)({ params: {} })) as ListToolsResult;

        expect(listed.tools.map((entry) => entry.name)).toStrictEqual(["lunora_search_docs", "lunora_get_doc", "lunora_list_docs"]);
    });

    it("appends extra tools when a host composes more onto the surface", async () => {
        expect.assertions(1);

        const server = createDocsMcpServer({
            extraTools: [
                tool("custom", async () => {
                    return { content: [] };
                }),
            ],
            index,
        });
        const listed = (await handlerFor(server, ListToolsRequestSchema.shape.method.value)({ params: {} })) as ListToolsResult;

        expect(listed.tools.map((entry) => entry.name)).toContain("custom");
    });
});

describe("createDocsMcpFetchHandler", () => {
    it("answers the initialize handshake over Streamable HTTP", async () => {
        expect.assertions(2);

        const handle = createDocsMcpFetchHandler({ index, version: "1.2.3" });

        const response = await handle(
            new Request("https://docs.example/mcp", {
                body: JSON.stringify({
                    id: 1,
                    jsonrpc: "2.0",
                    method: "initialize",
                    params: { capabilities: {}, clientInfo: { name: "test-client", version: "0.0.0" }, protocolVersion: "2025-06-18" },
                }),
                headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
                method: "POST",
            }),
        );

        expect(response.status).toBe(200);

        const payload = (await response.json()) as { result: { serverInfo: { name: string; version: string } } };

        expect(payload.result.serverInfo).toStrictEqual({ name: DOCS_SERVER_NAME, version: "1.2.3" });
    });
});
