/**
 * Presence / collaborative-awareness preset — the Cirrus answer to
 * `@convex-dev/presence`.
 *
 * Presence is the "who's here" + cursors/awareness primitive every real-time
 * app reaches for: a room (a document, a board, a channel) and the set of
 * users/sessions currently looking at it, each carrying an optional cursor and
 * a blob of awareness `data` (selection, color, name…). Convex ships this as a
 * component; Cirrus ships it from `@cirrus/server` built on primitives the
 * framework already has — no new package, no DO-level support:
 *
 * - **Schema extension / component system** ({@link defineSchemaExtension} /
 * {@link defineComponent}) declares the backing table and auto-namespaces it
 * (`presence_present`), so it can't collide with an app table.
 * - **Live queries (subscriptions)** drive `listPresent` — clients subscribe
 * and the present-list updates reactively as rows are inserted / patched.
 * - **Per-row subscription delta merge** means a single heartbeat patch
 * re-sends only the changed row to subscribers, not the whole list.
 * - **TTL by read-time filter**: `listPresent` filters `lastSeen > now - ttl`,
 * so a client that stops heart-beating silently disappears from the list
 * without any reaper. An optional scheduled sweep
 * ({@link PresenceFunctions.sweep}) hard-deletes the stale rows so the table
 * doesn't grow unbounded — wire it to a cron or `runAfter` if you want it.
 *
 * # Wiring
 *
 * ```ts
 * // cirrus/presence.ts
 * import { definePresence } from "@cirrus/server";
 *
 * export const presence = definePresence({ ttlMs: 10_000 });
 *
 * // Merge the table into the app schema (auto-namespaced to `presence_present`):
 * // cirrus/schema.ts
 * export const schema = defineSchema({ ... }).extend(presence.extension);
 *
 * // Re-export the functions so codegen exposes them under `presence:*`:
 * export const { heartbeat, listPresent, sweep } = presence.functions;
 * ```
 *
 * The client then calls `presence:heartbeat` on an interval and subscribes to
 * `presence:listPresent` — the `usePresence` hook in `@cirrus/react` does both.
 */

import { v } from "@cirrus/values";

import { mutation, query } from "./functions";
import type { Component, SchemaExtension } from "./plugin";
import { defineComponent, defineSchemaExtension } from "./plugin";
import { defineTable } from "./schema";
import type { MutationCtx as MutationContext, QueryCtx as QueryContext, RegisteredMutation, RegisteredQuery } from "./types";

/** Default time-to-live for a presence row: a heartbeat keeps a member "present" for this long. */
const DEFAULT_TTL_MS = 30_000;

/** The bare extension key and table name. Prefixing makes the merged table `presence_present`. */
const PRESENCE_KEY = "presence";
const PRESENCE_BARE_TABLE = "present";

/**
 * The prefixed table name the extension produces at merge time. The handlers
 * read/write this name directly so they always agree with the merged schema.
 */
const PRESENCE_TABLE: "presence_present" = `${PRESENCE_KEY}_${PRESENCE_BARE_TABLE}`;

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

/** Options for {@link definePresence}. */
interface DefinePresenceOptions {
    /**
     * How long (ms) a heartbeat keeps a member present. `listPresent` excludes
     * rows whose `lastSeen` is older than `now - ttlMs`. Defaults to 30s.
     */
    ttlMs?: number;
}

/** The registered functions a presence component ships. */
interface PresenceFunctions {
    /**
     * Upsert the caller's presence row for `roomId` and stamp `lastSeen = now`.
     * Keyed by `(roomId, sessionId)` — re-heartbeats patch the existing row so
     * subscribers receive a single-row delta, not a churn of insert/delete.
     */
    heartbeat: RegisteredMutation<
        {
            data: ReturnType<typeof v.optional>;
            roomId: ReturnType<typeof v.string>;
            sessionId: ReturnType<typeof v.string>;
        },
        { lastSeen: number }
    >;

    /**
     * Live query returning the non-expired members of `roomId`, newest heartbeat
     * first. Subscribe to it for a reactive "who's here" list.
     */
    listPresent: RegisteredQuery<{ roomId: ReturnType<typeof v.string> }, PresenceMember[]>;

    /**
     * Internal mutation that hard-deletes every expired row for `roomId`. Stale
     * rows already vanish from `listPresent` via the read-time TTL filter; this
     * only reclaims storage. Schedule it (cron / `runAfter`) if you care.
     */
    sweep: RegisteredMutation<{ roomId: ReturnType<typeof v.string> }, { deleted: number }>;
}

/** The component shape `definePresence` returns: the presence extension + typed functions. */
type PresenceComponent = Component<{ [PRESENCE_BARE_TABLE]: ReturnType<typeof defineTable> }> & { functions: PresenceFunctions };

