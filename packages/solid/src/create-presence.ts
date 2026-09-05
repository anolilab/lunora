import type { ArgsOf, FunctionReference, ReturnOf, SubscriptionError, SubscriptionErrorCallback } from "@lunora/client";
import { createSignal } from "solid-js";

import { randomSessionId } from "../../../shared/random-session-id";
import { useLunora } from "./context";
import { onMounted } from "./solid-compat";

/**
 * `createPresence` — collaborative-awareness primitive, the client half of the
 * `@lunora/server` `definePresence` preset.
 *
 * Drives the heartbeat mutation (on mount, interval, and tab re-focus) and
 * subscribes to the live `listPresent` query for the given room.
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

interface CreatePresenceOptions<H extends HeartbeatReference, L extends ListPresentReference> {
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
    roomId: string,
    options: CreatePresenceOptions<H, L>,
): CreatePresenceResult<L> => {
    const client = useLunora();
    const { heartbeat, intervalMs = DEFAULT_INTERVAL_MS, listPresent, shardKey } = options;

    const sessionId = options.sessionId ?? randomSessionId();

    const [present, setPresent] = createSignal<ReturnOf<L> | undefined>(undefined);
    const [error, setError] = createSignal<SubscriptionError | undefined>(undefined);

    // Latest awareness data — updated by `setData`; read at heartbeat time so
    // changing data never resets the interval or closes the subscription.
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

    onMounted(() => {
        // Heartbeat immediately on mount.
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
        const releaseConnectionContext = client.acquireConnectionContext({ roomId, sessionId }, { shardKey });

        // Subscribe to the live present-list for the room.
        const unsubscribe = client.subscribe(
            listPresent,
            { roomId } as ArgsOf<L>,
            (value) => {
                setPresent(() => value);
                setError(undefined);
            },
            {
                onError: (subscriptionError) => {
                    setError(subscriptionError);
                    options.onError?.(subscriptionError);
                },
                shardKey,
            },
        );

        return () => {
            clearInterval(intervalHandle);

            if (typeof document !== "undefined") {
                document.removeEventListener("visibilitychange", onVisible);
            }

            releaseConnectionContext();
            unsubscribe();
        };
    });

    return { error, present, sessionId, setData };
};

export type { CreatePresenceOptions, CreatePresenceResult, HeartbeatReference, ListPresentReference };
export { createPresence };
