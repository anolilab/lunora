import type { Infer, Validator, ValidatorKind } from "@cirrus/values";
import { ValidationError } from "@cirrus/values";

import type { EmptyArgs } from "./builder/index.js";
import { CirrusError } from "./error.js";
import type { ActionCtx, ArgsValidator, InferArgs } from "./types.js";

/** HTTP verbs an {@link HttpRouter} route can bind to. */
export type HttpMethod = "DELETE" | "GET" | "HEAD" | "OPTIONS" | "PATCH" | "POST" | "PUT";

/**
 * Context handed to an HTTP action handler. A narrower view of {@link ActionCtx}:
 * HTTP actions run in the worker (the "action runtime"), separate from the
 * transactional store, so there is no direct `db` / `vectors` / `scheduler` /
 * `storage` surface — reach the data layer through `runQuery` / `runMutation` /
 * `runAction`, which forward to the owning shard.
 */
export type HttpActionCtx = Pick<ActionCtx, "auth" | "fetch" | "runAction" | "runMutation" | "runQuery">;

/** A handler bound to a route via {@link httpRouter}. Receives the raw request, returns the raw response. */
export type HttpActionHandler = (ctx: HttpActionCtx, request: Request) => Promise<Response> | Response;

/**
 * The value {@link httpAction} produces. Marked with `isHttpAction` so the
 * router (and tooling) can tell it apart from a plain function.
 */
export interface RegisteredHttpAction {
    readonly handler: HttpActionHandler;
    readonly isHttpAction: true;
}

/** Wrap a `(ctx, request) => Response` handler so it can be mounted on an {@link httpRouter}. */
export const httpAction = (handler: HttpActionHandler): RegisteredHttpAction => ({ handler, isHttpAction: true });

/** Bind a handler to an exact pathname. */
export interface ExactRouteSpec {
    handler: RegisteredHttpAction;
    method: HttpMethod;
    path: string;
}

/** Bind a handler to every pathname under `pathPrefix` (which must end in `/`). */
export interface PrefixRouteSpec {
    handler: RegisteredHttpAction;
    method: HttpMethod;
    pathPrefix: string;
}

export type RouteSpec = ExactRouteSpec | PrefixRouteSpec;

/** A normalised route entry, as returned by {@link HttpRouter.getRoutes}. */
export interface RouteEntry {
    handler: RegisteredHttpAction;
    method: HttpMethod;
    /** The exact pathname, or — for prefix routes — the prefix ending in `/`. */
    path: string;
    prefix: boolean;
}

/**
 * Result of {@link HttpRouter.lookup}. Distinguishes "no path matched" (→ 404)
 * from "path matched but not this method" (→ 405 with an `Allow` list) so the
 * worker can respond with the correct status.
 */
export type RouteLookup = { action: RegisteredHttpAction; kind: "match" } | { allow: HttpMethod[]; kind: "method_not_allowed" } | { kind: "not_found" };

export interface HttpRouter {
    /** All registered routes, in declaration order. */
    getRoutes: () => readonly RouteEntry[];
    /** Marker so the worker and tooling can recognise a router instance. */
    readonly isRouter: true;
    /** Resolve a request to a handler, a 405, or a 404. Exact paths beat prefixes; longest prefix wins. */
    lookup: (pathname: string, method: string) => RouteLookup;
    /** Register a route. Throws on a malformed path or a duplicate (method, path). */
    route: (spec: RouteSpec) => void;
}

const isPrefixSpec = (spec: RouteSpec): spec is PrefixRouteSpec => "pathPrefix" in spec;

/**
 * Create a router for HTTP actions. Mirrors Convex's `httpRouter()`:
 *
 * ```ts
 * const http = httpRouter();
 * http.route({ path: "/webhook", method: "POST", handler: onWebhook });
 * http.route({ pathPrefix: "/img/", method: "GET", handler: serveImage });
 * export default http;
 * ```
 *
 * Pass the router to `createWorker({ httpRouter })` so inbound requests that
 * don't hit the RPC/WebSocket endpoints are dispatched to these handlers.
 */
