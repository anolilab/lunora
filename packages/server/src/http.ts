import { isLunoraError, LunoraError, toErrorBody } from "@lunora/errors";
import type { Infer, Validator, ValidatorKind } from "@lunora/values";
import { ValidationError } from "@lunora/values";
import type { Context } from "hono";
import { Hono } from "hono";

import applyOutput from "./apply-output";
import type { EmptyArgs } from "./builder/index";
import { parseValidatorMap } from "./functions";
import type { ActionCtx as ActionContext, ArgsValidator, InferArgs } from "./types";

/** HTTP verbs the typed {@link httpRoute} builder can bind to. */
type HttpMethod = "DELETE" | "GET" | "HEAD" | "OPTIONS" | "PATCH" | "POST" | "PUT";

/**
 * Context handed to an HTTP action handler. A narrower view of {@link ActionContext}:
 * HTTP actions run in the worker (the "action runtime"), separate from the
 * transactional store, so there is no direct `db` / `vectors` surface — reach the
 * data layer through `runQuery` / `runMutation` / `runAction`, which forward to
 * the owning shard. `db`'s absence is principled: an HTTP handler is not
 * transactional.
 *
 * `scheduler` and `storage` ARE present, because neither needs the shard — the
 * scheduler talks to the scheduler DO, and R2 is a worker binding an HTTP
 * handler can reach where an action does. Both are optional: each exists only
 * when the app declared the matching capability (`.scheduler(...)` /
 * `.storage(...)`) on the generated app builder.
 *
 * Omitting them was costly out of proportion to the gap. Without `scheduler`,
 * "receive webhook → enqueue the real work → return 200" — the shape HTTP
 * actions exist for — forced a hop through a mutation plus a closed allow-list
 * of target strings, because a function reference cannot cross the RPC boundary
 * and a free-form target on an unauthenticated endpoint is a "call any internal
 * function" primitive. Without `storage`, any helper the ctx was threaded into
 * had to be typed for its storage-touching branch, so a handler was barred from
 * the helper even on the branches that never went near storage.
 */
// eslint-disable-next-line unicorn/prevent-abbreviations -- public API name re-exported by src/index.ts; renaming would break consumers
type HttpActionCtx = {
    readonly scheduler?: ActionContext["scheduler"];
    readonly storage?: ActionContext["storage"];

    /**
     * The request's `ExecutionContext.waitUntil` — keep a promise alive past the
     * returned `Response`. Present whenever the host supplied one (a real
     * Cloudflare `ExecutionContext` always does; a partial context from a
     * framework mount seam or a unit test may not), hence optional.
     *
     * An HTTP action is the one ctx that routinely returns before its work is
     * done — "acknowledge the webhook in 200ms, then do the real thing" — and
     * without this a handler had no way to defer anything: work started and not
     * awaited is cancelled when the response resolves. Wrappers that need it
     * (`@lunora/x402`'s `withX402`, whose receipt sink must outlive the
     * response) read it structurally off whatever context they are handed, so
     * its absence made them silently no-op rather than fail.
     */
    readonly waitUntil?: (promise: Promise<unknown>) => void;
} & Pick<ActionContext, "auth" | "cache" | "fetch" | "runAction" | "runMutation" | "runQuery">;

/** A raw handler wrapped by {@link httpAction}. Receives the raw request, returns the raw response. */
type HttpActionHandler = (context: HttpActionCtx, request: Request) => Promise<Response> | Response;

/**
 * The hono {@link https://hono.dev | Hono} environment used by {@link httpRouter}.
 * The runtime injects the per-request {@link HttpActionCtx} on the private
 * `__lunoraCtx` binding; the router's lifting middleware promotes it to
 * `c.var.lunora` so handlers can read it as a typed variable.
 */
interface LunoraHttpEnv {
    Bindings: Record<string, unknown> & { __lunoraCtx?: HttpActionCtx };
    Variables: { lunora: HttpActionCtx };
}

/** The hono app type {@link httpRouter} returns. */
type LunoraHttpApp = Hono<LunoraHttpEnv>;

/** A compiled route handler: a hono handler that resolves to a raw {@link Response}. */
type LunoraRouteHandler = (c: Context<LunoraHttpEnv>) => Promise<Response>;