/**
 * The presence schema extension: a single `present` table, auto-namespaced to
 * `presence_present` at merge time, indexed by `(roomId, sessionId)` for the
 * heartbeat upsert and by `roomId` for `listPresent`.
 */
// Explicit type on this exported const (isolatedDeclarations can't infer it
// from the generic call). The loose `ReturnType<typeof defineTable>` table type
// is fine for the convenience `.extend(presenceExtension)` path; the fully-typed
// route is `definePresence()` (returns the precise `PresenceComponent`).
const presenceExtension = defineSchemaExtension(PRESENCE_KEY, {
    tables: {
        [PRESENCE_BARE_TABLE]: defineTable({
            data: v.optional(v.record(v.string(), v.any())),
            lastSeen: v.number(),
            roomId: v.string(),
            sessionId: v.string(),
            userId: v.optional(v.string()),
        })
            // Drives the heartbeat upsert lookup.
            .index("byRoomSession", ["roomId", "sessionId"])
            // Drives the `listPresent` / `sweep` per-room scans.
            .index("byRoom", ["roomId"]),
    },
}) as unknown as SchemaExtension<{ [PRESENCE_BARE_TABLE]: ReturnType<typeof defineTable> }>;

/**
 * Build a presence {@link Component} — schema extension + heartbeat / listPresent
 * / sweep functions — wired to a single TTL. Re-export `component.functions`
 * from your `cirrus/` module so codegen exposes them, and `.extend(component.
 * extension)` to merge the table.
 *
 * Deviations from the brief: `sweep` is shipped as an **internal** mutation
 * (callable only server-side, e.g. from a cron) since hard-deletes shouldn't be
 * client triggered. `listPresent` stays a plain public query so the client can
 * subscribe to it.
 * @param options presence configuration (TTL).
 * @returns a component bundling the extension and the presence functions.
 */
const definePresence = (options: DefinePresenceOptions = {}): PresenceComponent => {
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;

    const heartbeat = mutation({
        args: {
            data: v.optional(v.record(v.string(), v.any())),
            roomId: v.string(),
            sessionId: v.string(),
        },
        handler: async (context: MutationContext, args): Promise<{ lastSeen: number }> => {
            const lastSeen = Date.now();
            const userId = context.auth.userId ?? undefined;

            const existing = await context.db
                .query(PRESENCE_TABLE)
                .withIndex("byRoomSession", (q) => q.eq("roomId", args.roomId).eq("sessionId", args.sessionId))
                .first();

            const row: Record<string, unknown> = {
                lastSeen,
                roomId: args.roomId,
                sessionId: args.sessionId,
                ...(args.data === undefined ? {} : { data: args.data }),
                ...(userId === undefined ? {} : { userId }),
            };

            // Patch on re-heartbeat — a single-row delta for subscribers, not an
            // insert+delete churn that would re-send the whole present list.
            await (existing ? context.db.patch(existing["_id"] as never, row) : context.db.insert(PRESENCE_TABLE, row));

            return { lastSeen };
        },
    });

    const listPresent = query({
        args: { roomId: v.string() },
        handler: async (context: QueryContext, args): Promise<PresenceMember[]> => {
            const cutoff = Date.now() - ttlMs;

            const rows = await context.db
                .query(PRESENCE_TABLE)
                .withIndex("byRoom", (q) => q.eq("roomId", args.roomId))
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
        },
    });

    const sweep = mutation({
        args: { roomId: v.string() },
        handler: async (context: MutationContext, args): Promise<{ deleted: number }> => {
            const cutoff = Date.now() - ttlMs;

            const stale = await context.db
                .query(PRESENCE_TABLE)
                .withIndex("byRoom", (q) => q.eq("roomId", args.roomId))
                .filter((row) => (row["lastSeen"] as number) <= cutoff)
                .collect();

            // These deletes share the mutation's snapshot and the stale set is
            // small (one room's expired members); fire them together.
            await Promise.all(stale.map((row) => context.db.delete(row["_id"] as never)));

            return { deleted: stale.length };
        },
    });

    // `sweep` is server-only — stamp it internal so a client can't trigger bulk
    // deletes. mutation()/internalMutation() differ only by a visibility tag, so
    // re-tag here to keep the factory single-sourced.
    const internalSweep = { ...sweep, visibility: "internal" } as typeof sweep;

    return defineComponent(PRESENCE_KEY, {
        extension: presenceExtension,
        functions: { heartbeat, listPresent, sweep: internalSweep },
    }) as PresenceComponent;
};

export type { DefinePresenceOptions, PresenceComponent, PresenceFunctions, PresenceMember };
export { definePresence, DEFAULT_TTL_MS as PRESENCE_DEFAULT_TTL_MS, PRESENCE_TABLE, presenceExtension };
