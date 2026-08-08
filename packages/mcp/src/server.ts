/* eslint-disable sonarjs/deprecation -- the SDK marks the low-level `Server` @deprecated in favour of the high-level `McpServer`, but explicitly sanctions `Server` for "advanced use cases". Ours qualifies: we dispatch tools defined with plain JSON Schema and bridge structured results ourselves, which avoids McpServer's per-tool zod dependency. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { LunoraClient } from "@lunora/client";
import { LunoraError } from "@lunora/errors";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import type { McpAgentExposure } from "./agent-tools";
import { agentToolDefinitions, callAgentTool, isAgentToolName } from "./agent-tools";
import { callTool, toolDefinitions } from "./tools";

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
                if (pkg.name === "@lunora/mcp" && typeof pkg.version === "string" && pkg.version.length > 0) {
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
const SERVER_INFO = { name: "lunora", version: resolveVersion() } as const;

interface LunoraMcpServerOptions {
    /** Wall-clock budget a single agent tool call awaits before returning a pending result. */
    agentMaxWaitMs?: number;

    /** Delay between agent thread-status polls. */
    agentPollIntervalMs?: number;
    /** The agents this server fronts as MCP tools (see `allowAgents`). */
    agents?: ReadonlyArray<McpAgentExposure>;

    /**
     * Expose the per-agent tools (`agent_<name>` + the generic
     * `lunora_agent_status`). Defaults to `false`, mirroring `allowWrites`:
     * starting a durable agent run is a side effect, so the agent tools are
     * omitted from the advertised list AND refused at dispatch unless explicitly
     * opted in. Only takes effect together with a non-empty `agents` list.
     */
    allowAgents?: boolean;

    /**
     * Expose the write tools (`lunora_run_mutation` / `lunora_run_action`).
     * Defaults to `false`: the server is READ-ONLY unless explicitly opted in,
     * so a prompt-injected or misaligned agent can't mutate the deployment with
     * the configured token. When false the write tools are omitted from the
     * advertised tool list AND refused at dispatch.
     */
    allowWrites?: boolean;

    /**
     * Pre-built client (test injection). When omitted a `LunoraClient` is
     * created from `url`/`token`/`fetch`.
     */
    client?: LunoraClient;
    /** `fetch` implementation; defaults to the ambient global. */
    fetch?: typeof fetch;

    /**
     * Bearer token sent on every RPC. This must be the deployment's **admin
     * bearer**: the introspection/allowlist path every tool depends on
     * (`lunora_list_functions`, `lunora_list_tables`, and the `assertRunnable`
     * precheck that runs before every `run` tool) hits admin-gated
     * `/_lunora/admin/*` routes, so no scoped/app token works today — it would
     * 403 (`ADMIN_FORBIDDEN`) on the first tool call. The read-only guarantee is
     * therefore NOT enforced by the token's scope; it is enforced in-process via
     * `allowWrites: false` (the default), which omits the write tools from the
     * advertised list and refuses them at dispatch.
     *
     * Its presence is also what gates the observability tools (logs, Issues,
     * advisories, query insights, migration status): without a token they are
     * omitted from `ListTools` and refused at dispatch.
     */
    token?: string;
    /** Base URL of the deployed Lunora Worker. Required unless `client` is given. */
    url?: string;
}

/** Build the `LunoraClient` the tools dispatch against. */
const resolveClient = (options: LunoraMcpServerOptions): LunoraClient => {
    if (options.client !== undefined) {
        return options.client;
    }

    if (options.url === undefined) {
        throw new LunoraError("INTERNAL", "createLunoraMcpServer requires either a `client` or a `url`");
    }

    const client = new LunoraClient({ fetch: options.fetch, url: options.url });

    if (options.token !== undefined) {
        client.setAuthToken(options.token);
    }

    return client;
};

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
    // The observability tools' gate. Read off `options.token` rather than the
    // client, because a caller that injects a pre-built `client` has not told
    // this server what that client can reach — and the fail-closed reading of
    // "unknown" is "no privileged tools".
    const hasAdminToken = typeof options.token === "string" && options.token.length > 0;
    const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });

    server.setRequestHandler(ListToolsRequestSchema, () => {
        return { tools: [...toolDefinitions(allowWrites, hasAdminToken), ...agentToolDefinitions(agents, allowAgents)] };
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
            : await callTool(client, name, input, allowWrites, hasAdminToken);

        return result as CallToolResult;
    });

    return server;
};

/**
 * Build the server and connect it over stdio — the transport MCP clients use
 * when they spawn the `lunora-mcp` binary. Resolves once the transport is
 * connected; the process then stays alive serving requests.
 */
const connectStdio = async (options: LunoraMcpServerOptions): Promise<Server> => {
    const server = createLunoraMcpServer(options);

    await server.connect(new StdioServerTransport());

    return server;
};

export type { LunoraMcpServerOptions };
export { connectStdio, createLunoraMcpServer };
