import type { ArgsOf, FunctionReference, LunoraClient, ReturnOf, SubscriptionError, SubscriptionErrorCallback } from "@lunora/client";
import { onDestroy } from "svelte";
import type { Readable } from "svelte/store";
import { readable, writable } from "svelte/store";

import { isBrowser } from "../../../shared/is-browser";
import { randomSessionId } from "../../../shared/random-session-id";
import { getLunoraClient } from "./context";

/**
 * `presence` — collaborative-awareness stores, the client half of the
 * `@lunora/server` `definePresence` preset.
 *
 * Drives the heartbeat mutation (on call, interval, and tab re-focus) and
 * subscribes to the live `listPresent` query for the given room.
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

interface PresenceOptions<H extends HeartbeatReference, L extends ListPresentReference> {
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
    roomId: string,
    options: PresenceOptions<H, L>,
): PresenceHandle<L> => {
    const { heartbeat, intervalMs = DEFAULT_INTERVAL_MS, listPresent, shardKey } = options;
    const sessionId = options.sessionId ?? randomSessionId();

    let latestData: Record<string, unknown> | undefined = options.data;

    const sendHeartbeat = (): void => {
        const args = {
            roomId,
            sessionId,
            ...(latestData === undefined ? {} : { data: latestData }),
        } as ArgsOf<H>;

        client.mutation(heartbeat, args, { shardKey }).catch(() => undefined);
    };

    const setData = (next: Record<string, unknown> | undefined): void => {
        latestData = next;
        sendHeartbeat();
    };

    const onVisible = (): void => {
        if (typeof document !== "undefined" && document.visibilityState === "visible") {
            sendHeartbeat();
        }
    };

    let intervalHandle: ReturnType<typeof setInterval> | undefined;
    let releaseConnectionContext: (() => void) | undefined;

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
        sendHeartbeat();
        intervalHandle = setInterval(sendHeartbeat, intervalMs);

        if (typeof document !== "undefined") {
            document.addEventListener("visibilitychange", onVisible);
        }

        // Register connection context so server can drop the row on socket disconnect.
        // Use the refcounted acquire (not the last-writer-wins setter) so a second
        // presence store on the same client/shard doesn't clobber this one's context
        // when either tears down.
        releaseConnectionContext = client.acquireConnectionContext({ roomId, sessionId }, { shardKey });
    }

    const errorStore = writable<SubscriptionError | undefined>();

    // Subscribe to the live present-list; expose as a Readable store. Also
    // gated: `readable`'s start callback only runs once the store gets its
    // first subscriber, but a server-rendered page that reads `$present`
    // during `renderToString` WOULD trigger it — so guard it too rather than
    // open a live WS subscription server-side.
    const present = readable<ReturnOf<L> | undefined>(undefined, (set) => {
        if (!isBrowser()) {
            return undefined;
        }

        return client.subscribe(
            listPresent,
            { roomId } as ArgsOf<L>,
            (value) => {
                set(value);
                errorStore.set(undefined);
            },
            {
                onError: (subscriptionError) => {
                    errorStore.set(subscriptionError);
                    options.onError?.(subscriptionError);
                },
                shardKey,
            },
        );
    });

    let torndown = false;

    const teardown = (): void => {
        // Idempotent: the auto-wired `onDestroy` below and a manual
        // `onDestroy(handle.teardown)` (or a `setData`-after-teardown) may both
        // fire, and `releaseConnectionContext` must run at most once.
        if (torndown) {
            return;
        }

        torndown = true;

        if (intervalHandle !== undefined) {
            clearInterval(intervalHandle);
        }

        if (typeof document !== "undefined") {
            document.removeEventListener("visibilitychange", onVisible);
        }

        releaseConnectionContext?.();
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
export function presence<H extends HeartbeatReference, L extends ListPresentReference>(roomId: string, options: PresenceOptions<H, L>): PresenceHandle<L>;
export function presence<H extends HeartbeatReference, L extends ListPresentReference>(
    client: LunoraClient,
    roomId: string,
    options: PresenceOptions<H, L>,
): PresenceHandle<L>;
export function presence<H extends HeartbeatReference, L extends ListPresentReference>(
    clientOrRoomId: LunoraClient | string,
    roomIdOrOptions: PresenceOptions<H, L> | string,
    maybeOptions?: PresenceOptions<H, L>,
): PresenceHandle<L> {
    const hasExplicitClient = typeof clientOrRoomId !== "string";
    const client = hasExplicitClient ? clientOrRoomId : getLunoraClient();
    const roomId = (hasExplicitClient ? roomIdOrOptions : clientOrRoomId) as string;
    const options = (hasExplicitClient ? maybeOptions : roomIdOrOptions) as PresenceOptions<H, L>;

    return createPresenceHandle(client, roomId, options);
}

export type { HeartbeatReference, ListPresentReference, PresenceHandle, PresenceOptions };
