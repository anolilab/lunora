import { isLunoraError, LunoraError, toErrorBody } from "@lunora/errors";
import type { Infer, Validator, ValidatorKind } from "@lunora/values";
import { ValidationError } from "@lunora/values";
import { encodeWire } from "@lunora/wire";
import type { Context } from "hono";
import { Hono } from "hono";

import applyOutput from "./apply-output";
import type { EmptyArgs } from "./builder/index";
import { parseValidatorMap } from "./functions";
import type { ActionCtx as ActionContext, ArgsValidator, InferArgs } from "./types";

/** HTTP verbs the typed {@link httpRoute} builder can bind to. */
type HttpMethod = "DELETE" | "GET" | "HEAD" | "OPTIONS" | "PATCH" | "POST" | "PUT";

/** The `run*` trio, shared between {@link HttpActionCtx} itself and its `forShard(key)` view. */
type HttpRunners = Pick<ActionContext, "runAction" | "runMutation" | "runQuery">;

/**
 * Context handed to an HTTP action handler. A narrower view of {@link ActionContext}:
 * HTTP actions run in the worker (the "action runtime"), separate from the
 * transactional store, so there is no direct `db` / `vectors` surface — reach the
 * data layer through `runQuery` / `runMutation` / `runAction`, which forward an
 * RPC to a shard. `db`'s absence is principled: an HTTP handler is not
 * transactional.
 *
 * WHICH shard is the handler's to choose. A query/mutation ctx is already inside
 * the owning DO, so its `ctx.run*` has nowhere else to go; an HTTP action runs in
 * the worker, one hop away from every shard, so the bare `ctx.run*` targets the
 * DEFAULT shard and {@link HttpActionCtx.forShard} names any other. On a
 * `.shardBy(...)` app that distinction is the whole ballgame — the default shard
 * is the root DO, which holds none of a sharded table's rows.
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
    /**
     * Forward a server-to-server request to a shard Durable Object carrying the
     * caller's resolved identity headers — the seam the live-stream primitive
     * (`defineLiveStream`) uses to reach the shard's subscriber registry. See
     * {@link ShardFetch}.
     */
    readonly fetchShard: ShardFetch;

    /**
     * The same `run*` trio bound to `shardKey`, mirroring
     * `createShardClient(...).forShard(key)`:
     *
     * ```ts
     * const rows = await ctx.forShard(channelId).runQuery(api.messages.list, { channelId });
     * ```
     *
     * Without it a webhook / REST route on a `.shardBy(...)` app could only reach
     * the default (root) shard, so it read an empty table and wrote to the wrong
     * DO — silently, with no way to say otherwise.
     */
    readonly forShard: (shardKey: string) => HttpRunners;

    /** Publish an arbitrary event to a live topic. See {@link LivePublisher}. */
    readonly live: LivePublisher;

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
} & HttpRunners &
    Pick<ActionContext, "auth" | "cache" | "fetch">;

/** A raw handler wrapped by {@link httpAction}. Receives the raw request, returns the raw response. */
type HttpActionHandler = (context: HttpActionCtx, request: Request) => Promise<Response> | Response;

/** Init for {@link ShardFetch} — the fields the live-stream primitive needs. */
interface ShardFetchInit {
    /** Request body (already serialized). */
    body?: string;
    /** Extra headers merged over the forwarded identity headers. */
    headers?: Record<string, string>;
    /** HTTP method; defaults to `GET`. */
    method?: string;
}

/**
 * Forward a server-to-server request to a shard Durable Object, carrying the
 * caller's resolved identity headers. This is the seam the live-stream
 * primitive uses to reach the shard's subscriber registry: a worker-side
 * `.stream()` handler cannot itself hold a connection-scoped subscription (the
 * registry must be the single-actor DO), so the SSE stream is served by the DO
 * and this is how the route reaches it.
 *
 * Not a general-purpose escape hatch: like `ctx.run*` it dispatches as trusted
 * worker code, so a handler must have already run whatever authorization it
 * requires before forwarding. An internal call has no client-reachable path of
 * its own — the DO is never directly addressable.
 *
 * `shardKey === undefined` targets the app's default shard.
 */
type ShardFetch = (shardKey: string | undefined, path: string, init?: ShardFetchInit) => Promise<Response>;

/** Where a {@link LivePublisher.publish} goes. */
interface LivePublishOptions {
    /** The shard to publish on. Defaults to the ctx's default shard. */
    shardKey?: string;

    /**
     * The `id` of the `defineLiveStream` whose subscribers see the event. A
     * subscriber follows a topic through the stream that authorized it, so a
     * publish reaches only that stream's subscribers.
     */
    stream: string;
}

