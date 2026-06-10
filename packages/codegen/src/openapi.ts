import type { JsonSchema } from "@cirrus/values";

import type { FunctionIR, HttpRouteIR, ValidatorIR } from "./ir";
import sanitizeNamespace from "./paths";

/**
 * Convert a codegen {@link ValidatorIR} (parsed from the schema/handler AST) into
 * a JSON Schema node, mirroring `@cirrus/values`' `toJsonSchema` faithfully so
 * the dialect (Draft 2020-12 / OpenAPI 3.1) stays identical across the two entry
 * points. We re-implement over `ValidatorIR` rather than reuse `toJsonSchema`
 * directly because codegen only ever holds the reflected IR — it never
 * instantiates the runtime `v.*` validator objects that `toJsonSchema` consumes.
 *
 * The kind→schema mapping (date/timestamp → epoch-ms integer, bigint → int64,
 * bytes → base64 string, id → annotated string with `x-cirrus-table`, literal →
 * `const`, optionality via the parent `required` list, `.nullable()` widening to
 * accept null) is borrowed verbatim from `@cirrus/values/src/to-json-schema.ts`.
 */
const validatorIrToJsonSchema = (validator: ValidatorIR): JsonSchema => {
    const base = ((): JsonSchema => {
        switch (validator.kind) {
            case "any": {
                return {};
            }
            case "array": {
                return { items: validator.inner ? validatorIrToJsonSchema(validator.inner) : {}, type: "array" };
            }
            case "bigint": {
                return { format: "int64", type: "integer" };
            }
            case "boolean": {
                return { type: "boolean" };
            }
            case "bytes": {
                return { contentEncoding: "base64", description: "binary (ArrayBuffer)", type: "string" };
            }
            case "date": {
                return { description: "epoch milliseconds (date)", type: "integer" };
            }
            case "id": {
                return { description: `Id<"${String(validator.tableName)}">`, type: "string", "x-cirrus-table": validator.tableName };
            }
            case "literal": {
                // eslint-disable-next-line @typescript-eslint/no-use-before-define -- literalConst is a sibling helper defined just below
                return literalConst(validator.literalValue);
            }
            case "null": {
                return { type: "null" };
            }
            case "number": {
                return { type: "number" };
            }
            case "object": {
                // eslint-disable-next-line @typescript-eslint/no-use-before-define -- objectSchema is mutually recursive with this function
                return objectSchema(validator.shape ?? {});
            }
            case "optional": {
                return validator.inner ? validatorIrToJsonSchema(validator.inner) : {};
            }
            case "record": {
                return { additionalProperties: validator.valueType ? validatorIrToJsonSchema(validator.valueType) : {}, type: "object" };
            }
            case "string": {
                return { type: "string" };
            }
            case "timestamp": {
                return { description: "epoch milliseconds (timestamp)", type: "integer" };
            }
            case "union": {
                return { anyOf: (validator.members ?? []).map((member) => validatorIrToJsonSchema(member)) };
            }
            default: {
                return {};
            }
        }
    })();

    // `.nullable()` is the only modifier that flips `column.notNull` to false;
    // widen the schema to accept null (mirrors `@cirrus/values`).
    if (validator.column?.notNull === false) {
        return { anyOf: [base, { type: "null" }] };
    }

    return base;
};

/**
 * Render a `v.literal(...)` value as a JSON Schema `const`. The IR carries the
 * literal as verbatim source text (`"admin"`, `42`, `true`, `null`), so parse it
 * back to a JSON value; a bigint-style literal is carried as its decimal string.
 */
const literalConst = (literalValue: string | undefined): JsonSchema => {
    if (literalValue === undefined) {
        return {};
    }

    const trimmed = literalValue.trim();

    if (trimmed === "true") {
        return { const: true };
    }

    if (trimmed === "false") {
        return { const: false };
    }

    if (trimmed === "null") {
        // eslint-disable-next-line unicorn/no-null -- a `v.literal(null)` must serialize to a JSON Schema `const: null`
        return { const: null, type: "null" };
    }

    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
        return { const: trimmed.slice(1, -1), type: "string" };
    }

    const asNumber = Number(trimmed);

    if (!Number.isNaN(asNumber)) {
        return { const: asNumber };
    }

    return { const: trimmed };
};

