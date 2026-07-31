import { toErrorBody } from "@lunora/errors";
import type { Infer, Validator, ValidatorKind } from "@lunora/values";
import { ValidationError } from "@lunora/values";
import type { Context } from "hono";
import { Hono } from "hono";

import type { EmptyArgs } from "./builder/index";
import { LunoraError } from "./error";
import { parseValidatorMap } from "./functions";
import type { ActionCtx as ActionContext, ArgsValidator, InferArgs } from "./types";

/** HTTP verbs the typed {@link httpRoute} builder can bind to. */
type HttpMethod = "DELETE" | "GET" | "HEAD" | "OPTIONS" | "PATCH" | "POST" | "PUT";

/**
 * Context handed to an HTTP action handler. A narrower view of {@link ActionContext}:
 * HTTP actions run in the worker (the "action runtime"), separate from the
 * transactional store, so there is no direct `db` / `vectors` / `storage`
 * surface — reach the data layer through `runQuery` / `runMutation` /
 * `runAction`, which forward to the owning shard.
 *
 * `scheduler` IS present (it talks to the scheduler DO, not the shard) but is
 * optional: it exists only when the app declared `.scheduler(...)` on the
 * generated app builder. "Receive webhook → enqueue the real work → return 200"
 * is what HTTP actions are for, so omitting it forced every app to hand-roll a
 * hop through a mutation plus a closed allow-list of target strings.
 */
// eslint-disable-next-line unicorn/prevent-abbreviations -- public API name re-exported by src/index.ts; renaming would break consumers
type HttpActionCtx = Pick<ActionContext, "auth" | "cache" | "fetch" | "runAction" | "runMutation" | "runQuery"> & {
    readonly scheduler?: ActionContext["scheduler"];
};

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
     * `AsyncIterable&lt;R>`) that yields one chunk per SSE `data:` frame; on
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
 * `array` validator collects every repeated occurrence (`?tag=a&amp;tag=b`) via
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

/**
 * Parse the handler result through `.output()`. A mismatch here is a server
 * contract bug, not a client error, so re-tag it as a 500.
 */
const applyOutput = (output: Validator, result: unknown): unknown => {
    try {
        return output.parse(result);
    } catch (error: unknown) {
        if (error instanceof ValidationError) {
            throw new LunoraError("INTERNAL_SERVER_ERROR", `Response did not match the declared output schema: ${error.message}`);
        }

        throw error;
    }
};

