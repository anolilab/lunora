/**
 * Presence / collaborative-awareness preset — the Lunora answer to
 * `@convex-dev/presence`.
 *
 * Presence is the "who's here" + cursors/awareness primitive every real-time
 * app reaches for: a room (a document, a board, a channel) and the set of
 * users/sessions currently looking at it, each carrying an optional cursor and
 * a blob of awareness `data` (selection, color, name…). Convex ships this as a
 * component; Lunora ships it from `@lunora/server` built on primitives the
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
 * without any reaper. The read filter only HIDES stale rows; it never deletes
 * them, so to keep the table from growing unbounded you SHOULD schedule the
 * sweep ({@link PresenceFunctions.sweep}) on a cron / `runAfter`. The heartbeat
 * also bounds its `data` blob and refuses to write under another identity's
 * session, but a reaper is still required to reclaim aged-out rows. For
 * high-traffic rooms, wrap the presence functions with `@lunora/ratelimit`.
 *
 * # Wiring
 *
 * ```ts
 * // lunora/presence.ts
 * import { definePresence } from "@lunora/server";
 *
 * export const presence = definePresence({ ttlMs: 10_000 });
 *
 * // Merge the table into the app schema (auto-namespaced to `presence_present`):
 * // lunora/schema.ts
 * export const schema = defineSchema({ ... }).extend(presence.extension);
 *
 * // Re-export the functions so codegen exposes them under `presence:*`:
 * export const { heartbeat, listPresent, sweep } = presence.functions;
 * ```
 *
 * The client then calls `presence:heartbeat` on an interval and subscribes to
 * `presence:listPresent` — the `usePresence` hook in `@lunora/react` does both.
 */

import { v } from "@lunora/values";

import { initLunora } from "./builder/index";
import { LunoraError } from "./error";
import { onDisconnect } from "./lifecycle";
import type { Component, SchemaExtension } from "./plugin";
import { defineComponent, defineSchemaExtension } from "./plugin";
import { defineTable } from "./schema";
import type { MutationCtx as MutationContext, RegisteredLifecycleHook, RegisteredMutation, RegisteredQuery } from "./types";

/** Default time-to-live for a presence row: a heartbeat keeps a member "present" for this long. */
const DEFAULT_TTL_MS = 30_000;

/**
 * Cap on the serialized size (bytes) of a heartbeat `data` blob. The awareness
 * payload (cursor, selection, name, color…) is small by nature; bounding it
 * stops a client from inflating presence rows — and the per-row delta echoed to
 * every room subscriber — into a storage / bandwidth amplification vector. An
 * over-limit `data` is rejected with `BAD_REQUEST`.
 */
const MAX_DATA_BYTES = 4096;

/** The bare extension key and table name. Prefixing makes the merged table `presence_present`. */
const PRESENCE_KEY = "presence";
const PRESENCE_BARE_TABLE = "present";

/**
 * The prefixed table name the extension produces at merge time. The handlers
 * read/write this name directly so they always agree with the merged schema.
 */
const PRESENCE_TABLE: "presence_present" = `${PRESENCE_KEY}_${PRESENCE_BARE_TABLE}`;

/**
 * A single present member as returned by `listPresent`.
 *
 * Note: the raw client-chosen `sessionId` is deliberately NOT surfaced. It is a
 * connection secret — disclosing every member's `sessionId` would let any
 * subscriber enumerate them and target the heartbeat / disconnect write paths.
 * A "who's here" UI needs only `userId` + awareness `data`; the caller already
 * knows its own session id locally (the `usePresence` hook returns it).
 */
interface PresenceMember {
    /** Opaque awareness blob (selection, cursor, name, color…). */
    data?: Record<string, unknown>;
    /** Last heartbeat time (epoch ms). */
    lastSeen: number;
    /** The room / channel / document this presence is scoped to. */
    roomId: string;
    /** Authenticated user id, when known. */
    userId?: string;
}

/** Options for {@link definePresence}. */
interface DefinePresenceOptions {
    /**
     * Grace window (ms) before a gracefully-closed session is dropped from the
     * present list. When `0` (the default), `onDisconnect` hard-deletes the
     * session's row the instant its socket closes. When `> 0`, the row is
     * instead aged so the read-time TTL filter hides it `disconnectGraceMs`
     * from now — a reconnect with the same `sessionId` within the window
     * re-heartbeats and restores full presence with no visible flicker (the
     * AnyCable `presence_ttl` behaviour). Clamped to `ttlMs`.
     */
    disconnectGraceMs?: number;

