import type { Signal } from "@angular/core";
import { DestroyRef, inject, signal } from "@angular/core";
import type { ArgsOf, FunctionReference, LunoraClient, ReturnOf } from "@lunora/client";

import { resolveLunoraClient } from "./client";

type HeartbeatReference = FunctionReference<"mutation", { data?: Record<string, unknown>; roomId: string; sessionId: string }>;

type ListPresentReference = FunctionReference<"query", { roomId: string }>;

/* eslint-disable n/no-unsupported-features/node-builtins -- crypto.randomUUID is available in all target browsers and Node 19+; the fallback below handles older runtimes. */
/* eslint-disable sonarjs/pseudo-random -- the fallback session id is a non-cryptographic correlation key, not a security primitive. */
const makeSessionId = (): string => {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }

    return `sess-${Math.random().toString(36).slice(2)}-${String(Date.now())}`;
};
/* eslint-enable n/no-unsupported-features/node-builtins */
/* eslint-enable sonarjs/pseudo-random */

const DEFAULT_INTERVAL_MS = 10_000;

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
     * Stable id for this presence row. Defaults to a fresh per-call id.
     * Pass a user/connection id to control deduping across tabs.
     */
    sessionId?: string;

    /** Forwarded to the heartbeat mutation / listPresent subscription when sharding by room. */
    shardKey?: string;
}

export interface PresenceResult<L extends ListPresentReference> {
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
 */
export const presence = <H extends HeartbeatReference, L extends ListPresentReference>(roomId: string, options: PresenceOptions<H, L>): PresenceResult<L> => {
    const client = resolveLunoraClient(options.client);
    const destroyRef = options.destroyRef ?? inject(DestroyRef);
    const { heartbeat, listPresent, shardKey } = options;
    const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;

    const sessionId = options.sessionId ?? makeSessionId();
    const present = signal<ReturnOf<L> | undefined>(undefined);

    // Latest awareness data — updated by `setData`; read at heartbeat time so
    // changing data never resets the interval or closes the subscription.
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
        throw new RangeError(`presence intervalMs must be a positive number, got ${String(intervalMs)}`);
    }

    let latestData: Record<string, unknown> | undefined = options.data;

    // Register this room/session as the socket's connection context BEFORE the
    // first heartbeat so the server's presence `onDisconnect` hook can delete
    // the row instantly on socket drop.
    const releaseConnectionContext = client.acquireConnectionContext({ roomId, sessionId }, { shardKey });

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

    // Subscribe to the live present-list for the room.
    const listArgs: ArgsOf<L> = { roomId } as ArgsOf<L>;

    const unsubscribe = client.subscribe(
        listPresent,
        listArgs,
        (value) => {
            present.set(value);
        },
        { shardKey },
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

    return { present: present.asReadonly(), sessionId, setData };
};
