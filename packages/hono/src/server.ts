/**
 * Server-side data-loading helpers for the Hono integration — re-exported from
 * `@lunora/client/ssr`, the framework-neutral server contract (one implementation
 * shared across every adapter, not re-declared here).
 *
 * Opens no WebSocket and touches no browser globals, so it is safe to import from
 * a Hono handler running SSR (e.g. `hono/jsx` renderer): build a request-scoped
 * client with `createServerClient`, run `preloadQuery`, then hand the
 * serializable `Preloaded` token to whichever island/client adapter's
 * `hydratePreloaded` your frontend ships (`@lunora/react`, `@lunora/solid`,
 * `@lunora/svelte`, `@lunora/vue`).
 *
 * Hono has no reactive UI layer of its own, so `@lunora/hono` owns the
 * server/composition seam and delegates the client-side "SSR-seed → live" handoff
 * to the chosen client adapter.
 */
export type { ArgsOf, AuthLike, FunctionReference, HeadersSource, Preloaded, ReturnOf, ServerClientOptions, ServerSession } from "@lunora/client/ssr";
export { createServerClient, deserializePreloaded, getServerSession, preloadedQueryResult, preloadQuery, serializePreloaded } from "@lunora/client/ssr";
