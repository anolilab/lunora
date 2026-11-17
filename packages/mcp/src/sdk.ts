// eslint-disable-next-line sonarjs/deprecation -- the low-level `Server` is the sanctioned choice, as in `./server`: plain JSON Schema tools with no per-tool zod.
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";

interface McpSdk {
    CallToolRequestSchema: typeof CallToolRequestSchema;
    ListResourcesRequestSchema: typeof ListResourcesRequestSchema;
    ListToolsRequestSchema: typeof ListToolsRequestSchema;
    ReadResourceRequestSchema: typeof ReadResourceRequestSchema;
    // eslint-disable-next-line sonarjs/deprecation -- see the `Server` import above.
    Server: typeof Server;
}

/**
 * The MCP SDK values the server builders use, loaded on first use.
 *
 * `@modelcontextprotocol/sdk` is ~200 modules / ~1 MiB with its zod schemas. A static import from a
 * module the Worker entry reaches (`@lunora/mcp/worker`) evaluates all of it in every isolate before
 * its first event, whether or not a request ever reaches MCP. The `*RequestSchema` exports are zod
 * values, not types, so they come through here too; only `import type` may stay static elsewhere.
 * The runtime's module cache makes every call after the first free.
 */
const loadMcpSdk = async (): Promise<McpSdk> => {
    const [server, types] = await Promise.all([import("@modelcontextprotocol/sdk/server/index.js"), import("@modelcontextprotocol/sdk/types.js")]);

    return {
        CallToolRequestSchema: types.CallToolRequestSchema,
        ListResourcesRequestSchema: types.ListResourcesRequestSchema,
        ListToolsRequestSchema: types.ListToolsRequestSchema,
        ReadResourceRequestSchema: types.ReadResourceRequestSchema,
        // eslint-disable-next-line sonarjs/deprecation -- see the `Server` import above.
        Server: server.Server,
    };
};

export default loadMcpSdk;
