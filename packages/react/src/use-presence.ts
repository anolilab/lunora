"use client";

import type { ArgsOf, FunctionReference, ReturnOf } from "@lunora/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useLunora } from "./lunora-provider";

/**
 * `usePresence` — collaborative-awareness hook, the client half of the
 * `@lunora/server` `definePresence` preset (Convex `@convex-dev/presence`
 * parity).
 *
 * It drives the two presence functions the server component ships:
 *
 * - **heartbeat** (a mutation): called on mount, on a fixed interval, and again
 * whenever the tab becomes visible, to upsert the caller's presence row and
 * refresh its `lastSeen`. On unmount the interval is cleared. Each heartbeat
 * carries the latest `data` from a ref, so `setData` takes effect on the next
 * tick without re-subscribing or resetting the timer.
 * - **listPresent** (a query): subscribed to over the live-query WS, so the
 * present-list updates reactively. Because the server patches a single row per
 * heartbeat, the client's **per-row subscription delta merge** applies just that
 * row to the cached list instead of re-sending every member — the list stays
 * cheap even with many participants heart-beating.
 *
 * `sessionId` defaults to a stable per-mount id (one row per tab); pass your own
 * to dedupe across tabs by user. TTL/expiry is server-side: a member that stops
 * heart-beating drops out of `listPresent` once `lastSeen` ages past the TTL, so
 * the hook needs no client-side reaping.
 *
 * The two `FunctionReference`s come from your generated `api` (e.g.
 * `api.presence.heartbeat` / `api.presence.listPresent`) — passed in so the hook
 * stays decoupled from any specific app schema.
 */

/**
 * A heartbeat mutation reference: takes `{ roomId, sessionId, data? }` (the shape
 * `definePresence().functions.heartbeat` registers).
 */
type HeartbeatReference = FunctionReference<"mutation", { data?: Record<string, unknown>; roomId: string; sessionId: string }>;

/**
 * A listPresent query reference: takes `{ roomId }` and returns the array of
 * present members.
 */
type ListPresentReference = FunctionReference<"query", { roomId: string }>;

interface UsePresenceOptions<H extends HeartbeatReference, L extends ListPresentReference> {
    /** Awareness blob for the first heartbeat (selection, cursor, name, color…). */
    data?: Record<string, unknown>;
    /** The `api.*` reference for the presence heartbeat mutation. */
    heartbeat: H;
    /** Heartbeat cadence in ms. Defaults to 10s — keep it well under the server TTL. */
    intervalMs?: number;
    /** The `api.*` reference for the presence listPresent query. */
    listPresent: L;

    /**
     * Stable id for this presence row. Defaults to a fresh per-mount id (one row
     * per tab). Pass a user/connection id to control deduping.
     */
    sessionId?: string;
    /** Forwarded to the heartbeat mutation / listPresent subscription when sharding by room. */
    shardKey?: string;
}

interface UsePresenceResult<L extends ListPresentReference> {
    /** The present members for the room, as `listPresent` returns them. `undefined` until the first push. */
    present: ReturnOf<L> | undefined;
    /** This mount's session id (generated when not supplied). */
    sessionId: string;
    /** Replace the awareness `data` sent with subsequent heartbeats, and heartbeat once now. */
    setData: (data: Record<string, unknown> | undefined) => void;
}

/** A best-effort unique id for a presence session — `crypto.randomUUID` when available, else a random fallback. */
const makeSessionId = (): string => {
    // Guard the whole `crypto` reference, not just `randomUUID`: some SSR /
    // older runtimes leave `crypto` undefined, where reading `.randomUUID` off
    // it throws a TypeError instead of falling through. `typeof crypto` (rather
    // than `globalThis.crypto !== undefined`) is the form the lib's
    // non-nullable `Crypto` typing leaves intact — mirrors `offline-queue.ts`.
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }

    // Non-security id — just needs to be unique per tab for a presence row.
    // eslint-disable-next-line sonarjs/pseudo-random -- presence session id, not a credential
    return `sess-${Math.random().toString(36).slice(2)}-${String(Date.now())}`;
};

const DEFAULT_INTERVAL_MS = 10_000;

export const usePresence = <H extends HeartbeatReference, L extends ListPresentReference>(
    roomId: string,
    options: UsePresenceOptions<H, L>,
): UsePresenceResult<L> => {
    const client = useLunora();

    const { heartbeat, intervalMs = DEFAULT_INTERVAL_MS, listPresent, shardKey } = options;

    // One session id per mount unless the caller pins one.
    const generatedSessionId = useMemo(() => options.sessionId ?? makeSessionId(), [options.sessionId]);

    const [present, setPresent] = useState<ReturnOf<L> | undefined>(undefined);

    // Latest awareness data, read at heartbeat time so `setData` never resets the
    // interval or re-subscribes.
    const dataRef = useRef<Record<string, unknown> | undefined>(options.data);

    // Stash the live inputs so the heartbeat callback stays stable (its identity
    // doesn't churn the interval effect) while still seeing the latest values.
    const inputsRef = useRef({ client, heartbeat, roomId, sessionId: generatedSessionId, shardKey });

    useEffect(() => {
        inputsRef.current = { client, heartbeat, roomId, sessionId: generatedSessionId, shardKey };
    });

    const sendHeartbeat = useCallback((): void => {
        const { client: c, heartbeat: hb, roomId: room, sessionId: sid, shardKey: sk } = inputsRef.current;
        const args = {
            roomId: room,
            sessionId: sid,
            ...(dataRef.current === undefined ? {} : { data: dataRef.current }),
        } as ArgsOf<H>;

        // Fire-and-forget — a dropped heartbeat self-heals on the next tick.
        c.mutation(hb, args, { shardKey: sk }).catch(() => undefined);
    }, []);

    const setData = useCallback(
        (next: Record<string, unknown> | undefined): void => {
            dataRef.current = next;
            sendHeartbeat();
        },
        [sendHeartbeat],
    );

    // Heartbeat: immediately, on an interval, and whenever the tab regains
    // visibility. Cleared on unmount so no timer leaks.
    useEffect(() => {
        sendHeartbeat();

        const handle = setInterval(sendHeartbeat, intervalMs);

        const onVisible = (): void => {
            if (document.visibilityState === "visible") {
                sendHeartbeat();
            }
        };

        document.addEventListener("visibilitychange", onVisible);

        return () => {
            clearInterval(handle);
            document.removeEventListener("visibilitychange", onVisible);
        };
    }, [sendHeartbeat, intervalMs]);

    // Register this room/session as the socket's connection context so the
    // server's presence `onDisconnect` hook can delete the row the instant the
    // socket drops — immediate departure, no TTL lag. The heartbeat + TTL stay
    // as the safety net for an ungraceful drop before the context was recorded.
    useEffect(() => {
        client.setConnectionContext({ roomId, sessionId: generatedSessionId }, { shardKey });

        return () => {
            client.setConnectionContext(undefined, { shardKey });
        };
    }, [client, roomId, generatedSessionId, shardKey]);

    // Subscribe to the reactive present-list for the room.
    useEffect(() => {
        let cancelled = false;

        const unsubscribe = client.subscribe(
            listPresent,
            { roomId } as ArgsOf<L>,
            (value) => {
                if (!cancelled) {
                    setPresent(value);
                }
            },
            { shardKey },
        );

        return () => {
            cancelled = true;
            unsubscribe();
        };
    }, [client, listPresent.__lunoraRef, roomId, shardKey]);

    return { present, sessionId: generatedSessionId, setData };
};

export type { HeartbeatReference, ListPresentReference, UsePresenceOptions, UsePresenceResult };
