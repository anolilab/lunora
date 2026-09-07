/**
 * Analog (Nitro) server route mounted at `/_lunora/**`. It is the single-worker
 * seam: every Lunora RPC (`POST /_lunora/rpc`), WebSocket upgrade
 * (`/_lunora/ws`), and admin request (`/_lunora/admin/*`) is forwarded to the
 * project's Lunora worker, which runs *inside* this same Nitro/Cloudflare worker
 * that Analog deploys as.
 *
 * Analog mounts files under `src/server/routes/` directly at the URL path (no
 * `/api` prefix — that prefix only applies to `src/server/routes/api/`). So this
 * `_lunora/[...].ts` catch-all owns `/_lunora/**`.
 *
 * The Lunora worker is imported from `~/../lunora/server` (`defineApp().build()`,
 * which also re-exports `ShardDO`). The same `ShardDO` reaches the deployed
 * Cloudflare worker entrypoint via the project root's `worker.ts` wrapper
 * (`wrangler.jsonc`'s `main`), so one deploy carries both the SSR handler and
 * the Durable Object class.
 *
 * `defineEventHandler`, `getRequestURL`, `toWebRequest` and friends are
 * Nitro/H3 utilities; on Cloudflare the inbound request is already a Web
 * `Request`, so the lift is thin. This module is only ever bundled by Nitro.
 */
import { defineEventHandler, toWebRequest } from "h3";

// The Lunora worker (`defineApp().build()` result). Relative path from
// `src/server/routes/_lunora/` up to the project-root `lunora/` directory.
import lunoraApp from "../../../../lunora/server";

/** Cloudflare `ExecutionContext` subset Lunora uses (`waitUntil` / `passThroughOnException`). */
interface ExecutionContextLike {
    passThroughOnException?: () => void;
    waitUntil?: (promise: Promise<unknown>) => void;
}

/** A no-op `ExecutionContext` for when the runtime didn't supply one. */
const NOOP_EXECUTION_CONTEXT: ExecutionContextLike = {
    passThroughOnException: () => {},
    waitUntil: () => {},
};

/**
 * Pull the Cloudflare `env` (bindings, carrying `SHARD`) + `ExecutionContext`
 * off the Nitro event, tolerating both the legacy `event.context.cloudflare`
 * shape and the newer `event.req.runtime.cloudflare` shape. Returns `{}` when
 * neither is present (no Cloudflare runtime — e.g. a Node preview).
 *
 * Mirrors `@lunora/nuxt`'s `resolveCloudflare`/`delegateToLunora` seam, inlined
 * because a scaffolded template can't depend on that adapter package — keep the
 * two in sync if the Nitro Cloudflare-runtime shapes change.
 */
const resolveCloudflare = (event: unknown): { ctx?: ExecutionContextLike; env?: Record<string, unknown> } => {
    const anyEvent = event as {
        context?: { cloudflare?: { context?: ExecutionContextLike; ctx?: ExecutionContextLike; env?: Record<string, unknown> } };
        req?: { runtime?: { cloudflare?: { context?: ExecutionContextLike; ctx?: ExecutionContextLike; env?: Record<string, unknown> } } };
    };

    const fromContext = anyEvent.context?.cloudflare;

    if (fromContext?.env) {
        return { ctx: fromContext.context ?? fromContext.ctx, env: fromContext.env };
    }

    const fromRuntime = anyEvent.req?.runtime?.cloudflare;

    if (fromRuntime?.env) {
        return { ctx: fromRuntime.ctx ?? fromRuntime.context, env: fromRuntime.env };
    }

    return {};
};

/**
 * Forward `/_lunora/**` to the Lunora worker. We reconstruct a Web `Request`
 * from the H3 event (Lunora speaks the Web Fetch contract — RPC bodies and the
 * WebSocket `Upgrade` handshake), resolve the Cloudflare `env`/`ExecutionContext`
 * off the event, and return the worker's `Response` verbatim (Nitro streams it,
 * including a `101 Switching Protocols` upgrade with its `webSocket`).
 */
export default defineEventHandler(async (event) => {
    const { ctx, env } = resolveCloudflare(event);

    if (!env) {
        return Response.json(
            {
                error: {
                    code: "LUNORA_RUNTIME_UNAVAILABLE",
                    message:
                        "Lunora could not read the Cloudflare bindings from the request. The `/_lunora/**` route only works on the Cloudflare Workers runtime (deployed, or dev with the Cloudflare Nitro runtime enabled).",
                },
            },
            { status: 500 },
        );
    }

    const request = toWebRequest(event);

    return lunoraApp.fetch(request, env, ctx ?? NOOP_EXECUTION_CONTEXT);
});
