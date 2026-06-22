/**
 * The Lunora ↔ Nitro delegation seam. Given a Lunora worker (the
 * `defineApp().build()` app or a bare `createWorker(...)` result) and the
 * Cloudflare runtime resolved off the request event, forward the inbound
 * `Request` — RPC (`POST /_lunora/rpc`), WebSocket upgrade (`/_lunora/ws`), and
 * the admin plane (`/_lunora/admin/*`) — straight to `worker.fetch`.
 *
 * This is the single-worker composition the void.cloud Nuxt approach uses,
 * inverted: instead of Lunora owning the worker entry, Lunora is mounted
 * inside* Nitro as a server route, and the `ShardDO` class is re-exported to
 * the Cloudflare worker entrypoint via the project's `exports.cloudflare.ts`.
 *
 * Kept framework-neutral (a `LunoraWorkerLike` + the resolved `env`/`ctx`, not
 * an H3 event) so it can be unit-tested with a stub worker — no Nuxt or workerd
 * boot required. The thin H3 adapter that reads `env`/`ctx` off the event and
 * the raw `Request`/`Response` lives in the `[...].ts` route module.
 */
import type { ExecutionContextLike } from "./cloudflare";

/**
 * Structural view of the Lunora worker the route delegates to — just the
 * `fetch` entrypoint. Both `createWorker(...)` and the generated
 * `defineApp().build()` app satisfy it (a `ComposedApp` is a superset). Declared
 * locally so `@lunora/nuxt` doesn't hard-depend on `@lunora/runtime`'s worker type.
 */
interface LunoraWorkerLike {
    fetch: (request: Request, env: unknown, context: ExecutionContextLike) => Promise<Response> | Response;
}

/** A no-op `ExecutionContext` used when the Cloudflare runtime didn't supply one (so `worker.fetch` always gets a valid 3rd arg). */
const NOOP_EXECUTION_CONTEXT: ExecutionContextLike = {
    passThroughOnException: () => {},
    waitUntil: () => {},
};

/**
 * Forward one inbound request to the Lunora worker. `env` must be the Cloudflare
 * bindings (carrying the `SHARD` Durable Object namespace); when it is missing
 * the Cloudflare runtime wasn't available (e.g. a non-CF preview), so we answer
 * a clear 500 rather than handing the worker an `undefined` env.
 */
const delegateToLunora = async (
    worker: LunoraWorkerLike,
    request: Request,
    env: Record<string, unknown> | undefined,
    context?: ExecutionContextLike,
): Promise<Response> => {
    if (!env) {
        return Response.json(
            {
                error: {
                    code: "LUNORA_RUNTIME_UNAVAILABLE",
                    message:
                        "Lunora could not read the Cloudflare bindings from the request. The `/_lunora/**` route only works on the Cloudflare Workers runtime (deployed, or `nuxt dev` with `nitro-cloudflare-dev`).",
                },
            },
            { status: 500 },
        );
    }

    return worker.fetch(request, env, context ?? NOOP_EXECUTION_CONTEXT);
};

export type { LunoraWorkerLike };
export { delegateToLunora, NOOP_EXECUTION_CONTEXT };
