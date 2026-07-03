import type { FunctionDescriptor, FunctionReference, LunoraClient } from "@lunora/client";
import { LunoraError } from "@lunora/errors";

/**
 * The tool surface this MCP server exposes. Each tool maps onto a method the
 * `LunoraClient` already provides, so an AI agent can introspect a deployment
 * (functions, global tables) and invoke its functions over HTTP RPC.
 *
 * Definitions and dispatch live here — separate from the server wiring — so the
 * behaviour is unit-testable against a mock client without driving a transport.
 */

/** A JSON-Schema object describing a tool's arguments, per the MCP spec. */
interface ToolInputSchema {
    properties: Record<string, unknown>;
    required?: ReadonlyArray<string>;
    type: "object";
}

interface ToolDefinition {
    description: string;
    inputSchema: ToolInputSchema;
    name: string;
}

/** The MCP `CallToolResult` shape this server returns. */
interface ToolResult {
    content: { text: string; type: "text" }[];
    isError?: boolean;
}

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

/** The read-only tool surface: introspection + query. Always exposed. */
const READ_ONLY_TOOL_DEFINITIONS: ReadonlyArray<ToolDefinition> = [
    {
        description: "List the deployment's public functions (queries, mutations, actions) with their kinds.",
        inputSchema: NO_INPUT_SCHEMA,
        name: "lunora_list_functions",
    },
    {
        description: "List the deployment's .global() tables and their column shapes.",
        inputSchema: NO_INPUT_SCHEMA,
        name: "lunora_list_tables",
    },
    {
        description:
            "Return a function's argument JSON Schema and kind, so a caller can construct a valid arguments object. Call lunora_list_functions first to discover available function paths.",
        inputSchema: FUNCTION_PATH_INPUT_SCHEMA,
        name: "lunora_get_function_schema",
    },
    {
        description: "Run a query and return its result. Read-only.",
        inputSchema: RUN_INPUT_SCHEMA,
        name: "lunora_run_query",
    },
];

/** The write tool surface (mutations + actions). Exposed ONLY when writes are enabled. */
const WRITE_TOOL_DEFINITIONS: ReadonlyArray<ToolDefinition> = [
    {
        description: "Run a mutation and return its result. Writes data — use with care.",
        inputSchema: RUN_INPUT_SCHEMA,
        name: "lunora_run_mutation",
    },
    {
        description: "Run an action and return its result. May call external services.",
        inputSchema: RUN_INPUT_SCHEMA,
        name: "lunora_run_action",
    },
];

/** Names of the write tools — used to gate them out of a read-only server. */
const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(WRITE_TOOL_DEFINITIONS.map((tool) => tool.name));

/**
 * The tools this server advertises. When `allowWrites` is false (the default),
 * only the read-only surface is exposed — the mutation/action tools are omitted
 * from `ListTools` entirely, so an AI agent can't invoke a write it can't see.
 */
const toolDefinitions = (allowWrites: boolean): ReadonlyArray<ToolDefinition> =>
    // Fail closed: only the boolean `true` opts in. These are exported helpers, so
    // an env-plumbed/JS caller could pass a truthy string like `"false"`/`"0"` —
    // the explicit `=== true` guards that despite the declared `boolean` type.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare -- intentional runtime guard at an exported API boundary against non-boolean callers
    allowWrites === true ? [...READ_ONLY_TOOL_DEFINITIONS, ...WRITE_TOOL_DEFINITIONS] : READ_ONLY_TOOL_DEFINITIONS;

/** Extract and validate `functionPath` from an MCP `arguments` bag. */
const readFunctionPath = (input: Record<string, unknown>): string => {
    const { functionPath } = input;

    if (typeof functionPath !== "string" || functionPath.length === 0) {
        throw new LunoraError("INTERNAL", '"functionPath" is required and must be a non-empty string');
    }

    return functionPath;
};

