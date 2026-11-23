import type { Injector, Signal } from "@angular/core";
import { DestroyRef, inject, signal } from "@angular/core";
import type { ArgsOf, FunctionReference, LunoraClient, ReturnOf, SubscriptionError, SubscriptionErrorCallback } from "@lunora/client";

import { assertPresenceInterval } from "../../../shared/presence-interval";
import { createPresenceWrites } from "../../../shared/presence-writes";
import { randomSessionId } from "../../../shared/random-session-id";
import { resolveLunoraClient } from "./client";
import { attachReactiveArgs, outsideAngularRunner, shouldOpenSubscription } from "./platform";

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

/**
 * The presence `leave` mutation: `definePresence(...).functions.leave`.
 * `LeaveReference` is part of the experimental `@lunora/angular` API and may change without a major version bump.
 * @experimental
 */
type LeaveReference = FunctionReference<"mutation", { roomId: string; sessionId: string }>;

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

    /**
     * `Injector` to create the reactive-room `effect()` from. Only needed when `roomId`
     * is a function/`Signal` AND `presence` is called outside an injection context (an
     * explicit `destroyRef` is also being passed). Defaults to the ambient injection context.
     */
    injector?: Injector;

    /** Heartbeat cadence in ms. Defaults to 10s (10000). */
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
 * subscribes to the live `listPresent` query for the given room. `roomId` may
 * be a function or `Signal`; a change stops the old room's heartbeats and
 * subscription and joins the new one. Pass `leave` to drop the old room's row
 * at once; without it the server keeps that row until it ages out (`ttlMs`).
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
export const presence = <H extends HeartbeatReference, L extends ListPresentReference>(
    roomId: string | (() => string),
    options: PresenceOptions<H, L>,
): PresenceResult<L> => {
    const client = resolveLunoraClient(options.client);
    const fromInjectionContext = options.destroyRef === undefined;
    const destroyRef = options.destroyRef ?? inject(DestroyRef);
    const { heartbeat, leave, listPresent, shardKey } = options;
    const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;

    const sessionId = options.sessionId ?? randomSessionId();
    const present = signal<ReturnOf<L> | undefined>(undefined);
    const error = signal<SubscriptionError | undefined>(undefined);

    assertPresenceInterval(intervalMs);

    // Latest awareness data — updated by `setData`; read at heartbeat time so
    // changing data never resets the interval or closes the subscription.
    let latestData: Record<string, unknown> | undefined = options.data;
    // True only inside the subscription gate; `setData` must not heartbeat on the server.
    let mounted = false;
    // The room the armed wiring belongs to; only read while `mounted`.
    let currentRoom = "";

    // Resolved here, in the injection context: the arm below can run later from an effect.
    const runInZone = outsideAngularRunner(fromInjectionContext);

    // A room's leave cannot overtake its heartbeat still in flight, nor a rejoin's heartbeat its leave.
    const presenceWrites = createPresenceWrites();

    const sendHeartbeat = (): void => {
        const args: ArgsOf<H> = { roomId: currentRoom, sessionId } as ArgsOf<H>;

        if (latestData !== undefined) {
            (args as Record<string, unknown>).data = latestData;
        }

        // Fire-and-forget — a dropped heartbeat self-heals on the next tick. Never queued: a
        // heartbeat replayed after reconnect would mark a room this session has since left.
        presenceWrites.heartbeat(currentRoom, async () => client.mutation(heartbeat, args, { onlineOnly: true, shardKey }));
    };

    const setData = (next: Record<string, unknown> | undefined): void => {
        latestData = next;

        if (mounted) {
            sendHeartbeat();
        }
    };

    // Skip every network side effect on the Angular server platform (SSR): Node
    // 22+ ships a global `WebSocket`, so a field-initializer heartbeat/subscribe
    // would open a real connection during the server render. `present` stays
    // `undefined`; the browser render re-runs this and connects.
    // Only a reactive room runs in `options.injector` (its effect does); a static one uses the ambient context.
    if (shouldOpenSubscription(fromInjectionContext, typeof roomId === "function" ? options.injector : undefined)) {
        // Everything tied to one room. A room change disposes it and arms the next, so the old
        // room's interval, listener, connection context and subscription never outlive it.
        // `register` receives the room's teardown BEFORE it subscribes: a replayed refusal can
        // destroy the owner inside `subscribe`, and a teardown registered after that never runs.
        const arm = (room: string, register: (teardown: () => void) => void): void => {
            currentRoom = room;
            mounted = true;

            // Guards a value or error the client delivers after this room was torn down.
            let live = true;

            // Register this room/session as the socket's connection context BEFORE the
            // first heartbeat so the server's presence `onDisconnect` hook can delete
            // the row instantly on socket drop.
            const releaseConnectionContext = client.acquireConnectionContext({ roomId: room, sessionId }, { shardKey });

            // Heartbeat immediately on mount, and at once for a new room.
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
            const intervalHandle = runInZone(() => {
                if (typeof document !== "undefined") {
                    document.addEventListener("visibilitychange", onVisible);
                }

                return setInterval(sendHeartbeat, intervalMs);
            });

            let unsubscribe: (() => void) | undefined;
            let disposed = false;

            // Teardown: clear interval, remove listener, release connection context, unsubscribe.
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

            // Read through a call: `subscribe` can flip the flag, which control-flow narrowing cannot see.
            const isDisposed = (): boolean => disposed;

            register(dispose);

            // Subscribe to the live present-list for the room.
            const listArgs: ArgsOf<L> = { roomId: room } as ArgsOf<L>;

            try {
                unsubscribe = client.subscribe(
                    listPresent,
                    listArgs,
                    (value) => {
                        if (live) {
                            present.set(value);
                            error.set(undefined);
                        }
                    },
                    {
                        onError: (subscriptionError) => {
                            if (live) {
                                error.set(subscriptionError);
                                options.onError?.(subscriptionError);
                            }
                        },
                        shardKey,
                    },
                );
            } catch (subscribeError) {
                dispose();

                throw subscribeError;
            }

            // Torn down while `subscribe` replayed: the handle arrived after the teardown ran.
            if (isDisposed()) {
                unsubscribe();
            }
        };

        if (typeof roomId === "function") {
            attachReactiveArgs(roomId, { destroyRef, injector: options.injector }, (room, onCleanup) => {
                // A room change must not show the previous room's members or error under the new one.
                present.set(undefined);
                error.set(undefined);
                arm(room, onCleanup);
            });
        } else {
            arm(roomId, (teardown) => {
                destroyRef.onDestroy(teardown);
            });
        }
    }

    return { error: error.asReadonly(), present: present.asReadonly(), sessionId, setData };
};

export type { HeartbeatReference, LeaveReference, ListPresentReference };
