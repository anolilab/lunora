import type { JsonSchema } from "@lunora/values";

import type { RestCachePolicy, RestFunctionKind } from "../../../shared/rest-surface";
import { cacheControlValue, cacheVaryValue, restMethodForKind, restPathForFunction } from "../../../shared/rest-surface";
import { GENERATED_HEADER } from "./emit";
import type { ExposeCacheIR, FunctionIR, HttpRouteIR, ValidatorIR } from "./ir";
import sanitizeNamespace from "./paths";
import { argsObjectSchema, LUNORA_ERROR_CODES, objectSchema, validatorIrToJsonSchema } from "./schema-ir";

// ─── OpenAPI document assembly ───────────────────────────────────────────────

/** The reusable error-response component every operation references via `$ref`. */
const ERROR_COMPONENT_REF = "#/components/responses/LunoraError";

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
        operation["x-lunora-stream"] = "text/event-stream";
    }

    return operation;
};

/**
 * Build the single RPC operation for one query/mutation/action. Every RPC call
 * is `POST /_lunora/rpc`; to list each function individually in Swagger UI (oRPC
 * pattern: one operation per procedure) we synthesise a distinct path suffix
 * `/_lunora/rpc#<functionPath>` — the `#`-fragment is ignored by the transport
 * (all still POST to `/_lunora/rpc`) but gives each operation a unique path key
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
        description: `Invoke the \`${definition.kind}\` \`${functionPath}\` over the Lunora RPC envelope (POST /_lunora/rpc).`,
        operationId: functionPath,
        requestBody: {
            content: { "application/json": { schema: requestSchema } },
            required: true,
        },
        responses: {
            "200": {
                content: {
                    "application/json": {
                        schema: { description: "RPC result. The shape is TS-inferred from the function's return type; best-effort — any JSON." },
                    },
                },
                description: "Successful RPC result (TypeScript-inferred return shape, documented best-effort).",
            },
            default: { $ref: ERROR_COMPONENT_REF },
        },
        summary: `${definition.kind}: ${functionPath}`,
        tags: [tag],
        "x-lunora-function-kind": definition.kind,
    };

    return { operation, pathKey: `/_lunora/rpc#${functionPath}` };
};

/**
 * Describe the cache headers a `.expose({ cache })` endpoint answers with, as an
 * OpenAPI `headers` block for the 200 response. Returns `{}` when the endpoint
 * declares no caching, so it spreads away to nothing.
 *
 * The documented `Cache-Control` states the DECLARED scope but spells out the
 * runtime's downgrade rule, because a caller reading the spec needs to know that
 * a credentialed request is answered `private` regardless (see
 * `@lunora/runtime`'s `rest-cache`).
 */
const cacheResponseHeaders = (cache: ExposeCacheIR | undefined, method: "get" | "post"): { headers?: Record<string, unknown> } => {
    // Three reasons to document nothing, all of them "the runtime won't do this":
    // caching isn't declared; the operation isn't a GET (a mutation/action is
    // POST-only and `rest-cache` refuses to cache it); or the declaration used
    // computed values discovery couldn't read, so any example emitted here would
    // be invented. The spec under-documenting beats the spec contradicting the
    // runtime — that fidelity is the whole point of deriving it from the source.
    if (cache === undefined || method !== "get" || cache.scope === undefined || cache.maxAge === undefined) {
        return {};
    }

    // Same two functions the runtime uses to WRITE these headers, so the example
    // and the served value cannot disagree — including on clamping.
    const policy: RestCachePolicy = {
        maxAge: cache.maxAge,
        scope: cache.scope,
        ...(cache.staleWhileRevalidate === undefined ? {} : { staleWhileRevalidate: cache.staleWhileRevalidate }),
        ...(cache.tag === undefined ? {} : { tag: cache.tag }),
        ...(cache.vary === undefined ? {} : { vary: cache.vary }),
    };

    const headers: Record<string, unknown> = {
        "Cache-Control": {
            description:
                policy.scope === "public"
                    ? "Caching policy. `public` applies only to an uncredentialed request — a request carrying `Authorization` or `Cookie` is always answered `private`."
                    : "Caching policy. Restricted to the caller's own cache; never stored by a shared/edge cache.",
            schema: { example: cacheControlValue(policy, policy.scope), type: "string" },
        },
    };

    if (policy.tag !== undefined) {
        headers["Cache-Tag"] = {
            description: "Purge tag for `ctx.cache.purge({ tags: [...] })`.",
            schema: { example: policy.tag, type: "string" },
        };
    }

    const vary = cacheVaryValue(policy);

    if (vary !== undefined) {
        headers.Vary = {
            description: "Request headers this response varies by. The endpoint's own negotiated headers are merged in at runtime.",
            schema: { example: vary, type: "string" },
        };
    }

    return { headers };
};