/**
 * Wrap a `(ctx, request) => Response` handler as a hono handler. The raw escape
 * hatch — mount it with `app.all(path, httpAction(fn))`. `ctx` is the
 * runtime-injected {@link HttpActionCtx} lifted into `c.var.lunora` by
 * {@link httpRouter}; `request` is the underlying `c.req.raw`.
 */
const httpAction =
    (handler: HttpActionHandler): LunoraRouteHandler =>
    async (c) =>
        handler(c.get("lunora"), c.req.raw);

/**
 * Create the hono app for HTTP actions. Pre-wired with a middleware that lifts
 * the runtime-injected `c.env.__lunoraCtx` into `c.var.lunora`, so both
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
 * `c.var.lunora` be silently `undefined` despite its non-optional type.
 */
const httpRouter = (): LunoraHttpApp => {
    const app = new Hono<LunoraHttpEnv>();

    app.use("*", async (c, next) => {
        const injected = c.env.__lunoraCtx;

        if (!injected) {
            throw new LunoraError(
                "INTERNAL_SERVER_ERROR",
                "HttpActionCtx was not injected — mount httpRouter() on createWorker(), which supplies it per request.",
            );
        }

        c.set("lunora", injected);

        await next();
    });

    return app;
};

/** The `{ ctx, searchParams, body, params }` a typed route handler receives. */
interface HttpRouteHandlerOptions<SearchParams extends ArgsValidator, Body extends ArgsValidator, Params extends ArgsValidator> {
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
 * @experimental Part of the HTTP-SSE stream surface; reconnect/POST-body design questions are still open.
 */
interface HttpStreamHandlerOptions<SearchParams extends ArgsValidator, Params extends ArgsValidator> {
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
 * The terminal `.handler()` yields a {@link LunoraRouteHandler} — mount it
 * directly with `app.get(path, route)`.
 */
interface HttpRouteBuilder<SearchParams extends ArgsValidator, Body extends ArgsValidator, Params extends ArgsValidator, Output = undefined> {
    body: <B extends ArgsValidator>(validators: B) => HttpRouteBuilder<SearchParams, B & Body, Params, Output>;

    /**
     * Attach a `Cache-Control` header to the response. Only meaningful when
     * Workers Cache is enabled in `wrangler.jsonc` (`"cache": { "enabled": true }`).
     */
    cacheControl: (value: string) => HttpRouteBuilder<SearchParams, Body, Params, Output>;

    /**
     * Attach a `Cache-Tag` header to the response for tag-based purging via
     * `ctx.cache.purge({ tags: [...] })`.
     */
    cacheTag: (value: string) => HttpRouteBuilder<SearchParams, Body, Params, Output>;
    handler: [Output] extends [undefined]
        ? <R>(handler: (options: HttpRouteHandlerOptions<SearchParams, Body, Params>) => Promise<R> | R) => LunoraRouteHandler
        : (handler: (options: HttpRouteHandlerOptions<SearchParams, Body, Params>) => Output | Promise<Output>) => LunoraRouteHandler;
    output: <V extends Validator>(validator: V) => HttpRouteBuilder<SearchParams, Body, Params, Infer<V>>;
    params: <P extends ArgsValidator>(validators: P) => HttpRouteBuilder<SearchParams, Body, P & Params, Output>;
    searchParams: <S extends ArgsValidator>(validators: S) => HttpRouteBuilder<S & SearchParams, Body, Params, Output>;

    /**
     * Terminal: declare this route as a streaming Server-Sent Events endpoint.
     * The handler is an async generator (or any function returning an
     * `AsyncIterable<R>`) that yields one chunk per SSE `data:` frame; on
     * iterator completion the route writes a final `event: complete` frame; on
     * throw, an `event: error` frame is written with `{code, message}` before
     * the stream closes. The chunks are JSON-encoded; `R` is inferred from the
     * handler's yielded type.
     * @experimental Reconnect/POST-body/wire-fidelity design questions are still open, so the shape may change.
     */
    stream: <R>(handler: (options: HttpStreamHandlerOptions<SearchParams, Params>) => AsyncGenerator<R, void, void> | AsyncIterable<R>) => LunoraRouteHandler;

