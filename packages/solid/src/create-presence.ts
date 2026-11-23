import type { ArgsOf, FunctionReference, ReturnOf, SubscriptionError, SubscriptionErrorCallback } from "@lunora/client";
import type { Accessor } from "solid-js";
import { createMemo, createSignal, onCleanup } from "solid-js";

import { assertPresenceInterval } from "../../../shared/presence-interval";
import { createPresenceWrites } from "../../../shared/presence-writes";
import { randomSessionId } from "../../../shared/random-session-id";
import { useLunora } from "./context";
import { trackedEffect } from "./solid-compat";

/**
 * `createPresence` — collaborative-awareness primitive, the client half of the
 * `@lunora/server` `definePresence` preset.
 *
 * Drives the heartbeat mutation (on mount, interval, and tab re-focus) and
 * subscribes to the live `listPresent` query for the given room. `roomId` may
 * be an accessor; a change stops the old room's heartbeats and subscription and
 * joins the new one. Pass `leave` to drop the old room's row at once; without it
 * the server keeps that row until it ages out (`ttlMs`).
 *
 * Call inside a reactive context (component / `createRoot`).
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

/**
 * The presence `leave` mutation: `definePresence(...).functions.leave`.
 */
type LeaveReference = FunctionReference<"mutation", { roomId: string; sessionId: string }>;

interface CreatePresenceOptions<H extends HeartbeatReference, L extends ListPresentReference> {
    /** Awareness blob for the first heartbeat (selection, cursor, name, color…). */
    data?: Record<string, unknown>;
    /** The `api.*` reference for the presence heartbeat mutation. */
    heartbeat: H;
    /** Heartbeat cadence in ms. Defaults to 10s. */
    intervalMs?: number;

