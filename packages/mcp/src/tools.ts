import type { FunctionDescriptor, FunctionReference, LunoraClient } from "@lunora/client";
import { LunoraError } from "@lunora/errors";

import { callObservabilityTool, OBSERVABILITY_TOOL_DEFINITIONS, OBSERVABILITY_TOOL_NAMES } from "./observability-tools";
import { errorResult, ok } from "./tool-result";
import type { ToolDefinition, ToolInputSchema, ToolResult } from "./tool-types";

/**
 * The tool surface this MCP server exposes. Each tool maps onto a method the
 * `LunoraClient` already provides, so an AI agent can introspect a deployment
 * (functions, global tables) and invoke its functions over HTTP RPC.
 *
 * Definitions and dispatch live here — separate from the server wiring — so the
 * behaviour is unit-testable against a mock client without driving a transport.
 */

const RUN_INPUT_SCHEMA: ToolInputSchema = {
    properties: {
        args: { description: "Arguments object passed to the function", type: "object" },
        functionPath: { description: 'Function reference, e.g. "messages:send"', type: "string" },
        shardKey: { description: "Optional shard key when the function is .shardBy()-partitioned", type: "string" },
    },
    required: ["functionPath"],
    type: "object",
};

const NO_INPUT_SCHEMA: ToolInputSchema = { properties: {}, type: "object" };

const FUNCTION_PATH_INPUT_SCHEMA: ToolInputSchema = {
    properties: {
        functionPath: { description: 'Function reference, e.g. "messages:send"', type: "string" },
    },
    required: ["functionPath"],
    type: "object",
};

/** Introspection and queries touch no state; every call goes to the deployment. */
const READ_ONLY_ANNOTATIONS = { destructiveHint: false, idempotentHint: true, openWorldHint: true, readOnlyHint: true } as const;

/** The read-only tool surface: introspection + query. Always exposed. */
const READ_ONLY_TOOL_DEFINITIONS: ReadonlyArray<ToolDefinition> = [
    {
        annotations: { ...READ_ONLY_ANNOTATIONS, title: "List deployment functions" },
        description: "List the deployment's public functions (queries, mutations, actions) with their kinds.",
        inputSchema: NO_INPUT_SCHEMA,
        name: "lunora_list_functions",
    },
    {
        annotations: { ...READ_ONLY_ANNOTATIONS, title: "List global tables" },
        description: "List the deployment's .global() tables with their row counts. Names and row counts only — no column shapes.",
        inputSchema: NO_INPUT_SCHEMA,
        name: "lunora_list_tables",
    },
    {
        annotations: { ...READ_ONLY_ANNOTATIONS, title: "Describe a function's arguments" },
        description:
            "Return a function's argument descriptors (name, validator kind, whether it is optional) and its kind, so a caller can construct a valid arguments object. Call lunora_list_functions first to discover available function paths.",
        inputSchema: FUNCTION_PATH_INPUT_SCHEMA,
        name: "lunora_get_function_schema",
    },
    {
        annotations: { ...READ_ONLY_ANNOTATIONS, title: "Run a query" },
        description: "Run a query and return its result. Read-only.",
        inputSchema: RUN_INPUT_SCHEMA,
        name: "lunora_run_query",
    },
];

/** The write tool surface (mutations + actions). Exposed ONLY when writes are enabled. */
const WRITE_TOOL_DEFINITIONS: ReadonlyArray<ToolDefinition> = [
    {
        // Not idempotent and not read-only: this is the distinction the whole
        // `allowWrites` gate exists for, now legible to a client's UI.
        annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true, readOnlyHint: false, title: "Run a mutation (writes data)" },
        description: "Run a mutation and return its result. Writes data — use with care.",
        inputSchema: RUN_INPUT_SCHEMA,
        name: "lunora_run_mutation",
    },
    {
        annotations: {
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: true,
            readOnlyHint: false,
            title: "Run an action (may call external services)",
        },
        description: "Run an action and return its result. May call external services.",
        inputSchema: RUN_INPUT_SCHEMA,
        name: "lunora_run_action",
    },
];

/** Names of the write tools — used to gate them out of a read-only server. */
const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(WRITE_TOOL_DEFINITIONS.map((tool) => tool.name));

/**
 * The tools this server advertises, in three tiers:
 *
 * - the read-only surface, always exposed;
 * - the observability surface, exposed only when `allowObservability` is set —
 * read-only, but every row it returns (log lines, request metadata, grouped
 * error messages) is user data that lands in the model's context and therefore
 * at its provider, so it is opt-in rather than implied by holding a token;
 * - the write surface, exposed only when `allowWrites` is set.
 *
 * Both gates OMIT rather than refuse: an AI agent can't invoke what it can't
 * see. Dispatch re-checks both in {@link callTool}, so the guarantee does not
 * depend on a client honouring the advertised list.
 */
