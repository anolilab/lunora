import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { CallToolResult, ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import { CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";

import type { McpTool } from "../src/compose";
import { createToolServer } from "../src/compose";
import { createDocsMcpFetchHandler, createDocsMcpServer, DEFAULT_MAX_REQUEST_BYTES, DOCS_SERVER_NAME } from "../src/docs/server";
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

describe("createDocsMcpFetchHandler request screening", () => {
    /**
     * These are the limits that make an unauthenticated public endpoint
     * defensible. The stateless transport buffers a whole batch's replies into
     * one response body, and `lunora_list_docs` serialises the entire corpus per
     * call — so without the batch refusal, one small request fans out into
     * hundreds of megabytes with no session to rate-limit against.
     */
    const countingIndex = (): { calls: () => number; index: DocsIndex } => {
        let calls = 0;

        return {
            calls: () => calls,
            index: {
                getPage: async () => undefined,
                listPages: async () => {
                    calls += 1;

                    return [{ title: "Sharding", url: "/docs/sharding" }];
                },
                search: async () => [],
            },
        };
    };

    const post = async (handle: (request: Request) => Promise<Response>, body: string): Promise<Response> =>
        handle(
            new Request("https://docs.example/mcp", {
                body,
                headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
                method: "POST",
            }),
        );

    const toolCall = (id: number): Record<string, unknown> => {
        return { id, jsonrpc: "2.0", method: "tools/call", params: { arguments: {}, name: "lunora_list_docs" } };
    };

    it("refuses a batched request without dispatching any of it", async () => {
        expect.assertions(3);

        const { calls, index: countedIndex } = countingIndex();
        const response = await post(createDocsMcpFetchHandler({ index: countedIndex }), JSON.stringify([toolCall(1), toolCall(2), toolCall(3)]));

        expect(response.status).toBe(400);
        await expect(response.text()).resolves.toContain("batched requests are not supported");
        // The point of the guard: no tool ran at all.
        expect(calls()).toBe(0);
    });

    it("refuses a body over the size cap", async () => {
        expect.assertions(3);

        const { calls, index: countedIndex } = countingIndex();
        const oversize = JSON.stringify({
            id: 1,
            jsonrpc: "2.0",
            method: "tools/call",
            params: { arguments: { query: "z".repeat(DEFAULT_MAX_REQUEST_BYTES) }, name: "lunora_search_docs" },
        });
        const response = await post(createDocsMcpFetchHandler({ index: countedIndex }), oversize);

        expect(response.status).toBe(413);
        await expect(response.text()).resolves.toContain("exceeds");
        expect(calls()).toBe(0);
    });

    it("measures the cap in bytes, not UTF-16 code units", async () => {
        expect.assertions(2);

        const { calls, index: countedIndex } = countingIndex();
        // 40 000 three-byte characters: ~120 KB of UTF-8 inside a 64 KB cap,
        // but only 40 000 `String.length` units — a naive check waves it through.
        const multiByte = JSON.stringify({
            id: 1,
            jsonrpc: "2.0",
            method: "tools/call",
            params: { arguments: { query: "☃".repeat(40_000) }, name: "lunora_search_docs" },
        });
        const response = await post(createDocsMcpFetchHandler({ index: countedIndex, maxRequestBytes: 64 * 1024 }), multiByte);

        expect(response.status).toBe(413);
        expect(calls()).toBe(0);
    });

    it("honours a caller-supplied size cap", async () => {
        expect.assertions(1);

        const { index: countedIndex } = countingIndex();
        const response = await post(createDocsMcpFetchHandler({ index: countedIndex, maxRequestBytes: 32 }), JSON.stringify(toolCall(1)));

        expect(response.status).toBe(413);
    });

    it("answers a malformed body with a parse error rather than throwing", async () => {
        expect.assertions(2);

        const { index: countedIndex } = countingIndex();
        const response = await post(createDocsMcpFetchHandler({ index: countedIndex }), "{ not json");

        expect(response.status).toBe(400);
        await expect(response.text()).resolves.toContain("parse error");
    });

    it("still serves a single well-formed call", async () => {
        expect.assertions(2);

        const { calls, index: countedIndex } = countingIndex();
        const response = await post(createDocsMcpFetchHandler({ index: countedIndex }), JSON.stringify(toolCall(1)));

        await expect(response.text()).resolves.toContain("/docs/sharding");
        expect(calls()).toBe(1);
    });
});

describe("documentation resources", () => {
    /**
     * Resources are the other half of the same corpus: tools are what a model
     * calls when it decides it needs something, resources are what a client can
     * enumerate and attach on the user's behalf.
     */
    it("advertises the resources capability only when a provider is present", async () => {
        expect.assertions(2);

        const withResources = createDocsMcpServer({ index });
        const toolsOnly = createToolServer({ name: "t", version: "1.0.0" }, []);

        // eslint-disable-next-line no-underscore-dangle -- the SDK exposes registered capabilities nowhere else
        expect((withResources as unknown as { _capabilities: Record<string, unknown> })._capabilities.resources).toBeDefined();
        // eslint-disable-next-line no-underscore-dangle -- as above
        expect((toolsOnly as unknown as { _capabilities: Record<string, unknown> })._capabilities.resources).toBeUndefined();
    });

    it("lists every page as a resource with a stable uri", async () => {
        expect.assertions(2);

        const server = createDocsMcpServer({ index });
        const listed = (await handlerFor(server, ListResourcesRequestSchema.shape.method.value)({ params: {} })) as {
            resources: { mimeType?: string; name: string; uri: string }[];
        };

        expect(listed.resources).toStrictEqual([{ mimeType: "text/markdown", name: "Sharding", uri: "lunora-docs:/docs/sharding" }]);
        expect(listed.resources[0]?.uri.startsWith("http")).toBe(false);
    });

    it("reads a page back through its uri", async () => {
        expect.assertions(2);

        const server = createDocsMcpServer({ index });
        const read = (await handlerFor(
            server,
            ReadResourceRequestSchema.shape.method.value,
        )({
            params: { uri: "lunora-docs:/docs/sharding" },
        })) as { contents: { mimeType?: string; text: string }[] };

        expect(read.contents[0]?.text).toContain("Partition state.");
        expect(read.contents[0]?.mimeType).toBe("text/markdown");
    });

    it("refuses a traversal uri without touching the index", async () => {
        expect.assertions(3);

        const getPage = vi.fn<DocsIndex["getPage"]>(async () => undefined);
        const server = createDocsMcpServer({ index: { ...index, getPage } });
        const read = handlerFor(server, ReadResourceRequestSchema.shape.method.value);

        await expect(read({ params: { uri: "lunora-docs:/../../admin/secrets" } })).rejects.toThrow(/must not contain/);
        await expect(read({ params: { uri: "lunora-docs:/%2e%2e/%2e%2e/admin/secrets" } })).rejects.toThrow(/must not contain/);
        expect(getPage).not.toHaveBeenCalled();
    });

    it("rejects a uri it does not own", async () => {
        expect.assertions(1);

        const server = createDocsMcpServer({ index });

        await expect(handlerFor(server, ReadResourceRequestSchema.shape.method.value)({ params: { uri: "file:///etc/passwd" } })).rejects.toThrow(
            /unknown resource/,
        );
    });
});