/**
 * Build the OpenAPI operation for one `.expose({ rest: true })` procedure (plan
 * 167). Unlike the synthetic RPC operations, these are REAL REST endpoints on
 * `/_lunora/rest/<namespace>/<fn>` — the exact path + method the runtime router
 * mints (both derive from the shared `restPathForFunction` contract, so the spec
 * cannot drift from the live surface). A `query` maps to `GET` with its args as
 * query parameters; a `mutation`/`action` maps to `POST` with a JSON request body.
 */
const restOperation = (definition: FunctionIR): { method: "get" | "post"; operation: Record<string, unknown>; path: string } | undefined => {
    const functionPath = `${sanitizeNamespace(definition.filePath)}:${definition.exportName}`;
    const path = restPathForFunction(functionPath);

    if (path === undefined) {
        return undefined;
    }

    const tag = sanitizeNamespace(definition.filePath);
    // Single-source the transport method from the shared REST-surface contract (the
    // same mapping the runtime router derives), so the spec cannot drift on method.
    // `stream` is already filtered upstream, so the narrowing cast is safe here.
    const method = restMethodForKind(definition.kind as RestFunctionKind);
    const isQuery = method === "GET";

    const operation: Record<string, unknown> = {
        description: `Public REST endpoint for the \`${definition.kind}\` \`${functionPath}\` (opt-in via \`.expose({ rest: true })\`). Routed through the procedure, so auth / RLS / validators are enforced.`,
        operationId: `rest_${sanitizeNamespace(path)}`,
        responses: {
            "200": {
                content: {
                    "application/json": {
                        schema: { description: "Procedure result. The shape is TS-inferred from the return type; best-effort — any JSON." },
                    },
                },
                description: "Successful result (TypeScript-inferred return shape, documented best-effort).",
                ...cacheResponseHeaders(definition.expose?.cache, isQuery ? "get" : "post"),
            },
            default: { $ref: ERROR_COMPONENT_REF },
        },
        summary: `${method} ${path}`,
        tags: [tag],
        "x-lunora-function-kind": definition.kind,
    };

    if (isQuery) {
        // A query's args ride the query string; each becomes an optional query parameter.
        const parameters = Object.entries(definition.args).map(([name, validator]) => {
            const inner = validator.kind === "optional" ? (validator.inner ?? validator) : validator;

            return {
                description: `Argument \`${name}\` (JSON-encoded for non-string values).`,
                in: "query" as const,
                name,
                required: validator.kind !== "optional",
                schema: validatorIrToJsonSchema(inner),
            };
        });

        if (parameters.length > 0) {
            operation.parameters = parameters;
        }

        return { method: "get", operation, path };
    }

    operation.requestBody = {
        content: { "application/json": { schema: argsObjectSchema(definition.args) } },
        required: Object.keys(definition.args).length > 0,
    };

    return { method: "post", operation, path };
};

/** Inputs the OpenAPI emitter needs from a codegen run. */
interface OpenApiEmitInput {
    functions: ReadonlyArray<FunctionIR>;
    httpRoutes: ReadonlyArray<HttpRouteIR>;
    /** `info.version`; defaults to `"0.0.0"` with a TODO when the project version is unknown. */
    version?: string;
}

