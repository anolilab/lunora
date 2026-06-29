/**
 * The subset of the Cloudflare `ExecutionContext` the Lunora worker entry and
 * the framework mount seams rely on — `waitUntil` for fire-and-forget work that
 * must outlive the response, and `passThroughOnException` for the top-level
 * error posture.
 *
 * It is deliberately **not** a package. `@lunora/runtime` is the leaf server
 * runtime and `@lunora/nuxt` is a framework integration that intentionally does
 * not depend on `@lunora/runtime`'s worker types, yet both need this exact
 * shape: the runtime to build/forward the worker `fetch`, Nuxt to forward an
 * inbound request to the user's composed worker. Each imports this file by
 * relative path and the bundler (packem/rollup) inlines it: no runtime
 * dependency edge is created, the helper is duplicated only in emitted output,
 * never in source. One source of truth, zero deps. See AGENTS.md → "Top-level
 * `shared/` — bundler-inlined source".
 *
 * Both methods are **optional**: a real Cloudflare `ExecutionContext` always
 * supplies them, but a host that mounts Lunora as a sub-handler (Nitro/H3, a
 * non-Cloudflare preview, a unit test) may hand over a partial context or none
 * at all. Callers therefore invoke them defensively (`ctx.waitUntil?.(…)`) or
 * fall back to {@link NOOP_EXECUTION_CONTEXT}.
 */
export interface ExecutionContextLike {
    passThroughOnException?: () => void;
    waitUntil?: (promise: Promise<unknown>) => void;
}

/**
 * No-op `ExecutionContext` used when the host runtime didn't supply one (a
 * non-Cloudflare preview, or a unit test), so the worker's `fetch` always
 * receives a valid third argument.
 */
export const NOOP_EXECUTION_CONTEXT: ExecutionContextLike = {
    passThroughOnException: () => {},
    waitUntil: () => {},
};