const toolDefinitions = (allowWrites: boolean, allowObservability = false): ReadonlyArray<ToolDefinition> =>
    // Fail closed: only the boolean `true` opts in. These are exported helpers, so
    // an env-plumbed/JS caller could pass a truthy string like `"false"`/`"0"` —
    // the explicit `=== true` guards that despite the declared `boolean` type.
    /* eslint-disable @typescript-eslint/no-unnecessary-boolean-literal-compare -- intentional runtime guard at an exported API boundary against non-boolean callers */
    [
        ...READ_ONLY_TOOL_DEFINITIONS,
        ...(allowObservability === true ? OBSERVABILITY_TOOL_DEFINITIONS : []),
        ...(allowWrites === true ? WRITE_TOOL_DEFINITIONS : []),
    ];

/* eslint-enable @typescript-eslint/no-unnecessary-boolean-literal-compare */
/** Extract and validate `functionPath` from an MCP `arguments` bag. */
const readFunctionPath = (input: Record<string, unknown>): string => {
    const { functionPath } = input;

    if (typeof functionPath !== "string" || functionPath.length === 0) {
        throw new LunoraError("INTERNAL", '"functionPath" is required and must be a non-empty string');
    }

    return functionPath;
};

/** True for a JSON object (`{}`), excluding `null` and arrays (both are `typeof "object"`). */
const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A short human label for a rejected `args` value, for the error message. */
const describeArgs = (value: unknown): string => (Array.isArray(value) ? "an array" : `a ${typeof value}`);

/**
 * Resolve the `args` bag for a run tool. Absent (`undefined`/`null`) → an empty
 * bag so an all-optional function runs with its defaults. A JSON-stringified
 * object (which LLMs very commonly emit, e.g. `args: "{\"limit\":5}"`) is parsed
 * and accepted. Anything else — a number, boolean, array, or a string that isn't
 * a JSON object — is REJECTED with a clear error rather than silently coerced to
 * `{}`, so the model gets a signal naming the actual mistake (wrong `args` type)
 * instead of a silent success with defaults, or a misdirecting "missing argument"
 * from the server validator.
 */
const readArgumentsBag = (raw: unknown): Record<string, unknown> => {
    if (raw === undefined || raw === null) {
        return {};
    }

    if (typeof raw === "string") {
        let parsed: unknown;

        try {
            parsed = JSON.parse(raw);
        } catch {
            throw new LunoraError("BAD_REQUEST", `"args" must be a JSON object; received a string that is not valid JSON`);
        }

        if (!isPlainObject(parsed)) {
            throw new LunoraError("BAD_REQUEST", `"args" must be a JSON object; the provided string decoded to ${describeArgs(parsed)}`);
        }

        return parsed;
    }

    if (!isPlainObject(raw)) {
        throw new LunoraError("BAD_REQUEST", `"args" must be a JSON object, got ${describeArgs(raw)}`);
    }

    return raw;
};

/** Coerce an MCP `arguments` bag into the `(fn, args, shardKey)` triple the run-tools share. */
const readRunArguments = (input: Record<string, unknown>): { args: Record<string, unknown>; functionPath: string; shardKey: string | undefined } => {
    const functionPath = readFunctionPath(input);

    const args = readArgumentsBag(input.args);
    // Treat an empty/blank shardKey as absent: forwarding `shardKey: ""` would
    // resolve a different (empty-string) shard than the unsharded default the
    // caller intends, so coalesce it to `undefined`.
    const shardKey = typeof input.shardKey === "string" && input.shardKey.length > 0 ? input.shardKey : undefined;

    return { args, functionPath, shardKey };
};

const reference = (functionPath: string): FunctionReference => {
    return { __lunoraRef: functionPath };
};

/**
 * The deployment's public-function registry is static per deploy, but every run
 * tool (via {@link assertRunnable}) and `lunora_get_function_schema` needs it —
 * two sequential admin round trips per tool call without caching. Memoize
 * `listFunctions()` per client for a short TTL (freshness only matters across
 * redeploys) and cache the in-flight promise so a burst of concurrent tool calls
 * shares one fetch. A rejected fetch is evicted so the next call retries rather
 * than replaying the failure. Keyed by client via a `WeakMap` so a discarded
 * client's entry is collectable and separate servers don't share a cache.
 */
const FUNCTIONS_CACHE_TTL_MS = 30_000;

interface FunctionsCacheEntry {
    expiresAt: number;
    promise: Promise<FunctionDescriptor[]>;
}

const functionsCache = new WeakMap<LunoraClient, FunctionsCacheEntry>();