export const httpRouter = (): HttpRouter => {
    const routes: RouteEntry[] = [];

    const route = (spec: RouteSpec): void => {
        const prefix = isPrefixSpec(spec);
        const path = prefix ? spec.pathPrefix : spec.path;

        if (!path.startsWith("/")) {
            throw new Error(`httpRouter: ${prefix ? "pathPrefix" : "path"} must start with "/" (got ${JSON.stringify(path)})`);
        }

        if (prefix && !path.endsWith("/")) {
            throw new Error(`httpRouter: pathPrefix must end with "/" (got ${JSON.stringify(path)})`);
        }

        const duplicate = routes.some((entry) => entry.prefix === prefix && entry.path === path && entry.method === spec.method);

        if (duplicate) {
            throw new Error(`httpRouter: duplicate route for ${spec.method} ${path}`);
        }

        routes.push({ handler: spec.handler, method: spec.method, path, prefix });
    };

    const lookup = (pathname: string, method: string): RouteLookup => {
        // Gather every entry whose path/prefix matches, ignoring the method, so
        // we can tell a true 404 (no path) from a 405 (path, wrong method).
        const pathMatches = routes.filter((entry) => entry.prefix ? pathname.startsWith(entry.path) : entry.path === pathname);

        if (pathMatches.length === 0) {
            return { kind: "not_found" };
        }

        // Exact routes win over prefixes; among prefixes the longest one wins.
        const ranked = [...pathMatches].sort((a, b) => {
            if (a.prefix !== b.prefix) {
                return a.prefix ? 1 : -1;
            }

            return b.path.length - a.path.length;
        });

        const hit = ranked.find((entry) => entry.method === method);

        if (hit) {
            return { action: hit.handler, kind: "match" };
        }

        const allow = [...new Set(ranked.map((entry) => entry.method))];

        return { allow, kind: "method_not_allowed" };
    };

    return {
        getRoutes: () => routes,
        isRouter: true,
        lookup,
        route,
    };
};

/** The `{ ctx, searchParams, body }` a typed route handler receives. */
export interface HttpRouteHandlerOptions<SearchParams extends ArgsValidator, Body extends ArgsValidator> {
    body: InferArgs<Body>;
    ctx: HttpActionCtx;
    searchParams: InferArgs<SearchParams>;
}

/**
 * A typed REST route under construction. `.searchParams()` / `.body()` accumulate
 * validator maps (later calls merge, a colliding key wins) that decode the URL
 * query and JSON body into the handler's typed `searchParams` / `body`. Like the
 * procedure builder, `.output(validator)` defaults to the `undefined` sentinel —
 * while unset the handler is generic over its own return; once set the handler
 * must return that type and the result is parsed through the validator before
 * serialization. `[Output] extends [undefined]` is tuple-wrapped so a union
 * `Output` doesn't distribute and the test is for the exact sentinel.
 *
 * The terminal `.handler()` yields an {@link ExactRouteSpec} — mount it directly
 * via `httpRouter().route(spec)`.
 */
export interface HttpRouteBuilder<SearchParams extends ArgsValidator, Body extends ArgsValidator, Output = undefined> {
    body: <B extends ArgsValidator>(validators: B) => HttpRouteBuilder<SearchParams, B & Body, Output>;
    handler: [Output] extends [undefined]
        ? <R>(handler: (options: HttpRouteHandlerOptions<SearchParams, Body>) => Promise<R> | R) => ExactRouteSpec
        : (handler: (options: HttpRouteHandlerOptions<SearchParams, Body>) => Output | Promise<Output>) => ExactRouteSpec;
    output: <V extends Validator>(validator: V) => HttpRouteBuilder<SearchParams, Body, Infer<V>>;
    searchParams: <S extends ArgsValidator>(validators: S) => HttpRouteBuilder<S & SearchParams, Body, Output>;
}

/** Binds a method to a pathname, opening a fresh {@link HttpRouteBuilder}. */
export type HttpRouteFactory = (path: string) => HttpRouteBuilder<EmptyArgs, EmptyArgs>;

