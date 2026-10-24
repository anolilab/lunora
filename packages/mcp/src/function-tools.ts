import { LunoraError } from "@lunora/errors";

import type { Schema } from "./function-args";
import { isSchema } from "./function-args";
import { withErrorShape } from "./tool-result";
import type { ToolDefinition, ToolInputSchema, ToolOutputSchema } from "./tool-types";
import { WRITE_CONFIRMATION_PROPERTIES } from "./write-confirmation";

/**
 * One MCP tool per query, mutation, action and stream in the developer's app, built
 * from the OpenRPC document codegen emits (`openRpcSpec`). Building the tools needs
 * no network call and no admin token. The server may build them again from a newer
 * document when codegen rewrites it (see `createFunctionMcpServer`).
 *
 * Only the functions the RPC surface exposes reach here: codegen drops `internal`
 * functions from the document. A `stream` becomes a read-only tool whose dispatch
 * collects the chunks it yields.
 */

type FunctionKind = "action" | "mutation" | "query" | "stream";

/** A mutation or action writes, so it passes the confirmation handshake. A query and a stream only read. */
const isWrite = (kind: FunctionKind): boolean => kind === "action" || kind === "mutation";

/**
 * `none`: no `.output()` was declared, so the result is text only.
 * `object`: the declared output is an object, returned as `structuredContent`.
 * `wrapped`: the declared output is not an object. MCP requires an object root,
 * so the value is returned as `{ result }`.
 */
type OutputMode = "none" | "object" | "wrapped";

/** What a call to a tool needs at dispatch. */
interface FunctionRoute {
    argsSchema: Schema;
    kind: FunctionKind;
    outputMode: OutputMode;
    path: string;
    /** Argument names marked `v.sensitive` (`writeOnly` in the schema): masked in a write proposal. */
    sensitiveArgs: ReadonlyArray<string>;
}

interface FunctionTools {
    definitions: ReadonlyArray<ToolDefinition>;
    routes: ReadonlyMap<string, FunctionRoute>;
}

/** One function as the OpenRPC document describes it, before it becomes a tool. */
interface FunctionShape {
    argsSchema: Schema;
    /** The author's doc comment, from `x-lunora-description`. Absent when the export has none. */
    description?: string;
    kind: FunctionKind;
    output: { mode: "none" } | { mode: "object" | "wrapped"; schema: ToolOutputSchema };
    path: string;
}

const isKind = (value: unknown): value is FunctionKind => value === "query" || value === "mutation" || value === "action" || value === "stream";

/**
 * Anthropic's tool-name rule: `^[a-zA-Z0-9_-]{1,64}$`. Namespaces may carry `/`
 * and other punctuation, so a path is sanitised rather than rejected.
 */
const TOOL_NAME_MAX_LENGTH = 64;
const UNSAFE_NAME_CHARACTERS = /[^\w-]/g;

const READ_ONLY_ANNOTATIONS = { destructiveHint: false, idempotentHint: true, openWorldHint: true, readOnlyHint: true } as const;
const WRITE_ANNOTATIONS = { destructiveHint: true, idempotentHint: false, openWorldHint: true, readOnlyHint: false } as const;

const SHARD_KEY_PROPERTY = {
    description: "Shard key. Only for a function partitioned with .shardBy(); omit it otherwise.",
    type: "string",
};

const HANDSHAKE = "The first call only proposes the write. Confirm it with confirmed: true and the actionDigest the proposal returns.";

/** The sentence used when the export has no doc comment. */
const GENERATED_DESCRIPTION_BY_KIND: Record<FunctionKind, (path: string) => string> = {
    action: (path) => `Runs the action "${path}", which may call external services.`,
    mutation: (path) => `Runs the mutation "${path}", which changes data.`,
    query: (path) => `Runs the query "${path}". Read-only.`,
    stream: (path) => `Runs the stream "${path}", which yields chunks. The result is every chunk, in order. Read-only.`,
};

/** The author's doc comment when present, else the generated sentence. Writes always end with the handshake. */
const descriptionOf = (shape: FunctionShape, write: boolean): string => {
    const base = shape.description ?? GENERATED_DESCRIPTION_BY_KIND[shape.kind](shape.path);

    return write ? `${base} ${HANDSHAKE}` : base;
};

const invalidSpec = (): LunoraError =>
    new LunoraError("BAD_REQUEST", "openRpcSpec must be the OpenRPC document codegen emits (the `openRpcSpec` export of `_generated/openrpc`)");

