/**
 * Presence functions — added by `lunora add presence`.
 *
 * This file is YOURS: it's a normal Lunora module, copied into your project so
 * you own and edit it. Re-export these from your `lunora/` entry (or rely on
 * file-based discovery) so codegen picks them up — they surface in the generated
 * `api` as `presence/heartbeat`, `presence/listPresent`, `presence/sweep`.
 *
 *   - **heartbeat** (mutation) — upsert the caller's presence row for a room and
 *     stamp `lastSeen = now`. Keyed by `(roomId, sessionId)`, so a re-heartbeat
 *     *patches* the existing row: subscribers receive a single-row delta, not an
 *     insert/delete churn that would re-send the whole present list.
 *   - **listPresent** (query) — the non-expired members of a room, newest
 *     heartbeat first. Subscribe to it for a reactive "who's here" list; the TTL
 *     filter ({@link PRESENCE_TTL_MS}) drops members that stopped heart-beating,
 *     so no client-side reaping is needed.
 *   - **sweep** (internal mutation) — hard-delete the expired rows for a room.
 *     Stale rows already vanish from `listPresent` via the read-time filter; this
 *     only reclaims storage. It's *internal* (server-only) so a client can't
 *     trigger bulk deletes — wire it to a cron / `runAfter` if you want it.
 *
 * The client half is `usePresence` in `@lunora/react`, which calls `heartbeat`
 * on an interval and subscribes to `listPresent`.
 */
import { LunoraError } from "@lunora/errors";
import { RateLimiter, rateLimit, createMemoryStore } from "@lunora/ratelimit";

import { internalMutation, mutation, query, v } from "#lunora/_generated/server.js";

import { PRESENCE_TABLE, PRESENCE_TTL_MS } from "./schema.js";

export { presence } from "./schema.js";

/**
 * Per-session rate limit for the public `heartbeat` mutation — clients call it on
 * an interval, so cap the rate to defend against a runaway/forged loop. The
 * default store is in-memory (per-isolate, resets on eviction); run
 * `lunora add ratelimit` for a durable, `ctx.db`-backed store in production.
 */
const limiter = new RateLimiter({
    config: {
        heartbeat: { kind: "token bucket", period: 60_000, rate: 120 },
    },
    store: createMemoryStore(),
});

/** A single present member as returned by `listPresent`. */
interface PresenceMember {
    /** Opaque awareness blob (selection, cursor, name, color…). */
    data?: Record<string, unknown>;
    /** Last heartbeat time (epoch ms). */
    lastSeen: number;
    /** The room / channel / document this presence is scoped to. */
    roomId: string;
    /** Stable per-tab / per-connection id. */
    sessionId: string;
    /** Authenticated user id, when known. */
    userId?: string;
}

/**
 * Upsert the caller's presence row for `roomId` and stamp `lastSeen = now`.
 * Patches the existing `(roomId, sessionId)` row on re-heartbeat so subscribers
 * get a single-row delta.
 */
export const heartbeat = mutation
    .input({
        // Awareness payload (cursor, status, color, …) — a bounded map of scalar
        // values rather than `v.any()`, so a public client can't smuggle an
        // unvalidated/oversized blob. Widen the value union if you need more.
        data: v.optional(v.record(v.string(), v.union(v.string().max(1024), v.number(), v.boolean()))),
        roomId: v.string().max(256),
        sessionId: v.string().max(256),
    })
    // Keyed by the authenticated caller, falling back to the server-trusted
    // `ctx.ip` (Cloudflare's `CF-Connecting-IP`, forwarded server-side, never read
    // from a client header). Without the `ctx.ip` hop every anonymous client
    // shares one `"anon"` bucket, so a single one exhausts the limit for all of
    // them — see the `ratelimit_key_spoofable_or_global` advisor lint.
    .use(rateLimit(limiter, "heartbeat", { key: (ctx) => ctx.auth.userId ?? ctx.ip ?? "anon" }))
    .mutation(async ({ args: { data, roomId, sessionId }, ctx }): Promise<{ lastSeen: number }> => {
        const lastSeen = ctx.now;
        const userId = ctx.auth.userId ?? undefined;

        const existing = await ctx.db
            .query(PRESENCE_TABLE)
            .withIndex("byRoomSession", (q) => q.eq("roomId", roomId).eq("sessionId", sessionId))
            .first();

        // Ownership guard. `sessionId` is client-supplied and `listPresent`
        // exposes it to every room subscriber, so without this a participant
        // could reuse another visible `sessionId` and overwrite that member's
        // presence row. Reject a heartbeat that targets a row owned by a
        // *different* authenticated user; an anonymous caller (no `userId`)
        // likewise may not patch a row that belongs to an authenticated user.
        if (existing && existing["userId"] !== undefined && existing["userId"] !== userId) {
            // Coded, not a bare `Error`: an uncoded throw is redacted to a
            // generic 500, so the caller sees a server fault instead of the
            // ownership refusal.
            throw new LunoraError(
                "FORBIDDEN",
                "presence/heartbeat: sessionId belongs to a different user — refusing to overwrite another participant's presence.",
            );
        }

        const row: Record<string, unknown> = {
            lastSeen,
            roomId,
            sessionId,
            ...(data === undefined ? {} : { data }),
            ...(userId === undefined ? {} : { userId }),
        };

        await (existing ? ctx.db.patch(existing["_id"] as never, row) : ctx.db.insert(PRESENCE_TABLE, row));

        return { lastSeen };
    });

/**
 * Live query: the non-expired members of `roomId`, newest heartbeat first.
 * Subscribe to it for a reactive present-list.
 */
export const listPresent = query.input({ roomId: v.string().max(256) }).query(async ({ args: { roomId }, ctx }): Promise<PresenceMember[]> => {
    const cutoff = ctx.now - PRESENCE_TTL_MS;

    const rows = await ctx.db
        .query(PRESENCE_TABLE)
        .withIndex("byRoomSession", (q) => q.eq("roomId", roomId))
        .collect();

    return rows
        .filter((row) => (row["lastSeen"] as number) > cutoff)
        .map((row) => {
            const member: PresenceMember = {
                lastSeen: row["lastSeen"] as number,
                roomId: row["roomId"] as string,
                sessionId: row["sessionId"] as string,
            };

            if (row["userId"] !== undefined) {
                member.userId = row["userId"] as string;
            }

            if (row["data"] !== undefined) {
                member.data = row["data"] as Record<string, unknown>;
            }

            return member;
        })
        .toSorted((a, b) => b.lastSeen - a.lastSeen);
});

/**
 * Hard-delete every expired row for `roomId`. Internal (server-only) — schedule
 * it from a cron / `runAfter` to reclaim storage. Stale rows already vanish from
 * `listPresent` via the read-time TTL filter, so this is purely housekeeping.
 */
export const sweep = internalMutation.input({ roomId: v.string() }).mutation(async ({ args: { roomId }, ctx }): Promise<{ deleted: number }> => {
    const cutoff = ctx.now - PRESENCE_TTL_MS;

    const stale = await ctx.db
        .query(PRESENCE_TABLE)
        .withIndex("byRoomSession", (q) => q.eq("roomId", roomId))
        .filter((row) => (row["lastSeen"] as number) <= cutoff)
        .collect();

    // One room's expired members is a small set sharing the mutation's
    // snapshot — fire the deletes together.
    await Promise.all(stale.map((row) => ctx.db.delete(row["_id"] as never)));

    return { deleted: stale.length };
});

export type { PresenceMember };
