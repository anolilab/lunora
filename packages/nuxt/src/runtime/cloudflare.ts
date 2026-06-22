/**
 * Resolve the Cloudflare per-request `env` (bindings) and `ExecutionContext`
 * from a Nitro/H3 event, tolerating the two shapes Nitro has shipped.
 *
 * Legacy `event.context.cloudflare.{ env, context }` — surfaced by
 * `nitro-cloudflare-dev` in `nuxt dev` and by older `cloudflare_module` builds,
 * where `context` is the `ExecutionContext` (`waitUntil` / `passThroughOnException`).
 *
 * Newer `event.req.runtime.cloudflare.{ env, ctx }` — the Nitro runtime accessor
 * (Nitro v2.10+ / Nuxt 4), where the `ExecutionContext` is `ctx`.
 *
 * Both are read defensively so the delegating handler works across the version
 * range a scaffolded app might pin, in both dev and the deployed worker. When
 * neither is present (no Cloudflare runtime — e.g. a Node preview), `env` is
 * `undefined` and the caller surfaces a clear error.
 *
 * Typed against a structural `H3EventLike` rather than `nitropack`'s `H3Event`
 * so this seam stays pure (no Nitro types needed) and unit-testable with a plain
 * object — a real `H3Event` is still assignable here.
 */

/** Cloudflare `ExecutionContext` subset Lunora uses (`waitUntil` / `passThroughOnException`). */
interface ExecutionContextLike {
    passThroughOnException?: () => void;
    waitUntil?: (promise: Promise<unknown>) => void;
}

/** The `{ env, context|ctx }` payload Nitro attaches for the Cloudflare runtime. */
interface CloudflareEventBag {
    context?: ExecutionContextLike;
    ctx?: ExecutionContextLike;
    env?: Record<string, unknown>;
}

/**
 * Structural view of the bits of an H3 event the resolver reads. Both legacy
 * (`context.cloudflare`) and current (`req.runtime.cloudflare`) shapes are
 * optional so a real H3 `H3Event` is assignable here.
 */
interface H3EventLike {
    context?: { cloudflare?: CloudflareEventBag };
    req?: { runtime?: { cloudflare?: CloudflareEventBag } };
}

/** Resolved Cloudflare runtime for one request: the bindings `env` and the optional `ExecutionContext`. */
interface ResolvedCloudflare {
    ctx?: ExecutionContextLike;
    env?: Record<string, unknown>;
}

/**
 * Pull the Cloudflare `env` + `ExecutionContext` off a Nitro/H3 event, checking
 * the legacy `event.context.cloudflare` shape first (present under
 * `nitro-cloudflare-dev` in dev) and the newer `event.req.runtime.cloudflare`
 * shape second. Returns `{}` when neither is present.
 */
const resolveCloudflare = (event: H3EventLike): ResolvedCloudflare => {
    const fromContext = event.context?.cloudflare;

    if (fromContext?.env) {
        return { ctx: fromContext.context ?? fromContext.ctx, env: fromContext.env };
    }

    const fromRuntime = event.req?.runtime?.cloudflare;

    if (fromRuntime?.env) {
        return { ctx: fromRuntime.ctx ?? fromRuntime.context, env: fromRuntime.env };
    }

    return {};
};

export type { ExecutionContextLike, H3EventLike, ResolvedCloudflare };
export { resolveCloudflare };
