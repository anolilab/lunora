/**
 * `onWhisper` — per-topic authorization for the ephemeral whisper channel.
 *
 * Whispers (`client.whisperSubscribe` / `client.whisper`) relay a payload between
 * sockets on a shard without touching SQLite, the CDC log, or any query — which
 * is exactly what makes them cheap enough for cursors and typing indicators, and
 * exactly what leaves them outside RLS. Without an authorizer the only boundary a
 * whisper topic has is the shard itself: any client that can open a socket to the
 * shard can join, read, and inject on any topic name.
 *
 * A whisper authorizer closes that. It is a read-only check the shard runs before
 * a socket joins a topic and before it broadcasts to one:
 *
 * ```ts
 * // lunora/whisper.ts
 * import { onWhisper } from "@lunora/server";
 *
 * export const authorize = onWhisper(async (ctx, event) => {
 *     const [kind, roomId] = event.topic.split(":");
 *
 *     if (kind !== "room") {
 *         return false;
 *     }
 *
 *     return ctx.db.roomMembers.findFirst({ where: { roomId, userId: ctx.auth.userId } }) !== null;
 * });
 * ```
 *
 * # It is a query, and it fails closed
 *
 * The handler runs as an internal **query** under the socket's verified identity,
 * so `ctx.auth` is the connecting user and `ctx.db` is RLS-scoped to them — but it
 * cannot write. An authorization check that mutates is a check you cannot re-run,
 * and the shard re-runs this one.
 *
 * Only a literal `true` allows. A handler that returns anything else — including
 * `undefined` from a forgotten `return` — denies, and a handler that **throws**
 * denies and logs. A broken authorizer must not open a topic.
 *
 * # Registering one is opt-in; not registering one keeps today's behaviour
 *
 * With no `onWhisper` export the shard allows every topic, as it always has:
 * cursor demos and typing indicators keep working with no app changes. Register
 * one and it governs every topic — there is no per-topic opt-out, because a
 * default-allow hole is the thing this exists to remove. Route on the topic name
 * (`presence:*` open, `room:*` checked) inside the handler.
 *
 * Multiple exports are AND-ed: every registered authorizer must allow.
 *
 * # What it costs, and the memoisation ceiling
 *
 * A cursor stream sends many whispers a second, and running a database query per
 * frame would make the cheap primitive expensive. So the shard memoises the
 * verdict per (socket, topic) for the life of the socket's in-memory state: the
 * query runs on the first subscribe and the first send, not on every frame.
 *
 * The ceiling that buys: revoking a user's membership does NOT evict them from a
 * topic they already joined — they keep receiving until the socket drops or the
 * Durable Object hibernates (which clears the memo, so the next frame re-checks).
 * Whispers are transient awareness with no durable trace; if a topic carries
 * something that must stop the instant access is revoked, it does not belong on a
 * whisper topic. Use a query with RLS.
 */

import type { QueryCtx as QueryContext, RegisteredFunction, WhisperEvent } from "./types";

/** Handler for a whisper authorizer. Return `true` to allow; anything else denies. */
type WhisperAuthorizeHandler = (context: QueryContext, event: WhisperEvent) => boolean | Promise<boolean>;

/**
 * A registered whisper authorizer — an internal query tagged `lifecycle:
 * "whisper"`.
 *
 * Typed separately from `RegisteredLifecycleHook` (an internal mutation returning
 * `void`) on both counts: this one reports a verdict the shard acts on, and it
 * must not be able to write while doing so.
 */
type RegisteredWhisperAuthorizer = RegisteredFunction<Record<string, never>, boolean, "query"> & { readonly lifecycle: "whisper" };

/**
 * Register a whisper-topic authorizer. See the module docblock for the verdict
 * rules, the opt-in default, and the memoisation ceiling.
 */
const onWhisper = (handler: WhisperAuthorizeHandler): RegisteredWhisperAuthorizer => {
    return {
        args: {},
        handler: async (context: unknown, args: unknown): Promise<boolean> => {
            // `unknown`, so the strict `=== true` is a real check rather than a
            // tautology the compiler sees through. The declared return type is
            // `boolean` for the author's benefit; nothing enforces it at runtime,
            // and truthy-widening a returned membership ROW into an allow is the
            // exact mistake this normalisation exists to refuse.
            const verdict: unknown = await handler(context as QueryContext, args as WhisperEvent);

            return verdict === true;
        },
        kind: "query",
        lifecycle: "whisper",
        visibility: "internal",
    };
};

export { onWhisper };
export type { RegisteredWhisperAuthorizer, WhisperAuthorizeHandler };
