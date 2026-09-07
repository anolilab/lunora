"use client";

import type { ArgsOf, FunctionReference, ReturnOf, SubscriptionError, SubscriptionErrorCallback } from "@lunora/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { randomSessionId } from "../../../shared/random-session-id";
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
     * Called when the `listPresent` subscription reports an error (a session
     * expiry, an RLS denial). Without it — and without reading `error` — such a
     * failure is invisible and `present` freezes at its last value.
     */
    onError?: SubscriptionErrorCallback;

    /**
     * Stable id for this presence row. Defaults to a fresh per-mount id (one row
     * per tab). Pass a user/connection id to control deduping.
     */
    sessionId?: string;
    /** Forwarded to the heartbeat mutation / listPresent subscription when sharding by room. */
    shardKey?: string;
}

interface UsePresenceResult<L extends ListPresentReference> {
    /** The `listPresent` subscription's last error, or `undefined`. */
    error: SubscriptionError | undefined;
    /** The present members for the room, as `listPresent` returns them. `undefined` until the first push. */
    present: ReturnOf<L> | undefined;
    /** This mount's session id (generated when not supplied). */
    sessionId: string;
    /** Replace the awareness `data` sent with subsequent heartbeats, and heartbeat once now. */
    setData: (data: Record<string, unknown> | undefined) => void;
}

/** A best-effort unique id for a presence session — `crypto.randomUUID` when available, else a `crypto.getRandomValues` fallback. */
const DEFAULT_INTERVAL_MS = 10_000;

export const usePresence = <H extends HeartbeatReference, L extends ListPresentReference>(
    roomId: string,
    options: UsePresenceOptions<H, L>,
): UsePresenceResult<L> => {
    const client = useLunora();

    const { heartbeat, intervalMs = DEFAULT_INTERVAL_MS, listPresent, shardKey } = options;

    // One session id per mount unless the caller pins one.
    // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- load-bearing: `randomSessionId()` mints a fresh random id; it must run once per mount (keyed on `options.sessionId`), never per render, or every render would generate a new presence-row id. Keep the explicit `useMemo` so the identity is stable even if the compiler bails this function.
    const generatedSessionId = useMemo(() => options.sessionId ?? randomSessionId(), [options.sessionId]);

    const [present, setPresent] = useState<ReturnOf<L> | undefined>(undefined);
    const [error, setError] = useState<SubscriptionError | undefined>(undefined);

    // The subscribe effect keys on the query ref + room + shard, so an inline
    // `onError` must not change its identity — read the latest through a ref.
    const onErrorRef = useRef(options.onError);

    useEffect(() => {
        onErrorRef.current = options.onError;
    });

    // Latest awareness data, read at heartbeat time so `setData` never resets the
    // interval or re-subscribes.
    const dataRef = useRef<Record<string, unknown> | undefined>(options.data);

    // Stash the live inputs so the heartbeat callback stays stable (its identity
    // doesn't churn the interval effect) while still seeing the latest values.
    const inputsRef = useRef({ client, heartbeat, roomId, sessionId: generatedSessionId, shardKey });

    useEffect(() => {
        inputsRef.current = { client, heartbeat, roomId, sessionId: generatedSessionId, shardKey };
    });

    // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- load-bearing: `sendHeartbeat` is a dependency of the interval effect below; a stable identity keeps the interval from being torn down and re-armed on every render. It reads all live inputs from `inputsRef`, so the empty dep list is correct. Keep the explicit `useCallback`.
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

    // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- load-bearing: `setData` is part of the hook's public return and builds on the stable `sendHeartbeat`; keeping it explicitly memoized preserves a steady identity for consumers that place it in their own effect deps.
    const setData = useCallback(
        (next: Record<string, unknown> | undefined): void => {
            dataRef.current = next;
            sendHeartbeat();
        },
        [sendHeartbeat],
    );

    // Heartbeat: immediately, on an interval, and whenever the tab regains
    // visibility. Cleared on unmount so no timer leaks.
    //
    // `document` is guarded (`typeof document !== "undefined"`, matching
    // vue/solid/svelte/angular's presence) rather than read bare: React Native
    // has no `document` global at all, so an unguarded read throws a
    // ReferenceError on mount (RN-01) instead of just skipping the
    // visibility-driven heartbeat, which is a web-only refinement anyway (the
    // interval heartbeat still covers RN).
    useEffect(() => {
        sendHeartbeat();

        const handle = setInterval(sendHeartbeat, intervalMs);

        const onVisible = (): void => {
            if (typeof document !== "undefined" && document.visibilityState === "visible") {
                sendHeartbeat();
            }
        };

        if (typeof document !== "undefined") {
            document.addEventListener("visibilitychange", onVisible);
        }

        return () => {
            clearInterval(handle);

            if (typeof document !== "undefined") {
                document.removeEventListener("visibilitychange", onVisible);
            }
        };
    }, [sendHeartbeat, intervalMs]);

    // Register this room/session as the socket's connection context so the
    // server's presence `onDisconnect` hook can delete the row the instant the
    // socket drops — immediate departure, no TTL lag. The heartbeat + TTL stay
    // as the safety net for an ungraceful drop before the context was recorded.
    //
    // Use the refcounted `acquireConnectionContext` (not the last-writer-wins
    // `setConnectionContext`): two `usePresence` hooks mounted on the same shard
    // each hold their own registration, so one unmounting no longer clears the
    // other's context. The returned release drops only this hook's holder.
    useEffect(() => {
        const release = client.acquireConnectionContext({ roomId, sessionId: generatedSessionId }, { shardKey });

        return release;
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
                    setError(undefined);
                }
            },
            {
                onError: (subscriptionError) => {
                    if (!cancelled) {
                        setError(subscriptionError);
                    }

                    onErrorRef.current?.(subscriptionError);
                },
                shardKey,
            },
        );

        return () => {
            cancelled = true;
            unsubscribe();
        };
        // react-doctor-disable-next-line react-doctor/exhaustive-deps -- intentional: the subscription re-attaches on the query's stable `__lunoraRef` (not the whole `listPresent` object, which the caller may recreate each render with the same target) plus room/shard/client. `onErrorRef` is a stable ref carrying the latest handler. `client` is provider-stable (swapping it remounts the provider subtree).
    }, [client, listPresent.__lunoraRef, roomId, shardKey]);

    return { error, present, sessionId: generatedSessionId, setData };
};

export type { HeartbeatReference, ListPresentReference, UsePresenceOptions, UsePresenceResult };