    /**
     * The `api.*` reference for the presence `leave` mutation. When given, leaving a room (a room
     * change, or teardown) removes this session's row there at once; without it the old room lists
     * the session until its last heartbeat ages out (`ttlMs`).
     */
    leave?: LeaveReference;
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

interface CreatePresenceResult<L extends ListPresentReference> {
    /** The `listPresent` subscription's last error, or `undefined`. */
    error: () => SubscriptionError | undefined;
    /** The present members for the room. `undefined` until the first push. */
    present: () => ReturnOf<L> | undefined;
    /** This mount's session id (generated when not supplied). */
    sessionId: string;
    /** Replace the awareness `data` sent with subsequent heartbeats, and heartbeat immediately. */
    setData: (data: Record<string, unknown> | undefined) => void;
}

const DEFAULT_INTERVAL_MS = 10_000;

const createPresence = <H extends HeartbeatReference, L extends ListPresentReference>(
    roomId: Accessor<string> | string,
    options: CreatePresenceOptions<H, L>,
): CreatePresenceResult<L> => {
    const client = useLunora();
    const { heartbeat, intervalMs = DEFAULT_INTERVAL_MS, leave, listPresent, shardKey } = options;

    assertPresenceInterval(intervalMs);

    const sessionId = options.sessionId ?? randomSessionId();

    const [present, setPresent] = createSignal<ReturnOf<L> | undefined>(undefined);
    const [error, setError] = createSignal<SubscriptionError | undefined>(undefined);

    // Latest awareness data — updated by `setData`; read at heartbeat time so
    // changing data never resets the interval or closes the subscription.
    let latestData: Record<string, unknown> | undefined = options.data;
    // True only between mount and teardown; `setData` must not heartbeat before then.
    let mounted = false;
    // The room the armed wiring belongs to; only read while `mounted`.
    let currentRoom = "";

    // A room's leave cannot overtake its heartbeat still in flight, nor a rejoin's heartbeat its leave.
    const presenceWrites = createPresenceWrites();

    const sendHeartbeat = (): void => {
        const args = {
            roomId: currentRoom,
            sessionId,
            ...(latestData === undefined ? {} : { data: latestData }),
        } as ArgsOf<H>;

        // Never queued: a heartbeat replayed after reconnect would mark a room this session has since left.
        presenceWrites.heartbeat(currentRoom, async () => client.mutation(heartbeat, args, { onlineOnly: true, shardKey }));
    };

    const setData = (next: Record<string, unknown> | undefined): void => {
        latestData = next;

        if (mounted) {
            sendHeartbeat();
        }
    };

    // The memo below runs eagerly on the server, where an accessor such as
    // `() => window.location.hash` throws; effects never run there anyway, so stay idle until the
    // client takes over. `solid-js/web`'s `isServer` is not importable from both majors.
    if ((globalThis as { window?: unknown }).window === undefined) {
        return { error, present, sessionId, setData };
    }

    // The room teardown is handed to the effect only once `apply` returns, but a replayed refusal can
    // dispose the owner from inside `subscribe` before that. The owner's own cleanup covers that window:
    // it tears the room being armed down, and `apply` unsubscribes as soon as `subscribe` returns.
    let ownerDisposed = false;
    let disposeArming: (() => void) | undefined;
    const isOwnerDisposed = (): boolean => ownerDisposed;

    onCleanup(() => {
        ownerDisposed = true;
        disposeArming?.();
    });

    // Memoised: Solid 1.x's `on` re-runs on every dependency notification, so an accessor that
    // re-computes the same room string would otherwise leave and rejoin the room.
    const resolveRoom: Accessor<string> = typeof roomId === "function" ? createMemo(roomId) : () => roomId;

    // Re-runs per room: the previous room's interval, listener, connection context and subscription
    // are torn down before the next room is armed. Effects do not run during SSR, which keeps
    // heartbeats and sockets off the server.
    trackedEffect(resolveRoom, (room) => {
        currentRoom = room;
        mounted = true;

        // A room change must not show the previous room's members or error under the new one.
        setPresent(() => undefined);
        setError(() => undefined);

        // Guards a value or error the client delivers after this room was torn down.
        let live = true;

        // Heartbeat immediately on mount, and at once for a new room.
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

        // Register connection context so server can drop the row on socket disconnect.
        //
        // Use the refcounted `acquireConnectionContext` (not the last-writer-wins
        // `setConnectionContext`): two `createPresence` hooks mounted on the same
        // shard each hold their own registration, so one unmounting no longer
        // clears the other's context. The returned release drops only this hook's
        // holder.
        const releaseConnectionContext = client.acquireConnectionContext({ roomId: room, sessionId }, { shardKey });

        let unsubscribe: (() => void) | undefined;
        let disposed = false;

        // The one teardown for this room: a normal room change or unmount, a setup rollback, and the
        // owner disposed while `subscribe` replays. Idempotent, so `leave` goes out exactly once.
        const dispose = (): void => {
            if (disposed) {
                return;
            }

            disposed = true;
            live = false;
            mounted = false;
            clearInterval(intervalHandle);

            if (typeof document !== "undefined") {
                document.removeEventListener("visibilitychange", onVisible);
            }

            releaseConnectionContext();
            unsubscribe?.();

            // The old room stops listing this session now, instead of when its last heartbeat ages out.
            if (leave !== undefined) {
                presenceWrites.leave(room, async () => client.mutation(leave, { roomId: room, sessionId }, { onlineOnly: true, shardKey }));
            }
        };

        disposeArming = dispose;

        // Subscribe to the live present-list for the room; a throw rolls this room's setup back.
        try {
            unsubscribe = client.subscribe(
                listPresent,
                { roomId: room } as ArgsOf<L>,
                (value) => {
                    if (live) {
                        setPresent(() => value);
                        setError(undefined);
                    }
                },
                {
                    onError: (subscriptionError) => {
                        if (live) {
                            setError(subscriptionError);
                            options.onError?.(subscriptionError);
                        }
                    },
                    shardKey,
                },
            );
        } catch (subscribeError) {
            dispose();

            throw subscribeError;
        } finally {
            disposeArming = undefined;
        }

        // A read through a call: `subscribe` can flip the flag, which control-flow narrowing cannot see.
        // The owner's cleanup ran `dispose` before `subscribe` returned the handle, so close it now.
        if (isOwnerDisposed()) {
            unsubscribe();

            return undefined;
        }

        return dispose;
    });

    return { error, present, sessionId, setData };
};

export type { CreatePresenceOptions, CreatePresenceResult, HeartbeatReference, LeaveReference, ListPresentReference };
export { createPresence };
