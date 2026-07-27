/* eslint-disable sonarjs/deprecation -- the SDK marks the low-level `Server` @deprecated in favour of the high-level `McpServer`, but explicitly sanctions `Server` for "advanced use cases" (matching `server.ts`): we dispatch tools defined with plain JSON Schema, which avoids McpServer's per-tool zod dependency. */

/**
 * Compose several independent tool surfaces into one MCP server.
 *
 * `createLunoraMcpServer` hard-wires the deployment surface because it also has
 * to route dynamically-named `agent_&lt;name>` tools. Everything else in this
 * package — the documentation tools, and the CLI's local dev tools — is a flat
 * list of `(definition, handler)` pairs, and those compose by concatenation.
 * {@link createToolServer} is that composition: one `ListTools` answer, one
 * `CallTool` dispatch table, no knowledge of what any individual tool does.
 *
 * Deliberately free of `@lunora/client` and of Node built-ins, so a surface
 * built on it (notably `./docs`) runs unchanged on Workers and in the browser.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import type { ToolDefinition, ToolResult } from "./tool-types";

/** A tool: what to advertise in `ListTools`, and what to run on `CallTool`. */
interface McpTool {
    definition: ToolDefinition;
    handle: (input: Record<string, unknown>) => Promise<ToolResult>;
}

/** Name/version pair reported in the MCP `initialize` handshake. */
interface McpServerInfo {
    name: string;
    version: string;
}

/**
 * Build an MCP `Server` that advertises and dispatches `tools`.
 *
 * On duplicate names the FIRST wins, so a caller can layer surfaces in
 * precedence order without the later list silently shadowing the earlier one.
 * Thrown errors become `isError` results rather than rejections, per the MCP
 * convention that a tool failure is output the model can read and react to,
 * not a protocol-level fault.
 */
const createToolServer = (info: McpServerInfo, tools: ReadonlyArray<McpTool>): Server => {
    const dispatch = new Map<string, McpTool>();

    for (const tool of tools) {
        if (!dispatch.has(tool.definition.name)) {
            dispatch.set(tool.definition.name, tool);
        }
    }

    const definitions = [...dispatch.values()].map((tool) => tool.definition);
    const server = new Server(info, { capabilities: { tools: {} } });

    server.setRequestHandler(ListToolsRequestSchema, () => {
        return { tools: definitions };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
        const { arguments: rawArguments, name } = request.params;
        const tool = dispatch.get(name);

        if (tool === undefined) {
            return { content: [{ text: `unknown tool: ${name}`, type: "text" }], isError: true };
        }

        try {
            // ToolResult is structurally a CallToolResult; the assertion bridges
            // the SDK's open-ended index signature (passthrough zod schema),
            // which a closed interface can't satisfy by inference alone.
            return (await tool.handle(rawArguments ?? {})) as CallToolResult;
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);

            return { content: [{ text: message, type: "text" }], isError: true };
        }
    });

    return server;
};

export type { McpServerInfo, McpTool };
export { createToolServer };
