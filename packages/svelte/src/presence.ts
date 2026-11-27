import type { ArgsOf, FunctionReference, LunoraClient, ReturnOf, SubscriptionError, SubscriptionErrorCallback } from "@lunora/client";
import { onDestroy } from "svelte";
import type { Readable } from "svelte/store";
import { readable, writable } from "svelte/store";

import { isBrowser } from "../../../shared/is-browser";
import { assertPresenceInterval } from "../../../shared/presence-interval";
import { holdPresenceRow, onReconnected, sendPresenceHeartbeat, sendPresenceLeave } from "../../../shared/presence-writes";
import { randomSessionId } from "../../../shared/random-session-id";
import { getLunoraClient } from "./context";
import { subscribeReactiveArgs } from "./subscribe-reactive-args";

/**
 * `presence` — collaborative-awareness stores, the client half of the
 * `@lunora/server` `definePresence` preset.
 *
 * Drives the heartbeat mutation (on call, interval, and tab re-focus) and
 * subscribes to the live `listPresent` query for the given room. `roomId` may
 * be a `Readable<string>`; a change stops the old room's heartbeats and
 * subscription and joins the new one. Pass `leave` to drop the old room's row
 * at once; without it the server keeps that row until it ages out (`ttlMs`).
 *
 * Pass `client` explicitly, or omit it to resolve the ambient client from the
 * Svelte context.
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

interface PresenceOptions<H extends HeartbeatReference, L extends ListPresentReference> {
    /** Awareness blob for the first heartbeat (selection, cursor, name, color…). */
    data?: Record<string, unknown>;
    /** The `api.*` reference for the presence heartbeat mutation. */
    heartbeat: H;
    /** Heartbeat cadence in ms. Defaults to 10s. */
    intervalMs?: number;

    /**
     * The `api.*` reference for the presence `leave` mutation. When given, leaving a room (a room
     * change, or teardown) removes this session's row there at once, unless another view on the same
     * client still shows that session in that room; without it the old room lists the session until
     * its last heartbeat ages out (`ttlMs`).
     */
    leave?: LeaveReference;
    /** The `api.*` reference for the presence listPresent query. */
    listPresent: L;

    /**
     * Called when the `listPresent` subscription reports an error (a session
     * expiry, an RLS denial). Without it — and without reading `error` — such a
     * failure is invisible and `present` freezes at its last value.
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

interface PresenceHandle<L extends ListPresentReference> {
    /** The `listPresent` subscription's last error, or `undefined`. */
    error: Readable<SubscriptionError | undefined>;
    /** The present members for the room. `undefined` until the first push. */
    present: Readable<ReturnOf<L> | undefined>;
    /** This handle's session id. */
    sessionId: string;
    /** Replace the awareness `data` sent with subsequent heartbeats, and heartbeat immediately. */
    setData: (data: Record<string, unknown> | undefined) => void;
    /** Stop all heartbeats, remove the visibility listener, and unsubscribe. Call in `onDestroy`. */
    teardown: () => void;
}

/** Best-effort unique id for a presence session. */
const DEFAULT_INTERVAL_MS = 10_000;

