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

// `shared/` is bundler-inlined (not a package): relative import, no `.js`
// extension, and this package's tsconfig drops `outDir`/`rootDir` for it (see
// packages/mcp/tsconfig.json).
import { evictOldestEntry } from "../../../shared/evict-oldest";
import type { McpResourceProvider, McpResourceSummary, McpTool } from "./compose";
import { createToolServer } from "./compose";
import { createRemoteDocsIndex } from "./docs/remote-index";
import { docsResources } from "./docs/resources";
import { docsTools } from "./docs/tools";
import type { DocsIndex } from "./docs/types";
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

/** The remote docs index for `options`, or `undefined` when the docs surface is disabled. */
const buildDocsIndex = (options: LocalMcpServerOptions): DocsIndex | undefined =>
    options.docs === false
        ? undefined
        : createRemoteDocsIndex({
              ...(options.docs?.baseUrl === undefined ? {} : { baseUrl: options.docs.baseUrl }),
              ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
          });

/** Server identity advertised in the MCP `initialize` handshake. */
const LOCAL_SERVER_NAME = "lunora";

/** Shown when a deployment tool is called and no dev server can be found. */
const NO_DEPLOYMENT_MESSAGE =
    "no Lunora dev server is running for this project — start one with `lunora dev`, then call this tool again (call lunora_dev_status to check).";

/**
 * Small — the realistic population is one dev server plus a handful of stale
 * restarts, not a long tail of distinct deployments.
 */
const MAX_CLIENT_CACHE = 8;

/**
 * Reuse one `LunoraClient` per `url|token` pair, shared by both the tool and
 * resource surfaces (one instance built by {@link createLocalMcpServer} and
 * injected into both), so a tool call and a resource read against the same
 * deployment share one client instead of minting their own.
 *
 * Not just an allocation win: `tools.ts` memoizes the deployment's function
 * registry in a `WeakMap` keyed by client, so minting a fresh client per
 * surface would re-fetch that registry on every single tool call.
 *
 * Bounded FIFO (`evictOldestEntry`, `shared/evict-oldest.ts`): this server is
 * long-lived by design (an editor spawns it once and keeps it alive across
 * every `lunora dev` restart afterwards — see the resolver rationale above),
 * and every restart can rotate the dev server's port/token, so an unbounded
 * map would accrete one dead client per restart for the process's life.
 * Evicting a client whose request is still in flight is safe — eviction only
 * drops the map's reference; the in-flight call keeps its own reference to
 * the client alive.
 */
const createClientCache = (fetchImplementation: typeof fetch | undefined): ((deployment: LocalDeployment) => LunoraClient) => {
    const cache = new Map<string, LunoraClient>();

    return (deployment: LocalDeployment): LunoraClient => {
        // Serialized rather than delimiter-joined: a `|` inside either value
        // would otherwise let two distinct pairs collide onto one client.
        const key = JSON.stringify([deployment.url, deployment.token ?? ""]);
        const cached = cache.get(key);

        if (cached !== undefined) {
            return cached;
        }

        const client = new LunoraClient({ fetch: fetchImplementation, url: deployment.url });

        if (deployment.token !== undefined && deployment.token.length > 0) {
            client.setAuthToken(deployment.token);
        }

        evictOldestEntry(cache, MAX_CLIENT_CACHE);
        cache.set(key, client);

        return client;
    };
};

/**
 * True when `deployment` carries a usable admin bearer — the observability
 * tools' gate on THIS server.
 *
 * The remote/deployment server (`./server`) additionally requires an explicit
 * `allowObservability` opt-in, because there the reads are production user data
 * shipped to a model provider. Here the target is the developer's own
 * `lunora dev` server on their own machine, started by them for this purpose, so
 * the resolved dev token is the opt-in.
 */
const hasAdminToken = (deployment: LocalDeployment | undefined): boolean => deployment?.token !== undefined && deployment.token.length > 0;

/**
 * The deployment tools, resolving their target at dispatch time.
 *
 * The definitions are advertised unconditionally — an MCP client reads the tool
 * list once and caches it, so a surface that appeared only when the dev server
 * happened to be up at startup would stay invisible for the rest of the
 * session. Calling one while nothing is running returns an actionable error
 * instead.
 *
 * The observability tools are the ONE exception: they read the deployment's
 * logs and grouped errors, so an unauthenticated server must not advertise that
 * they exist. Their gate is therefore a snapshot taken here, at build time —
 * fail-closed, at the cost of a session that started before the dev server not
 * seeing them. Dispatch re-checks the token as freshly resolved, so a listed
 * tool whose token has since gone is still refused.
 */
