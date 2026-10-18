import type { LunoraClient } from "@lunora/client";
import type { CallToolResult, ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";

import { createDocsMcpServer } from "../src/docs/server";
import type { DocsIndex } from "../src/docs/types";
import { createLocalMcpServer } from "../src/local";
import { createLunoraMcpServer } from "../src/server";
import type { ToolDefinition } from "../src/tool-types";

/**
 * The SDK `Server` keeps request handlers in a private map keyed by method. The
 * same lookup `server.test.ts` uses, so the assertions read what a client sees
 * on `tools/list` rather than what the module happened to export.
 */
const handlerFor = (server: { _requestHandlers: Map<string, unknown> }, method: string): ((request: Record<string, unknown>) => unknown) => {
    // eslint-disable-next-line no-underscore-dangle -- reach into the SDK's private handler map; there is no public accessor for registered handlers.
    const handler = server._requestHandlers.get(method) as (request: Record<string, unknown>, extra: unknown) => unknown;

    return (request) => handler({ method, ...request }, { signal: new AbortController().signal });
};

const listedTools = async (server: object): Promise<ListToolsResult["tools"]> => {
    const result = (await handlerFor(server as { _requestHandlers: Map<string, unknown> }, ListToolsRequestSchema.shape.method.value)({})) as ListToolsResult;

    return result.tools;
};

const NO_INPUT = { properties: {}, type: "object" as const };

describe("toolDefinition annotations (compile-time)", () => {
    it("rejects a tool that declares no annotations", () => {
        expect.assertions(1);

        // @ts-expect-error -- every tool must declare its access; this definition does not
        const undeclared: ToolDefinition = { description: "x", inputSchema: NO_INPUT, name: "undeclared" };

        expect(undeclared.name).toBe("undeclared");
    });

    it("rejects a write tool that omits destructiveHint or idempotentHint", () => {
        expect.assertions(1);

        const noDestructive: ToolDefinition = {
            // @ts-expect-error -- readOnlyHint: false requires destructiveHint
            annotations: { idempotentHint: false, readOnlyHint: false },
            description: "x",
            inputSchema: NO_INPUT,
            name: "w1",
        };
        const noIdempotent: ToolDefinition = {
            // @ts-expect-error -- readOnlyHint: false requires idempotentHint
            annotations: { destructiveHint: true, readOnlyHint: false },
            description: "x",
            inputSchema: NO_INPUT,
            name: "w2",
        };

        expect([noDestructive.name, noIdempotent.name]).toStrictEqual(["w1", "w2"]);
    });

    it("rejects a read-only tool that claims to be destructive", () => {
        expect.assertions(1);

        const contradictory: ToolDefinition = {
            // @ts-expect-error -- a read-only tool cannot declare destructiveHint: true
            annotations: { destructiveHint: true, readOnlyHint: true },
            description: "x",
            inputSchema: NO_INPUT,
            name: "r",
        };

        expect(contradictory.name).toBe("r");
    });

    it("accepts a fully declared read-only and write tool", () => {
        expect.assertions(1);

        const read: ToolDefinition = { annotations: { readOnlyHint: true }, description: "x", inputSchema: NO_INPUT, name: "read" };
        const write: ToolDefinition = {
            annotations: { destructiveHint: true, idempotentHint: false, readOnlyHint: false },
            description: "x",
            inputSchema: NO_INPUT,
            name: "write",
        };

        expect([read.name, write.name]).toStrictEqual(["read", "write"]);
    });
});

describe("every tool a server exposes declares annotations (runtime)", () => {
    const assertAnnotated = (tools: ListToolsResult["tools"]): void => {
        for (const tool of tools) {
            expect(tool.annotations, `${tool.name} has no annotations`).toBeDefined();
            expect(typeof tool.annotations?.readOnlyHint, `${tool.name} has no readOnlyHint`).toBe("boolean");

            if (tool.annotations?.readOnlyHint === false) {
                expect(typeof tool.annotations.destructiveHint, `${tool.name} has no destructiveHint`).toBe("boolean");
                expect(typeof tool.annotations.idempotentHint, `${tool.name} has no idempotentHint`).toBe("boolean");
            }
        }
    };

    it("covers the deployment server with every gate open", async () => {
        expect.hasAssertions();

        const client = {
            listFunctions: vi.fn<() => Promise<unknown[]>>(async () => []),
            listGlobalTables: vi.fn<() => Promise<unknown[]>>(async () => []),
            query: vi.fn<() => Promise<unknown>>(),
        } as unknown as LunoraClient;
        const tools = await listedTools(
            createLunoraMcpServer({
                agents: [{ description: "Answers support questions", name: "support" }],
                allowAgents: true,
                allowDataReads: true,
                allowObservability: true,
                allowWrites: true,
                client,
                token: "admin-token",
            }),
        );

        assertAnnotated(tools);

        // Every family is open here, so this list cannot pass by being empty.
        expect(tools.length).toBeGreaterThanOrEqual(15);
    });

    it("covers the local server with writes and the deployment open", async () => {
        expect.hasAssertions();

        const tools = await listedTools(
            createLocalMcpServer({ allowWrites: true, deployment: { token: "admin-token", url: "https://worker.example" }, docs: false }),
        );

        assertAnnotated(tools);

        expect(tools.length).toBeGreaterThanOrEqual(10);
    });

    it("covers the documentation server", async () => {
        expect.hasAssertions();

        const index = { getPage: async () => undefined, listPages: async () => [], search: async () => [] } as unknown as DocsIndex;
        const tools = await listedTools(createDocsMcpServer({ index }));

        assertAnnotated(tools);

        expect(tools.length).toBeGreaterThanOrEqual(3);
    });
});

describe("tool errors carry structuredContent and a text block", () => {
    it("returns a typed error for an unknown tool through the deployment server", async () => {
        expect.assertions(4);

        const query = vi.fn<() => Promise<unknown>>();
        const client = { listFunctions: vi.fn<() => Promise<unknown[]>>(async () => []), query } as unknown as LunoraClient;
        const server = createLunoraMcpServer({ client });
        const result = (await handlerFor(
            server as unknown as { _requestHandlers: Map<string, unknown> },
            CallToolRequestSchema.shape.method.value,
        )({
            params: { arguments: {}, name: "nope" },
        })) as CallToolResult;

        expect(result.isError).toBe(true);
        expect(result.structuredContent).toStrictEqual({ code: "NOT_FOUND", message: "unknown tool: nope" });
        expect(result.content).toStrictEqual([{ text: "NOT_FOUND: unknown tool: nope", type: "text" }]);
        expect(query).not.toHaveBeenCalled();
    });
});