/** Build `{ type: "object", properties, required }` from an IR shape (mirrors `@cirrus/values`' `objectSchema`). */
const objectSchema = (shape: Record<string, ValidatorIR>): JsonSchema => {
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];

    for (const [key, child] of Object.entries(shape)) {
        properties[key] = validatorIrToJsonSchema(child);

        // A `v.optional(...)` field is the only thing that drops out of `required`.
        if (child.kind !== "optional") {
            required.push(key);
        }
    }

    return { additionalProperties: false, properties, required, type: "object" };
};

/** Build the args object schema for an RPC function (mirrors `argsToJsonSchema`). */
const argsObjectSchema = (args: Record<string, ValidatorIR>): JsonSchema => objectSchema(args);

// ─── OpenAPI document assembly ───────────────────────────────────────────────

/** The reusable error-response component every operation references via `$ref`. */
const ERROR_COMPONENT_REF = "#/components/responses/CirrusError";

/**
 * The machine-readable `CirrusError` codes Cirrus emits on the RPC + REST
 * surfaces, enumerated from `@cirrus/server`'s `CODE_STATUS` map plus the
 * runtime/DO dispatch codes (`FUNCTION_NOT_FOUND`, `PAYLOAD_TOO_LARGE`,
 * `METHOD_NOT_ALLOWED`, the `*_NOT_CONFIGURED` admin gates, …). The list documents
 * the contract; clients switch on `error.code`. Kept sorted for stable output.
 */
const CIRRUS_ERROR_CODES: ReadonlyArray<string> = [
    "BAD_REQUEST",
    "CONFLICT",
    "COUNT_RLS_UNSUPPORTED",
    "FORBIDDEN",
    "FUNCTION_NOT_FOUND",
    "INTERNAL",
    "INTERNAL_SERVER_ERROR",
    "METHOD_NOT_ALLOWED",
    "NOT_FOUND",
    "NOT_IMPLEMENTED",
    "PAYLOAD_TOO_LARGE",
    "TOO_MANY_REQUESTS",
    "UNAUTHORIZED",
    "UNPROCESSABLE",
    "VALIDATION_ERROR",
];

/** Path params named in a route template (`/users/:id` → `["id"]`), in declaration order. */
const ROUTE_PARAM_RE = /:([A-Za-z_$][\w$]*)/gu;

const pathParameterNames = (path: string): string[] => [...path.matchAll(ROUTE_PARAM_RE)].map((match) => match[1] as string);

/**
 * Convert a hono-style `:param` route path to the OpenAPI `{param}` template
 * form. Hono and OpenAPI agree on segment structure; only the placeholder
 * syntax differs.
 */
const toOpenApiPath = (path: string): string => path.replaceAll(ROUTE_PARAM_RE, "{$1}");

/** An OpenAPI parameter object built from one declared validator. */
interface OpenApiParameter {
    description?: string;
    in: "path" | "query";
    name: string;
    required: boolean;
    schema: JsonSchema;
}

/** Build the `parameters` array (query + path) for an HTTP route. */
const buildParameters = (route: HttpRouteIR): OpenApiParameter[] => {
    const declaredPathNames = new Set(pathParameterNames(route.path));
    const parameters: OpenApiParameter[] = [];

    for (const [name, validator] of Object.entries(route.searchParams)) {
        const inner = validator.kind === "optional" ? (validator.inner ?? validator) : validator;

        parameters.push({
            description: `Query parameter \`${name}\``,
            in: "query",
            name,
            required: validator.kind !== "optional",
            schema: validatorIrToJsonSchema(inner),
        });
    }

    for (const [name, validator] of Object.entries(route.params)) {
        const inner = validator.kind === "optional" ? (validator.inner ?? validator) : validator;

        parameters.push({
            description: `Path parameter \`${name}\``,
            // A path param the template doesn't name is still surfaced (OpenAPI
            // requires path params to be `required: true`), but flagged so the
            // mismatch is visible rather than silently dropped.
            in: declaredPathNames.has(name) ? "path" : "query",
            name,
            required: declaredPathNames.has(name) ? true : validator.kind !== "optional",
            schema: validatorIrToJsonSchema(inner),
        });
    }

    return parameters;
};

