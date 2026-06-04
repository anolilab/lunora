/* eslint-disable sonarjs/deprecation -- the SDK marks the low-level `Server` @deprecated in favour of the high-level `McpServer`, but explicitly sanctions `Server` for "advanced use cases". Ours qualifies: we dispatch tools defined with plain JSON Schema and bridge structured results ourselves, which avoids McpServer's per-tool zod dependency. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CirrusClient } from "@cirrus/client";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { callTool, TOOL_DEFINITIONS } from "./tools.js";

/**
 * Resolve the package's real version so the MCP `initialize` handshake reports
 * the build a client is actually talking to. Reading `package.json` at runtime
 * (rather than hardcoding) keeps the advertised version in lockstep with
 * semantic-release bumps; if resolution ever fails we fall back to `0.0.0`.
 */
const resolveVersion = (): string => {
    // Walk up from this module's directory to the nearest `package.json`. A
    // relative `../package.json` is unreliable because the bundler emits this
    // code into a hashed shared-chunk subdirectory whose depth isn't fixed.
    try {
        let directory = dirname(fileURLToPath(import.meta.url));

        for (let depth = 0; depth < 8; depth += 1) {
            try {
                const raw = readFileSync(join(directory, "package.json"), "utf8");
                const pkg = JSON.parse(raw) as { name?: string; version?: string };

                // Skip any nested package.json that isn't ours.
                if (pkg.name === "@cirrus/mcp" && typeof pkg.version === "string" && pkg.version.length > 0) {
                    return pkg.version;
                }
            } catch {
                // No package.json at this level (or unreadable); keep climbing.
            }

            const parent = dirname(directory);

            if (parent === directory) {
                break;
            }

            directory = parent;
        }
    } catch {
        // Fall through to the static fallback below.
    }

    return "0.0.0";
};

/** Server name/version advertised in the MCP `initialize` handshake. */
const SERVER_INFO = { name: "cirrus", version: resolveVersion() } as const;

interface CirrusMcpServerOptions {
    /**
     * Pre-built client (test injection). When omitted a `CirrusClient` is
     * created from `url`/`token`/`fetch`.
     */
    client?: CirrusClient;
    /** `fetch` implementation; defaults to the ambient global. */
    fetch?: typeof fetch;
    /** Bearer token sent on every RPC (typically the admin token). */
    token?: string;
    /** Base URL of the deployed Cirrus Worker. Required unless `client` is given. */
    url?: string;
}

/** Build the `CirrusClient` the tools dispatch against. */
const resolveClient = (options: CirrusMcpServerOptions): CirrusClient => {
    if (options.client !== undefined) {
        return options.client;
    }

    if (options.url === undefined) {
        throw new Error("createCirrusMcpServer requires either a `client` or a `url`");
    }

    const client = new CirrusClient({ fetch: options.fetch, url: options.url });

    if (options.token !== undefined) {
        client.setAuthToken(options.token);
    }

    return client;
};

/**
 * Build an MCP `Server` whose tools talk to a Cirrus deployment. The server is
 * transport-agnostic — call `.connect(transport)` yourself, or use
 * `connectStdio` for the common stdio case.
 *
 * Tool calls are dispatched through `callTool`, which the deployment reaches
 * over HTTP RPC. No WebSocket is opened (the tools never subscribe), so this is
 * safe to run as a short-lived stdio process.
 */
const createCirrusMcpServer = (options: CirrusMcpServerOptions): Server => {
    const client = resolveClient(options);
    const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });

    server.setRequestHandler(ListToolsRequestSchema, () => {
        return { tools: [...TOOL_DEFINITIONS] };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
        // ToolResult is structurally a CallToolResult; the assertion bridges the
        // SDK's open-ended index signature (passthrough zod schema) which a
        // closed interface can't satisfy by inference alone.
        const result = await callTool(client, request.params.name, request.params.arguments ?? {});

        return result as CallToolResult;
    });

    return server;
};

/**
 * Build the server and connect it over stdio — the transport MCP clients use
 * when they spawn the `cirrus-mcp` binary. Resolves once the transport is
 * connected; the process then stays alive serving requests.
 */
const connectStdio = async (options: CirrusMcpServerOptions): Promise<Server> => {
    const server = createCirrusMcpServer(options);

    await server.connect(new StdioServerTransport());

    return server;
};

export type { CirrusMcpServerOptions };
export { connectStdio, createCirrusMcpServer };