/**
 * The MCP tool name for a function path. Anything outside the allowed set becomes
 * `_`, so `billing/invoices:create` reads as `billing_invoices_create`.
 */
const toolNameOf = (path: string): string => path.replaceAll(UNSAFE_NAME_CHARACTERS, "_");

/**
 * Whether a schema node, or any node beneath it, is `writeOnly`. A `v.sensitive`
 * value can sit inside an object, array, record or union argument, and codegen
 * marks only the sensitive node itself.
 */
const hasWriteOnly = (node: unknown): boolean => {
    if (Array.isArray(node)) {
        return node.some((child: unknown) => hasWriteOnly(child));
    }

    return isSchema(node) && (node["writeOnly"] === true || Object.values(node).some((child: unknown) => hasWriteOnly(child)));
};

/**
 * Top-level argument names that hold a sensitive value anywhere inside them. A
 * write proposal masks the whole argument, so a secret nested in an object is
 * not shown to the model or the human reviewing the proposal.
 */
const sensitiveArgumentNames = (argsSchema: Schema): ReadonlyArray<string> => {
    const { properties } = argsSchema;

    if (!isSchema(properties)) {
        return [];
    }

    return Object.entries(properties)
        .filter(([, property]) => hasWriteOnly(property))
        .map(([name]) => name);
};

/**
 * The output shape declared with `.output()`. Without it codegen emits a
 * description-only placeholder (no `type`, no keywords), which must not become
 * an `outputSchema`: a schema claiming "any JSON" would be checked against
 * results it does not describe.
 */
const outputShapeOf = (result: unknown): FunctionShape["output"] => {
    const schema = isSchema(result) && isSchema(result["schema"]) ? result["schema"] : undefined;

    if (schema === undefined || Object.keys(schema).every((keyword) => keyword === "description")) {
        return { mode: "none" };
    }

    if (schema["type"] === "object") {
        // The check above proves `type` is `object`, which MCP requires of an outputSchema root. The spread states that to the type checker.
        return { mode: "object", schema: { ...schema, type: "object" } };
    }

    // `result` is not required: a handler whose output is optional returns `undefined`, which
    // serializes to no `result` key. The document does not say whether the output can be absent.
    return { mode: "wrapped", schema: { properties: { result: schema }, type: "object" } };
};

/** The function's `args` parameter. An absent one means the function declares no arguments. */
const argsOf = (method: Schema): { argsSchema: Schema } => {
    const { params } = method;
    const argsParameter: unknown = Array.isArray(params) ? params.find((parameter: unknown) => isSchema(parameter) && parameter["name"] === "args") : undefined;
    const schema: unknown = isSchema(argsParameter) ? argsParameter["schema"] : undefined;

    return { argsSchema: isSchema(schema) ? schema : { properties: {}, type: "object" } };
};

/**
 * One method as a {@link FunctionShape}, or `undefined` for a kind the RPC surface
 * does not invoke. A malformed method throws: the document is codegen output, so a
 * bad entry means a broken integration, not a call to recover from.
 */
const shapeOf = (method: unknown): FunctionShape | undefined => {
    if (!isSchema(method)) {
        throw invalidSpec();
    }

    const { name: path } = method;

    if (typeof path !== "string") {
        throw invalidSpec();
    }

    const kind = method["x-lunora-function-kind"];

    if (!isKind(kind)) {
        return undefined;
    }

    const description = method["x-lunora-description"];

    return {
        ...argsOf(method),
        ...(typeof description === "string" ? { description } : {}),
        kind,
        // A stream has no single result, so no output shape is declared for it, even if the document carries one.
        output: kind === "stream" ? { mode: "none" } : outputShapeOf(method["result"]),
        path,
    };
};

/**
 * Claim the tool name for a path. Throws when the name is too long or already
 * taken, and checks both before the write gate runs, so the names a server
 * advertises never depend on `allowWrites`.
 */
const claimName = (path: string, claimed: Map<string, string>): string => {
    const name = toolNameOf(path);

    if (name.length > TOOL_NAME_MAX_LENGTH) {
        throw new LunoraError(
            "BAD_REQUEST",
            `the MCP tool name for "${path}" is ${name.length.toString()} characters; the limit is ${TOOL_NAME_MAX_LENGTH.toString()}. Rename the function.`,
        );
    }

    const owner = claimed.get(name);

    if (owner !== undefined) {
        throw new LunoraError("BAD_REQUEST", `"${path}" and "${owner}" both map to the MCP tool name "${name}". Rename one of them.`);
    }

    claimed.set(name, path);

    return name;
};

