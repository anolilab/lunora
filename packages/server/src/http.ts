import type { Infer, Validator, ValidatorKind } from "@cirrus/values";
import { ValidationError } from "@cirrus/values";
import type { Context } from "hono";
import { Hono } from "hono";

import type { EmptyArgs } from "./builder/index.js";
import { CirrusError } from "./error.js";
import type { ActionCtx as ActionContext, ArgsValidator, InferArgs } from "./types.js";

/** HTTP verbs the typed {@link httpRoute} builder can bind to. */
export type HttpMethod = "DELETE" | "GET" | "HEAD" | "OPTIONS" | "PATCH" | "POST" | "PUT";

/**
 * Context handed to an HTTP action handler. A narrower view of {@link ActionCtx}:
 * HTTP actions run in the worker (the "action runtime"), separate from the
 * transactional store, so there is no direct `db` / `vectors` / `scheduler` /
 * `storage` surface — reach the data layer through `runQuery` / `runMutation` /
 * `runAction`, which forward to the owning shard.
 */
export type HttpActionCtx = Pick<ActionContext, "auth" | "fetch" | "runAction" | "runMutation" | "runQuery">;

/** A raw handler wrapped by {@link httpAction}. Receives the raw request, returns the raw response. */
export type HttpActionHandler = (context: HttpActionCtx, request: Request) => Promise<Response> | Response;

/**
 * The hono {@link https://hono.dev | Hono} environment used by {@link httpRouter}.
 * The runtime injects the per-request {@link HttpActionCtx} on the private
 * `__cirrusCtx` binding; the router's lifting middleware promotes it to
 * `c.var.cirrus` so handlers can read it as a typed variable.
 */
export interface CirrusHttpEnv {
    Bindings: Record<string, unknown> & { __cirrusCtx?: HttpActionCtx };
    Variables: { cirrus: HttpActionCtx };
}

/** The hono app type {@link httpRouter} returns. */
export type CirrusHttpApp = Hono<CirrusHttpEnv>;

/** A compiled route handler: a hono handler that resolves to a raw {@link Response}. */
export type CirrusRouteHandler = (c: Context<CirrusHttpEnv>) => Promise<Response>;

/**
 * Wrap a `(ctx, request) => Response` handler as a hono handler. The raw escape
 * hatch — mount it with `app.all(path, httpAction(fn))`. `ctx` is the
 * runtime-injected {@link HttpActionCtx} lifted into `c.var.cirrus` by
 * {@link httpRouter}; `request` is the underlying `c.req.raw`.
 */
export const httpAction
    = (handler: HttpActionHandler): CirrusRouteHandler =>
        async (c) =>
            handler(c.get("cirrus"), c.req.raw);

/**
 * Create the hono app for HTTP actions. Pre-wired with a middleware that lifts
 * the runtime-injected `c.env.__cirrusCtx` into `c.var.cirrus`, so both
 * {@link httpAction} and the typed {@link httpRoute} builder can read the action
 * context. The full hono surface is available — plugins, path params, `.route`:
 *
 * ```ts
 * const app = httpRouter();
 * app.use("*", cors());
 * app.post("/webhook", httpAction(onWebhook));
 * app.get("/users/:id", getUser);
 * export default createWorker({ httpRouter: app, ... });
 * ```
 *
 * The lifting middleware throws if the context is absent. `createWorker` injects
 * it on every request the router sees, so this only trips when the app is run
 * outside the runtime — a misconfiguration we surface loudly rather than let
 * `c.var.cirrus` be silently `undefined` despite its non-optional type.
 */
export const httpRouter = (): CirrusHttpApp => {
    const app = new Hono<CirrusHttpEnv>();

    app.use("*", async (c, next) => {
        const injected = c.env.__cirrusCtx;

        if (!injected) {
            throw new CirrusError(
                "INTERNAL_SERVER_ERROR",
                "HttpActionCtx was not injected — mount httpRouter() on createWorker(), which supplies it per request.",
            );
        }

        c.set("cirrus", injected);

        await next();
    });

    return app;
};

/** The `{ ctx, searchParams, body, params }` a typed route handler receives. */
export interface HttpRouteHandlerOptions<SearchParams extends ArgsValidator, Body extends ArgsValidator, Params extends ArgsValidator> {
    body: InferArgs<Body>;
    ctx: HttpActionCtx;
    params: InferArgs<Params>;
    searchParams: InferArgs<SearchParams>;
}

/**
 * The `{ ctx, searchParams, params, request, signal }` a streaming HTTP
 * handler receives. There is no parsed `body` — streams are typically GET, and
 * the raw `request` is exposed if a handler needs to read the body itself.
 * `signal` is tripped when the client disconnects.
 */
