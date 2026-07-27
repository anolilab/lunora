/* eslint-disable sonarjs/deprecation -- the SDK marks the low-level `Server` @deprecated in favour of the high-level `McpServer`, but explicitly sanctions `Server` for "advanced use cases" (matching `server.ts`); here it appears only as a return type. */
/* eslint-disable unicorn/prevent-abbreviations -- "docs" is public API here: the `@lunora/mcp/docs` subpath and the `lunora_search_docs` / `lunora_get_doc` / `lunora_list_docs` tool names. Renaming the identifiers to "documentation" would diverge from the names callers and models actually use. */

/**
 * The composed server behind `lunora mcp serve` — one stdio endpoint carrying
 * every surface a coding agent wants while it builds a Lunora app:
 *
 * - the documentation tools, so it looks the API up instead of inventing it;
 * - the deployment tools pointed at whatever the caller resolves (typically the
 * dev server the user has running), so it can list functions and run queries
 * against real local data;
 * - any extra tools the caller supplies — the CLI adds dev-server status and log
 * tools, which need the filesystem access this package deliberately avoids.
 *
 * Assembling it here rather than in the CLI keeps the CLI's dependency on MCP to
 * this one package: it passes plain data (a URL resolver, a docs origin) and
 * gets a connected server back, without importing the protocol SDK or
 * `@lunora/client` itself.
 */
import { LunoraClient } from "@lunora/client";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import type { McpTool } from "./compose";
import { createToolServer } from "./compose";
import { createRemoteDocsIndex } from "./docs/remote-index";
import { docsTools } from "./docs/tools";
import type { ToolResult } from "./tool-types";
import { callTool, toolDefinitions } from "./tools";

/** A Lunora deployment the tools dispatch against. */
interface LocalDeployment {
    token?: string;
    url: string;
}

/**
 * Where the deployment comes from: a fixed value, or a function consulted on
 * every tool call.
 *
 * The resolver form exists because an editor spawns this server when the
 * project opens — routinely *before* `lunora dev` is running, and it keeps the
 * process alive across every restart afterwards. A URL captured once at startup
 * would therefore be absent for the entire first session and stale after the
 * first restart.
 */
type LocalDeploymentSource = (() => LocalDeployment | undefined) | LocalDeployment;

interface LocalMcpServerOptions {
    /**
     * Expose the deployment write tools (`lunora_run_mutation` /
     * `lunora_run_action`). Defaults to `false` — the same fail-closed default
     * as the remote server. Locally the blast radius is dev data rather than
     * production, but a mutation is still a side effect an agent should be
     * granted deliberately.
     */
    allowWrites?: boolean;

    /**
     * The Lunora deployment (usually the running dev server) to expose. Omit to
     * leave the deployment tools out entirely.
     */
    deployment?: LocalDeploymentSource;

    /** Docs site origin backing the documentation tools; `false` omits them. */
    docs?: false | { baseUrl?: string };

    /** Extra tools to compose in, e.g. the CLI's local dev-server tools. */
    extraTools?: ReadonlyArray<McpTool>;

    /** `fetch` implementation; defaults to the ambient global. */
    fetch?: typeof fetch;

    /** Version reported in the MCP handshake — the host CLI's, not this package's. */
    version?: string;
}

/** Server identity advertised in the MCP `initialize` handshake. */
const LOCAL_SERVER_NAME = "lunora";

/** Shown when a deployment tool is called and no dev server can be found. */
const NO_DEPLOYMENT_MESSAGE =
    "no Lunora dev server is running for this project — start one with `lunora dev`, then call this tool again (call lunora_dev_status to check).";

/**
 * Reuse one `LunoraClient` per `url|token` pair.
 *
 * Not just an allocation win: `tools.ts` memoizes the deployment's function
 * registry in a `WeakMap` keyed by client, so minting a fresh client per call
 * would re-fetch that registry on every single tool call.
 */
const createClientCache = (fetchImplementation: typeof fetch | undefined): ((deployment: LocalDeployment) => LunoraClient) => {
    const cache = new Map<string, LunoraClient>();

    return (deployment: LocalDeployment): LunoraClient => {
        const key = `${deployment.url}|${deployment.token ?? ""}`;
        const cached = cache.get(key);

        if (cached !== undefined) {
            return cached;
        }

        const client = new LunoraClient({ fetch: fetchImplementation, url: deployment.url });

        if (deployment.token !== undefined && deployment.token.length > 0) {
            client.setAuthToken(deployment.token);
        }

        cache.set(key, client);

        return client;
    };
};

/**
 * The deployment tools, resolving their target at dispatch time.
 *
 * The definitions are advertised unconditionally — an MCP client reads the tool
 * list once and caches it, so a surface that appeared only when the dev server
 * happened to be up at startup would stay invisible for the rest of the
 * session. Calling one while nothing is running returns an actionable error
 * instead.
 */
const lazyDeploymentTools = (source: LocalDeploymentSource, allowWrites: boolean, fetchImplementation: typeof fetch | undefined): ReadonlyArray<McpTool> => {
    const resolve = typeof source === "function" ? source : (): LocalDeployment => source;
    const clientFor = createClientCache(fetchImplementation);

    return toolDefinitions(allowWrites).map((definition) => {
        return {
            definition,
            handle: async (input: Record<string, unknown>): Promise<ToolResult> => {
                const deployment = resolve();

                if (deployment === undefined) {
                    return { content: [{ text: NO_DEPLOYMENT_MESSAGE, type: "text" }], isError: true };
                }

                return callTool(clientFor(deployment), definition.name, input, allowWrites);
            },
        };
    });
};

/**
 * Assemble the tool list, in the order it is advertised: docs first (the
 * surface that always works), then the caller's extras, then the deployment
 * tools. Order also decides precedence — `createToolServer` keeps the first
 * registration of a duplicated name.
 */
const localTools = (options: LocalMcpServerOptions): ReadonlyArray<McpTool> => {
    const tools: McpTool[] = [];

    if (options.docs !== false) {
        tools.push(
            ...docsTools(
                createRemoteDocsIndex({
                    ...(options.docs?.baseUrl === undefined ? {} : { baseUrl: options.docs.baseUrl }),
                    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
                }),
            ),
        );
    }

    tools.push(...(options.extraTools ?? []));

    if (options.deployment !== undefined) {
        tools.push(...lazyDeploymentTools(options.deployment, options.allowWrites ?? false, options.fetch));
    }

    return tools;
};

/** Build the composed local server without connecting a transport. */
const createLocalMcpServer = (options: LocalMcpServerOptions = {}): Server =>
    createToolServer({ name: LOCAL_SERVER_NAME, version: options.version ?? "0.0.0" }, localTools(options));

/**
 * Build the composed local server and connect it over stdio — the transport an
 * MCP client uses when it spawns `lunora mcp serve`. Resolves once connected;
 * the process then stays alive serving requests.
 */
const connectLocalStdio = async (options: LocalMcpServerOptions = {}): Promise<Server> => {
    const server = createLocalMcpServer(options);

    await server.connect(new StdioServerTransport());

    return server;
};

export type { LocalDeployment, LocalDeploymentSource, LocalMcpServerOptions };
export { connectLocalStdio, createLocalMcpServer, LOCAL_SERVER_NAME, localTools, NO_DEPLOYMENT_MESSAGE };