/**
 * Whether the `args` bag must be sent. The document marks it required whenever the
 * function declares any argument, but dispatch accepts an omitted bag as `{}`, so the
 * bag is required only when the argument object itself names a required field.
 */
const argsBagRequired = (shape: FunctionShape): boolean => {
    const { required }: { required?: unknown } = shape.argsSchema;

    return Array.isArray(required) && required.length > 0;
};

const inputSchemaOf = (shape: FunctionShape, write: boolean): ToolInputSchema => {
    return {
        properties: {
            args: shape.argsSchema,
            shardKey: SHARD_KEY_PROPERTY,
            ...(write ? WRITE_CONFIRMATION_PROPERTIES : {}),
        },
        required: argsBagRequired(shape) ? ["args"] : [],
        type: "object",
    };
};

/**
 * The `{}` an optional object output sends when its handler returned `undefined`. The
 * document does not say whether an output can be absent, so every object output admits it.
 */
const EMPTY_RESULT_SHAPE: ToolOutputSchema = { additionalProperties: false, properties: {}, type: "object" };

/**
 * The `outputSchema` of a query with a declared output. The error shape is always admitted.
 * An object output also admits `{}` (see {@link EMPTY_RESULT_SHAPE}). A wrapped output needs
 * no extra branch, because its `result` is not required.
 */
const outputSchemaOf = (output: FunctionShape["output"]): ToolOutputSchema | undefined => {
    if (output.mode === "none") {
        return undefined;
    }

    const schema = withErrorShape(output.schema);

    return output.mode === "object" ? { ...schema, anyOf: [...(schema.anyOf ?? []), EMPTY_RESULT_SHAPE] } : schema;
};

const toolDefinitionOf = (name: string, shape: FunctionShape): ToolDefinition => {
    const write = isWrite(shape.kind);
    const title = `${shape.kind} ${shape.path}`;
    // A write's first call returns a proposal, which is not the function's output shape, so
    // a write carries no outputSchema, as the generic write tools do.
    const outputSchema = write ? undefined : outputSchemaOf(shape.output);

    return {
        annotations: write ? { ...WRITE_ANNOTATIONS, title } : { ...READ_ONLY_ANNOTATIONS, title },
        description: descriptionOf(shape, write),
        inputSchema: inputSchemaOf(shape, write),
        name,
        ...(outputSchema === undefined ? {} : { outputSchema }),
    };
};

const routeOf = (shape: FunctionShape): FunctionRoute => {
    return {
        argsSchema: shape.argsSchema,
        kind: shape.kind,
        outputMode: shape.output.mode,
        path: shape.path,
        sensitiveArgs: sensitiveArgumentNames(shape.argsSchema),
    };
};

/**
 * Build the per-function tools from an OpenRPC document. `allowWrites` decides
 * which mutation and action tools are advertised. A closed write keeps its route,
 * so a direct call is refused with `FORBIDDEN` rather than reported as unknown.
 *
 * Throws at construction for a malformed document, for a name over the tool-name
 * limit, and for two functions that sanitise to the same name. Those are the
 * developer's to fix, and an error at startup beats a silent overwrite at call time.
 */
const functionToolsFromOpenRpc = (spec: unknown, options: { allowWrites: boolean }): FunctionTools => {
    const methods: unknown = isSchema(spec) ? spec["methods"] : undefined;

    if (!Array.isArray(methods)) {
        throw invalidSpec();
    }

    const definitions: ToolDefinition[] = [];
    const routes = new Map<string, FunctionRoute>();
    const claimed = new Map<string, string>();

    for (const method of methods) {
        const shape = shapeOf(method);

        if (shape === undefined) {
            continue;
        }

        const name = claimName(shape.path, claimed);

        routes.set(name, routeOf(shape));

        if (!isWrite(shape.kind) || options.allowWrites) {
            definitions.push(toolDefinitionOf(name, shape));
        }
    }

    return { definitions, routes };
};

export type { FunctionKind, FunctionRoute, FunctionTools };
export { functionToolsFromOpenRpc, isWrite, toolNameOf };