export interface HttpStreamHandlerOptions<SearchParams extends ArgsValidator, Params extends ArgsValidator> {
    ctx: HttpActionCtx;
    params: InferArgs<Params>;
    request: Request;
    searchParams: InferArgs<SearchParams>;
    signal: AbortSignal;
}

/**
 * A typed REST route under construction. `.searchParams()` / `.body()` /
 * `.params()` accumulate validator maps (later calls merge, a colliding key
 * wins) that decode the URL query, JSON body, and hono path params into the
 * handler's typed `searchParams` / `body` / `params`. Like the procedure
 * builder, `.output(validator)` defaults to the `undefined` sentinel — while
 * unset the handler is generic over its own return; once set the handler must
 * return that type and the result is parsed through the validator before
 * serialization. `[Output] extends [undefined]` is tuple-wrapped so a union
 * `Output` doesn't distribute and the test is for the exact sentinel.
 *
 * The terminal `.handler()` yields a {@link CirrusRouteHandler} — mount it
 * directly with `app.get(path, route)`.
 */
export interface HttpRouteBuilder<SearchParams extends ArgsValidator, Body extends ArgsValidator, Params extends ArgsValidator, Output = undefined> {
    body: <B extends ArgsValidator>(validators: B) => HttpRouteBuilder<SearchParams, B & Body, Params, Output>;
    handler: [Output] extends [undefined]
        ? <R>(handler: (options: HttpRouteHandlerOptions<SearchParams, Body, Params>) => Promise<R> | R) => CirrusRouteHandler
        : (handler: (options: HttpRouteHandlerOptions<SearchParams, Body, Params>) => Output | Promise<Output>) => CirrusRouteHandler;
    output: <V extends Validator>(validator: V) => HttpRouteBuilder<SearchParams, Body, Params, Infer<V>>;
    params: <P extends ArgsValidator>(validators: P) => HttpRouteBuilder<SearchParams, Body, P & Params, Output>;
    searchParams: <S extends ArgsValidator>(validators: S) => HttpRouteBuilder<S & SearchParams, Body, Params, Output>;

    /**
     * Terminal: declare this route as a streaming Server-Sent Events endpoint.
     * The handler is an async generator (or any function returning an
     * `AsyncIterable&lt;R>`) that yields one chunk per SSE `data:` frame; on
     * iterator completion the route writes a final `event: complete` frame; on
     * throw, an `event: error` frame is written with `{code, message}` before
     * the stream closes. The chunks are JSON-encoded; `R` is inferred from the
     * handler's yielded type.
     */
    stream: <R>(handler: (options: HttpStreamHandlerOptions<SearchParams, Params>) => AsyncGenerator<R, void, void> | AsyncIterable<R>) => CirrusRouteHandler;
}

/** Opens a fresh {@link HttpRouteBuilder}. The `path` documents intent; hono owns the actual routing at mount. */
export type HttpRouteFactory = (path: string) => HttpRouteBuilder<EmptyArgs, EmptyArgs, EmptyArgs>;

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
    params: ArgsValidator;
    path: string;
    searchParams: ArgsValidator;
}

/** Internal view exposing `_meta.inner` so search-param coercion can read the wrapped validator. */
interface ValidatorWithMeta extends Validator {
    readonly _meta?: { readonly inner?: Validator };
}

/** Peel a single `v.optional()` layer so coercion keys off the underlying kind. */
const unwrapOptional = (validator: Validator): Validator =>
    validator.kind === "optional" ? ((validator as ValidatorWithMeta)._meta?.inner ?? validator) : validator;

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
 * Decode one declared query parameter from the hono request. Absent →
 * `undefined` (so `v.optional` passes and a required validator fails). An
 * `array` validator collects every repeated occurrence (`?tag=a&amp;tag=b`) via
 * `c.req.queries`, coercing each element.
 */
const coerceSearchParameter = (validator: Validator, c: Context<CirrusHttpEnv>, key: string): unknown => {
    const effective = unwrapOptional(validator);

    if (effective.kind === "array") {
        const values = c.req.queries(key);

        if (values === undefined) {
            return undefined;
        }

        const element = (effective as ValidatorWithMeta)._meta?.inner;

        return values.map((raw) => coerceScalar(element?.kind ?? "string", raw));
    }

    const raw = c.req.query(key);

    return raw === undefined ? undefined : coerceScalar(effective.kind, raw);
};

