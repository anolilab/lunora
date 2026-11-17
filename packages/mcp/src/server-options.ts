/**
 * The Lunora MCP server's options and the client they resolve to, kept apart
 * from `./server` so the HTTP handlers can validate their options when they are
 * built without loading `@modelcontextprotocol/sdk`: the handlers `import()` the
 * server per request, which keeps the SDK out of a Worker's startup graph.
 */
import { LunoraAdminClient } from "@lunora/client/admin";
import { LunoraError } from "@lunora/errors";

import type { McpAgentExposure } from "./agent-tools";

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
     * Expose `lunora_find_related`, which returns raw table rows read through the
     * admin writer, so RLS policies and column masks do not apply. Defaults to
     * `false`, for the same reason as `allowObservability`. Only takes effect
     * when a `token` resolved. On the OAuth-protected path the verified token must
     * also carry the data-read scope (see `DATA_READ_SCOPE` in `./tools`).
     */
    allowDataReads?: boolean;

    /**
     * Expose the observability tools (`lunora_get_logs`, `lunora_get_issues`,
     * `lunora_get_advisories`, `lunora_get_query_insights`,
     * `lunora_get_migration_status`). Defaults to `false`, mirroring
     * `allowWrites`: they are read-only, but every row they return — log lines,
     * request metadata, grouped error messages — is production user data that
     * lands in the model's context and therefore at its provider. Holding the
     * admin bearer is not consent to ship that, so it is a separate opt-in;
     * without it the tools are omitted from the advertised list AND refused at
     * dispatch. Only takes effect when a `token` resolved. On the OAuth-protected
     * path the verified token must also carry the observability scope (see
     * `OBSERVABILITY_SCOPE` in `./tools`); this option stays the outer gate.
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
     * Pre-built client (test injection). When omitted a `LunoraAdminClient` is
     * created from `url`/`token`/`fetch`.
     */
    client?: LunoraAdminClient;
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
    /** Version reported in the `initialize` handshake. Defaults to the version bundled at build time. */
    version?: string;
}

/**
 * Build the `LunoraAdminClient` the tools dispatch against.
 *
 * Exported for the HTTP handlers, which build one client for the lifetime of
 * the handler instead of one per request: `listFunctionsCached` in `./tools`
 * keys its memo on client identity, so a fresh client per request turns every
 * tool call back into two admin round trips.
 */
const resolveClient = (options: LunoraMcpServerOptions): LunoraAdminClient => {
    if (options.client !== undefined) {
        // The type already says so; this catches a JS caller or a cast, which would
        // otherwise fail on the first tool call with `listFunctions is not a function`.
        // It probes the one admin method every tool needs rather than
        // `isLunoraAdminClient`, so an injected stub need only carry what MCP calls.
        if (typeof (options.client as Partial<LunoraAdminClient>).listFunctions !== "function") {
            throw new LunoraError("INTERNAL", "createLunoraMcpServer needs a LunoraAdminClient (`@lunora/client/admin`), not a plain LunoraClient.");
        }

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

    const client = new LunoraAdminClient({ fetch: options.fetch, url: options.url });

    client.setAuthToken(options.token);

    return client;
};

export type { LunoraMcpServerOptions };
export { resolveClient };
