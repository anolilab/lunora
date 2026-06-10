/**
 * Server-side data-loading helpers for the Svelte adapter — re-exported from
 * `@cirrus/ssr`, the framework-neutral server contract (one implementation
 * shared across every adapter, not re-declared here).
 *
 * Opens no WebSocket and touches no browser globals, so it is safe to import
 * from a SvelteKit `+page.ts` / `+layout.ts` `load`: build a request-scoped
 * client with `createServerClient` (forwarding SvelteKit's `fetch` for the
 * session cookie), run `preloadQuery`, then hand the serializable `Preloaded`
 * token to `hydratePreloaded` on the client.
 */
export type { ArgsOf, AuthLike, FunctionReference, HeadersSource, Preloaded, ReturnOf, ServerClientOptions, ServerSession } from "@cirrus/ssr";
export { createServerClient, deserializePreloaded, getServerSession, preloadedQueryResult, preloadQuery, serializePreloaded } from "@cirrus/ssr";