/**
 * Validate each declared field of `source` through its validator, prefixing any
 * `ValidationError` with `label.&lt;key>` so the 400 response points at the bad
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

const parseSearchParams = (validators: ArgsValidator, c: Context<CirrusHttpEnv>): Record<string, unknown> => {
    const raw: Record<string, unknown> = {};

    for (const key of Object.keys(validators)) {
        const validator = validators[key];

        if (!validator) {
            continue;
        }

        raw[key] = coerceSearchParameter(validator, c, key);
    }

    return parseFields(validators, raw, "searchParams");
};

/** Coerce + validate the declared hono path params (`/users/:id`). Path params arrive as strings. */
const parseParams = (validators: ArgsValidator, c: Context<CirrusHttpEnv>): Record<string, unknown> => {
    const provided = c.req.param() as Record<string, string | undefined>;
    const raw: Record<string, unknown> = {};

    for (const key of Object.keys(validators)) {
        const validator = validators[key];

        if (!validator) {
            continue;
        }

        const value = provided[key];

        raw[key] = value === undefined ? undefined : coerceScalar(unwrapOptional(validator).kind, value);
    }

    return parseFields(validators, raw, "params");
};

type LooseHandler = (options: {
    body: Record<string, unknown>;
    ctx: HttpActionCtx;
    params: Record<string, unknown>;
    searchParams: Record<string, unknown>;
}) => unknown;

