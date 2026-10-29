/**
 * Presence schema extension + plugin — added by `lunora add presence`.
 *
 * Presence is the "who's here" primitive every real-time app reaches for: a
 * room (a document, a board, a channel) and the set of users/sessions currently
 * looking at it, each carrying an optional `data` awareness blob (cursor,
 * selection, name, color…). Convex ships this as `@convex-dev/presence`; here
 * it's built from primitives Lunora already has — a live-query table plus a
 * read-time TTL filter, no Durable-Object-level support.
 *
 * This file is YOURS to own and edit. `lunora add` splices a managed
 * `.extend(presence.extension)` into `lunora/schema.ts`, so the `present` table
 * below merges into your schema as **`presence_present`** (extension tables are
 * auto-prefixed with the plugin key — write the bare name here). The handlers in
 * `./index.ts` read/write that prefixed name via {@link PRESENCE_TABLE}.
 *
 * Tenancy: every row carries the `tenantId` the handlers derive server-side
 * from the caller's identity (see `presenceTenant` in `./index.ts`), never from
 * `args`. A client names only the room; the same room name in two tenants is
 * two separate rooms, and no argument reaches the other one.
 *
 * Indexes:
 *
 *   - `byTenantRoomSession` — drives the heartbeat upsert lookup (one row per
 *     `(tenantId, roomId, sessionId)`), so re-heartbeats patch instead of
 *     churning. `sessionId` is client-supplied and `listPresent` exposes it to
 *     every room subscriber, so it is NOT an ownership key on its own — the
 *     heartbeat handler additionally rejects a patch whose existing row belongs
 *     to a different `userId`, so a participant can't reuse another visible
 *     `sessionId` to hijack their presence row. Its `(tenantId, roomId)` prefix
 *     also serves the `listPresent` and targeted-`sweep` per-room scans, so no
 *     separate room index is needed (a standalone one would be a redundant prefix).
 *   - `byLastSeen` — drives the cross-tenant `sweep`. It reads expired rows by
 *     age alone, which also reaches rows written before `tenantId` existed:
 *     every tenant-prefixed lookup misses those.
 */
import { definePlugin, defineSchemaExtension, defineTable, v } from "@lunora/server";

/**
 * The merged table name. The bare `present` table is auto-prefixed with the
 * plugin key (`presence`) at merge time; the handlers in `./index.ts` reference
 * this constant so they always agree with the merged schema.
 */
export const PRESENCE_TABLE = "presence_present";

/**
 * How long (ms) a heartbeat keeps a member present. `listPresent` excludes rows
 * whose `lastSeen` is older than `now - PRESENCE_TTL_MS`, so a client that stops
 * heart-beating silently disappears without any reaper. Edit freely — keep the
 * client heartbeat cadence (default 10s in `usePresence`) well under this.
 */
export const PRESENCE_TTL_MS = 30_000;

/**
 * The presence plugin: a single `present` table (no middleware). `lunora/
 * schema.ts` wires the extension in via the managed `.extend(presence.extension)`
 * block.
 */
export const presence = definePlugin("presence", {
    extension: defineSchemaExtension("presence", {
        tables: {
            // Bare name — auto-prefixes to `presence_present` at merge time.
            present: defineTable({
                data: v.optional(v.record(v.string(), v.any())),
                lastSeen: v.number(),
                roomId: v.string(),
                sessionId: v.string(),
                // A separate column, not a `tenant:room` key: concatenation lets org `a:b`
                // + room `c` collide with org `a` + room `b:c`. `""` is the app-wide tenant.
                tenantId: v.string(),
                userId: v.optional(v.string()),
            })
                // The `(tenantId, roomId)` prefix also covers the per-room
                // `listPresent`/`sweep` scans — a separate room index would be redundant.
                .index("byTenantRoomSession", ["tenantId", "roomId", "sessionId"])
                .index("byLastSeen", ["lastSeen"]),
        },
    }),
});
