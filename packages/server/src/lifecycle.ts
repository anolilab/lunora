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

import type { LifecycleEvent, MutationCtx as MutationContext, RegisteredLifecycleHook, ShardInitEvent } from "./types";

/** Handler for a connection-lifecycle hook. */
type LifecycleHandler = (context: MutationContext, event: LifecycleEvent) => Promise<void> | void;

/** Handler for a shard-init hook. */
type ShardInitHandler = (context: MutationContext, event: ShardInitEvent) => Promise<void> | void;

/**
 * Wrap a lifecycle handler as an internal mutation tagged with its side. The
 * event is forwarded verbatim (no validator map — its shape is framework-fixed),
 * so this bypasses the arg-parsing the `query`/`mutation` factories apply.
 */
const wrapLifecycle = (lifecycle: "connect" | "disconnect" | "init", handler: LifecycleHandler | ShardInitHandler): RegisteredLifecycleHook => {
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

/**
 * Register a hook that fires ONCE per Durable Object instance, before any
 * handler on that instance can run — the re-init half of `.memory()` tables.
 *
 * A shard is not a process that stays up. Cloudflare reconstructs the Durable
 * Object after every eviction, and a shard whose sockets are hibernating is
 * evicted routinely, so "cold start" is a steady-state event rather than a rare
 * one. Everything the shard held in memory is gone at that moment: the JS heap,
 * and every `.memory()` table, which the framework has already cleared by the
 * time this hook runs.
 *
 * ```ts
 * // lunora/init.ts
 * import { onShardInit } from "@lunora/server";
 *
 * export const warm = onShardInit(async (ctx, event) => {
 *     // Rebuild ephemeral state from the durable tables that outlived us.
 *     for await (const member of ctx.db.roomMembers.iterate({ where: { roomId: event.shardKey } })) {
 *         await ctx.db.presence.insert({ userId: member.userId, status: "away" });
 *     }
 * });
 * ```
 *
 * **Ordering is the guarantee.** Memory tables are cleared, then every init hook
 * runs to completion, and only then does the dispatch that triggered the cold
 * start proceed. No handler, subscription refresh, alarm, or shape poke can
 * observe a memory table in the gap. Hooks run sequentially in manifest order,
 * so one may depend on state an earlier one wrote.
 *
 * **It is a mutation, and it runs on every cold start.** Keep it cheap and keep
 * it idempotent: it is on the latency path of the request that woke the shard,
 * and it will run again — many times — over the shard's life. Writing to durable
 * tables from here is legal and occasionally right, but remember it is a
 * rebuild, not a migration; use `defineMigration` for anything that should
 * happen once.
 *
 * **No caller identity.** The hook dispatches as a trusted system call with no
 * request identity — `ctx.auth` is anonymous and RLS does not apply, exactly as
 * for a cron tick. A throw is logged and does NOT fail the dispatch that woke
 * the shard: an init hook that cannot rebuild presence must not take the whole
 * shard down with it, and the memory table is simply left empty.
 */
const onShardInit = (handler: ShardInitHandler): RegisteredLifecycleHook => wrapLifecycle("init", handler);

export { onConnect, onDisconnect, onShardInit };
export type { LifecycleHandler, ShardInitHandler };
