import type { CirrusClient, FunctionReference } from "@cirrus/client";

/**
 * The tool surface this MCP server exposes. Each tool maps onto a method the
 * `CirrusClient` already provides, so an AI agent can introspect a deployment
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

const TOOL_DEFINITIONS: ReadonlyArray<ToolDefinition> = [
    {
        description: "List the deployment's public functions (queries, mutations, actions) with their kinds.",
        inputSchema: NO_INPUT_SCHEMA,
        name: "cirrus_list_functions",
    },
    {
        description: "List the deployment's .global() tables and their column shapes.",
        inputSchema: NO_INPUT_SCHEMA,
        name: "cirrus_list_tables",
    },
    {
        description: "Run a query and return its result. Read-only.",
        inputSchema: RUN_INPUT_SCHEMA,
        name: "cirrus_run_query",
    },
    {
        description: "Run a mutation and return its result. Writes data — use with care.",
        inputSchema: RUN_INPUT_SCHEMA,
        name: "cirrus_run_mutation",
    },
    {
        description: "Run an action and return its result. May call external services.",
        inputSchema: RUN_INPUT_SCHEMA,
        name: "cirrus_run_action",
    },
];

/** Coerce an MCP `arguments` bag into the `(fn, args, shardKey)` triple the run-tools share. */
const readRunArguments = (input: Record<string, unknown>): { args: Record<string, unknown>; functionPath: string; shardKey: string | undefined } => {
    const { functionPath } = input;

    if (typeof functionPath !== "string" || functionPath.length === 0) {
        throw new Error('"functionPath" is required and must be a non-empty string');
    }

    // Per the tool's JSON Schema, `args` is an object; coerce anything else
    // (including arrays — `typeof [] === "object"`) to an empty bag so a
    // malformed payload can't be forwarded as the function's arguments.
    const rawArguments = input.args;
    const isPlainObject = typeof rawArguments === "object" && rawArguments !== null && !Array.isArray(rawArguments);
    const args = isPlainObject ? (rawArguments as Record<string, unknown>) : {};
    const shardKey = typeof input.shardKey === "string" ? input.shardKey : undefined;

    return { args, functionPath, shardKey };
};

const reference = (functionPath: string): FunctionReference => {
    return { __cirrusRef: functionPath };
};

const ok = (value: unknown): ToolResult => {
    return { content: [{ text: JSON.stringify(value, undefined, 2), type: "text" }] };
};

/**
 * Dispatch a tool call against `client`. Unknown tools and thrown errors are
 * returned as `isError` results (rather than rejections) so the calling model
 * sees the failure as tool output, per the MCP convention.
 */
const callTool = async (client: CirrusClient, name: string, input: Record<string, unknown>): Promise<ToolResult> => {
    try {
        switch (name) {
            case "cirrus_list_functions": {
                return ok(await client.listFunctions());
            }
            case "cirrus_list_tables": {
                return ok(await client.listGlobalTables());
            }
            case "cirrus_run_action": {
                const { args, functionPath, shardKey } = readRunArguments(input);

                return ok(await client.action(reference(functionPath), args, { shardKey }));
            }
            case "cirrus_run_mutation": {
                const { args, functionPath, shardKey } = readRunArguments(input);

                return ok(await client.mutation(reference(functionPath), args, { shardKey }));
            }
            case "cirrus_run_query": {
                const { args, functionPath, shardKey } = readRunArguments(input);

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
export { callTool, TOOL_DEFINITIONS };
