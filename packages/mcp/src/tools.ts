import type { FunctionDescriptor, FunctionReference, LunoraClient } from "@lunora/client";
import { LunoraError } from "@lunora/errors";
import { ADMIN_FUNCTIONS } from "@lunora/shard-engine";

import { callErrorTool, ERROR_TOOL_DEFINITIONS, ERROR_TOOL_NAMES } from "./error-tools";
import { callObservabilityTool, OBSERVABILITY_TOOL_DEFINITIONS, OBSERVABILITY_TOOL_NAMES } from "./observability-tools";
import { errorResult, ok } from "./tool-result";
import type { ToolDefinition, ToolInputSchema, ToolResult } from "./tool-types";
import { readConfirmation, screenWriteConfirmation, WRITE_CONFIRMATION_PROPERTIES } from "./write-confirmation";

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

const FIND_RELATED_INPUT_SCHEMA: ToolInputSchema = {
    properties: {
        cursor: { description: "Opaque cursor from a previous call's continueCursor, to fetch the next page.", type: "string" },
        depth: { description: "How many hops to follow. 1 (default) is the direct neighbourhood; maximum 4.", type: "number" },
        direction: {
            description:
                'Which way to follow foreign keys: "out" follows the ids this row holds (ticket → customer), "in" the rows that point at it (customer → tickets), "both" (default) does both.',
            type: "string",
        },
        edges: {
            description:
                'Restrict the walk to these edge names, each "<table>.<column>" (e.g. "tickets.customerId"). Omit to follow every declared foreign key.',
            items: { type: "string" },
            type: "array",
        },
        id: { description: "Document id of the row to start from.", type: "string" },
        limit: { description: "Maximum related rows to return (default 50, maximum 200).", type: "number" },
        shardKey: { description: "Shard to read from on a .shardBy()-partitioned deployment. Omit for the default (unsharded) shard.", type: "string" },
        table: { description: 'Table the start row lives in, e.g. "customers".', type: "string" },
    },
    required: ["table", "id"],
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
    {
        annotations: { ...READ_ONLY_ANNOTATIONS, title: "Find rows related to a row" },
        description:
            "Follow the schema's foreign keys out of one row and return the rows it is connected to, each with its hop distance, the edge names walked to reach it, and a depth-decaying score. Use this to answer 'what is connected to this' — a customer's tickets, those tickets' messages — which keyword and semantic search cannot, because the connection lives in a foreign key rather than in the text. Read-only.",
        inputSchema: FIND_RELATED_INPUT_SCHEMA,
        name: "lunora_find_related",
    },
];

/**
 * The write tools' input schema: the shared run-tool triple plus the
 * confirmation handshake fields (`confirmed`, `actionDigest`, `idempotencyKey`).
 * Only `functionPath` stays required — the first call is the one that PROPOSES
 * the write, so a schema demanding a digest up front would be unsatisfiable.
 */
const WRITE_RUN_INPUT_SCHEMA: ToolInputSchema = {
    properties: { ...RUN_INPUT_SCHEMA.properties, ...WRITE_CONFIRMATION_PROPERTIES },
    required: ["functionPath"],
    type: "object",
};

/** The two-step handshake, restated in every write tool's description because that is what the model actually reads. */
const HANDSHAKE_DESCRIPTION =
    'TWO-STEP: the first call does NOT execute. It returns status "action_required" with the proposed action and an actionDigest; show that to a human, then call again with the IDENTICAL functionPath/args/shardKey plus confirmed: true and that actionDigest. Any change to the target or the arguments produces a different digest and needs a fresh review.';

/** The write tool surface (mutations + actions). Exposed ONLY when writes are enabled. */
const WRITE_TOOL_DEFINITIONS: ReadonlyArray<ToolDefinition> = [
    {
        // Not idempotent and not read-only: this is the distinction the whole
        // `allowWrites` gate exists for, now legible to a client's UI.
        annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true, readOnlyHint: false, title: "Run a mutation (writes data)" },
        description: `Run a mutation. Writes data. ${HANDSHAKE_DESCRIPTION}`,
        inputSchema: WRITE_RUN_INPUT_SCHEMA,
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
        description: `Run an action. May call external services — send mail, charge a card, hit a third-party API — so the confirmation is the only thing between a proposal and a real-world side effect. ${HANDSHAKE_DESCRIPTION}`,
        inputSchema: WRITE_RUN_INPUT_SCHEMA,
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
        ...ERROR_TOOL_DEFINITIONS,
        ...(allowObservability === true ? OBSERVABILITY_TOOL_DEFINITIONS : []),
        ...(allowWrites === true ? WRITE_TOOL_DEFINITIONS : []),
    ];