const createPresenceHandle = <H extends HeartbeatReference, L extends ListPresentReference>(
    client: LunoraClient,
    roomId: Readable<string> | string,
    options: PresenceOptions<H, L>,
): PresenceHandle<L> => {
    const { heartbeat, intervalMs = DEFAULT_INTERVAL_MS, leave, listPresent, shardKey } = options;

    assertPresenceInterval(intervalMs);

    const sessionId = options.sessionId ?? randomSessionId();

    let latestData: Record<string, unknown> | undefined = options.data;
    // True only between the client-side mount and teardown; `setData` must not heartbeat before then.
    let mounted = false;
    // The room the armed wiring belongs to; only read while `mounted`.
    let currentRoom = "";

    const sendHeartbeat = (): void => {
        const args = {
            roomId: currentRoom,
            sessionId,
            ...(latestData === undefined ? {} : { data: latestData }),
        } as ArgsOf<H>;

        // Never queued: a heartbeat replayed after reconnect would mark a room this session has since left.
        const write = async () => client.mutation(heartbeat, args, { onlineOnly: true, shardKey });

        sendPresenceHeartbeat(client, { roomId: currentRoom, sessionId, shardKey }, write);
    };

    const setData = (next: Record<string, unknown> | undefined): void => {
        latestData = next;

        if (mounted) {
            sendHeartbeat();
        }
    };

    const onVisible = (): void => {
        if (typeof document !== "undefined" && document.visibilityState === "visible") {
            sendHeartbeat();
        }
    };

    let stopRoomWiring: (() => void) | undefined;

    // The heartbeat, interval, visibility listener, connection-context, and
    // live subscription below are all client-only side effects. During SSR
    // (this package pairs with `@lunora/nuxt`'s server rendering) a
    // component's init runs inside `renderToString` with no `window`: firing a
    // heartbeat there writes a ghost presence row under a throwaway session
    // id, and the render scope never stops — so the auto-`onDestroy` below
    // never fires and every server render would leak a live `setInterval`
    // handle (SVELTE-01). Skip the whole client wiring server-side, mirroring
    // `@lunora/vue`'s `use-presence.ts` guard; the returned store stays inert
    // until the component hydrates.
    if (isBrowser()) {
        // A room change tears the previous room's interval and connection context down before the
        // next room is armed, so neither outlives the room it belongs to.
        stopRoomWiring = subscribeReactiveArgs(roomId, (room) => {
            currentRoom = room;
            mounted = true;
            sendHeartbeat();

            const intervalHandle = setInterval(sendHeartbeat, intervalMs);

            if (typeof document !== "undefined") {
                document.addEventListener("visibilitychange", onVisible);
            }

            // Register connection context so server can drop the row on socket disconnect.
            // Use the refcounted acquire (not the last-writer-wins setter) so a second
            // presence store on the same client/shard doesn't clobber this one's context
            // when either tears down.
            const releaseConnectionContext = client.acquireConnectionContext({ roomId: room, sessionId }, { shardKey });
            const releaseRow = holdPresenceRow(client, { roomId: room, sessionId, shardKey });
            const stopRejoin = onReconnected(client, shardKey, sendHeartbeat);

            return () => {
                mounted = false;
                clearInterval(intervalHandle);

                if (typeof document !== "undefined") {
                    document.removeEventListener("visibilitychange", onVisible);
                }

                stopRejoin();

                releaseConnectionContext();

                // The old room stops listing this session now, instead of when its last heartbeat ages out — unless

                // another mounted view still shows the same session there.
                if (releaseRow() && leave !== undefined) {
                    const write = async () => client.mutation(leave, { roomId: room, sessionId }, { onlineOnly: true, shardKey });

                    sendPresenceLeave(client, { roomId: room, sessionId, shardKey }, write);
                }
            };
        });
    }

    const errorStore = writable<SubscriptionError | undefined>();
    let torndown = false;
    // Read through a call where `subscribe` can flip it: control-flow narrowing cannot see that.
    const isTornDown = (): boolean => torndown;
    // `teardown` stops the live subscription even while a consumer is still subscribed to `present`;
    // otherwise a later room change would open a fresh one for a destroyed handle.
    let stopPresentRoom: (() => void) | undefined;

    // Subscribe to the live present-list; expose as a Readable store. Also
    // gated: `readable`'s start callback only runs once the store gets its
    // first subscriber, but a server-rendered page that reads `$present`
    // during `renderToString` WOULD trigger it — so guard it too rather than
    // open a live WS subscription server-side.
    const present = readable<ReturnOf<L> | undefined>(undefined, (set) => {
        if (!isBrowser() || torndown) {
            return undefined;
        }

        const stop = subscribeReactiveArgs(roomId, (room) => {
            // A room change after teardown opens nothing.
            if (torndown) {
                return () => {};
            }

            // A room change must not show the previous room's members or error under the new one.
            set(undefined);
            errorStore.set(undefined);

            // Guards a value or error the client delivers after this room was torn down.
            let live = true;

            const unsubscribe = client.subscribe(
                listPresent,
                { roomId: room } as ArgsOf<L>,
                (value) => {
                    if (live) {
                        set(value);
                        errorStore.set(undefined);
                    }
                },
                {
                    onError: (subscriptionError) => {
                        if (live) {
                            errorStore.set(subscriptionError);
                            options.onError?.(subscriptionError);
                        }
                    },
                    shardKey,
                },
            );

            // Torn down while `subscribe` replayed (a refusal whose `onError` called `teardown`):
            // the stop that ran held the previous room's disposer, not this one.
            if (isTornDown()) {
                live = false;
                unsubscribe();

                return () => {};
            }

            return () => {
                live = false;
                unsubscribe();
            };
        });
        let stopped = false;
        const stopOnce = (): void => {
            if (!stopped) {
                stopped = true;
                stopPresentRoom = undefined;
                stop();
            }
        };

        stopPresentRoom = stopOnce;

        return stopOnce;
    });

    const teardown = (): void => {
        // Idempotent: the auto-wired `onDestroy` below and a manual
        // `onDestroy(handle.teardown)` (or a `setData`-after-teardown) may both
        // fire, and `releaseConnectionContext` must run at most once.
        if (torndown) {
            return;
        }

        torndown = true;
        mounted = false;
        stopRoomWiring?.();
        stopPresentRoom?.();
    };

    // Auto-teardown on component destruction so a consumer who forgets
    // `onDestroy(handle.teardown)` does not leak the heartbeat interval and
    // connection context. When called outside a component (tests, or an
    // explicit-client helper), `onDestroy` throws — fall back to the manual
    // `handle.teardown()` contract.
    try {
        onDestroy(teardown);
    } catch {
        // Not inside a component's init: the caller owns teardown.
    }

    return { error: { subscribe: errorStore.subscribe }, present, sessionId, setData, teardown };
};

