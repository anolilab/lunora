import { LunoraError } from "@lunora/errors";
import { jsonSchema } from "ai";

import type { AgentToolDefinition } from "./types";

/**
 * One text/image/… content part of an MCP `CallToolResult`.
 * @experimental
 */
interface McpContentPart {
    [key: string]: unknown;
    text?: string;
    type: string;
}

/**
 * The result of an MCP `tools/call` — the structural subset the adapter reads.
 * @experimental
 */
interface McpCallResult {
    [key: string]: unknown;
    content?: ReadonlyArray<McpContentPart>;
    isError?: boolean;
    structuredContent?: unknown;
}

/**
 * One entry of an MCP `tools/list` — the structural subset the adapter reads.
 * @experimental
 */
interface McpToolInfo {
    description?: string;
    inputSchema: { [key: string]: unknown; properties?: Record<string, object>; required?: string[]; type: "object" };
    name: string;
}

/**
 * Structural subset of `@modelcontextprotocol/sdk`'s `Client` the adapter uses.
 * Declaring it locally lets tests inject a mock without the real SDK (and its
 * transport) and keeps the heavy dependency behind a lazy dynamic import.
 * @experimental
 */
interface McpClientLike {
    callTool: (params: { arguments?: Record<string, unknown>; name: string }) => Promise<McpCallResult>;
    close?: () => Promise<void>;
    connect?: (transport: unknown) => Promise<void>;
    listTools: (params?: unknown) => Promise<{ tools: ReadonlyArray<McpToolInfo> }>;
}

/**
 * Options for {@link mcpTools}.
 * @experimental
 */
interface McpToolsOptions {
    /**
     * A pre-built (already-connected) MCP client. Takes precedence over `url` —
     * the seam tests inject, and the escape hatch for a custom transport.
     */
    client?: McpClientLike;

    /**
     * A stdio command. NOT supported in the Workers runtime (stdio transports
     * cannot run in workerd) — passing it throws unless a `client` is injected.
     * Present so the intent is explicit rather than silently unsupported.
     */
    command?: string;

    /** Identify this client to the server on connect. Default `"lunora-agent"`. */
    name?: string;

    /** Only adapt these tool names (default: every tool the server lists). */
    only?: ReadonlyArray<string>;

    /** Prefix added to each adapted tool's key (disambiguate multiple servers). */
    prefix?: string;

    /** Transport for an `url`: Streamable HTTP (default) or legacy SSE. */
    transport?: "http" | "sse";

    /** The HTTP(S) endpoint of a Streamable-HTTP (or SSE) MCP server. */
    url?: string;

    /** Client version reported to the server on connect. Default `"0.0.0"`. */
    version?: string;
}

/**
 * Reduce an MCP tool result to the value persisted as the tool message. A
 * server's `structuredContent` is returned as-is; otherwise the text parts are
 * joined. An `isError` result is returned as an error STRING (not thrown) so
 * the next LLM turn can recover, consistent with the loop's unknown-tool path.
 * @experimental
 */
const adaptMcpResult = (result: McpCallResult): unknown => {
    if (result.structuredContent !== undefined) {
        return result.structuredContent;
    }

    const text = (result.content ?? [])
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n");

    if (result.isError === true) {
        return `MCP tool error: ${text.length > 0 ? text : "unknown error"}`;
    }

    if (text.length > 0) {
        return text;
    }

    return result.content;
};

/** Build a durable-step-friendly {@link AgentToolDefinition} that calls one MCP tool. */
const adaptMcpTool = (client: McpClientLike, info: McpToolInfo): AgentToolDefinition<Record<string, unknown>> => {
    return {
        description: info.description ?? `MCP tool "${info.name}".`,
        // Runs inside the loop's `tool:NAME:CALL_ID` durable step: a completed
        // call is memoized on replay, and a failed step retries at-least-once —
        // the same idempotency contract every agent tool carries.
        execute: async (input) => adaptMcpResult(await client.callTool({ arguments: input, name: info.name })),
        inputSchema: jsonSchema<Record<string, unknown>>(info.inputSchema),
        isLunoraAgentTool: true,
    };
};

/** Open an MCP client for `url` over the requested transport (Streamable HTTP by default). */
const connectClient = async (options: McpToolsOptions): Promise<McpClientLike> => {
    if (options.command !== undefined) {
        throw new LunoraError(
            "INTERNAL",
            "@lunora/agent: mcpTools `command` (stdio transport) cannot run in the Workers runtime — pass a `url` for an HTTP/SSE MCP server, or inject a connected `client`",
        );
    }

    if (options.url === undefined) {
        throw new LunoraError("INTERNAL", "@lunora/agent: mcpTools requires a `url` (an HTTP/SSE MCP server) or an injected `client`");
    }

    const url = new URL(options.url);

    // The SDK (and its transport) load lazily so an agent that never uses MCP
    // never pulls the dependency into its bundle, and tests that inject `client`
    // never touch it. HTTP/SSE transports run in workerd; stdio does not.
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

    let transport: unknown;

    if (options.transport === "sse") {
        // eslint-disable-next-line sonarjs/deprecation -- SSE is the intentional legacy fallback transport; Streamable HTTP is the default
        const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");

        transport = new SSEClientTransport(url);
    } else {
        const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");

        transport = new StreamableHTTPClientTransport(url);
    }

    const client = new Client({ name: options.name ?? "lunora-agent", version: options.version ?? "0.0.0" });

    await client.connect(transport as never);

    return client as unknown as McpClientLike;
};

/**
 * Connect to an external MCP server, list its tools, and adapt each into an
 * {@link AgentToolDefinition} — a record you spread into an agent's `tools`.
 * Each adapted tool's `execute` calls the MCP tool through the client, and runs
 * inside the loop's named durable step like any other tool (so a completed call
 * is never re-run on a workflow replay).
 *
 * ```ts
 * export const support = defineAgent({
 *     model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
 *     tools: {
 *         ...(await mcpTools({ url: "https://mcp.example.com/mcp" })),
 *     },
 * });
 * ```
 *
 * The connection is made at build time (listing tools needs it), then reused by
 * every call. In the Workers runtime only the HTTP/SSE transports run (stdio
 * does not) — pass `url`, or inject an already-connected `client` for a custom
 * transport (also the test seam).
 * @experimental
 */
const mcpTools = async (options: McpToolsOptions): Promise<Record<string, AgentToolDefinition<Record<string, unknown>>>> => {
    const client = options.client ?? (await connectClient(options));
    const { tools: listed } = await client.listTools();

    const record: Record<string, AgentToolDefinition<Record<string, unknown>>> = {};

    for (const info of listed) {
        if (options.only !== undefined && !options.only.includes(info.name)) {
            continue;
        }

        record[`${options.prefix ?? ""}${info.name}`] = adaptMcpTool(client, info);
    }

    return record;
};

export type { McpCallResult, McpClientLike, McpContentPart, McpToolInfo, McpToolsOptions };
export { adaptMcpResult, mcpTools };
