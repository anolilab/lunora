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
 * Indexes:
 *
 *   - `byRoomSession` — drives the heartbeat upsert lookup (one row per
 *     `(roomId, sessionId)`), so re-heartbeats patch instead of churning.
 *   - `byRoom` — drives the `listPresent` / `sweep` per-room scans.
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
                userId: v.optional(v.string()),
            })
                .index("byRoomSession", ["roomId", "sessionId"])
                .index("byRoom", ["roomId"]),
        },
    }),
});