/** The 200 response object for an operation — uses `.output()` when present, else a permissive schema with a note. */
const successResponse = (output: ValidatorIR | undefined): Record<string, unknown> => {
    if (output) {
        return {
            content: { "application/json": { schema: validatorIrToJsonSchema(output) } },
            description: "Successful response.",
        };
    }

    return {
        content: { "application/json": { schema: { description: "Return shape is TS-inferred (no `.output()` declared); best-effort — any JSON." } } },
        description: "Successful response. The return shape is TypeScript-inferred and not declared via `.output()`, so it is documented best-effort.",
    };
};

/** Build one OpenAPI operation for a discovered HTTP route. */
const httpRouteOperation = (route: HttpRouteIR): Record<string, unknown> => {
    const tag = sanitizeNamespace(route.filePath);
    const parameters = buildParameters(route);

    const operation: Record<string, unknown> = {
        description: `${route.stream ? "Streaming (SSE) " : ""}HTTP route handler \`${route.exportName}\` (${route.method} ${route.path}).`,
        operationId: `${route.method.toLowerCase()}_${sanitizeNamespace(route.path)}`,
        responses: {
            "200": successResponse(route.output),
            "204": { description: "No content (handler returned `undefined`)." },
            default: { $ref: ERROR_COMPONENT_REF },
        },
        summary: `${route.method} ${route.path}`,
        tags: [tag],
    };

    if (parameters.length > 0) {
        operation.parameters = parameters;
    }

    if (Object.keys(route.body).length > 0) {
        operation.requestBody = {
            content: { "application/json": { schema: objectSchema(route.body) } },
            required: true,
        };
    }

    if (route.stream) {
        // Document the SSE content type alongside the JSON success schema.
        operation["x-cirrus-stream"] = "text/event-stream";
    }

    return operation;
};

/**
 * Build the single RPC operation for one query/mutation/action. Every RPC call
 * is `POST /_cirrus/rpc`; to list each function individually in Swagger UI (oRPC
 * pattern: one operation per procedure) we synthesise a distinct path suffix
 * `/_cirrus/rpc#&lt;functionPath>` — the `#`-fragment is ignored by the transport
 * (all still POST to `/_cirrus/rpc`) but gives each operation a unique path key
 * so they render as separate entries. The requestBody pins `functionPath` to a
 * `const`, types `args` from the function's validators, and allows an optional
 * `shardKey`.
 */
const rpcOperation = (definition: FunctionIR): { operation: Record<string, unknown>; pathKey: string } => {
    const functionPath = `${sanitizeNamespace(definition.filePath)}:${definition.exportName}`;
    const tag = sanitizeNamespace(definition.filePath);

    const requestSchema: JsonSchema = {
        additionalProperties: false,
        properties: {
            args: argsObjectSchema(definition.args),
            functionPath: { const: functionPath, type: "string" },
            shardKey: { description: "Optional shard key; omitted routes to the default shard.", type: "string" },
        },
        required: ["functionPath"],
        type: "object",
    };

    const operation: Record<string, unknown> = {
        description: `Invoke the \`${definition.kind}\` \`${functionPath}\` over the Cirrus RPC envelope (POST /_cirrus/rpc).`,
        operationId: functionPath,
        requestBody: {
            content: { "application/json": { schema: requestSchema } },
            required: true,
        },
        responses: {
            "200": {
                content: { "application/json": { schema: { description: "RPC result. The shape is TS-inferred from the function's return type; best-effort — any JSON." } } },
                description: "Successful RPC result (TypeScript-inferred return shape, documented best-effort).",
            },
            default: { $ref: ERROR_COMPONENT_REF },
        },
        summary: `${definition.kind}: ${functionPath}`,
        tags: [tag],
        "x-cirrus-function-kind": definition.kind,
    };

    return { operation, pathKey: `/_cirrus/rpc#${functionPath}` };
};