const lazyDeploymentTools = (
    source: LocalDeploymentSource,
    allowWrites: boolean,
    clientFor: (deployment: LocalDeployment) => LunoraClient,
): ReadonlyArray<McpTool> => {
    const resolve = typeof source === "function" ? source : (): LocalDeployment => source;

    return toolDefinitions(allowWrites, hasAdminToken(resolve())).map((definition) => {
        return {
            definition,
            handle: async (input: Record<string, unknown>): Promise<ToolResult> => {
                const deployment = resolve();

                if (deployment === undefined) {
                    return { content: [{ text: NO_DEPLOYMENT_MESSAGE, type: "text" }], isError: true };
                }

                return callTool(clientFor(deployment), definition.name, input, allowWrites, hasAdminToken(deployment));
            },
        };
    });
};

/** URI for the deployment's generated OpenRPC 1.x document (the RPC-native spec: a `methods` array). */
const OPENRPC_RESOURCE_URI = "lunora-spec:openrpc";

/** URI for the deployment's generated OpenAPI 3.1 document. */
const OPENAPI_RESOURCE_URI = "lunora-spec:openapi";

/** One deployment spec this server can offer as a resource, and how to fetch it. */
interface SpecResourceEntry {
    description: string;
    fetch: (client: LunoraClient) => Promise<Record<string, unknown>>;
    name: string;
    uri: string;
}

const SPEC_RESOURCE_ENTRIES: ReadonlyArray<SpecResourceEntry> = [
    {
        description:
            "The deployment's generated OpenRPC 1.x document — every RPC function's path, kind, and argument schema in one read, instead of list_functions plus one get_function_schema call per function.",
        fetch: async (client) => client.fetchOpenRpc(),
        name: "OpenRPC specification",
        uri: OPENRPC_RESOURCE_URI,
    },
    {
        description: "The deployment's generated OpenAPI 3.1 document.",
        fetch: async (client) => client.fetchOpenApi(),
        name: "OpenAPI specification",
        uri: OPENAPI_RESOURCE_URI,
    },
];

/**
 * The deployment's generated OpenRPC/OpenAPI spec documents, as MCP resources.
 *
 * The narrow `lunora_list_functions` / `lunora_get_function_schema` tools make
 * an agent discover the deployment's surface one function at a time — a
 * `list_functions` call plus one `get_function_schema` round trip per
 * function. The worker already serves the whole surface in one document (the
 * admin-gated `GET /_lunora/admin/openrpc` / `/openapi` endpoints codegen
 * emits); publishing it as a resource lets an agent read the entire API in one
 * request instead.
 *
 * Resolved lazily, exactly like {@link lazyDeploymentTools}: the deployment may
 * not be running yet when this server is built (an editor spawns it before
 * `lunora dev`), so both `list` and `read` re-resolve the source and re-fetch
 * on every call rather than caching a spec captured at server-build time.
 *
 * A deployment that isn't reachable, has no spec wired, or predates the
 * openrpc/openapi endpoints (an older worker build) fails the admin fetch;
 * that entry is simply left out of `list()` and its `read()` returns
 * `undefined` — resources are meant to be browsed, so one that would always
 * error on read is worse than one that's silently absent. A worker WITH the
 * endpoint but no spec configured still resolves 200 with an empty document,
 * so it stays listed — only a hard failure omits it.
 */
