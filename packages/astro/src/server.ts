/**
 * Server-side data-loading helpers for the Astro integration — re-exported from
 * `@lunora/client/ssr`, the framework-neutral server contract (one implementation
 * shared across every adapter, not re-declared here).
 *
 * Opens no WebSocket and touches no browser globals, so it is safe to import
 * from an Astro server endpoint or a `.astro` component's frontmatter (which
 * runs server-side during SSR): build a request-scoped client with
 * `createServerClient`, run `preloadQuery`, then hand the serializable
 * `Preloaded` token to whichever island adapter's `hydratePreloaded` you ship
 * (`@lunora/react`, `@lunora/solid`, `@lunora/svelte`, `@lunora/vue`).
 *
 * Astro is multi-framework at the UI layer — reactivity comes from the island
 * adapter the app picks, not from this package — so `@lunora/astro` owns the
 * server/composition seam and delegates the client-side "SSR-seed → live"
 * handoff to the chosen adapter.
 */
export type { ArgsOf, AuthLike, FunctionReference, HeadersSource, Preloaded, ReturnOf, ServerClientOptions, ServerSession } from "@lunora/client/ssr";
export { createServerClient, deserializePreloaded, getServerSession, preloadedQueryResult, preloadQuery, serializePreloaded } from "@lunora/client/ssr";