/** Map a thrown error to its HTTP response, re-throwing anything unrecognised. */
const errorResponse = (error: unknown): Response => {
    if (error instanceof ValidationError) {
        return Response.json({ code: "BAD_REQUEST", error: error.message }, { status: 400 });
    }

    if (error instanceof LunoraError) {
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
 * Compile the accumulated route state into a {@link LunoraRouteHandler}. Reads
 * `ctx` from `c.var.lunora` (set by {@link httpRouter}'s middleware). Input
 * decode failures (bad query / body / params) surface as 400; a result that
 * violates `.output()` surfaces as 500 (see {@link applyOutput}).
 */
const buildRouteHandler =
    (state: RouteState, userHandler: LooseHandler): LunoraRouteHandler =>
    async (c) => {
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

        // Already disconnected before we even started — return a closed stream
        // and never construct the pump or run the user handler.
        if (request.signal.aborted) {
            ac.abort();

            return new Response(
                new ReadableStream<Uint8Array>({
                    start: (controller) => {
                        controller.close();
                    },
                }),
                {
                    headers: {
                        "cache-control": "no-cache, no-transform",
                        "content-type": "text/event-stream; charset=utf-8",
                        "x-accel-buffering": "no",
                    },
                },
            );
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

                    controller.enqueue(encoder.encode(sseFrame({}, "complete")));
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

                    controller.enqueue(encoder.encode(sseFrame({ code: body.code, message: body.message }, "error")));
                } finally {
                    request.signal.removeEventListener("abort", onAbort);
                    controller.close();
                }
            },
        });

        const headers: Record<string, string> = {
            // SSE responses must stay uncacheable so proxies don't buffer or
            // coalesce live frames. `cacheControl()` is intentionally ignored
            // for stream() routes; `cacheTag`/`vary` are also omitted because
            // they only make sense alongside a cacheable response.
            "cache-control": "no-cache, no-transform",
            "content-type": "text/event-stream; charset=utf-8",
            // Hint to proxies (including Cloudflare's own buffering layer)
            // that this response must not be coalesced.
            "x-accel-buffering": "no",
        };

        return new Response(stream, { headers });
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

/** The minimal storage surface {@link serveStorageObject} needs: a metadata-rich `download`. */
interface StorageDownloader {
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
const isSafeHeaderValue = (value: string): boolean => {
    for (let index = 0; index < value.length; index += 1) {
        const code = value.codePointAt(index);

        // CR (13), LF (10), NUL (0).
        if (code === 13 || code === 10 || code === 0) {
            return false;
        }
    }

    return true;
};

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
 * Stream a stored object as an HTTP {@link Response} from an `httpAction`
 * handler, with correct `Content-Type`, `ETag`, and `Accept-Ranges: bytes`.
 * Honors a single-range `Range` request → **206 Partial Content** with
 * `Content-Range` + `Content-Length`; otherwise **200**. A missing object is a
 * **404**; an out-of-bounds range is a **416** with a `Content-Range` of
 * `bytes` star-slash-size.
 *
 * A range request re-issues the `download()` with the resolved `{ offset, length }`
 * window so R2 streams only those bytes back to the Worker — the slice is never
 * buffered in the isolate. The first `download()` is used only for the object's
 * size + metadata (its body is left unread and cancelled). For very large
 * objects a signed URL (`ctx.storage.getSignedUrl`) is still cheaper since the
 * client then ranges against R2/CDN directly with no Worker hop.
 */
const serveStorageObject = async (context: ContextWithStorage, key: string, request: Request): Promise<Response> => {
    const object = await context.storage.download(key);

    if (!object) {
        return new Response("Not Found", { status: 404 });
    }

    // `contentType` originates from object metadata set at upload time, so it is
    // attacker-influenced. A value carrying CR/LF (or other control chars) would
    // either throw inside `Response`/`Headers` construction (→ unhandled 500) or,
    // on a permissive runtime, smuggle an injected response header. Reject any
    // unsafe value and fall back to the safe default rather than reflecting it.
    const rawContentType = object.httpMetadata?.contentType;
    const contentType = rawContentType !== undefined && isSafeHeaderValue(rawContentType) ? rawContentType : "application/octet-stream";
    const baseHeaders: Record<string, string> = {
        "accept-ranges": "bytes",
        "content-type": contentType,
        etag: toHttpEtag(object.etag),
    };

    if (object.sha256Base64 !== undefined) {
        // RFC 9530 representation digest so clients can verify integrity. The
        // value is a structured-field byte-sequence (base64 wrapped in colons),
        // and it covers the full representation, so it's correct on a 206 too.
        baseHeaders["repr-digest"] = `sha-256=:${object.sha256Base64}:`;
    }

    const range = parseRange(request.headers.get("range"), object.size);

    if (range.kind === "unsatisfiable") {
        // The body here is a plain-text error, not the object — so it carries
        // neither the object's `Content-Type` nor its digest. Only the
        // range-relevant headers (and the resource ETag) ride along. The unread
        // object body is cancelled so the stream isn't left dangling.
        object.body?.cancel().catch(() => {});

        return new Response("Range Not Satisfiable", {
            headers: {
                "accept-ranges": "bytes",
                "content-range": `bytes */${String(object.size)}`,
                "content-type": "text/plain; charset=utf-8",
                etag: toHttpEtag(object.etag),
            },
            status: 416,
        });
    }

    if (range.kind === "full") {
        return new Response(object.body, {
            headers: { ...baseHeaders, "content-length": String(object.size) },
            status: 200,
        });
    }

    // Single range: re-fetch just the window so R2 streams only those bytes (the
    // first download's body is unused — cancel it rather than leak the stream).
    object.body?.cancel().catch(() => {});

    const length = range.end - range.start + 1;
    const slice = await context.storage.download(key, { range: { length, offset: range.start } });

    if (!slice) {
        // Raced with a delete between the metadata read and the ranged read.
        return new Response("Not Found", { status: 404 });
    }

    return new Response(slice.body, {
        headers: {
            ...baseHeaders,
            "content-length": String(length),
            "content-range": `bytes ${String(range.start)}-${String(range.end)}/${String(object.size)}`,
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
