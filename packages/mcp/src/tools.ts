import type { FunctionDescriptor, FunctionReference, LunoraClient } from "@lunora/client";
import { LunoraError } from "@lunora/errors";

import { callErrorTool, ERROR_TOOL_DEFINITIONS, ERROR_TOOL_NAMES } from "./error-tools";
import { callObservabilityTool, OBSERVABILITY_TOOL_DEFINITIONS, OBSERVABILITY_TOOL_NAMES } from "./observability-tools";
import { callRowReadTool, ROW_READ_TOOL_DEFINITIONS, ROW_READ_TOOL_NAMES } from "./row-read-tools";
import { errorResult, ok } from "./tool-result";
import type { ToolDefinition, ToolInputSchema, ToolResult } from "./tool-types";
import { readConfirmation, screenWriteConfirmation, WRITE_CONFIRMATION_PROPERTIES } from "./write-confirmation";

/**
 * The tool surface this MCP server exposes, and the router in front of it. Each
 * tool maps onto a method the `LunoraClient` already provides, so an AI agent
 * can introspect a deployment (functions, global tables) and invoke its
 * functions over HTTP RPC.
 *
 * The surface is a TABLE of families ({@link TOOL_FAMILIES}), each one a
 * `{ definitions, names, call, gate? }` record. {@link toolDefinitions} is a
 * flatMap over the enabled families and {@link callTool} is "find the owning
 * family, check its gate, dispatch" — so a new family is one table row rather
 * than a name-set check plus a switch case plus a second gate check.
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

/** Names of the read-only tools — used to route dispatch to {@link callReadOnlyTool}. */
const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set(READ_ONLY_TOOL_DEFINITIONS.map((tool) => tool.name));

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
    'TWO-STEP: the first call does NOT execute. It returns status "action_required" with the proposed action, an actionDigest and the expiresAt it is good until; show that to a human, then call again before expiresAt with the IDENTICAL functionPath/args/shardKey plus confirmed: true and that actionDigest. Any change to the target or the arguments produces a different digest and needs a fresh review, and an expired digest is refused rather than re-proposed.';

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

/** Names of the write tools — used to route dispatch and to gate them out of a read-only server. */
const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(WRITE_TOOL_DEFINITIONS.map((tool) => tool.name));

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

/** Dispatch a read-only tool: introspection and query, no gate. */
const callReadOnlyTool = async (client: LunoraClient, name: string, input: Record<string, unknown>): Promise<ToolResult> => {
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
        case "lunora_run_query": {
            const { args, functionPath, shardKey } = readRunArguments(input);

            await assertRunnable(client, functionPath, "query");

            return ok(await client.query(reference(functionPath), args, { shardKey }));
        }
        default: {
            throw new LunoraError("INTERNAL", `unknown read-only tool: ${name}`);
        }
    }
};

/**
 * Dispatch a write tool.
 *
 * The `allowWrites` gate has already passed by the time this runs — it gates the
 * SURFACE. Each individual write additionally goes through {@link screenWrite}'s
 * two-step confirmation here, so "this server may write" and "this write was
 * reviewed" stay separate questions.
 */
const callWriteTool = async (client: LunoraClient, name: string, input: Record<string, unknown>): Promise<ToolResult> => {
    if (name !== "lunora_run_action" && name !== "lunora_run_mutation") {
        throw new LunoraError("INTERNAL", `unknown write tool: ${name}`);
    }

    const kind = name === "lunora_run_action" ? "action" : "mutation";
    const { args, functionPath, shardKey } = readRunArguments(input);

    await assertRunnable(client, functionPath, kind);

    const gate = await screenWrite(client, name, kind, { args, functionPath, shardKey }, input);

    if (gate !== undefined) {
        return gate;
    }

    return ok(
        kind === "action"
            ? await client.action(reference(functionPath), args, { shardKey })
            : await client.mutation(reference(functionPath), args, { shardKey }),
    );
};

/** The opt-in flags `toolDefinitions` and `callTool` accept, by name. */
type ToolGate = "allowDataReads" | "allowObservability" | "allowWrites";

/**
 * The opt-in flags as the caller actually passed them.
 *
 * Deliberately `unknown` rather than `boolean`: both consumers are exported and
 * reachable from plain JS and from env plumbing, so a truthy string like
 * `"false"` or `"0"` must not opt in. {@link isOptedIn} is the one place that
 * decides, and an `unknown` bag is what keeps that comparison honest instead of
 * one the compiler (and the lint rule) believes is redundant.
 */
type ToolGates = Record<ToolGate, unknown>;

/** Fail closed: only the boolean `true` opts in, whatever a caller actually passed. */
const isOptedIn = (value: unknown): boolean => value === true;

/** The opt-in guarding one family, and the refusal a call to it earns without that opt-in. */
interface ToolGateSpec {
    flag: ToolGate;
    refuse: (name: string) => string;
}

/**
 * One family of tools: the definitions it advertises, the names it owns, how it
 * dispatches, and the opt-in guarding it.
 *
 * The gate is declared ONCE and consumed twice — {@link toolDefinitions} omits a
 * closed family's definitions, {@link callTool} refuses its names at dispatch.
 * Both halves are that guarantee: an AI agent can't invoke what it can't see,
 * and a client that ignores the advertised list must still be refused. A gate
 * that lived in only one of the two places would satisfy exactly half of it.
 */
