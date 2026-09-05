import type { Signal } from "@angular/core";
import { DestroyRef, inject, signal } from "@angular/core";
import type { ArgsOf, FunctionReference, LunoraClient, ReturnOf, SubscriptionError, SubscriptionErrorCallback } from "@lunora/client";

import { randomSessionId } from "../../../shared/random-session-id";
import { resolveLunoraClient } from "./client";
import { runOutsideAngular, shouldOpenSubscription } from "./platform";

/**
 * `HeartbeatReference` is part of the experimental `@lunora/angular` API and may change without a major version bump.
 * @experimental
 */
type HeartbeatReference = FunctionReference<"mutation", { data?: Record<string, unknown>; roomId: string; sessionId: string }>;

/**
 * `ListPresentReference` is part of the experimental `@lunora/angular` API and may change without a major version bump.
 * @experimental
 */
type ListPresentReference = FunctionReference<"query", { roomId: string }>;

const DEFAULT_INTERVAL_MS = 10_000;

/**
 * `PresenceOptions` is part of the experimental `@lunora/angular` API and may change without a major version bump.
 * @experimental
 */
export interface PresenceOptions<H extends HeartbeatReference, L extends ListPresentReference> {
    /** Client to bind to. Defaults to the injected `LUNORA_CLIENT`. */
    client?: LunoraClient;

    /** Awareness blob for the first heartbeat (selection, cursor, name, color…). */
    data?: Record<string, unknown>;

    /** `DestroyRef` whose `onDestroy` cleans up. Defaults to `inject(DestroyRef)`. */
    destroyRef?: DestroyRef;

    /** The `api.*` reference for the presence heartbeat mutation. */
    heartbeat: H;

    /** Heartbeat cadence in ms. Defaults to 10s (10000). */
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
     * Stable id for this presence row. Defaults to a fresh per-call id.
     * Pass a user/connection id to control deduping across tabs.
     */
    sessionId?: string;

    /** Forwarded to the heartbeat mutation / listPresent subscription when sharding by room. */
    shardKey?: string;
}

/**
 * `PresenceResult` is part of the experimental `@lunora/angular` API and may change without a major version bump.
 * @experimental
 */
export interface PresenceResult<L extends ListPresentReference> {
    /** The `listPresent` subscription's last error, or `undefined`. */
    error: Signal<SubscriptionError | undefined>;

    /** The present members for the room. `undefined` until the first push. */
    present: Signal<ReturnOf<L> | undefined>;

    /** This mount's session id (generated when not supplied). */
    sessionId: string;

    /** Replace the awareness `data` sent with subsequent heartbeats, and heartbeat immediately. */
    setData: (data: Record<string, unknown> | undefined) => void;
}

/**
 * `presence` — collaborative-awareness primitive, the client half of the
 * `@lunora/server` `definePresence` preset.
 *
 * Drives the heartbeat mutation (on mount, interval, and tab re-focus) and
 * subscribes to the live `listPresent` query for the given room.
 *
 * Call from an injection context (component/service field or constructor):
 * ```ts
 * readonly roomPresence = presence("room:general", {
 *     heartbeat: api.presence.heartbeat,
 *     listPresent: api.presence.listPresent,
 * });
 * ```
 * @experimental
 */
export const presence = <H extends HeartbeatReference, L extends ListPresentReference>(roomId: string, options: PresenceOptions<H, L>): PresenceResult<L> => {
    const client = resolveLunoraClient(options.client);
    const fromInjectionContext = options.destroyRef === undefined;
    const destroyRef = options.destroyRef ?? inject(DestroyRef);
    const { heartbeat, listPresent, shardKey } = options;
    const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;

    const sessionId = options.sessionId ?? randomSessionId();
    const present = signal<ReturnOf<L> | undefined>(undefined);
    const error = signal<SubscriptionError | undefined>(undefined);

    // Latest awareness data — updated by `setData`; read at heartbeat time so
    // changing data never resets the interval or closes the subscription.
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
        throw new RangeError(`presence intervalMs must be a positive number, got ${String(intervalMs)}`);
    }

    let latestData: Record<string, unknown> | undefined = options.data;

    const sendHeartbeat = (): void => {
        const args: ArgsOf<H> = { roomId, sessionId } as ArgsOf<H>;

        if (latestData !== undefined) {
            (args as Record<string, unknown>).data = latestData;
        }

        // Fire-and-forget — a dropped heartbeat self-heals on the next tick.
        client.mutation(heartbeat, args, { shardKey }).catch(() => undefined);
    };

    const setData = (next: Record<string, unknown> | undefined): void => {
        latestData = next;
        sendHeartbeat();
    };

    // Skip every network side effect on the Angular server platform (SSR): Node
    // 22+ ships a global `WebSocket`, so a field-initializer heartbeat/subscribe
    // would open a real connection during the server render. `present` stays
    // `undefined`; the browser render re-runs this and connects.
    if (shouldOpenSubscription(fromInjectionContext)) {
        // Register this room/session as the socket's connection context BEFORE the
        // first heartbeat so the server's presence `onDisconnect` hook can delete
        // the row instantly on socket drop.
        const releaseConnectionContext = client.acquireConnectionContext({ roomId, sessionId }, { shardKey });

        // Heartbeat immediately on mount.
        sendHeartbeat();

        const onVisible = (): void => {
            if (typeof document !== "undefined" && document.visibilityState === "visible") {
                sendHeartbeat();
            }
        };

        // Register the interval + visibilitychange listener OUTSIDE Angular's zone:
        // a heartbeat tick is a pure network side effect that writes no signal, so
        // it must not schedule an app-wide change-detection pass every `intervalMs`
        // (nor on every tab re-focus).
        const intervalHandle = runOutsideAngular(fromInjectionContext, () => {
            if (typeof document !== "undefined") {
                document.addEventListener("visibilitychange", onVisible);
            }

            return setInterval(sendHeartbeat, intervalMs);
        });

        // Subscribe to the live present-list for the room.
        const listArgs: ArgsOf<L> = { roomId } as ArgsOf<L>;

        const unsubscribe = client.subscribe(
            listPresent,
            listArgs,
            (value) => {
                present.set(value);
                error.set(undefined);
            },
            {
                onError: (subscriptionError) => {
                    error.set(subscriptionError);
                    options.onError?.(subscriptionError);
                },
                shardKey,
            },
        );

        // Teardown: clear interval, remove listener, release connection context, unsubscribe.
        destroyRef.onDestroy(() => {
            clearInterval(intervalHandle);

            if (typeof document !== "undefined") {
                document.removeEventListener("visibilitychange", onVisible);
            }

            releaseConnectionContext();
            unsubscribe();
        });
    }

    return { error: error.asReadonly(), present: present.asReadonly(), sessionId, setData };
};

export type { HeartbeatReference, ListPresentReference };