/** Read + validate the JSON body. A non-JSON or non-object payload is a 400. */
const parseBody = async (validators: ArgsValidator, c: Context<CirrusHttpEnv>): Promise<Record<string, unknown>> => {
    let json: unknown;

    try {
        json = await c.req.json();
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
 * Compile the accumulated route state into a {@link CirrusRouteHandler}. Reads
 * `ctx` from `c.var.cirrus` (set by {@link httpRouter}'s middleware). Input
 * decode failures (bad query / body / params) surface as 400; a result that
 * violates `.output()` surfaces as 500 (see {@link applyOutput}).
 */
const buildRouteHandler
    = (state: RouteState, userHandler: LooseHandler): CirrusRouteHandler =>
        async (c) => {
            try {
                const context = c.get("cirrus");
                const searchParams = Object.keys(state.searchParams).length > 0 ? parseSearchParams(state.searchParams, c) : {};
                const params = Object.keys(state.params).length > 0 ? parseParams(state.params, c) : {};
                const body = Object.keys(state.body).length > 0 ? await parseBody(state.body, c) : {};
                const result = await userHandler({ body, ctx: context, params, searchParams });
                const payload = state.output ? applyOutput(state.output, result) : result;

                return payload === undefined ? new Response(null, { status: 204 }) : Response.json(payload);
            } catch (error: unknown) {
                return errorResponse(error);
            }
        };

type LooseStreamHandler = (options: {
    ctx: HttpActionCtx;
    params: Record<string, unknown>;
    request: Request;
    searchParams: Record<string, unknown>;
    signal: AbortSignal;
}) => AsyncGenerator<unknown, void, void> | AsyncIterable<unknown>;

/**
 * Structural match for a {@link CirrusError} that survives cross-package class
 * identity. A handler may throw a `CirrusError` minted by a different copy of
 * `@cirrus/server` (duplicated in the dep graph), so `instanceof` is unreliable
 * — key off the public shape (`name === "CirrusError"` + string `code`) the way
 * `@cirrus/runtime`'s `toErrorResponse` does. Only such known-safe errors get
 * their `code`/`message` echoed to the client.
 */
const isCirrusErrorLike = (error: unknown): error is { code: string; message: string } => {
    if (!error || typeof error !== "object") {
        return false;
    }

    const candidate = error as { code?: unknown; message?: unknown; name?: unknown };

    return candidate.name === "CirrusError" && typeof candidate.code === "string" && typeof candidate.message === "string";
};

/**
 * Format one SSE frame. Each frame ends with `\n\n`, the spec-required
 * separator. `event:` is omitted for `data` (the default event name); we use
 * named events only for the terminal sentinels (`complete`, `error`).
 */
const sseFrame = (chunk: unknown, event?: "complete" | "error"): string => {
    const data = JSON.stringify(chunk);
    const prefix = event ? `event: ${event}\n` : "";

    return `${prefix}data: ${data}\n\n`;
};

/**
 * Compile the accumulated route state into an SSE {@link CirrusRouteHandler}.
 * Pumps the user iterator into a `text/event-stream` `ReadableStream`. The
 * stream wires the client `request.signal` through to the user handler so a
 * disconnect aborts in-flight work, and surfaces handler-thrown errors as an
 * `event: error` SSE frame (so clients see a structured payload instead of an
 * opaque transport-level disconnect).
 */
const buildStreamHandler
    = (state: RouteState, userHandler: LooseStreamHandler): CirrusRouteHandler =>
    // eslint-disable-next-line @typescript-eslint/require-await -- CirrusRouteHandler is contractually `(c) => Promise<Response>`; this handler returns synchronously (all awaits live inside the ReadableStream pump), so `async` is required by the type, not the body.
        async (c) => {
            let searchParams: Record<string, unknown>;
            let params: Record<string, unknown>;

            try {
                searchParams = Object.keys(state.searchParams).length > 0 ? parseSearchParams(state.searchParams, c) : {};
                params = Object.keys(state.params).length > 0 ? parseParams(state.params, c) : {};
            } catch (error: unknown) {
                return errorResponse(error);
            }

            const context = c.get("cirrus");
            const request = c.req.raw;
            const encoder = new TextEncoder();
            const ac = new AbortController();

            request.signal.addEventListener("abort", () => {
                ac.abort();
            });

            const stream = new ReadableStream<Uint8Array>({
                cancel() {
                // The downstream consumer dropped the stream — propagate the
                // cancel to the user iterator so any in-flight work bails out.
                    ac.abort();
                },
                async start(controller) {
                    try {
                        const iterator = userHandler({ ctx: context, params, request, searchParams, signal: ac.signal });

                        for await (const chunk of iterator) {
                            if (ac.signal.aborted) {
                                break;
                            }

                            controller.enqueue(encoder.encode(sseFrame(chunk)));
                        }

                        controller.enqueue(encoder.encode(sseFrame({}, "complete")));
                    } catch (error: unknown) {
                    // Mirror `@cirrus/runtime`'s `toErrorResponse` policy: only a
                    // known-safe CirrusError-shaped value gets its `code`/`message`
                    // echoed to the client. Everything else (which may carry stack
                    // traces, file paths, or internal identifiers in `.message`) is
                    // logged server-side and replaced with a generic frame.
                        let payload: { code: string; message: string };

                        if (isCirrusErrorLike(error)) {
                            payload = { code: error.code, message: error.message };
                        } else {
                        // eslint-disable-next-line no-console -- log internal errors server-side; never echo raw details to the client
                            console.error("[cirrus] unhandled stream handler error:", error);
                            payload = { code: "INTERNAL_SERVER_ERROR", message: "Internal error" };
                        }

                        controller.enqueue(encoder.encode(sseFrame(payload, "error")));
                    } finally {
                        controller.close();
                    }
                },
            });

            return new Response(stream, {
                headers: {
                    "cache-control": "no-cache, no-transform",
                    "content-type": "text/event-stream; charset=utf-8",
                    // Hint to proxies (including Cloudflare's own buffering layer)
                    // that this response must not be coalesced.
                    "x-accel-buffering": "no",
                },
            });
        };

const makeRouteBuilder = (state: RouteState): Record<string, unknown> => {
    return {
        body: (validators: ArgsValidator) => makeRouteBuilder({ ...state, body: { ...state.body, ...validators } }),
        handler: (userHandler: LooseHandler): CirrusRouteHandler => buildRouteHandler(state, userHandler),
        output: (validator: Validator) => makeRouteBuilder({ ...state, output: validator }),
        params: (validators: ArgsValidator) => makeRouteBuilder({ ...state, params: { ...state.params, ...validators } }),
        searchParams: (validators: ArgsValidator) => makeRouteBuilder({ ...state, searchParams: { ...state.searchParams, ...validators } }),
        stream: (userHandler: LooseStreamHandler): CirrusRouteHandler => buildStreamHandler(state, userHandler),
    };
};

const makeRouteFactory
    = (method: HttpMethod): HttpRouteFactory =>
        (path: string) =>
            makeRouteBuilder({ body: {}, method, params: {}, path, searchParams: {} }) as unknown as HttpRouteBuilder<EmptyArgs, EmptyArgs, EmptyArgs>;

/**
 * Typed REST route builder. Compiles down to a {@link CirrusRouteHandler}, so a
 * typed route and a hand-written {@link httpAction} are interchangeable when
 * mounted on {@link httpRouter}:
 *
 * ```ts
 * export const listTodos = httpRoute
 *     .get("/api/todos")
 *     .searchParams({ limit: v.number(), q: v.optional(v.string()) })
 *     .output(v.array(v.object({ id: v.string(), text: v.string() })))
 *     .handler(async ({ ctx, searchParams }) => ctx.runQuery(api.todos.list, searchParams));
 *
 * export const getTodo = httpRoute
 *     .get("/api/todos/:id")
 *     .params({ id: v.string() })
 *     .handler(async ({ ctx, params }) => ctx.runQuery(api.todos.get, params));
 *
 * const app = httpRouter();
 * app.get("/api/todos", listTodos);
 * app.get("/api/todos/:id", getTodo);
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
