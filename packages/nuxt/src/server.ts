/**
 * Server-side data-loading helpers for the Nuxt adapter — re-exported from
 * `@lunora/client/ssr`, the framework-neutral server contract (one implementation
 * shared across every adapter, not re-declared here).
 *
 * Opens no WebSocket and touches no browser globals, so it is safe to import
 * from a Nitro server route or any SSR context: build a request-scoped client
 * with `createServerClient`, run `preloadQuery`, then hand the serializable
 * `Preloaded` token to `hydratePreloaded` on the client.
 */
export type { ArgsOf, AuthLike, FunctionReference, HeadersSource, Preloaded, ReturnOf, ServerClientOptions, ServerSession } from "@lunora/client/ssr";
export { createServerClient, deserializePreloaded, getServerSession, preloadedQueryResult, preloadQuery, serializePreloaded } from "@lunora/client/ssr";
