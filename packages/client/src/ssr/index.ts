/**
 * `@cirrus/client/ssr` — the framework-neutral server contract that every Cirrus
 * meta-framework adapter (React, Solid, Svelte, Vue) depends on. It owns the
 * server-side seam: a request-scoped HTTP RPC client, session resolution from
 * the inbound request, query preloading, and the dehydrate/serialize helpers
 * for handing a preloaded snapshot to the client. Nothing here opens a
 * WebSocket or touches a UI framework, so it is safe to import from any SSR
 * loader.
 */

// Preload a query into a serializable snapshot (re-exported from the client
// root, the canonical home of `preloadQuery`).
export { preloadedQueryResult, preloadQuery } from "../index";
// Shared types every adapter needs for SSR data loading.
export type { ArgsOf, FunctionReference, Preloaded, ReturnOf } from "../index";

// Resolve `{ user, session } | null` from the inbound request + a better-auth
// instance (structurally typed, no hard `@cirrus/auth` dependency).
export type { AuthLike, HeadersSource, ServerSession } from "./get-server-session";
export { getServerSession } from "./get-server-session";
// Dehydrate helpers: embed a `Preloaded` token in HTML and read it back.
export { deserializePreloaded, serializePreloaded } from "./serialize-preloaded";

// Request-scoped HTTP RPC client, safe in any SSR loader (no WS).
export type { ServerClientOptions } from "./server-client";
export { createServerClient } from "./server-client";