/** The verb-keyed entry point: `httpRoute.get("/api/todos")…`. */
export interface HttpRoute {
    delete: HttpRouteFactory;
    get: HttpRouteFactory;
    head: HttpRouteFactory;
    options: HttpRouteFactory;
    patch: HttpRouteFactory;
    post: HttpRouteFactory;
    put: HttpRouteFactory;
}

/** Accumulated route state threaded through the chain. */
interface RouteState {
    body: ArgsValidator;
    method: HttpMethod;
    output?: Validator;
    path: string;
    searchParams: ArgsValidator;
}

/** Internal view exposing `_meta.inner` so search-param coercion can read the wrapped validator. */
interface ValidatorWithMeta extends Validator {
    readonly _meta?: { readonly inner?: Validator };
}

/** Peel a single `v.optional()` layer so coercion keys off the underlying kind. */
const unwrapOptional = (validator: Validator): Validator =>
    validator.kind === "optional" ? (validator as ValidatorWithMeta)._meta?.inner ?? validator : validator;

/**
 * Query-string values arrive as strings, but `@cirrus/values` validators are
 * strict (no coercion). Coerce the scalar kinds back to their declared type so
 * `?limit=5` satisfies `v.number()`; a malformed value (e.g. `?limit=abc` → NaN)
 * is left for the validator to reject. Unrecognised kinds pass through as-is.
 */
const coerceScalar = (kind: ValidatorKind, raw: string): unknown => {
    switch (kind) {
        case "bigint": {
            try {
                return BigInt(raw);
            } catch {
                return raw;
            }
        }
        case "boolean": {
            if (raw === "true" || raw === "1") {
                return true;
            }

            if (raw === "false" || raw === "0") {
                return false;
            }

            return raw;
        }
        case "number": {
            return Number(raw);
        }
        default: {
            return raw;
        }
    }
};

/**
 * Decode one declared query parameter. Absent → `undefined` (so `v.optional`
 * passes and a required validator fails). An `array` validator collects every
 * repeated occurrence (`?tag=a&tag=b`), coercing each element.
 */
const coerceSearchParam = (validator: Validator, params: URLSearchParams, key: string): unknown => {
    if (!params.has(key)) {
        return undefined;
    }

    const effective = unwrapOptional(validator);

    if (effective.kind === "array") {
        const element = (effective as ValidatorWithMeta)._meta?.inner;

        return params.getAll(key).map((raw) => coerceScalar(element?.kind ?? "string", raw));
    }

    return coerceScalar(effective.kind, params.get(key) as string);
};

/**
 * Validate each declared field of `source` through its validator, prefixing any
 * `ValidationError` with `label.<key>` so the 400 response points at the bad
 * field. Optional fields absent from the source are skipped.
 */
const parseFields = (validators: ArgsValidator, source: Record<string, unknown>, label: string): Record<string, unknown> => {
    const out: Record<string, unknown> = {};

    for (const key of Object.keys(validators)) {
        const validator = validators[key];

        if (!validator) {
            continue;
        }

        const candidate = source[key];

        if (candidate === undefined && validator.kind === "optional") {
            continue;
        }

        try {
            out[key] = validator.parse(candidate);
        } catch (error: unknown) {
            if (error instanceof ValidationError) {
                throw new ValidationError(`${label}.${key}: ${error.message}`, {
                    expected: error.expected,
                    path: [key, ...error.path],
                    received: error.received,
                });
            }

            throw error;
        }
    }

    return out;
};

const parseSearchParams = (validators: ArgsValidator, params: URLSearchParams): Record<string, unknown> => {
    const raw: Record<string, unknown> = {};

    for (const key of Object.keys(validators)) {
        if (!validators[key]) {
            continue;
        }

        raw[key] = coerceSearchParam(validators[key], params, key);
    }

    return parseFields(validators, raw, "searchParams");
};

type LooseHandler = (options: { body: Record<string, unknown>; ctx: HttpActionCtx; searchParams: Record<string, unknown> }) => unknown;

