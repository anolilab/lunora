/* eslint-disable sonarjs/deprecation -- the SDK marks the low-level `Server` @deprecated in favour of the high-level `McpServer`, but explicitly sanctions `Server` for "advanced use cases". Ours qualifies: we dispatch tools defined with plain JSON Schema and bridge structured results ourselves, which avoids McpServer's per-tool zod dependency. */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import pkg from "../package.json";
import { agentToolDefinitions, callAgentTool, isAgentToolName } from "./agent-tools";
import type { LunoraMcpServerOptions } from "./server-options";
import { resolveClient } from "./server-options";
import { callTool, toolDefinitions } from "./tools";

/**
 * Server name advertised in the MCP `initialize` handshake. The version defaults
 * to the `package.json` bundled at build time, which is stamped before
 * semantic-release bumps the manifest and so can lag one release behind on
 * Workers (it was `0.0.0` there before). The Node entry passes the installed
 * manifest's exact version via `version`.
 */
const SERVER_NAME = "lunora";

/**
 * Build an MCP `Server` whose tools talk to a Lunora deployment. The server is
 * transport-agnostic — call `.connect(transport)` yourself, or use
 * `connectStdio` for the common stdio case.
 *
 * Tool calls are dispatched through `callTool`, which the deployment reaches
 * over HTTP RPC. No WebSocket is opened (the tools never subscribe), so this is
 * safe to run as a short-lived stdio process.
 */
const createLunoraMcpServer = (options: LunoraMcpServerOptions): Server => {
    const client = resolveClient(options);
    const allowWrites = options.allowWrites ?? false;
    const allowAgents = options.allowAgents ?? false;
    const agents = options.agents ?? [];
    // The observability tools' gate: BOTH an explicit opt-in and a resolved admin
    // bearer. The bearer alone is not enough — every tool already needs it, so
    // deriving the gate from it made the privileged reads on by default on every
    // server. The token half still matters for the `client` injection seam, where
    // this server has not been told what the injected client can reach and the
    // fail-closed reading of "unknown" is "no privileged tools".
    const hasAdminToken = typeof options.token === "string" && options.token.length > 0;
    const allowObservability = options.allowObservability === true && hasAdminToken;
    // Its own gate, not folded into observability: log lines and raw table rows
    // are different data classes, and one opt-in must not silently grant both.
    const allowDataReads = options.allowDataReads === true && hasAdminToken;
    const server = new Server({ name: SERVER_NAME, version: options.version ?? pkg.version }, { capabilities: { tools: {} } });

    server.setRequestHandler(ListToolsRequestSchema, () => {
        return { tools: [...toolDefinitions(allowWrites, allowObservability, allowDataReads), ...agentToolDefinitions(agents, allowAgents)] };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
        const { arguments: rawArguments, name } = request.params;
        const input = rawArguments ?? {};
        // ToolResult is structurally a CallToolResult; the assertion bridges the
        // SDK's open-ended index signature (passthrough zod schema) which a
        // closed interface can't satisfy by inference alone.
        const result = isAgentToolName(name, agents)
            ? await callAgentTool(client, name, input, {
                  allowAgents,
                  exposures: agents,
                  ...(options.agentMaxWaitMs === undefined ? {} : { maxWaitMs: options.agentMaxWaitMs }),
                  ...(options.agentPollIntervalMs === undefined ? {} : { pollIntervalMs: options.agentPollIntervalMs }),
              })
            : await callTool(client, name, input, allowWrites, allowObservability, allowDataReads);

        return result;
    });

    return server;
};

export type { LunoraMcpServerOptions } from "./server-options";
export { createLunoraMcpServer };