interface ToolFamily {
    /** Dispatch a call this family owns. May throw; {@link callTool} turns that into an error result. */
    call: (client: LunoraClient, name: string, input: Record<string, unknown>) => Promise<ToolResult> | ToolResult;
    definitions: ReadonlyArray<ToolDefinition>;
    /** Absent for the always-exposed tiers. */
    gate?: ToolGateSpec;
    names: ReadonlySet<string>;
}

/**
 * The surface, in the order it is advertised: the two always-on tiers first,
 * then each gated one.
 *
 * The error tools are always on for a different reason than the read-only ones:
 * they answer from `@lunora/errors`' compiled-in catalog, so they carry no user
 * data, need no admin bearer, and are reachable with NO deployment at all (see
 * `./local`, which registers them on every local server).
 */
const TOOL_FAMILIES: ReadonlyArray<ToolFamily> = [
    { call: callReadOnlyTool, definitions: READ_ONLY_TOOL_DEFINITIONS, names: READ_ONLY_TOOL_NAMES },
    { call: (_client, name, input) => callErrorTool(name, input), definitions: ERROR_TOOL_DEFINITIONS, names: ERROR_TOOL_NAMES },
    {
        call: callRowReadTool,
        definitions: ROW_READ_TOOL_DEFINITIONS,
        gate: {
            flag: "allowDataReads",
            refuse: (name) =>
                `tool "${name}" is disabled: it returns raw table rows read through the deployment's ADMIN writer, so RLS policies and column masks do not apply. Enable it with the LUNORA_MCP_ALLOW_DATA_READS env var.`,
        },
        names: ROW_READ_TOOL_NAMES,
    },
    {
        call: callObservabilityTool,
        definitions: OBSERVABILITY_TOOL_DEFINITIONS,
        gate: {
            flag: "allowObservability",
            refuse: (name) =>
                `tool "${name}" is disabled: it reads the deployment's logs, request metadata and grouped errors — user data that would land at the model provider. Enable it with the LUNORA_MCP_ALLOW_OBSERVABILITY env var.`,
        },
        names: OBSERVABILITY_TOOL_NAMES,
    },
    {
        call: callWriteTool,
        definitions: WRITE_TOOL_DEFINITIONS,
        gate: {
            flag: "allowWrites",
            refuse: (name) => `tool "${name}" is disabled: this MCP server is read-only. Enable writes with the LUNORA_MCP_ALLOW_WRITES env var.`,
        },
        names: WRITE_TOOL_NAMES,
    },
];

/**
 * The gate holding `family` back for `gates`, or `undefined` when it is open —
 * the single decision both halves of the omit-and-refuse guarantee read.
 */
const closedGate = (family: ToolFamily, gates: ToolGates): ToolGateSpec | undefined =>
    family.gate !== undefined && !isOptedIn(gates[family.gate.flag]) ? family.gate : undefined;

/**
 * The tools this server advertises: every family whose gate is open, in table
 * order. A gated family is OMITTED rather than refused — an AI agent can't
 * invoke what it can't see — and {@link callTool} re-checks the same gate at
 * dispatch, so the guarantee does not depend on a client honouring this list.
 */
const toolDefinitions = (allowWrites: boolean, allowObservability = false, allowDataReads = false): ReadonlyArray<ToolDefinition> => {
    const gates: ToolGates = { allowDataReads, allowObservability, allowWrites };

    return TOOL_FAMILIES.filter((family) => closedGate(family, gates) === undefined).flatMap((family) => family.definitions);
};

/**
 * Dispatch a tool call against `client`: find the family that owns `name`, check
 * its gate, hand off. Unknown tools and thrown errors are returned as `isError`
 * results (rather than rejections) so the calling model sees the failure as tool
 * output, per the MCP convention.
 *
 * Each gate is enforced HERE as well as in {@link toolDefinitions}, so a call to
 * a gated tool is refused even if the client somehow names one it was never
 * shown.
 */
const callTool = async (
    client: LunoraClient,
    name: string,
    input: Record<string, unknown>,
    allowWrites = false,
    allowObservability = false,
    allowDataReads = false,
): Promise<ToolResult> => {
    const family = TOOL_FAMILIES.find((candidate) => candidate.names.has(name));

    if (family === undefined) {
        return errorResult(`unknown tool: ${name}`);
    }

    const closed = closedGate(family, { allowDataReads, allowObservability, allowWrites });

    if (closed !== undefined) {
        return errorResult(closed.refuse(name));
    }

    try {
        return await family.call(client, name, input);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        return errorResult(message);
    }
};

export { callTool, READ_ONLY_TOOL_DEFINITIONS, toolDefinitions, WRITE_TOOL_DEFINITIONS };

export { OBSERVABILITY_TOOL_DEFINITIONS } from "./observability-tools";
export { ROW_READ_TOOL_DEFINITIONS } from "./row-read-tools";
export { type ToolDefinition, type ToolInputSchema, type ToolResult } from "./tool-types";