const deploymentSpecResources = (source: LocalDeploymentSource, clientFor: (deployment: LocalDeployment) => LunoraClient): McpResourceProvider => {
    const resolve = typeof source === "function" ? source : (): LocalDeployment => source;

    /** The live document for `entry`, or `undefined` when the deployment can't serve it. */
    const fetchEntry = async (entry: SpecResourceEntry): Promise<Record<string, unknown> | undefined> => {
        const deployment = resolve();

        if (deployment === undefined) {
            return undefined;
        }

        try {
            return await entry.fetch(clientFor(deployment));
        } catch {
            return undefined;
        }
    };

    return {
        list: async (): Promise<ReadonlyArray<McpResourceSummary>> => {
            const summaries = await Promise.all(
                SPEC_RESOURCE_ENTRIES.map(async (entry): Promise<McpResourceSummary | undefined> => {
                    const spec = await fetchEntry(entry);

                    return spec === undefined ? undefined : { description: entry.description, mimeType: "application/json", name: entry.name, uri: entry.uri };
                }),
            );

            return summaries.filter((summary): summary is McpResourceSummary => summary !== undefined);
        },

        read: async (uri: string): Promise<{ mimeType?: string; text: string } | undefined> => {
            const entry = SPEC_RESOURCE_ENTRIES.find((candidate) => candidate.uri === uri);

            if (entry === undefined) {
                return undefined;
            }

            const spec = await fetchEntry(entry);

            return spec === undefined ? undefined : { mimeType: "application/json", text: JSON.stringify(spec, undefined, 2) };
        },
    };
};

/** Merge several resource providers into one — `list()` concatenates, `read()` tries each in order. */
const combineResourceProviders = (providers: ReadonlyArray<McpResourceProvider>): McpResourceProvider => {
    return {
        list: async (): Promise<ReadonlyArray<McpResourceSummary>> => {
            const lists = await Promise.all(providers.map(async (provider) => provider.list()));

            return lists.flat();
        },

        read: async (uri: string): Promise<{ mimeType?: string; text: string } | undefined> => {
            for (const provider of providers) {
                // eslint-disable-next-line no-await-in-loop -- sequential by design: the first provider that recognizes `uri` wins, and providers are few (docs + spec).
                const found = await provider.read(uri);

                if (found !== undefined) {
                    return found;
                }
            }

            return undefined;
        },
    };
};

/**
 * Assemble the tool list, in the order it is advertised: docs first (the
 * surface that always works), then the caller's extras, then the deployment
 * tools. Order also decides precedence — `createToolServer` keeps the first
 * registration of a duplicated name.
 *
 * `clientFor` is the shared client cache built once by
 * {@link createLocalMcpServer} and threaded into both the tool and resource
 * surfaces. Exported (and called directly by tests) without going through
 * `createLocalMcpServer`, so a caller that omits it gets a private,
 * call-scoped cache — same shape as before this surface was shared, just
 * without the cross-surface sharing that only matters once a resource
 * surface exists alongside it.
 */
const localTools = (options: LocalMcpServerOptions, clientFor?: (deployment: LocalDeployment) => LunoraClient): ReadonlyArray<McpTool> => {
    const tools: McpTool[] = [];
    const index = buildDocsIndex(options);

    if (index !== undefined) {
        tools.push(...docsTools(index));
    }

    tools.push(...(options.extraTools ?? []));

    if (options.deployment !== undefined) {
        tools.push(...lazyDeploymentTools(options.deployment, options.allowWrites ?? false, clientFor ?? createClientCache(options.fetch)));
    }

    return tools;
};

/** Build the composed local server without connecting a transport. */
const createLocalMcpServer = (options: LocalMcpServerOptions = {}): Server => {
    // Resources come from the same docs index the tools read, so they appear
    // only when the documentation surface is enabled.
    const index = buildDocsIndex(options);

    const resourceProviders: McpResourceProvider[] = [];

    if (index !== undefined) {
        resourceProviders.push(docsResources(index));
    }

    // One client cache for the whole server, shared by the tool and resource
    // surfaces below — see `createClientCache`'s docstring for why.
    const clientFor = createClientCache(options.fetch);

    // Only offer the spec resources when a deployment is configured at all —
    // mirrors the docs-index check above (the whole surface is opt-in, not a
    // live probe at server-build time).
    if (options.deployment !== undefined) {
        resourceProviders.push(deploymentSpecResources(options.deployment, clientFor));
    }

    return createToolServer(
        { name: LOCAL_SERVER_NAME, version: options.version ?? "0.0.0" },
        localTools(options, clientFor),
        resourceProviders.length === 0 ? undefined : combineResourceProviders(resourceProviders),
    );
};

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
export { connectLocalStdio, createLocalMcpServer, LOCAL_SERVER_NAME, localTools, NO_DEPLOYMENT_MESSAGE, OPENAPI_RESOURCE_URI, OPENRPC_RESOURCE_URI };