/**
 * `ctx.live` — publish an arbitrary event to a named topic. The event reaches
 * the SSE subscribers of `options.stream` that followed the topic, and the
 * WebSocket whisper members that hold a live grant for that stream and topic
 * (see the live-stream docblock).
 *
 * Reachable from an HTTP-action ctx; an action (a scheduled job) publishes
 * through the same surface in-process (see the live-stream docblock).
 */
interface LivePublisher {
    /**
     * Publish `payload` to `topic` on `options.stream`. Best-effort — a topic
     * with no subscribers is a no-op. Rejects when the shard refuses the publish:
     * a `room:` topic (403), a topic over the control-key bound (400), or a
     * payload over the publish cap (413), so a refused publish is not silently
     * dropped. On a target that does not serve live streams it rejects with
     * `LIVE_STREAMS_UNSUPPORTED`.
     */
    publish: (topic: string, payload: unknown, options: LivePublishOptions) => Promise<void>;
}

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
 * serialization. It binds `.stream()` the same way, per yielded chunk.
 * `[Output] extends [undefined]` is tuple-wrapped so a union
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
     * handler's yielded type — unless `.output()` was declared, in which case each
     * chunk must be that type and is parsed through the validator before the frame
     * is written (a violation ends the stream with an `event: error` frame).
     *
     * A handler may yield a plain `R` (unchanged) or {@link sseEvent}, which
     * wraps one chunk so the pump emits an `id:` line ahead of its `data:`.
     */
    stream: [Output] extends [undefined]
        ? <R>(
              handler: (
                  options: HttpStreamHandlerOptions<SearchParams, Params>,
              ) => AsyncGenerator<R | SseEvent<R>, void, void> | AsyncIterable<R | SseEvent<R>>,
          ) => LunoraRouteHandler
        : (
              handler: (
                  options: HttpStreamHandlerOptions<SearchParams, Params>,
              ) => AsyncGenerator<Output | SseEvent<Output>, void, void> | AsyncIterable<Output | SseEvent<Output>>,
          ) => LunoraRouteHandler;

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
 * Read the SSE resume position off a request: the `Last-Event-ID` header a
 * browser `EventSource` replays automatically on reconnect, falling back to a
 * `lastEventId` query parameter for clients that cannot set that header.
 * The query fallback applies only when the header is absent. A present but empty
 * header is a cleared position (the server emitted an empty `id:`), so it returns
 * `undefined` rather than resurrecting a stale query value. Returns `undefined`
 * when there is no resume position, so a handler can treat it the same as
 * "resume from the beginning".
 *
 * The handler decides what to replay — the framework only surfaces the value.
 */
const lastEventId = (request: Request): string | undefined => {
    const header = request.headers.get("last-event-id");

    if (header !== null) {
        return header === "" ? undefined : header;
    }

    const query = new URL(request.url).searchParams.get("lastEventId");

    return query === null || query === "" ? undefined : query;
};

/**
 * Module-unique brand marking a yielded chunk as an opt-in SSE frame that
 * carries an event id. `Symbol.for` (not a fresh `Symbol()`) keeps the key
 * stable even if this package is bundled twice into one worker, and the brand
 * means a plain user chunk that happens to have `id`/`data` fields is NOT
 * mistaken for a frame — {@link sseEvent} is the only way to opt in.
 */
const SSE_EVENT_BRAND: unique symbol = Symbol.for("@lunora/server/sse-event");

/**
 * The shape {@link sseEvent} returns and a `.stream()` handler yields to attach an
 * SSE `id:` to one chunk. The brand is REQUIRED: a plain `{ data, id }` object does
 * not satisfy it, so a yield typed `SseEvent<T>` is always a frame the pump unwraps,
 * and the chunk type codegen derives from it is the type that reaches the wire.
 */
interface SseEvent<R> {
    readonly data: R;
    readonly id: string;
    readonly [SSE_EVENT_BRAND]: true;
}

/**
 * Wrap a chunk so the SSE pump emits `id: <id>` immediately before its `data:`
 * line:
 *
 * ```ts
 * httpRoute.get("/api/logs").stream(async function* logs() {
 *     for await (const entry of tail()) {
 *         yield sseEvent({ data: entry, id: entry.seq });
 *     }
 * });
 * ```
 *
 * `data` goes through the same wire codec and per-chunk `.output()` enforcement
 * as a plain yield; the wrapper is transport, not part of the user's contract.
 */
const sseEvent = <R>(frame: { data: R; id: string }): SseEvent<R> => {
    return { [SSE_EVENT_BRAND]: true, data: frame.data, id: frame.id };
};

const isSseEvent = (value: unknown): value is SseEvent<unknown> =>
    typeof value === "object" && value !== null && (value as Partial<SseEvent<unknown>>)[SSE_EVENT_BRAND] === true;

/** A header or SSE field value that cannot break out of its line. */
const isSafeHeaderValue = (value: string): boolean => !(value.includes("\r") || value.includes("\n") || value.includes("\0"));

