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
     * Expose the observability tools (`lunora_get_logs`, `lunora_get_issues`,
     * `lunora_get_advisories`, `lunora_get_query_insights`,
     * `lunora_get_migration_status`). Defaults to `false`, mirroring
     * `allowWrites`: they are read-only, but every row they return — log lines,
     * request metadata, grouped error messages — is production user data that
     * lands in the model's context and therefore at its provider. Holding the
     * admin bearer is not consent to ship that, so it is a separate opt-in;
     * without it the tools are omitted from the advertised list AND refused at
     * dispatch. Only takes effect when a `token` resolved.
     */
    allowObservability?: boolean;

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
     * Bearer token sent on every RPC. **Required** alongside `url`, and it must
     * be the deployment's **admin bearer**: the introspection/allowlist path
     * every tool depends on (`lunora_list_functions`, `lunora_list_tables`, and
     * the `assertRunnable` precheck that runs before every `run` tool) hits
     * admin-gated `/_lunora/admin/*` routes, so no scoped/app token works
     * today — it would 403 (`ADMIN_FORBIDDEN`) on the first tool call. The
     * read-only guarantee is therefore NOT enforced by the token's scope; it is
     * enforced in-process via `allowWrites: false` (the default), which omits
     * the write tools from the advertised list and refuses them at dispatch.
     *
     * Because EVERY tool needs it, omitting it is a misconfiguration rather than
     * a reduced-capability mode, and `createLunoraMcpServer` says so at
     * construction instead of advertising a surface that 403s on first use. The
     * one exception is the `client` injection seam (tests / a pre-authenticated
     * client), where this server cannot know what the client can reach and so
     * reads "unknown" fail-closed: the privileged observability tools stay
     * unadvertised and are refused at dispatch.
     */
    token?: string;
    /** Base URL of the deployed Lunora Worker. Required unless `client` is given. */
    url?: string;
}

/**
 * Build the `LunoraClient` the tools dispatch against.
 *
 * Exported for the HTTP handlers, which build one client for the lifetime of
 * the handler instead of one per request: `listFunctionsCached` in `./tools`
 * keys its memo on client identity, so a fresh client per request turns every
 * tool call back into two admin round trips.
 */
const resolveClient = (options: LunoraMcpServerOptions): LunoraClient => {
    if (options.client !== undefined) {
        return options.client;
    }

    if (options.url === undefined) {
        throw new LunoraError("INTERNAL", "createLunoraMcpServer requires either a `client` or a `url`");
    }

    if (options.token === undefined || options.token.length === 0) {
        throw new LunoraError(
            "UNAUTHENTICATED",
            "createLunoraMcpServer requires a `token` (LUNORA_ADMIN_TOKEN) alongside `url`: every tool reaches admin-gated /_lunora/admin/* routes, so an unauthenticated server can only 403. Writes stay off unless `allowWrites` is set.",
        );
    }

    const client = new LunoraClient({ fetch: options.fetch, url: options.url });

    client.setAuthToken(options.token);

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
    // The observability tools' gate: BOTH an explicit opt-in and a resolved admin
    // bearer. The bearer alone is not enough — every tool already needs it, so
    // deriving the gate from it made the privileged reads on by default on every
    // server. The token half still matters for the `client` injection seam, where
    // this server has not been told what the injected client can reach and the
    // fail-closed reading of "unknown" is "no privileged tools".
    const hasAdminToken = typeof options.token === "string" && options.token.length > 0;
    const allowObservability = options.allowObservability === true && hasAdminToken;
    const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });

    server.setRequestHandler(ListToolsRequestSchema, () => {
        return { tools: [...toolDefinitions(allowWrites, allowObservability), ...agentToolDefinitions(agents, allowAgents)] };
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
            : await callTool(client, name, input, allowWrites, allowObservability);

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
export { connectStdio, createLunoraMcpServer, resolveClient };