/**
 * Emit an OpenAPI 3.1.0 document covering both Lunora function surfaces.
 *
 * `httpRouter()` typed REST routes become real `paths` keyed by their method +
 * URL, with query/path parameters and JSON request bodies derived from their
 * `v.*` validators, and a response schema from `.output()` when declared.
 *
 * RPC `query`/`mutation`/`action` functions become one operation each on
 * `POST /_lunora/rpc` (disambiguated by a `#functionPath` path fragment), with a
 * requestBody pinning `functionPath` + typed `args`. `internal`/`stream`
 * functions are excluded (unreachable / not invocable on the external RPC path).
 *
 * Operations are grouped into `tags` by file namespace, and every operation
 * references a reusable `LunoraError` error-response component enumerating the
 * standard error codes. Borrows oRPC's per-procedure-operation + tag-grouping +
 * internal-filtering structure; the JSON Schema dialect matches `@lunora/values`
 * (Draft 2020-12). Returns the document as a plain object (the single source of
 * truth `emitOpenApi` stringifies and `emitOpenApiModule` inlines, so the
 * `.json` and `.ts` artifacts can never drift).
 */
const buildOpenApiDocument = (input: OpenApiEmitInput): Record<string, unknown> => {
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

    // RPC functions: one POST operation each on a synthetic `/_lunora/rpc#<path>`.
    // `internal` (off the external RPC path) and `stream` (not invocable via the
    // RPC envelope) are excluded — the oRPC `filter` idiom.
    const rpcFunctions = input.functions.filter((definition) => definition.visibility !== "internal" && definition.kind !== "stream");

    for (const definition of rpcFunctions) {
        const { operation, pathKey } = rpcOperation(definition);

        paths[pathKey] = { post: operation };
        tagNames.add(sanitizeNamespace(definition.filePath));
    }

    // Opt-in public REST surface (plan 167): a REAL REST path per
    // `.expose({ rest: true })` procedure, describing exactly the live surface the
    // runtime router serves. `internal`/`stream` are already excluded above.
    for (const definition of rpcFunctions) {
        if (definition.expose?.rest !== true) {
            continue;
        }

        const rest = restOperation(definition);

        if (rest === undefined) {
            continue;
        }

        const pathItem = paths[rest.path] ?? {};

        pathItem[rest.method] = rest.operation;
        paths[rest.path] = pathItem;
        tagNames.add(sanitizeNamespace(definition.filePath));
    }

    const tags = [...tagNames]
        .toSorted((a, b) => a.localeCompare(b))
        .map((name) => {
            return { description: `Operations declared in \`lunora/${name}\`.`, name };
        });

    const document = {
        components: {
            responses: {
                LunoraError: {
                    content: {
                        "application/json": {
                            schema: {
                                additionalProperties: false,
                                description: "Standard Lunora error envelope.",
                                properties: {
                                    error: {
                                        additionalProperties: false,
                                        properties: {
                                            code: {
                                                description: "Machine-readable error code. Clients switch on this value.",
                                                enum: LUNORA_ERROR_CODES,
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
                    description:
                        "A Lunora error response. The HTTP status reflects the error code (e.g. BAD_REQUEST→400, UNAUTHORIZED→401, FORBIDDEN→403, NOT_FOUND→404).",
                },
            },
        },
        info: {
            description: "Auto-generated from @lunora/values-typed functions by @lunora/codegen. Do not edit — run `lunora codegen` to regenerate.",
            title: "Lunora API",
            version,
        },
        openapi: "3.1.0",
        paths,
        tags,
    };

    return document;
};

/**
 * Emit the OpenAPI 3.1 document as a pretty-printed JSON string
 * (`_generated/openapi.json`) — the portable artifact for external tooling.
 */
const emitOpenApi = (input: OpenApiEmitInput): string => `${JSON.stringify(buildOpenApiDocument(input), undefined, 2)}\n`;

/**
 * Emit the OpenAPI document as an importable TS module
 * (`_generated/openapi.ts`) the worker entry imports and passes to
 * `createWorker({ openApiSpec })`. The document object literal is inlined
 * verbatim (same `JSON.stringify` form the `.json` uses), so the `.ts` and
 * `.json` are byte-identical content and regenerate together — closing the gap
 * where a Worker cannot read the JSON file at runtime. `document_` is the object
 * returned by {@link buildOpenApiDocument} (reused, never recomputed).
 */
const emitOpenApiModule = (document_: Record<string, unknown>): string =>
    `${GENERATED_HEADER}export const openApiSpec: Record<string, unknown> = ${JSON.stringify(document_, undefined, 4)};\n`;

export { buildOpenApiDocument, emitOpenApi, emitOpenApiModule };
export type { OpenApiEmitInput };
