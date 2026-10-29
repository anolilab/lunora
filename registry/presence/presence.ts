/**
 * Presence functions — added by `lunora add presence`.
 *
 * This file is YOURS: it's a normal Lunora module, copied into your project so
 * you own and edit it. Re-export these from your `lunora/` entry (or rely on
 * file-based discovery) so codegen picks them up — they surface in the generated
 * `api` as `presence/heartbeat`, `presence/listPresent`, `presence/sweep`.
 *
 * Rooms are tenant-scoped: the client names a room, and the server files it under
 * the caller's tenant ({@link presenceTenant}), so the same `roomId` in two
 * organizations is two rooms and no argument reaches another tenant's.
 *
 *   - **heartbeat** (mutation) — upsert the caller's presence row for a room and
 *     stamp `lastSeen = now`. Keyed by `(tenant, roomId, sessionId)`, so a re-heartbeat
 *     *patches* the existing row: subscribers receive a single-row delta, not an
 *     insert/delete churn that would re-send the whole present list. A session
 *     that joins the room also reclaims a batch of its tenant's expired rows in that
 *     room, so closed tabs cannot pile up between sweeps nobody scheduled.
 *   - **listPresent** (query) — the non-expired members of the caller's room, newest
 *     heartbeat first. Subscribe to it for a reactive "who's here" list; the TTL
 *     filter ({@link PRESENCE_TTL_MS}) drops members that stopped heart-beating,
 *     so no client-side reaping is needed.
 *   - **sweep** (internal mutation) — hard-delete expired rows in the shard it runs
 *     on, across every tenant by default or for one `(tenantId, roomId)` pair. Stale
 *     rows already vanish from `listPresent` via the read-time filter, and the
 *     table's `.ttl()` alarm deletes them in every shard; this is an on-demand pass
 *     on top. It's *internal* (server-only) so a client can't trigger bulk deletes.
 *
 * The client half is `usePresence` in `@lunora/react`, which calls `heartbeat`
 * on an interval and subscribes to `listPresent`.
 */
import { LunoraError } from "@lunora/errors";
import { RateLimiter, rateLimit, createMemoryStore } from "@lunora/ratelimit";

import type { MutationCtx } from "#lunora/_generated/server.js";
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

/**
 * Caps on the awareness payload. `listPresent` re-sends every member's `data` to
 * every room subscriber on each heartbeat, so one oversized blob is multiplied
 * by the room size and the heartbeat rate. The validator bounds each key and
 * value; these bound the record as a whole, which a per-value limit cannot.
 */
const PRESENCE_DATA_MAX_ENTRIES = 32;
const PRESENCE_DATA_MAX_BYTES = 4096;

/**
 * The tenant whose rooms the caller can reach, from the verified identity and
 * never from `args` — a client-chosen tenant is no boundary at all.
 *
 * `orgId` is the claim the `auth-*-jwt` presets and `@lunora/auth` (with the
 * organization plugin) put on the identity. It can lag a membership removal by
 * the identity cache window, and an open subscription keeps the claim it
 * connected with. Without the claim every caller shares the app-wide tenant
 * `""`, which is right for a single-tenant app and holds no organization's
 * rooms. Change this function to change the policy (a team, a workspace…).
 */
const presenceTenant = (identity: unknown): string => {
    const orgId = (identity as { orgId?: unknown } | null)?.orgId;

    return typeof orgId === "string" ? orgId : "";
};

/** A single present member as returned by `listPresent`. */
interface PresenceMember {
    /** Opaque awareness blob (selection, cursor, name, color…). */
    data?: Record<string, unknown>;
    /** Last heartbeat time (epoch ms). */
    lastSeen: number;
    /** The room / channel / document this presence is scoped to, as the client named it. */
    roomId: string;
    /** Stable per-tab / per-connection id. */
    sessionId: string;
    /** Authenticated user id, when known. */
    userId?: string;
}

/**
 * Expired rows a joining session reclaims at most. A room nobody swept can hold
 * far more than one mutation may read and delete, and a join that threw on that
 * backlog would never insert its own row. The rest go on later joins and `sweep`.
 */
const JOIN_CLEANUP_BATCH = 50;

/**
 * Expired rows one cross-tenant `sweep` deletes at most, so a backlog cannot push
 * the mutation past its read/write limits. A larger backlog drains over the
 * following cron ticks.
 */
const SWEEP_BATCH = 500;

/**
 * Hard-delete up to `limit` rows of `tenantId`'s `roomId` last seen at or before
 * `cutoff` (all of them without one). Rows sharing the mutation's snapshot, so
 * the deletes go out together.
 */
const deleteExpired = async (ctx: MutationCtx, tenantId: string, roomId: string, cutoff: number, limit?: number): Promise<number> => {
    const expired = ctx.db
        .query(PRESENCE_TABLE)
        .withIndex("byTenantRoomSession", (q) => q.eq("tenantId", tenantId).eq("roomId", roomId))
        .filter((row) => (row["lastSeen"] as number) <= cutoff);
    const stale = limit === undefined ? await expired.collect() : await expired.take(limit);

    await Promise.all(stale.map((row) => ctx.db.delete(PRESENCE_TABLE, row["_id"] as never)));

    return stale.length;
};

