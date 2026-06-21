/**
 * Connection-lifecycle hooks — run user code when a client's WebSocket connects
 * or disconnects.
 *
 * Unlike presence (a client heartbeat + read-time TTL filter), these fire
 * **server-side, once per socket**, the instant the connection opens or drops —
 * the basis for immediate presence/cleanup with no TTL lag. A hook is an
 * internal mutation tagged with the lifecycle side it fires on; codegen collects
 * the tagged exports into the generated `LUNORA_LIFECYCLE_HOOKS` manifest and the
 * DO dispatches them from `webSocketMessage` (connect) / `webSocketClose`
 * (disconnect), under the connecting user's **verified** identity (the runtime
 * wires `resolveIdentity` into the WS upgrade).
 *
 * ```ts
 * // lunora/lifecycle.ts
 * import { onConnect, onDisconnect } from "@lunora/server";
 *
 * export const connected = onConnect(async (ctx, event) => {
 *     ctx.log.info("connected", event.connectionId, ctx.auth.userId);
 * });
 *
 * export const disconnected = onDisconnect(async (ctx, event) => {
 *     // event.context is whatever the client passed to `connect({ context })`
 *     await ctx.db.insert("audit", { userId: ctx.auth.userId, at: Date.now() });
 * });
 * ```
 *
 * The hook receives a {@link LifecycleEvent} (`connectionId`, `shardKey`,
 * optional client `context`, `userId`); richer identity claims are on
 * `ctx.auth`. Hooks are internal — a client can never invoke one directly.
 *
 * Both sides fire **once per socket, unconditionally** — `onConnect` the instant
 * the socket opens (the client announces every connection, with or without a
 * registered `context`) and `onDisconnect` the instant it closes. Registering a
 * connection `context` on the client is optional: it only enriches the event and
 * is replayed to `onDisconnect`; it is never required to make either hook run.
 */

import type { LifecycleEvent, MutationCtx as MutationContext, RegisteredLifecycleHook } from "./types";

/** Handler for a connection-lifecycle hook. */
type LifecycleHandler = (context: MutationContext, event: LifecycleEvent) => Promise<void> | void;

/**
 * Wrap a lifecycle handler as an internal mutation tagged with its side. The
 * event is forwarded verbatim (no validator map — its shape is framework-fixed),
 * so this bypasses the arg-parsing the `query`/`mutation` factories apply.
 */
const wrapLifecycle = (lifecycle: "connect" | "disconnect", handler: LifecycleHandler): RegisteredLifecycleHook => {
    return {
        args: {},
        handler: (context: unknown, event: unknown) => handler(context as MutationContext, event as LifecycleEvent),
        kind: "mutation",
        lifecycle,
        visibility: "internal",
    };
};

/** Register a hook that fires once when a client's WebSocket connects. */
const onConnect = (handler: LifecycleHandler): RegisteredLifecycleHook => wrapLifecycle("connect", handler);

/** Register a hook that fires once when a client's WebSocket disconnects. */
const onDisconnect = (handler: LifecycleHandler): RegisteredLifecycleHook => wrapLifecycle("disconnect", handler);

export { onConnect, onDisconnect };
export type { LifecycleHandler };
