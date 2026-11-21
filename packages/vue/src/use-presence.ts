import type { ArgsOf, FunctionReference, ReturnOf, SubscriptionError, SubscriptionErrorCallback } from "@lunora/client";
import type { MaybeRefOrGetter, ShallowRef } from "vue";
import { shallowRef, toValue, watch } from "vue";

import { isBrowser } from "../../../shared/is-browser";
import { assertPresenceInterval } from "../../../shared/presence-interval";
import { randomSessionId } from "../../../shared/random-session-id";
import { useLunora } from "./lunora-provider";
import onScopeDisposeOrWarn from "./scope-dispose";

/**
 * `usePresence` — collaborative-awareness composable, the client half of the
 * `@lunora/server` `definePresence` preset.
 *
 * Drives the heartbeat mutation (on mount, interval, and tab re-focus) and
 * subscribes to the live `listPresent` query for the given room. `roomId` may
 * be a ref or getter; a change leaves the old room and joins the new one.
 *
 * Call inside `setup()` (or any active effect scope).
 */

/**
 * A heartbeat mutation reference: takes `{ roomId, sessionId, data? }`.
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
    /** Heartbeat cadence in ms. Defaults to 10s. */
    intervalMs?: number;
    /** The `api.*` reference for the presence listPresent query. */
    listPresent: L;

    /**
     * Called when the `listPresent` subscription reports an error (a session
     * expiry, an RLS denial). Without it — and without reading `error` — such a
     * failure is invisible and `present` is cleared until a later frame arrives.
     */
    onError?: SubscriptionErrorCallback;

    /**
     * Stable id for this presence row. Defaults to a fresh per-mount id.
     * Pass a user/connection id to control deduping across tabs.
     */
    sessionId?: string;
    /** Forwarded to the heartbeat mutation / listPresent subscription when sharding by room. */
    shardKey?: string;
}

interface UsePresenceResult<L extends ListPresentReference> {
    /** The `listPresent` subscription's last error, or `undefined`. */
    error: ShallowRef<SubscriptionError | undefined>;
    /** The present members for the room. `undefined` until the first push. */
    present: ShallowRef<ReturnOf<L> | undefined>;
    /** This mount's session id (generated when not supplied). */
    sessionId: string;
    /** Replace the awareness `data` sent with subsequent heartbeats, and heartbeat immediately. */
    setData: (data: Record<string, unknown> | undefined) => void;
}

const DEFAULT_INTERVAL_MS = 10_000;

const usePresence = <H extends HeartbeatReference, L extends ListPresentReference>(
    roomId: MaybeRefOrGetter<string>,
    options: UsePresenceOptions<H, L>,
): UsePresenceResult<L> => {
    const client = useLunora();
    const { heartbeat, intervalMs = DEFAULT_INTERVAL_MS, listPresent, shardKey } = options;

    assertPresenceInterval(intervalMs);

    // One session id per composable call unless the caller pins one.
    const sessionId = options.sessionId ?? randomSessionId();

    const present = shallowRef<ReturnOf<L> | undefined>(undefined) as ShallowRef<ReturnOf<L> | undefined>;
    const error = shallowRef<SubscriptionError | undefined>(undefined);

    // Latest awareness data — updated by `setData`; read at heartbeat time so
    // changing data never resets the interval or closes the subscription.
    let latestData: Record<string, unknown> | undefined = options.data;
    // True only between the client-side mount and teardown; `setData` must not heartbeat before then.
    let mounted = false;

    // The room the armed wiring belongs to; `setData` and the interval heartbeat read it at send time.
    let currentRoom = typeof roomId === "string" ? roomId : toValue(roomId);

    const sendHeartbeat = (): void => {
        const args = {
            roomId: currentRoom,
            sessionId,
            ...(latestData === undefined ? {} : { data: latestData }),
        } as ArgsOf<H>;

        // Fire-and-forget — a dropped heartbeat self-heals on the next tick.
        client.mutation(heartbeat, args, { shardKey }).catch(() => undefined);
    };

    const setData = (next: Record<string, unknown> | undefined): void => {
        latestData = next;

        if (mounted) {
            sendHeartbeat();
        }
    };

    // The heartbeat, interval, and live subscription are client-only. During SSR
    // (this package ships a `/server` entry and pairs with `@lunora/nuxt`) a
    // component's `setup()` runs inside `renderToString` with no `window`: firing
    // a heartbeat there writes a ghost presence row under a throwaway session id,
    // and the render scope never stops — so `onScopeDispose` never fires and each
    // request would leak a live `setInterval` handle. Skip the whole client wiring
    // server-side; the returned refs stay inert until the component hydrates.
    if (isBrowser()) {
        // Everything tied to one room. A room change disposes it and arms the next, so the old
        // room's interval, listener, connection context and subscription never outlive it.
        const arm = (room: string): (() => void) => {
            currentRoom = room;
            mounted = true;

            // Guards a value or error the client delivers after this room was torn down.
            let live = true;

            // Heartbeat: immediately on mount, on interval, and on tab re-focus.
            sendHeartbeat();
            const intervalHandle = setInterval(sendHeartbeat, intervalMs);

            const onVisible = (): void => {
                if (typeof document !== "undefined" && document.visibilityState === "visible") {
                    sendHeartbeat();
                }
            };

            if (typeof document !== "undefined") {
                document.addEventListener("visibilitychange", onVisible);
            }

            // Register this room/session as the socket's connection context so the server's
            // presence `onDisconnect` hook can delete the row instantly on socket drop.
            // Use the refcounted acquire so a second presence hook on the same client/shard
            // doesn't clobber this one's context when either unmounts.
            const releaseConnectionContext = client.acquireConnectionContext({ roomId: room, sessionId }, { shardKey });

            // Subscribe to the live present-list for the room.
            const unsubscribe = client.subscribe(
                listPresent,
                { roomId: room } as ArgsOf<L>,
                (value) => {
                    if (live) {
                        present.value = value;
                        error.value = undefined;
                    }
                },
                {
                    onError: (subscriptionError) => {
                        if (live) {
                            error.value = subscriptionError;
                            options.onError?.(subscriptionError);
                        }
                    },
                    shardKey,
                },
            );

            // Teardown: clear interval, remove listener, clear connection context, unsubscribe.
            return () => {
                live = false;
                mounted = false;
                clearInterval(intervalHandle);

                if (typeof document !== "undefined") {
                    document.removeEventListener("visibilitychange", onVisible);
                }

                releaseConnectionContext();
                unsubscribe();
            };
        };

        let teardownRoom = arm(typeof roomId === "string" ? roomId : toValue(roomId));
        let stopWatching: (() => void) | undefined;

        if (typeof roomId !== "string") {
            stopWatching = watch(
                () => toValue(roomId),
                (room) => {
                    teardownRoom();
                    present.value = undefined;
                    error.value = undefined;
                    teardownRoom = arm(room);
                },
            );
        }

        const noScopeWarning =
            "[@lunora/vue] usePresence called with no active effect scope — its heartbeat interval and live subscription will not be cleaned up automatically. Call it inside setup()/an effect scope.";

        onScopeDisposeOrWarn(() => {
            stopWatching?.();
            teardownRoom();
        }, noScopeWarning);
    }

    return { error, present, sessionId, setData };
};

export type { HeartbeatReference, ListPresentReference, UsePresenceOptions, UsePresenceResult };
export { usePresence };
