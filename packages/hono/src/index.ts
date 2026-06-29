/**
 * `@lunora/hono` — the Hono integration for Lunora: single-worker composition.
 *
 * Hono is a pure HTTP framework with no reactive UI layer, so this package owns
 * only the **server/composition seam** (it ships no client adapter — reactivity
 * comes from `@lunora/client` / `@lunora/react` / … on the browser side). Its job
 * is to let Lunora's realtime plane (`/_lunora/rpc`, `/_lunora/ws`,
 * `/_lunora/admin/*`) ride *inside* a Hono app you already own, so one Worker
 * serves both your Hono routes and Lunora — one deploy, same origin.
 *
 * Two directions, mirroring the other framework adapters:
 *
 * 1. **Hono owns the entry** (the common case) — mount Lunora as a Hono middleware
 * at `/_lunora/*`. {@link mountLunora} wraps `new Hono()` and returns the *same*
 * typed app, so it drops into your `const app = …` declaration and the rest of
 * your code stays 100% plain Hono:
 *
 * ```ts
 * import { Hono } from "hono";
 * import { mountLunora } from "@lunora/hono";
 *
 * const app = mountLunora(new Hono&lt;{ Bindings: Env }>());
 * app.get("/", (c) => c.text("hi"));
 * export default app;
 * ```
 *
 * 2. **Lunora owns the entry** — wrap a Hono app as the SSR/REST fallthrough of the
 * shared composer (the same `withFrameworkWorker` behind `@lunora/svelte/worker`,
 * `@lunora/vue/worker`, and `@lunora/astro`), re-exported here as `withLunora`
 * for symmetry.
 *
 * The framework-neutral reactive-loader server helpers live in
 * `@lunora/hono/server` (a re-export of `@lunora/client/ssr`).
 */
import type { ExecutionContextLike, FrameworkWorkerOptions, ShardNamespaceLike } from "@lunora/runtime";
import { createWorker } from "@lunora/runtime";
import type { Context, Env, Hono, MiddlewareHandler, Schema } from "hono";

/**
 * Lunora options for the Hono middleware. Either an `(env) => options` factory
 * (full control — for bindings that only exist at request time), or a partial
 * options object whose `shardDO` defaults to the conventional `env.SHARD`
 * binding. Pass nothing for the common case and the default applies.
 */
type LunoraOptions = ((env: unknown) => FrameworkWorkerOptions) | Partial<FrameworkWorkerOptions>;

/** Path Lunora's realtime plane is mounted under inside the Hono app. */
const LUNORA_ROUTE = "/_lunora/*";

/**
 * No-op `ExecutionContext` used when the host runtime didn't supply one (e.g. a
 * non-Cloudflare preview, or a unit test), so `worker.fetch` always receives a
 * valid third argument. Mirrors `@lunora/nuxt`'s fallback.
 */
const NOOP_EXECUTION_CONTEXT: ExecutionContextLike = {
    passThroughOnException: () => {},
    waitUntil: () => {},
};

/**
 * Resolve the per-request Lunora worker options. A factory is called with the
 * request `env`; a partial object has its `shardDO` defaulted to `env.SHARD` so
 * `mountLunora(new Hono())` needs no configuration at all. Throws a clear error
 * when no shard namespace can be found — that is a wiring mistake, not a runtime
 * condition to swallow.
 */
const resolveOptions = (options: LunoraOptions, env: unknown): FrameworkWorkerOptions => {
    if (typeof options === "function") {
        return options(env);
    }

    const shardDO = options.shardDO ?? (env as { SHARD?: ShardNamespaceLike } | undefined)?.SHARD;

    if (!shardDO) {
        throw new Error("@lunora/hono: no shard Durable Object namespace found. Bind `SHARD` in wrangler.jsonc, or pass `lunora({ shardDO: env.MY_SHARD })`.");
    }

    return { ...options, shardDO };
};

/**
 * Read the Cloudflare `ExecutionContext` off the Hono context. Hono's
 * `c.executionCtx` getter *throws* when no execution context is present (rather
 * than returning `undefined`), so this is guarded — falling back to the no-op
 * context keeps the worker callable in non-Cloudflare / test runtimes.
 */
const executionContextOf = (c: Context): ExecutionContextLike => {
    try {
        return c.executionCtx;
    } catch {
        return NOOP_EXECUTION_CONTEXT;
    }
};

/**
 * A Hono middleware that hands a matched request to Lunora's realtime plane. The
 * composed worker owns `/_lunora/rpc`, `/_lunora/ws`, and `/_lunora/admin/*`; the
 * `101 Switching Protocols` upgrade Response (with its `webSocket`) is returned
 * verbatim so Hono streams the WebSocket through unchanged.
 *
 * Mount it yourself for a custom path or alongside other middleware:
 *
 * ```ts
 * app.use("/_lunora/*", lunora((env) => ({ shardDO: env.SHARD, auth })));
 * ```
 *
 * Most apps want {@link mountLunora}, which registers this at `/_lunora/*` and
 * returns the app for a one-line setup.
 */
const lunora =
    (options: LunoraOptions = {}): MiddlewareHandler =>
    (c) => {
        const worker = createWorker(resolveOptions(options, c.env));

        return worker.fetch(c.req.raw, c.env, executionContextOf(c));
    };

/**
 * Mount Lunora's realtime plane onto a Hono app at `/_lunora/*` and return the
 * same* app — typed identically, so it slots straight into your declaration and
 * everything after it is plain Hono:
 *
 * ```ts
 * const app = mountLunora(new Hono&lt;{ Bindings: Env }>());
 * app.get("/", (c) => c.text("hi"));
 * export default app;
 * ```
 *
 * `shardDO` defaults to the conventional `env.SHARD` binding, so no options are
 * needed in the common case. Pass `options` to add `auth`, `crons`, a `security`
 * posture, or a non-default shard namespace.
 */
const mountLunora = <E extends Env, S extends Schema, BasePath extends string>(app: Hono<E, S, BasePath>, options?: LunoraOptions): Hono<E, S, BasePath> => {
    app.use(LUNORA_ROUTE, lunora(options));

    return app;
};

export type { LunoraOptions };
export { lunora, mountLunora };
export type {
    ExecutionContextLike,
    FrameworkHostHandler as HonoHostHandler,
    FrameworkWorkerOptions as LunoraWorkerOptions,
    FrameworkWorkerOptionsInput as LunoraWorkerOptionsInput,
} from "@lunora/runtime";
export { withFrameworkWorker as withLunora } from "@lunora/runtime";