/** Inputs the OpenAPI emitter needs from a codegen run. */
interface OpenApiEmitInput {
    functions: ReadonlyArray<FunctionIR>;
    httpRoutes: ReadonlyArray<HttpRouteIR>;
    /** `info.version`; defaults to `"0.0.0"` with a TODO when the project version is unknown. */
    version?: string;
}

/**
 * Emit an OpenAPI 3.1.0 document covering both Cirrus function surfaces.
 *
 * `httpRouter()` typed REST routes become real `paths` keyed by their method +
 * URL, with query/path parameters and JSON request bodies derived from their
 * `v.*` validators, and a response schema from `.output()` when declared.
 *
 * RPC `query`/`mutation`/`action` functions become one operation each on
 * `POST /_cirrus/rpc` (disambiguated by a `#functionPath` path fragment), with a
 * requestBody pinning `functionPath` + typed `args`. `internal`/`stream`
 * functions are excluded (unreachable / not invocable on the external RPC path).
 *
 * Operations are grouped into `tags` by file namespace, and every operation
 * references a reusable `CirrusError` error-response component enumerating the
 * standard error codes. Borrows oRPC's per-procedure-operation + tag-grouping +
 * internal-filtering structure; the JSON Schema dialect matches `@cirrus/values`
 * (Draft 2020-12). Returns the document as a pretty-printed JSON string.
 */
const emitOpenApi = (input: OpenApiEmitInput): string => {
    const version = input.version ?? "0.0.0";
    const paths: Record<string, Record<string, unknown>> = {};
    const tagNames = new Set<string>();

    // HTTP routes: real REST paths. Multiple verbs on one path merge into the
    // same path-item object.
    for (const route of input.httpRoutes) {
        const openApiPath = toOpenApiPath(route.path);
        const pathItem = paths[openApiPath] ?? {};

        pathItem[route.method.toLowerCase()] = httpRouteOperation(route);
        paths[openApiPath] = pathItem;
        tagNames.add(sanitizeNamespace(route.filePath));
    }

    // RPC functions: one POST operation each on a synthetic `/_cirrus/rpc#<path>`.
    // `internal` (off the external RPC path) and `stream` (not invocable via the
    // RPC envelope) are excluded — the oRPC `filter` idiom.
    const rpcFunctions = input.functions.filter((definition) => definition.visibility !== "internal" && definition.kind !== "stream");

    for (const definition of rpcFunctions) {
        const { operation, pathKey } = rpcOperation(definition);

        paths[pathKey] = { post: operation };
        tagNames.add(sanitizeNamespace(definition.filePath));
    }

    const tags = [...tagNames].toSorted((a, b) => a.localeCompare(b)).map((name) => {return { description: `Operations declared in \`cirrus/${name}\`.`, name }});

    const document = {
        components: {
            responses: {
                CirrusError: {
                    content: {
                        "application/json": {
                            schema: {
                                additionalProperties: false,
                                description: "Standard Cirrus error envelope.",
                                properties: {
                                    error: {
                                        additionalProperties: false,
                                        properties: {
                                            code: {
                                                description: "Machine-readable error code. Clients switch on this value.",
                                                enum: CIRRUS_ERROR_CODES,
                                                type: "string",
                                            },
                                            message: { description: "Human-readable error message (never echoes internal details).", type: "string" },
                                        },
                                        required: ["code", "message"],
                                        type: "object",
                                    },
                                },
                                required: ["error"],
                                type: "object",
                            },
                        },
                    },
                    description: "A Cirrus error response. The HTTP status reflects the error code (e.g. BAD_REQUEST→400, UNAUTHORIZED→401, FORBIDDEN→403, NOT_FOUND→404).",
                },
            },
        },
        info: {
            description: "Auto-generated from @cirrus/values-typed functions by @cirrus/codegen. Do not edit — run `cirrus codegen` to regenerate.",
            title: "Cirrus API",
            // TODO: thread the project/app package version through here when available.
            version,
        },
        openapi: "3.1.0",
        paths,
        tags,
    };

    return `${JSON.stringify(document, undefined, 2)}\n`;
};

export { CIRRUS_ERROR_CODES, emitOpenApi, validatorIrToJsonSchema };
export type { OpenApiEmitInput };