/** Read + validate the JSON body. A non-JSON or non-object payload is a 400. */
const parseBody = async (validators: ArgsValidator, request: Request): Promise<Record<string, unknown>> => {
    let json: unknown;

    try {
        json = await request.json();
    } catch {
        throw new CirrusError("BAD_REQUEST", "Invalid JSON body");
    }

    if (typeof json !== "object" || json === null || Array.isArray(json)) {
        throw new CirrusError("BAD_REQUEST", "Expected a JSON object body");
    }

    return parseFields(validators, json as Record<string, unknown>, "body");
};

/**
 * Parse the handler result through `.output()`. A mismatch here is a server
 * contract bug, not a client error, so re-tag it as a 500.
 */
const applyOutput = (output: Validator, result: unknown): unknown => {
    try {
        return output.parse(result);
    } catch (error: unknown) {
        if (error instanceof ValidationError) {
            throw new CirrusError("INTERNAL_SERVER_ERROR", `Response did not match the declared output schema: ${error.message}`);
        }

        throw error;
    }
};

/** Map a thrown error to its HTTP response, re-throwing anything unrecognised. */
const errorResponse = (error: unknown): Response => {
    if (error instanceof ValidationError) {
        return Response.json({ code: "BAD_REQUEST", error: error.message }, { status: 400 });
    }

    if (error instanceof CirrusError) {
        return Response.json({ code: error.code, error: error.message }, { status: error.status });
    }

    throw error;
};

/**
 * Compile the accumulated route state into a {@link RegisteredHttpAction}.
 * Input decode failures (bad query / body) surface as 400; a result that
 * violates `.output()` surfaces as 500 (see {@link applyOutput}).
 */
const buildRouteHandler = (state: RouteState, userHandler: LooseHandler): RegisteredHttpAction =>
    httpAction(async (ctx, request) => {
        try {
            const searchParams = Object.keys(state.searchParams).length > 0 ? parseSearchParams(state.searchParams, new URL(request.url).searchParams) : {};
            const body = Object.keys(state.body).length > 0 ? await parseBody(state.body, request) : {};
            const result = await userHandler({ body, ctx, searchParams });
            const payload = state.output ? applyOutput(state.output, result) : result;

            return payload === undefined ? new Response(null, { status: 204 }) : Response.json(payload);
        } catch (error: unknown) {
            return errorResponse(error);
        }
    });

const makeRouteBuilder = (state: RouteState): Record<string, unknown> => ({
    body: (validators: ArgsValidator) => makeRouteBuilder({ ...state, body: { ...state.body, ...validators } }),
    handler: (userHandler: LooseHandler): ExactRouteSpec => ({
        handler: buildRouteHandler(state, userHandler),
        method: state.method,
        path: state.path,
    }),
    output: (validator: Validator) => makeRouteBuilder({ ...state, output: validator }),
    searchParams: (validators: ArgsValidator) => makeRouteBuilder({ ...state, searchParams: { ...state.searchParams, ...validators } }),
});

const makeRouteFactory
    = (method: HttpMethod): HttpRouteFactory =>
        (path: string) =>
            makeRouteBuilder({ body: {}, method, path, searchParams: {} }) as unknown as HttpRouteBuilder<EmptyArgs, EmptyArgs>;

/**
 * Typed REST route builder. Compiles down to the same `ExactRouteSpec` /
 * `RegisteredHttpAction` the raw {@link httpRouter} mounts, so a typed route and
 * a hand-written `httpAction` are interchangeable on the router:
 *
 * ```ts
 * export const listTodos = httpRoute
 *     .get("/api/todos")
 *     .searchParams({ limit: v.number(), q: v.optional(v.string()) })
 *     .output(v.array(v.object({ id: v.string(), text: v.string() })))
 *     .handler(async ({ ctx, searchParams }) => ctx.runQuery(api.todos.list, searchParams));
 *
 * const http = httpRouter();
 * http.route(listTodos);
 * ```
 */
export const httpRoute: HttpRoute = {
    delete: makeRouteFactory("DELETE"),
    get: makeRouteFactory("GET"),
    head: makeRouteFactory("HEAD"),
    options: makeRouteFactory("OPTIONS"),
    patch: makeRouteFactory("PATCH"),
    post: makeRouteFactory("POST"),
    put: makeRouteFactory("PUT"),
};