/** Coerce an MCP `arguments` bag into the `(fn, args, shardKey)` triple the run-tools share. */
const readRunArguments = (input: Record<string, unknown>): { args: Record<string, unknown>; functionPath: string; shardKey: string | undefined } => {
    const functionPath = readFunctionPath(input);

    // Per the tool's JSON Schema, `args` is an object; coerce anything else
    // (including arrays — `typeof [] === "object"`) to an empty bag so a
    // malformed payload can't be forwarded as the function's arguments.
    const rawArguments = input.args;
    const isPlainObject = typeof rawArguments === "object" && rawArguments !== null && !Array.isArray(rawArguments);
    const args = isPlainObject ? (rawArguments as Record<string, unknown>) : {};
    // Treat an empty/blank shardKey as absent: forwarding `shardKey: ""` would
    // resolve a different (empty-string) shard than the unsharded default the
    // caller intends, so coalesce it to `undefined`.
    const shardKey = typeof input.shardKey === "string" && input.shardKey.length > 0 ? input.shardKey : undefined;

    return { args, functionPath, shardKey };
};

const reference = (functionPath: string): FunctionReference => {
    return { __lunoraRef: functionPath };
};

const ok = (value: unknown): ToolResult => {
    // A void-returning mutation/action resolves to `undefined`, and
    // `JSON.stringify(undefined)` yields the JS value `undefined` (not a
    // string), which violates both `ToolResult.content[].text: string` and the
    // MCP `TextContent` contract. Emit the JSON `null` literal in that case.
    const text = value === undefined ? "null" : JSON.stringify(value, undefined, 2);

    return { content: [{ text, type: "text" }] };
};

/**
 * Resolve `functionPath` against the deployment's DISCOVERED public functions and
 * assert it exists and matches the expected kind. This is the allowlist: a run
 * tool can only invoke a path `lunora_list_functions` would surface, so an agent
 * can't reach internal/non-public function paths it invented, and can't run a
 * mutation/action through the query tool (or vice-versa). Throws on any mismatch.
 */
const assertRunnable = async (client: LunoraClient, functionPath: string, expectedKind: "action" | "mutation" | "query"): Promise<void> => {
    const functions = await client.listFunctions();
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
 * `allowWrites` gates the mutation/action tools: when false (the default) a call
 * to a write tool is refused even if the client somehow names it, so the
 * read-only guarantee holds at dispatch, not just in the advertised tool list.
 */
const callTool = async (client: LunoraClient, name: string, input: Record<string, unknown>, allowWrites = false): Promise<ToolResult> => {
    try {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare -- intentional runtime guard at an exported API boundary against non-boolean callers
        if (allowWrites !== true && WRITE_TOOL_NAMES.has(name)) {
            return {
                content: [
                    { text: `tool "${name}" is disabled: this MCP server is read-only. Enable writes with the LUNORA_MCP_ALLOW_WRITES env var.`, type: "text" },
                ],
                isError: true,
            };
        }

        switch (name) {
            case "lunora_get_function_schema": {
                const functionPath = readFunctionPath(input);
                const functions = await client.listFunctions();
                const descriptor: FunctionDescriptor | undefined = functions.find((function_) => function_.path === functionPath);

                if (descriptor === undefined) {
                    return { content: [{ text: `function not found: ${functionPath}`, type: "text" }], isError: true };
                }

                return ok({ args: descriptor.args ?? [], kind: descriptor.kind, path: descriptor.path });
            }
            case "lunora_list_functions": {
                return ok(await client.listFunctions());
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
                return { content: [{ text: `unknown tool: ${name}`, type: "text" }], isError: true };
            }
        }
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        return { content: [{ text: message, type: "text" }], isError: true };
    }
};

export type { ToolDefinition, ToolInputSchema, ToolResult };
export { callTool, READ_ONLY_TOOL_DEFINITIONS, toolDefinitions, WRITE_TOOL_DEFINITIONS };