/* eslint-enable @typescript-eslint/no-unnecessary-boolean-literal-compare */
/** Extract and validate `functionPath` from an MCP `arguments` bag. */
const readFunctionPath = (input: Record<string, unknown>): string => {
    const { functionPath } = input;

    if (typeof functionPath !== "string" || functionPath.length === 0) {
        // BAD_REQUEST, not INTERNAL: the value comes from the model's own
        // `arguments` bag, so it is the caller's mistake — same as the
        // `readArgumentsBag` refusals below, and what the docs document.
        throw new LunoraError("BAD_REQUEST", '"functionPath" is required and must be a non-empty string');
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
 * Coerce an MCP `arguments` bag into the `findRelated` admin payload.
 *
 * Only SHAPE is enforced here. The range checks that matter (`depth` 1-4,
 * `limit` 1-200, a known edge name) belong to `ctx.db.related` itself, and its
 * refusals name the cap — a second copy here would drift from them.
 */
const readRelatedArguments = (input: Record<string, unknown>): { args: Record<string, unknown>; shardKey: string | undefined } => {
    const { cursor, depth, direction, edges, id, limit, shardKey, table } = input;

    if (typeof table !== "string" || table.length === 0) {
        throw new LunoraError("BAD_REQUEST", '"table" is required and must be a non-empty string');
    }

    if (typeof id !== "string" || id.length === 0) {
        throw new LunoraError("BAD_REQUEST", '"id" is required and must be a non-empty string');
    }

    return {
        args: {
            id,
            table,
            ...(typeof cursor === "string" ? { cursor } : {}),
            ...(typeof depth === "number" ? { depth } : {}),
            ...(typeof direction === "string" ? { direction } : {}),
            ...(Array.isArray(edges) ? { edges } : {}),
            ...(typeof limit === "number" ? { limit } : {}),
        },
        shardKey: typeof shardKey === "string" && shardKey.length > 0 ? shardKey : undefined,
    };
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
 * The confirmation handshake in front of one write. Returns the result to hand
 * back — the `action_required` proposal on an unconfirmed call, or a refusal
 * when the supplied digest does not verify — and `undefined` when the call is
 * confirmed and may execute. See `./write-confirmation`.
 *
 * Runs AFTER {@link assertRunnable}, so a proposal only ever describes a
 * function the deployment really exposes at the kind the tool claims: the
 * proposal a human reviews states that kind, and asking someone to approve a
 * call that would have failed anyway is worse than the error.
 */
const screenWrite = async (
    client: LunoraClient,
    tool: string,
    kind: "action" | "mutation",
    run: { args: Record<string, unknown>; functionPath: string; shardKey: string | undefined },
    input: Record<string, unknown>,
): Promise<ToolResult | undefined> => {
    const confirmation = readConfirmation(input);

    return screenWriteConfirmation(client, { ...run, idempotencyKey: confirmation.idempotencyKey, kind, tool }, confirmation);
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
 *
 * `allowWrites` is a gate on the SURFACE, not on any one write. Past it, every
 * mutation/action call additionally goes through {@link screenWrite}'s two-step
 * confirmation, so "this server may write" and "this write was reviewed" stay
 * separate questions.
 */
const callTool = async (
    client: LunoraClient,
    name: string,
    input: Record<string, unknown>,
    allowWrites = false,
    allowObservability = false,
): Promise<ToolResult> => {
    try {
        // Static catalog content — no client, no gate, and reachable on a server
        // whose deployment is unreachable.
        if (ERROR_TOOL_NAMES.has(name)) {
            return callErrorTool(name, input);
        }

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
            case "lunora_find_related": {
                // Served by the shard's `__lunora_admin__:findRelated` op, over
                // the same `client.query` transport the observability tools use:
                // the traversal needs the app's schema-derived edge set, which
                // only the deployment has.
                const { args, shardKey } = readRelatedArguments(input);

                return ok(await client.query(reference(ADMIN_FUNCTIONS.findRelated), args, { ...(shardKey === undefined ? {} : { shardKey }) }));
            }
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

                const gate = await screenWrite(client, name, "action", { args, functionPath, shardKey }, input);

                if (gate !== undefined) {
                    return gate;
                }

                return ok(await client.action(reference(functionPath), args, { shardKey }));
            }
            case "lunora_run_mutation": {
                const { args, functionPath, shardKey } = readRunArguments(input);

                await assertRunnable(client, functionPath, "mutation");

                const gate = await screenWrite(client, name, "mutation", { args, functionPath, shardKey }, input);

                if (gate !== undefined) {
                    return gate;
                }

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