/**
 * Open a live presence handle.
 *
 * Pass `client` explicitly, or omit it to resolve the ambient client from the
 * Svelte context (requires calling inside a component's `<script>` block or
 * inside a function called during component initialisation).
 *
 * Teardown (stop heartbeats, remove the visibility listener, release the
 * connection context) is wired automatically to the component's `onDestroy`
 * when called during component initialisation. Outside a component call
 * `handle.teardown()` yourself. `teardown()` is idempotent, so an explicit
 * `onDestroy(handle.teardown)` on top of the auto-wiring is safe.
 */
export function presence<H extends HeartbeatReference, L extends ListPresentReference>(
    roomId: Readable<string> | string,
    options: PresenceOptions<H, L>,
): PresenceHandle<L>;
export function presence<H extends HeartbeatReference, L extends ListPresentReference>(
    client: LunoraClient,
    roomId: Readable<string> | string,
    options: PresenceOptions<H, L>,
): PresenceHandle<L>;
export function presence<H extends HeartbeatReference, L extends ListPresentReference>(
    clientOrRoomId: LunoraClient | Readable<string> | string,
    roomIdOrOptions: PresenceOptions<H, L> | Readable<string> | string,
    maybeOptions?: PresenceOptions<H, L>,
): PresenceHandle<L> {
    // By arity, not by type: a `Readable` room and a `LunoraClient` both expose `subscribe`.
    const hasExplicitClient = maybeOptions !== undefined;
    const client = hasExplicitClient ? (clientOrRoomId as LunoraClient) : getLunoraClient();
    const roomId = (hasExplicitClient ? roomIdOrOptions : clientOrRoomId) as Readable<string> | string;
    const options = (hasExplicitClient ? maybeOptions : roomIdOrOptions) as PresenceOptions<H, L>;

    return createPresenceHandle(client, roomId, options);
}

export type { HeartbeatReference, LeaveReference, ListPresentReference, PresenceHandle, PresenceOptions };