    /**
     * How long (ms) a heartbeat keeps a member present. `listPresent` excludes
     * rows whose `lastSeen` is older than `now - ttlMs`. Defaults to 30s.
     */
    ttlMs?: number;
}

/** The registered functions a presence component ships. */
interface PresenceFunctions {
    /**
     * Connection-lifecycle hook: the instant a client's WebSocket drops, hard-
     * delete its presence row so it disappears from `listPresent` with no TTL
     * lag. Targets the row by the `{ roomId, sessionId }` the client passed as
     * the connection `context`, and only deletes it when the disconnecting
     * VERIFIED identity owns the row (so a forged context can't evict another
     * member). The TTL filter + `sweep` remain the fallback for ungraceful drops
     * where no `context` was recorded.
     */
    disconnect: RegisteredLifecycleHook;

    /**
     * Upsert the caller's presence row for `roomId` and stamp `lastSeen = now`.
     * Keyed by `(roomId, sessionId)` — re-heartbeats patch the existing row so
     * subscribers receive a single-row delta, not a churn of insert/delete. A
     * heartbeat may only patch a row owned by the same identity (an existing row
     * held by a different `userId` is refused with `FORBIDDEN`), so a client
     * can't overwrite another member's awareness data via a guessed `sessionId`.
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
 * from your `lunora/` module so codegen exposes them, and `.extend(component.
 * extension)` to merge the table.
 *
 * Deviations from the brief: `sweep` is shipped as an **internal** mutation
 * (callable only server-side, e.g. from a cron) since hard-deletes shouldn't be
 * client triggered. `listPresent` stays a plain public query so the client can
 * subscribe to it.
 * @param options presence configuration (TTL).
 * @returns a component bundling the extension and the presence functions.
 */
// The presence functions are built with the procedure builders (no generated
// server here, so bind the base contexts via `initLunora.dataModel().create()`).
const { mutation, query } = initLunora.dataModel().create();

const definePresence = (options: DefinePresenceOptions = {}): PresenceComponent => {
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    // A grace window longer than the TTL would never hide the row before the
    // TTL filter already does, so clamp it; negative values disable the grace.
    const disconnectGraceMs = Math.max(0, Math.min(options.disconnectGraceMs ?? 0, ttlMs));

    const heartbeat = mutation
        .input({
            data: v.optional(v.record(v.string(), v.any())),
            roomId: v.string(),
            sessionId: v.string(),
        })
        .mutation(async ({ args, ctx: context }): Promise<{ lastSeen: number }> => {
            const lastSeen = Date.now();
            const userId = context.auth.userId ?? undefined;

            // Bound the arbitrary awareness blob so a client can't grow the
            // presence table (and the subscriber delta) without limit.
            if (args.data !== undefined && new TextEncoder().encode(JSON.stringify(args.data)).length > MAX_DATA_BYTES) {
                throw new LunoraError("BAD_REQUEST", `presence data exceeds the ${String(MAX_DATA_BYTES)}-byte limit`);
            }

            const existing = await context.db
                .query(PRESENCE_TABLE)
                .withIndex("byRoomSession", (q) => q.eq("roomId", args.roomId).eq("sessionId", args.sessionId))
                .first();

            // Ownership gate: `sessionId` is client-chosen and every member's
            // sessionId is observable, so a caller could heartbeat under a
            // victim's `(roomId, sessionId)` to overwrite their awareness data or
            // relabel `userId`. Only the identity that owns the row may patch it;
            // an anonymous-owned row (no `userId`) may only be patched by another
            // anonymous caller. A mismatch is refused rather than silently
            // hijacking the row.
            if (existing && (existing["userId"] ?? undefined) !== userId) {
                throw new LunoraError("FORBIDDEN", "presence heartbeat denied: this (roomId, sessionId) is held by another identity");
            }

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
        });

    const listPresent = query.input({ roomId: v.string() }).query(async ({ args, ctx: context }): Promise<PresenceMember[]> => {
        const cutoff = Date.now() - ttlMs;

        const rows = await context.db
            .query(PRESENCE_TABLE)
            .withIndex("byRoom", (q) => q.eq("roomId", args.roomId))
            .collect();

        // Newest heartbeat first, so the dedup below keeps the freshest row per
        // user and the returned list stays newest-first.
        const live = rows.filter((row) => (row["lastSeen"] as number) > cutoff).toSorted((a, b) => (b["lastSeen"] as number) - (a["lastSeen"] as number));

        // Collapse multiple sessions of the same authenticated user — the
        // common multi-tab / multi-device case — to a single member so a "who's
        // here" UI shows the user once, not once per open tab (AnyCable dedups
        // sessions sharing a presence id the same way). The most recent row
        // wins (the list is already newest-first). Anonymous rows carry no
        // `userId` to collapse on, so each anonymous session stays distinct.
        const seenUsers = new Set<string>();
        const members: PresenceMember[] = [];

        for (const row of live) {
            const userId = row["userId"] as string | undefined;

            if (userId !== undefined) {
                if (seenUsers.has(userId)) {
                    continue;
                }

                seenUsers.add(userId);
            }

            // `sessionId` is intentionally omitted from the public payload
            // (see {@link PresenceMember}) so a subscriber can't enumerate
            // other members' connection ids and target their rows.
            const member: PresenceMember = {
                lastSeen: row["lastSeen"] as number,
                roomId: row["roomId"] as string,
            };

            if (userId !== undefined) {
                member.userId = userId;
            }

            if (row["data"] !== undefined) {
                member.data = row["data"] as Record<string, unknown>;
            }

            members.push(member);
        }

        return members;
    });

    const sweep = mutation.input({ roomId: v.string() }).mutation(async ({ args, ctx: context }): Promise<{ deleted: number }> => {
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
    });

    // `sweep` is server-only — stamp it internal so a client can't trigger bulk
    // deletes. mutation()/internalMutation() differ only by a visibility tag, so
    // re-tag here to keep the factory single-sourced.
    const internalSweep = { ...sweep, visibility: "internal" } as typeof sweep;

    // Immediate-departure hook: when the socket closes, drop the matching row
    // now instead of waiting for the TTL filter to age it out. The client stamps
    // `{ roomId, sessionId }` into the connection `context`; without it we have
    // nothing to target and fall back to TTL + `sweep`.
    const disconnect = onDisconnect(async (context: MutationContext, event): Promise<void> => {
        const roomId = event.context?.["roomId"];
        const sessionId = event.context?.["sessionId"];

        if (typeof roomId !== "string" || typeof sessionId !== "string") {
            return;
        }

        const existing = await context.db
            .query(PRESENCE_TABLE)
            .withIndex("byRoomSession", (q) => q.eq("roomId", roomId).eq("sessionId", sessionId))
            .first();

        if (!existing) {
            return;
        }

        // Ownership gate: `roomId`/`sessionId` come from the client connection
        // context and are observable on every member, so a socket could close
        // with a victim's `(roomId, sessionId)` to evict them. Only delete the
        // row when the disconnecting verified identity owns it (an anonymous-
        // owned row may only be reaped by an anonymous socket). Mismatches fall
        // back to the TTL filter + `sweep` for the real owner.
        const verifiedUserId = event.userId ?? undefined;

        if ((existing["userId"] ?? undefined) !== verifiedUserId) {
            return;
        }

        if (disconnectGraceMs === 0) {
            // No grace: drop the row now so the member disappears immediately.
            await context.db.delete(existing["_id"] as never);

            return;
        }

        // Grace window: instead of vanishing instantly, age the row so the
        // read-time TTL filter (`lastSeen > now - ttlMs`) hides it
        // `disconnectGraceMs` from now. A reconnect with the same `sessionId`
        // within the window re-heartbeats and restores full presence — no
        // flicker. `min` ensures we only ever SHORTEN the row's life (a row
        // already due to expire sooner is left alone), never extend it.
        const agedLastSeen = Math.min(existing["lastSeen"] as number, Date.now() + disconnectGraceMs - ttlMs);

        await context.db.patch(existing["_id"] as never, { lastSeen: agedLastSeen });
    });

    return defineComponent(PRESENCE_KEY, {
        extension: presenceExtension,
        functions: { disconnect, heartbeat, listPresent, sweep: internalSweep },
    }) as PresenceComponent;
};

export type { DefinePresenceOptions, PresenceComponent, PresenceFunctions, PresenceMember };
export { definePresence, DEFAULT_TTL_MS as PRESENCE_DEFAULT_TTL_MS, PRESENCE_TABLE, presenceExtension };