/**
 * Format one SSE frame. Each frame ends with `\n\n`, the spec-required
 * separator. `event:` is omitted for `data` (the default event name); we use
 * named events only for the terminal sentinels (`complete`, `error`). `id:` is
 * omitted unless the chunk opted in via {@link sseEvent}.
 *
 * A default `data` frame carries a user chunk, so it goes through the wire codec
 * — the same bracketing the WS stream path has always had, and which this
 * transport was missing on both ends. Bare `JSON.stringify` flattens a `Date` to
 * an ISO string, an `ArrayBuffer` to `{}` and `NaN` to `null` (all still typed
 * as the declared yield type on the client), and throws outright on a `bigint`,
 * killing the stream mid-flight with a redacted "Internal error".
 *
 * The terminal sentinels are NOT encoded: `complete` carries `{}` and `error`
 * carries a plain `{ code, message }` that the client reads without decoding.
 */
const sseFrame = (chunk: unknown, event?: "complete" | "error", id?: string): string => {
    const data = JSON.stringify(event === undefined ? encodeWire(chunk) : chunk);

    // An id is written verbatim into an `id:` line, so a line break in it would
    // end the frame early and let the id inject `event:` / `data:` lines.
    if (id !== undefined && !isSafeHeaderValue(id)) {
        throw new LunoraError("INTERNAL", "sseEvent id must not contain CR, LF or NUL");
    }

    const idLine = id === undefined ? "" : `id: ${id}\n`;
    const prefix = event ? `event: ${event}\n` : "";

    return `${idLine}${prefix}data: ${data}\n\n`;
};

/**
 * Encode one yielded chunk into a default SSE frame. `.output()` is enforced
 * HERE — the pump's per-chunk contract check — against the chunk itself, or
 * against a branded {@link sseEvent}'s inner `data` (the wrapper is transport,
 * not the user's contract). A violating chunk throws out of the pump into its
 * catch and becomes a redacted `event: error` frame, the same verdict the RPC
 * and REST paths reach for a contract breach — a wrong chunk is not a stream
 * that keeps going.
 */
const frameChunk = (output: Validator | undefined, chunk: unknown): string => {
    if (isSseEvent(chunk)) {
        const data = output ? applyOutput(output, chunk.data) : chunk.data;

        return sseFrame(data, undefined, chunk.id);
    }

    return sseFrame(output ? applyOutput(output, chunk) : chunk);
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
            // KNOWN CEILING — no backpressure. The whole user iterator is driven
            // inside `start()`, enqueueing every chunk without consulting
            // `controller.desiredSize`, so a generator that yields faster than the
            // client reads buffers the difference in worker memory. Cancel IS
            // honored (see `cancel()` above and the `ac.signal` check below), so
            // nothing keeps running past a disconnect — this is a memory ceiling on
            // a live stream, not a leak.
            //
            // Deliberately left: draining on demand means hoisting the iterator and
            // pulling one chunk per `pull()`, which rewrites the abort / terminal-
            // frame / error-frame ordering this block already carries a scar from
            // (see the post-loop re-check). Do it when a real stream is observed
            // outrunning its reader; the fix is internal and does not move the public surface.
            async start(controller) {
                try {
                    const iterator = userHandler({ ctx: context, params, request, searchParams, signal: ac.signal });

                    for await (const chunk of iterator) {
                        if (ac.signal.aborted) {
                            break;
                        }

                        // SSE was the one result path that skipped `applyOutput`,
                        // whose own contract is "every result-parsing site (RPC,
                        // REST, any future transport) must route through this
                        // helper" — so `.output()` is enforced per chunk inside
                        // `frameChunk`, alongside the branded-`sseEvent` framing.
                        controller.enqueue(encoder.encode(frameChunk(state.output, chunk)));
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
 * True when `value` is safe to use as an HTTP header field-value: no CR, LF, or
 * NUL. Guards against response-header injection / `Headers`-construction throws
 * when reflecting attacker-influenced object metadata (e.g. a stored
 * `Content-Type`). Exported (see the `export {}` at the file end) so an `httpAction`
 * handler can guard a request-derived header value before writing it — the fix the
 * `http_action_response_header_injection` advisor lint points to.
 */

export { httpAction, httpRoute, httpRouter, isSafeHeaderValue, lastEventId, sseEvent };

export type {
    HttpActionCtx,
    HttpActionHandler,
    HttpMethod,
    HttpRoute,
    HttpRouteBuilder,
    HttpRouteFactory,
    HttpRouteHandlerOptions,
    HttpRunners,
    HttpStreamHandlerOptions,
    LivePublisher,
    LivePublishOptions,
    LunoraHttpApp,
    LunoraHttpEnv,
    LunoraRouteHandler,
    ShardFetch,
    ShardFetchInit,
    SseEvent,
};