const listFunctionsCached = (client: LunoraClient): Promise<FunctionDescriptor[]> => {
    const now = Date.now();
    const cached = functionsCache.get(client);

    if (cached !== undefined && cached.expiresAt > now) {
        return cached.promise;
    }

    const promise = client.listFunctions().catch((error: unknown) => {
        // Don't leave a rejected fetch cached — evict this entry (unless a newer
        // one already replaced it) so the next call retries.
        if (functionsCache.get(client)?.promise === promise) {
            functionsCache.delete(client);
        }

        throw error;
    });

    functionsCache.set(client, { expiresAt: now + FUNCTIONS_CACHE_TTL_MS, promise });

    return promise;
};

/**
 * Resolve `functionPath` against the deployment's DISCOVERED public functions and
 * assert it exists and matches the expected kind. This is the allowlist: a run
 * tool can only invoke a path `lunora_list_functions` would surface, so an agent
 * can't reach internal/non-public function paths it invented, and can't run a
 * mutation/action through the query tool (or vice-versa). Throws on any mismatch.
 */
const assertRunnable = async (client: LunoraClient, functionPath: string, expectedKind: "action" | "mutation" | "query"): Promise<void> => {
    const functions = await listFunctionsCached(client);
    const descriptor: FunctionDescriptor | undefined = functions.find((function_) => function_.path === functionPath);

    if (descriptor === undefined) {
        throw new LunoraError("NOT_FOUND", `function not found or not public: ${functionPath}`);
    }

    if (descriptor.kind !== expectedKind) {
        throw new LunoraError("BAD_REQUEST", `function ${functionPath} is a ${descriptor.kind}, not a ${expectedKind}`);
    }
};

/**
 * Dispatch a tool call against `client`. Unknown tools and thrown errors are
 * returned as `isError` results (rather than rejections) so the calling model
 * sees the failure as tool output, per the MCP convention.
 *
 * `allowWrites` gates the mutation/action tools and `allowObservability` gates
 * the observability tools: when either is false a call to the gated tool is
 * refused even if the client somehow names it, so both guarantees hold at
 * dispatch, not just in the advertised tool list.
 */
const callTool = async (
    client: LunoraClient,
    name: string,
    input: Record<string, unknown>,
    allowWrites = false,
    allowObservability = false,
): Promise<ToolResult> => {
    try {
        /* eslint-disable @typescript-eslint/no-unnecessary-boolean-literal-compare -- intentional runtime guard at an exported API boundary against non-boolean callers */
        if (allowWrites !== true && WRITE_TOOL_NAMES.has(name)) {
            return errorResult(`tool "${name}" is disabled: this MCP server is read-only. Enable writes with the LUNORA_MCP_ALLOW_WRITES env var.`);
        }

        if (OBSERVABILITY_TOOL_NAMES.has(name)) {
            if (allowObservability !== true) {
                return errorResult(
                    `tool "${name}" is disabled: it reads the deployment's logs, request metadata and grouped errors — user data that would land at the model provider. Enable it with the LUNORA_MCP_ALLOW_OBSERVABILITY env var.`,
                );
            }

            return await callObservabilityTool(client, name, input);
        }
        /* eslint-enable @typescript-eslint/no-unnecessary-boolean-literal-compare */

        switch (name) {
            case "lunora_get_function_schema": {
                const functionPath = readFunctionPath(input);
                const functions = await listFunctionsCached(client);
                const descriptor: FunctionDescriptor | undefined = functions.find((function_) => function_.path === functionPath);

                if (descriptor === undefined) {
                    return errorResult(`function not found: ${functionPath}`);
                }

                return ok({ args: descriptor.args ?? [], kind: descriptor.kind, path: descriptor.path });
            }
            case "lunora_list_functions": {
                return ok(await listFunctionsCached(client));
            }
            case "lunora_list_tables": {
                return ok(await client.listGlobalTables());
            }
            case "lunora_run_action": {
                const { args, functionPath, shardKey } = readRunArguments(input);

                await assertRunnable(client, functionPath, "action");

                return ok(await client.action(reference(functionPath), args, { shardKey }));
            }
            case "lunora_run_mutation": {
                const { args, functionPath, shardKey } = readRunArguments(input);

                await assertRunnable(client, functionPath, "mutation");

                return ok(await client.mutation(reference(functionPath), args, { shardKey }));
            }
            case "lunora_run_query": {
                const { args, functionPath, shardKey } = readRunArguments(input);

                await assertRunnable(client, functionPath, "query");

                return ok(await client.query(reference(functionPath), args, { shardKey }));
            }
            default: {
                return errorResult(`unknown tool: ${name}`);
            }
        }
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        return errorResult(message);
    }
};

export { callTool, READ_ONLY_TOOL_DEFINITIONS, toolDefinitions, WRITE_TOOL_DEFINITIONS };

export { OBSERVABILITY_TOOL_DEFINITIONS } from "./observability-tools";
export { type ToolDefinition, type ToolInputSchema, type ToolResult } from "./tool-types";