    /**
     * Attach a `Vary` header to the response so Cloudflare stores separate
     * cached variants per distinct value of the listed request headers.
     */
    vary: (value: string) => HttpRouteBuilder<SearchParams, Body, Params, Output>;
}

/** Opens a fresh {@link HttpRouteBuilder}. The `path` documents intent; hono owns the actual routing at mount. */
type HttpRouteFactory = (path: string) => HttpRouteBuilder<EmptyArgs, EmptyArgs, EmptyArgs>;

/** The verb-keyed entry point: `httpRoute.get("/api/todos")…`. */
interface HttpRoute {
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
    cacheControl?: string;
    cacheTag?: string;
    method: HttpMethod;
    output?: Validator;
    params: ArgsValidator;
    path: string;
    searchParams: ArgsValidator;
    vary?: string;
}

/** Internal view exposing `_meta.inner` so search-param coercion can read the wrapped validator. */
interface ValidatorWithMeta extends Validator {
    readonly _meta?: { readonly inner?: Validator };
}

/** Peel a single `v.optional()` layer so coercion keys off the underlying kind. */
const unwrapOptional = (validator: Validator): Validator =>
    validator.kind === "optional" ? ((validator as ValidatorWithMeta)._meta?.inner ?? validator) : validator;

/**
 * Query-string values arrive as strings, but `@lunora/values` validators are
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
            // `Number("")` is `0`, so an empty-but-present numeric param
            // (`?limit=`) would silently satisfy `v.number()` as 0. Map the
            // empty string to NaN so the validator rejects it like any other
            // malformed value rather than coercing to a surprising 0.
            return raw === "" ? Number.NaN : Number(raw);
        }
        default: {
            return raw;
        }
    }
};

/**
 * Decode one declared query parameter from the hono request. Absent →
 * `undefined` (so `v.optional` passes and a required validator fails). An
 * `array` validator collects every repeated occurrence (`?tag=a&tag=b`) via
 * `c.req.queries`, coercing each element.
 */
const coerceSearchParameter = (validator: Validator, c: Context<LunoraHttpEnv>, key: string): unknown => {
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

const parseSearchParams = (validators: ArgsValidator, c: Context<LunoraHttpEnv>): Record<string, unknown> => {
    const raw: Record<string, unknown> = {};

    for (const key of Object.keys(validators)) {
        const validator = validators[key];

        if (!validator) {
            continue;
        }

        raw[key] = coerceSearchParameter(validator, c, key);
    }

    return parseValidatorMap(validators, raw, "searchParams");
};

/** Coerce + validate the declared hono path params (`/users/:id`). Path params arrive as strings. */
const parseParams = (validators: ArgsValidator, c: Context<LunoraHttpEnv>): Record<string, unknown> => {
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

    return parseValidatorMap(validators, raw, "params");
};

type LooseHandler = (options: {
    body: Record<string, unknown>;
    ctx: HttpActionCtx;
    params: Record<string, unknown>;
    searchParams: Record<string, unknown>;
}) => unknown;

/** Read + validate the JSON body. A non-JSON or non-object payload is a 400. */
const parseBody = async (validators: ArgsValidator, c: Context<LunoraHttpEnv>): Promise<Record<string, unknown>> => {
    let json: unknown;

    try {
        json = await c.req.json();
    } catch {
        throw new LunoraError("BAD_REQUEST", "Invalid JSON body");
    }

    if (typeof json !== "object" || json === null || Array.isArray(json)) {
        throw new LunoraError("BAD_REQUEST", "Expected a JSON object body");
    }

    return parseValidatorMap(validators, json as Record<string, unknown>, "body");
};

/** Map a thrown error to its HTTP response, re-throwing anything unrecognised. */
const errorResponse = (error: unknown): Response => {
    if (error instanceof ValidationError) {
        return Response.json({ code: "BAD_REQUEST", error: error.message }, { status: 400 });
    }

    // Structural, NOT `instanceof`: the errors that actually reach a route
    // handler are minted by several classes (the facade's `@lunora/errors`
    // `LunoraError`, the runtime's own subclass, a twin rebuilt from a shard-RPC
    // error payload) and by other bundled copies of this package. An
    // `instanceof` test against any single class misses all of those and falls
    // through to the rethrow below, which escapes hono as a bare
    // `500 text/plain` — losing the code, status, hint and `data`.
    if (isLunoraError(error)) {
        const { body, redacted, status } = toErrorBody(error, { fallbackCode: "INTERNAL_SERVER_ERROR", redactedMessage: "Internal error" });

        if (redacted) {
            // eslint-disable-next-line no-console -- log internal errors server-side; never echo raw details to the client
            console.error("[lunora] http action error (redacted on the wire):", error);
        }

        return Response.json({ code: body.code, error: body.message }, { status });
    }

    throw error;
};

/**
 * Reject a request whose verb is not the one the route was declared with.
 *
 * The verb is real routing information, not decoration: mounting
 * `httpRoute.post("/api/todos")…` as `app.get("/api/todos", create)` is a typo
 * hono cannot catch, and without this check the GET runs the POST handler and
 * dies in `parseBody` with `400 "Invalid JSON body"` instead of saying the
 * method is wrong. `HEAD` is accepted on a `GET` route (RFC 9110: HEAD is GET
 * without a body); everything else answers 405 with the required `Allow` header.
 */
const methodNotAllowed = (state: RouteState, c: Context<LunoraHttpEnv>): Response | undefined => {
    const { method } = c.req;

    if (method === state.method || (state.method === "GET" && method === "HEAD")) {
        return undefined;
    }

    return Response.json(
        { code: "METHOD_NOT_ALLOWED", error: `${method} is not allowed on this route (declared as ${state.method})` },
        { headers: { allow: state.method }, status: 405 },
    );
};

/**
 * Compile the accumulated route state into a {@link LunoraRouteHandler}. Reads
 * `ctx` from `c.var.lunora` (set by {@link httpRouter}'s middleware). Input
 * decode failures (bad query / body / params) surface as 400; a result that
 * violates `.output()` surfaces as 500 (see {@link applyOutput}).
 */
const buildRouteHandler =
    (state: RouteState, userHandler: LooseHandler): LunoraRouteHandler =>
    async (c) => {
        const wrongMethod = methodNotAllowed(state, c);

        if (wrongMethod) {
            return wrongMethod;
        }

        try {
            const context = c.get("lunora");
            const searchParams = Object.keys(state.searchParams).length > 0 ? parseSearchParams(state.searchParams, c) : {};
            const params = Object.keys(state.params).length > 0 ? parseParams(state.params, c) : {};
            const body = Object.keys(state.body).length > 0 ? await parseBody(state.body, c) : {};
            const result = await userHandler({ body, ctx: context, params, searchParams });
            const payload = state.output ? applyOutput(state.output, result) : result;

            const headers: Record<string, string> = {};

            if (state.cacheControl) {
                headers["cache-control"] = state.cacheControl;
            }

            if (state.cacheTag) {
                headers["cache-tag"] = state.cacheTag;
            }

            if (state.vary) {
                headers.vary = state.vary;
            }

            const hasCacheHeaders = Object.keys(headers).length > 0;

            if (payload === undefined) {
                // eslint-disable-next-line unicorn/no-null -- Response body must be `null` for an empty 204 (the Fetch API rejects `undefined`)
                return new Response(null, { headers: hasCacheHeaders ? headers : undefined, status: 204 });
            }

            return Response.json(payload, { headers: hasCacheHeaders ? headers : undefined });
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
 * Headers on every SSE response. SSE responses must stay uncacheable so proxies
 * don't buffer or coalesce live frames — `cacheControl()` is intentionally
 * ignored for stream() routes, and `cacheTag`/`vary` are also omitted because
 * they only make sense alongside a cacheable response. `x-accel-buffering`
 * hints to proxies (including Cloudflare's own buffering layer) that this
 * response must not be coalesced.
 */
const SSE_HEADERS: Record<string, string> = {
    "cache-control": "no-cache, no-transform",
    "content-type": "text/event-stream; charset=utf-8",
    "x-accel-buffering": "no",
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
 * Compile the accumulated route state into an SSE {@link LunoraRouteHandler}.
 * Pumps the user iterator into a `text/event-stream` `ReadableStream`. The
 * stream wires the client `request.signal` through to the user handler so a
 * disconnect aborts in-flight work, and surfaces handler-thrown errors as an
 * `event: error` SSE frame (so clients see a structured payload instead of an
 * opaque transport-level disconnect).
 */
const buildStreamHandler =
    (state: RouteState, userHandler: LooseStreamHandler): LunoraRouteHandler =>
    // eslint-disable-next-line @typescript-eslint/require-await -- LunoraRouteHandler is contractually `(c) => Promise<Response>`; this handler returns synchronously (all awaits live inside the ReadableStream pump), so `async` is required by the type, not the body.
    async (c) => {
        const wrongMethod = methodNotAllowed(state, c);

        if (wrongMethod) {
            return wrongMethod;
        }

        let searchParams: Record<string, unknown>;
        let params: Record<string, unknown>;

        try {
            searchParams = Object.keys(state.searchParams).length > 0 ? parseSearchParams(state.searchParams, c) : {};
            params = Object.keys(state.params).length > 0 ? parseParams(state.params, c) : {};
        } catch (error: unknown) {
            return errorResponse(error);
        }

        const context = c.get("lunora");
        const request = c.req.raw;
        const encoder = new TextEncoder();
        const ac = new AbortController();

        // Already disconnected before we even started — return an empty body
        // and never construct the pump or run the user handler.
        if (request.signal.aborted) {
            ac.abort();

            return new Response("", { headers: SSE_HEADERS });
        }

        const onAbort = (): void => {
            ac.abort();
        };

        request.signal.addEventListener("abort", onAbort, { once: true });

        const stream = new ReadableStream<Uint8Array>({
            cancel() {
                // The downstream consumer dropped the stream — propagate the
                // cancel to the user iterator so any in-flight work bails out.
                request.signal.removeEventListener("abort", onAbort);
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

                    // Re-check after the loop: a consumer `cancel()` (or a client
                    // disconnect) aborts `ac` and breaks the pump, and the
                    // controller is already closed by then — enqueueing the
                    // terminal frame onto it throws a `TypeError` that would be
                    // caught below, logged as a bogus handler error, and then
                    // throw AGAIN out of the error frame and `close()`, rejecting
                    // `start()` unhandled on every mid-stream disconnect.
                    if (!ac.signal.aborted) {
                        controller.enqueue(encoder.encode(sseFrame({}, "complete")));
                    }
                } catch (error: unknown) {
                    // Mirror the shared `toErrorBody` redaction policy: only a
                    // non-internal LunoraError-shaped value gets its `code`/`message`
                    // echoed to the client. An internal-coded or unrecognized throw
                    // (which may carry stack traces, file paths, or internal
                    // identifiers in `.message`) is logged server-side and replaced
                    // with a generic frame.
                    const { body, redacted } = toErrorBody(error, { fallbackCode: "INTERNAL_SERVER_ERROR", redactedMessage: "Internal error" });

                    if (redacted) {
                        // eslint-disable-next-line no-console -- log internal errors server-side; never echo raw details to the client
                        console.error("[lunora] unhandled stream handler error:", error);
                    }

                    // Same guard as the terminal frame above: nobody is left to
                    // read the error frame once the stream is cancelled, and
                    // enqueueing onto the closed controller would throw out of
                    // this catch.
                    if (!ac.signal.aborted) {
                        controller.enqueue(encoder.encode(sseFrame({ code: body.code, message: body.message }, "error")));
                    }
                } finally {
                    request.signal.removeEventListener("abort", onAbort);

                    // `close()` throws on an already-closed/errored controller
                    // (a cancelled stream), which would escape `start()` as an
                    // unhandled rejection. The close is best-effort cleanup.
                    try {
                        controller.close();
                    } catch {
                        // already closed — nothing to do
                    }
                }
            },
        });

        return new Response(stream, { headers: SSE_HEADERS });
    };

const makeRouteBuilder = (state: RouteState): Record<string, unknown> => {
    return {
        body: (validators: ArgsValidator) => makeRouteBuilder({ ...state, body: { ...state.body, ...validators } }),
        cacheControl: (value: string) => makeRouteBuilder({ ...state, cacheControl: value }),
        cacheTag: (value: string) => makeRouteBuilder({ ...state, cacheTag: value }),
        handler: (userHandler: LooseHandler): LunoraRouteHandler => buildRouteHandler(state, userHandler),
        output: (validator: Validator) => makeRouteBuilder({ ...state, output: validator }),
        params: (validators: ArgsValidator) => makeRouteBuilder({ ...state, params: { ...state.params, ...validators } }),
        searchParams: (validators: ArgsValidator) => makeRouteBuilder({ ...state, searchParams: { ...state.searchParams, ...validators } }),
        stream: (userHandler: LooseStreamHandler): LunoraRouteHandler => buildStreamHandler(state, userHandler),
        vary: (value: string) => makeRouteBuilder({ ...state, vary: value }),
    };
};

const makeRouteFactory =
    (method: HttpMethod): HttpRouteFactory =>
    (path: string) =>
        makeRouteBuilder({ body: {}, method, params: {}, path, searchParams: {} }) as unknown as HttpRouteBuilder<EmptyArgs, EmptyArgs, EmptyArgs>;

/**
 * Typed REST route builder. Compiles down to a {@link LunoraRouteHandler}, so a
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
const httpRoute: HttpRoute = {
    delete: makeRouteFactory("DELETE"),
    get: makeRouteFactory("GET"),
    head: makeRouteFactory("HEAD"),
    options: makeRouteFactory("OPTIONS"),
    patch: makeRouteFactory("PATCH"),
    post: makeRouteFactory("POST"),
    put: makeRouteFactory("PUT"),
};

/**
 * Structural view of an R2 object body, as returned by `@lunora/storage`'s
 * `download()`. Re-declared here (not imported) so `@lunora/server` takes no
 * runtime dependency on `@lunora/storage`; the real binding satisfies the shape.
 */
interface StorageObjectBody {
    /** The object body stream (`null` for a zero-byte object). */
    body: ReadableStream | null;
    etag: string;
    httpMetadata?: { contentType?: string };
    key: string;
    /** Hex SHA-256, when R2 carries a checksum (surfaced by `@lunora/storage`). */
    sha256?: string;
    /** Base64 SHA-256 (RFC 9530 digest encoding), when R2 carries a checksum. */
    sha256Base64?: string;
    size: number;
}

/** Byte window forwarded to `download()` so R2 streams just the requested slice. */
interface StorageRange {
    length: number;
    offset: number;
}

/**
 * The minimal storage surface {@link serveStorageObject} needs: a metadata-rich
 * `download`, plus the body-free `head` a range request resolves against.
 *
 * `head` is required rather than optional-with-a-fallback because the fallback
 * is the bug: without it a ranged request has to start a full-object `download`
 * just to learn the size, then throw that body away. `@lunora/storage`'s `head`
 * already degrades internally to a 0-length ranged `get()` on a binding with no
 * HEAD, so there is nothing a caller here could usefully do that it does not.
 */
interface StorageHead {
    /** Object metadata with no body. `size` is the FULL object size (mirrors R2). */
    head: (key: string) => Promise<Omit<StorageObjectBody, "body"> | null>;
}

/** The storage surface {@link serveStorageObject} reads through. */
interface StorageDownloader extends StorageHead {
    download: (key: string, options?: { range?: StorageRange }) => Promise<StorageObjectBody | null>;
}

/** Any ctx that carries a {@link StorageDownloader} on `.storage` (Query/Mutation/Action ctx all do). */
interface ContextWithStorage {
    storage: StorageDownloader;
}

/** Hoisted so the single-range matcher isn't recompiled on every request. */
const SINGLE_BYTE_RANGE_RE = /^bytes=(\d*)-(\d*)$/;

/**
 * RFC 7232 requires an `ETag` field-value to be a quoted-string (or `W/`-prefixed
 * weak validator). R2's `object.etag` is the *unquoted* MD5 hex, so emitting it
 * verbatim produces a malformed header that conditional-request clients and CDNs
 * will never match against `If-None-Match: "…"`. Wrap it in quotes unless the
 * source already carries them (or a weak prefix).
 */
const toHttpEtag = (etag: string): string => {
    if (etag.startsWith('"') || etag.startsWith('W/"')) {
        return etag;
    }

    return `"${etag}"`;
};

/**
 * True when `value` is safe to use as an HTTP header field-value: no CR, LF, or
 * NUL. Guards against response-header injection / `Headers`-construction throws
 * when reflecting attacker-influenced object metadata (e.g. a stored
 * `Content-Type`). Exported (see the `export {}` at the file end) so an `httpAction`
 * handler can guard a request-derived header value before writing it — the fix the
 * `http_action_response_header_injection` advisor lint points to.
 */
const isSafeHeaderValue = (value: string): boolean => !(value.includes("\r") || value.includes("\n") || value.includes("\0"));

/**
 * Outcome of parsing a `Range` header. `kind: "full"` → no/ignorable range
 * (serve the whole object as 200); `kind: "partial"` → a resolved inclusive
 * `[start, end]` (serve 206); `kind: "unsatisfiable"` → syntactically valid but
 * out of bounds (serve 416).
 */
type RangeResult = { end: number; kind: "partial"; start: number } | { kind: "full" } | { kind: "unsatisfiable" };

/**
 * Parse a single-range `Range: bytes=start-end` header against a known object
 * `size`. Only a single byte range is supported; a multi-range request
 * (`bytes=0-1,3-4`) is ignored and the full object is served — the common
 * media-streaming case is a single range, and multipart/byteranges responses
 * add disproportionate complexity.
 */
const parseRange = (header: null | string, size: number): RangeResult => {
    if (header === null) {
        return { kind: "full" };
    }

    const match = SINGLE_BYTE_RANGE_RE.exec(header.trim());

    if (!match) {
        // Multi-range or malformed — ignore and serve the whole object.
        return { kind: "full" };
    }

    const startRaw = match[1] ?? "";
    const endRaw = match[2] ?? "";

    if (startRaw === "" && endRaw === "") {
        return { kind: "full" };
    }

    let start: number;
    let end: number;

    if (startRaw === "") {
        // Suffix range `bytes=-N`: the final N bytes.
        const suffix = Number(endRaw);

        if (suffix === 0) {
            return { kind: "unsatisfiable" };
        }

        start = Math.max(0, size - suffix);
        end = size - 1;
    } else {
        start = Number(startRaw);
        end = endRaw === "" ? size - 1 : Math.min(Number(endRaw), size - 1);
    }

    if (start > end || start >= size) {
        return { kind: "unsatisfiable" };
    }

    return { end, kind: "partial", start };
};

/**
 * The headers every representation of an object carries — its content-type, its
 * validator, and the RFC 9530 digest when R2 recorded a checksum.
 *
 * `contentType` originates from object metadata set at upload time, so it is
 * attacker-influenced. A value carrying CR/LF (or other control chars) would
 * either throw inside `Response`/`Headers` construction (→ unhandled 500) or,
 * on a permissive runtime, smuggle an injected response header. Reject any
 * unsafe value and fall back to the safe default rather than reflecting it.
 */
const storageObjectHeaders = (object: Omit<StorageObjectBody, "body">): Record<string, string> => {
    const rawContentType = object.httpMetadata?.contentType;
    const headers: Record<string, string> = {
        "accept-ranges": "bytes",
        "content-type": rawContentType !== undefined && isSafeHeaderValue(rawContentType) ? rawContentType : "application/octet-stream",
        etag: toHttpEtag(object.etag),
    };

    if (object.sha256Base64 !== undefined) {
        // RFC 9530 representation digest so clients can verify integrity. The
        // value is a structured-field byte-sequence (base64 wrapped in colons),
        // and it covers the full representation, so it's correct on a 206 too.
        headers["repr-digest"] = `sha-256=:${object.sha256Base64}:`;
    }

    return headers;
};

/**
 * Whether `header` degrades to the whole object no matter how big the object is:
 * absent, multi-range, malformed, or a bare `bytes=-`.
 *
 * Every branch of {@link parseRange} that answers `"full"` returns before `size`
 * is read, so probing with `0` is a header-only question — which lets a request
 * that can never be a 206 skip the metadata read instead of paying for one and
 * throwing it away.
 */
const rangeDegradesToWholeObject = (header: null | string): boolean => parseRange(header, 0).kind === "full";

/** The whole object as a `200`, streamed from a single `download()`. */
const serveWholeStorageObject = async (context: ContextWithStorage, key: string): Promise<Response> => {
    const object = await context.storage.download(key);

    if (!object) {
        return new Response("Not Found", { status: 404 });
    }

    return new Response(object.body, {
        headers: { ...storageObjectHeaders(object), "content-length": String(object.size) },
        status: 200,
    });
};

/**
 * Stream a stored object as an HTTP {@link Response} from an `httpAction`
 * handler, with correct `Content-Type`, `ETag`, and `Accept-Ranges: bytes`.
 * Honors a single-range `Range` request → **206 Partial Content** with
 * `Content-Range` + `Content-Length`; otherwise **200**. A missing object is a
 * **404**; an out-of-bounds range is a **416** with a `Content-Range` of
 * `bytes` star-slash-size.
 *
 * A range request resolves its window against a body-free `head()`, then issues
 * ONE `download()` with the resolved `{ offset, length }` so R2 streams just
 * those bytes — the slice is never buffered in the isolate, and no full-object
 * body transfer is started only to be cancelled. A request that cannot produce a
 * 206 at all (no `Range`, multi-range, malformed) skips the `head()` entirely and
 * streams straight from a single `download()`. For very
 * large objects a signed URL (`ctx.storage.getSignedUrl`) is still cheaper since
 * the client then ranges against R2/CDN directly with no Worker hop.
 */
const serveStorageObject = async (context: ContextWithStorage, key: string, request: Request): Promise<Response> => {
    const rangeHeader = request.headers.get("range");

    // No `Range`, or one that cannot produce a 206 anyway (multi-range, malformed):
    // the object's own metadata rides along with its body, so there is nothing to
    // look up first — and paying for a `head()` here would only add a round trip
    // and a window for the object to vanish between the two reads.
    if (rangeDegradesToWholeObject(rangeHeader)) {
        return serveWholeStorageObject(context, key);
    }

    // A range has to be resolved against the object's size before it can be
    // requested, so this read exists only for the metadata — which is exactly why
    // it is a `head()` and not a `download()`.
    const metadata = await context.storage.head(key);

    if (!metadata) {
        return new Response("Not Found", { status: 404 });
    }

    const range = parseRange(rangeHeader, metadata.size);

    if (range.kind === "unsatisfiable") {
        // The body here is a plain-text error, not the object — so it carries
        // neither the object's `Content-Type` nor its digest. Only the
        // range-relevant headers (and the resource ETag) ride along.
        return new Response("Range Not Satisfiable", {
            headers: {
                "accept-ranges": "bytes",
                "content-range": `bytes */${String(metadata.size)}`,
                "content-type": "text/plain; charset=utf-8",
                etag: toHttpEtag(metadata.etag),
            },
            status: 416,
        });
    }

    // Unreachable: the whole-object check at the top already answered this, and
    // its answer does not depend on `size`. Kept so the union stays exhaustive.
    if (range.kind === "full") {
        return serveWholeStorageObject(context, key);
    }

    const length = range.end - range.start + 1;
    const slice = await context.storage.download(key, { range: { length, offset: range.start } });

    if (!slice) {
        // Raced with a delete between the metadata read and the ranged read.
        return new Response("Not Found", { status: 404 });
    }

    // Headers come from `metadata`, not `slice`: the validator, the digest and the
    // `Content-Range` total must all describe the ONE representation the window
    // was resolved against. (An object replaced between the two reads is a
    // pre-existing race either way — this at least keeps the header set coherent.)
    return new Response(slice.body, {
        headers: {
            ...storageObjectHeaders(metadata),
            "content-length": String(length),
            "content-range": `bytes ${String(range.start)}-${String(range.end)}/${String(metadata.size)}`,
        },
        status: 206,
    });
};

export { httpAction, httpRoute, httpRouter, isSafeHeaderValue, serveStorageObject };

export type {
    HttpActionCtx,
    HttpActionHandler,
    HttpMethod,
    HttpRoute,
    HttpRouteBuilder,
    HttpRouteFactory,
    HttpRouteHandlerOptions,
    HttpStreamHandlerOptions,
    LunoraHttpApp,
    LunoraHttpEnv,
    LunoraRouteHandler,
};