/**
 * Upsert the caller's presence row for `roomId` in their tenant and stamp
 * `lastSeen = now`. Patches the existing `(tenant, roomId, sessionId)` row on
 * re-heartbeat so subscribers get a single-row delta.
 */
export const heartbeat = mutation
    .input({
        // Awareness payload (cursor, status, color, …) — a map of scalar values
        // rather than `v.any()`. The validator bounds each key and value; the
        // entry count and total size are checked in the handler below
        // (PRESENCE_DATA_MAX_ENTRIES / PRESENCE_DATA_MAX_BYTES). Widen the value
        // union or the caps if you need more.
        data: v.optional(v.record(v.string().max(64), v.union(v.string().max(1024), v.number(), v.boolean()))),
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
        if (data !== undefined) {
            const entries = Object.keys(data).length;
            const bytes = new TextEncoder().encode(JSON.stringify(data)).byteLength;

            if (entries > PRESENCE_DATA_MAX_ENTRIES || bytes > PRESENCE_DATA_MAX_BYTES) {
                throw new LunoraError(
                    "BAD_REQUEST",
                    `presence/heartbeat: data has ${String(entries)} entries / ${String(bytes)} bytes; the limit is ${String(PRESENCE_DATA_MAX_ENTRIES)} entries / ${String(PRESENCE_DATA_MAX_BYTES)} bytes.`,
                );
            }
        }

        const lastSeen = ctx.now;
        const userId = ctx.auth.userId ?? undefined;
        const tenantId = presenceTenant(await ctx.auth.getIdentity());

        const existing = await ctx.db
            .query(PRESENCE_TABLE)
            .withIndex("byTenantRoomSession", (q) => q.eq("tenantId", tenantId).eq("roomId", roomId).eq("sessionId", sessionId))
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
            tenantId,
            ...(data === undefined ? {} : { data }),
            ...(userId === undefined ? {} : { userId }),
        };

        if (existing) {
            // A replace, not a patch: a heartbeat without `data` clears it, and a
            // patch can only leave an omitted field as it was.
            await ctx.db.replace(PRESENCE_TABLE, existing["_id"] as never, row);
        } else {
            // A new session is the one moment the room grows, and the only write
            // that is certain to happen: reclaim what the room has outgrown first.
            await deleteExpired(ctx, tenantId, roomId, ctx.now - PRESENCE_TTL_MS, JOIN_CLEANUP_BATCH);
            await ctx.db.insert(PRESENCE_TABLE, row);
        }

        return { lastSeen };
    });

/**
 * Live query: the non-expired members of `roomId` in the caller's tenant, newest
 * heartbeat first. Subscribe to it for a reactive present-list.
 */
export const listPresent = query.input({ roomId: v.string().max(256) }).query(async ({ args: { roomId }, ctx }): Promise<PresenceMember[]> => {
    const cutoff = ctx.now - PRESENCE_TTL_MS;
    const tenantId = presenceTenant(await ctx.auth.getIdentity());

    const rows = await ctx.db
        .query(PRESENCE_TABLE)
        .withIndex("byTenantRoomSession", (q) => q.eq("tenantId", tenantId).eq("roomId", roomId))
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
 * Hard-delete expired rows in the shard this runs on — a cron dispatches to the
 * root shard only, so organization shards rely on the table's `.ttl()` alarm.
 * Without arguments it deletes up to {@link SWEEP_BATCH} of them across every
 * tenant and room; being internal (server-only), it may cross tenants. That path scans by
 * `lastSeen` alone, so it also reclaims rows written before rooms were
 * tenant-scoped, which no `(tenantId, roomId)` lookup can reach. Pass both
 * `tenantId` (`""` for the app-wide tenant) and `roomId` to sweep just that room.
 * Stale rows already vanish from `listPresent` via the read-time TTL filter, so
 * this is purely housekeeping.
 */
export const sweep = internalMutation
    .input({ roomId: v.optional(v.string()), tenantId: v.optional(v.string()) })
    .mutation(async ({ args: { roomId, tenantId }, ctx }): Promise<{ deleted: number }> => {
        const cutoff = ctx.now - PRESENCE_TTL_MS;

        // `""` is the app-wide tenant, so presence is tested against `undefined`, never truthiness.
        if (tenantId !== undefined && roomId !== undefined) {
            return { deleted: await deleteExpired(ctx, tenantId, roomId, cutoff) };
        }

        if (tenantId !== undefined || roomId !== undefined) {
            throw new LunoraError("BAD_REQUEST", "presence/sweep: pass both tenantId and roomId for one room, or neither to sweep every tenant.");
        }

        const stale = await ctx.db
            .query(PRESENCE_TABLE)
            .withIndex("byLastSeen", (q) => q.lte("lastSeen", cutoff))
            .take(SWEEP_BATCH);

        await Promise.all(stale.map((row) => ctx.db.delete(PRESENCE_TABLE, row["_id"] as never)));

        return { deleted: stale.length };
    });

export type { PresenceMember };
