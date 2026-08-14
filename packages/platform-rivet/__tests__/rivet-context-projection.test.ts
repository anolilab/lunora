import { describe, expect, expectTypeOf, it } from "vitest";

import type {
    RivetActorHandleLike,
    RivetActorLike,
    RivetActorNamespaceLike,
    RivetCronLike,
    RivetRawDatabaseLike,
    RivetScheduledEventLike,
    RivetScheduleLike,
    RivetWebSocketLike,
} from "../src/rivet-context";

/**
 * A drift check for the `*Like` projections in `src/rivet-context.ts`.
 *
 * CLAUDE.md's platform-parity section names the exact failure this guards
 * against: the canonical binding `*Like` types "drifted from the real ones
 * because nothing consumed them". This package's projections are consumed by
 * every adapter in it, but they are still hand-written narrowings of somebody
 * else's package — so the narrowing itself needs pinning, or a `rivetkit`
 * release that renames a member leaves an adapter that compiles cleanly and
 * calls a method that no longer exists.
 *
 * The declarations below are copied from **rivetkit 2.3.10**:
 * `src/actor/config.ts` (`ActorContext`, `ActorSchedule`, `ActorCron`,
 * `ActorCronSetOptions`, `ScheduledEventInfo`), `src/common/database/config.ts`
 * (`RawAccess`), and the client's actor-handle surface. Each is asserted
 * assignable to this package's projection of it, so a projection that adds a
 * member Rivet does not have, or narrows a parameter Rivet widens, fails here.
 *
 * **Why a copy rather than a `devDependency` on `rivetkit`.** Depending on it
 * for types alone would pull `@rivetkit/rivetkit-napi`, `@rivetkit/rivetkit-wasm`,
 * `drizzle-orm`, `hono`, `pino` and a dozen more into every install of this
 * repo — a large, partly-native tree, for a check. A dated copy is weaker: it
 * catches a projection that was always wrong, and it catches drift only when
 * somebody refreshes it. That is a real limitation, recorded in
 * `plans/rivet-host-findings.md`, and the version above is the thing to compare
 * against when refreshing.
 *
 * One deliberate edit to the copies: upstream's `ActorSchedule`, `ActorCron`
 * and `ActorContext` each carry an `[key: string]: any` index signature. Copied
 * faithfully, that signature would satisfy *any* member this projection claims
 * — including a misspelled one — and the check would pass unconditionally. The
 * signatures are dropped so the structural comparison means something.
 */

// --- Copied from rivetkit@2.3.10 src/common/database/config.ts -------------

type UpstreamExecuteFunction = <TRow extends Record<string, unknown> = Record<string, unknown>>(query: string, ...args: unknown[]) => Promise<TRow[]>;

interface UpstreamRawAccess {
    close: () => Promise<void>;
    execute: UpstreamExecuteFunction;
    nativeMetrics?: () => unknown;
    transaction: <T>(callback: (tx: UpstreamRawAccess) => Promise<T> | T, options?: { timeout?: number }) => Promise<T>;
}

// --- Copied from rivetkit@2.3.10 src/actor/config.ts -----------------------

interface UpstreamScheduledEventInfo {
    action: string;
    args: unknown[];
    id: string;
    runAt: number;
}

interface UpstreamActorSchedule {
    after: (duration: number, action: string, ...args: unknown[]) => Promise<string>;
    at: (timestamp: number, action: string, ...args: unknown[]) => Promise<string>;
    cancel: (id: string) => Promise<boolean>;
    get: (id: string) => Promise<UpstreamScheduledEventInfo | undefined>;
    list: () => Promise<UpstreamScheduledEventInfo[]>;
}

interface UpstreamActorCronSetOptions {
    action: string;
    args?: unknown[];
    expression: string;
    maxHistory?: number;
    name: string;
    timezone?: string;
}

interface UpstreamActorCronEveryOptions {
    action: string;
    args?: unknown[];
    interval: number;
    maxHistory?: number;
    name: string;
}

interface UpstreamActorCron {
    delete: (name: string) => Promise<boolean>;
    every: (options: UpstreamActorCronEveryOptions) => Promise<void>;
    get: (name: string) => Promise<unknown>;
    history: (name: string, options?: { limit?: number }) => Promise<unknown[]>;
    list: () => Promise<unknown[]>;
    set: (options: UpstreamActorCronSetOptions) => Promise<void>;
}

/** The members of `ActorContext` this package's `RivetActorLike` narrows. */
interface UpstreamActorContextSlice {
    readonly abortSignal: AbortSignal;
    readonly actorId: string;
    broadcast: (name: string, ...args: unknown[]) => void;
    readonly cron: UpstreamActorCron;
    readonly db: UpstreamRawAccess;
    destroy: () => void;
    keepAwake: <T>(promise: Promise<T>) => Promise<T>;
    readonly key: string[];
    readonly name: string;
    readonly region: string;
    saveState: (options?: { immediate?: boolean; maxWait?: number }) => Promise<void>;
    readonly schedule: UpstreamActorSchedule;
    sleep: () => void;
    waitUntil: (promise: Promise<unknown>) => void;
}

/** The client-handle members `RivetActorHandleLike` / `RivetActorNamespaceLike` narrow. */
interface UpstreamActorFetchInit extends RequestInit {
    skipReadyWait?: boolean;
}

interface UpstreamActorHandle {
    fetch: (input: string | URL | Request, init?: UpstreamActorFetchInit) => Promise<Response>;
    resolve: () => Promise<string>;
    webSocket: (path?: string) => Promise<WebSocket>;
}

/** `GetOrCreateOptions` from rivetkit's `src/client/client.ts`. */
interface UpstreamGetOrCreateOptions {
    createInRegion?: string;
    createWithInput?: unknown;
}

interface UpstreamActorNamespace {
    create: (key: string | string[], options?: Record<string, unknown>) => Promise<UpstreamActorHandle>;
    get: (key?: string | string[]) => UpstreamActorHandle;
    getForId: (id: string) => UpstreamActorHandle;
    getOrCreate: (key?: string | string[], options?: UpstreamGetOrCreateOptions) => UpstreamActorHandle;
}

/**
 * `UniversalWebSocket` from `@rivetkit/virtual-websocket`, narrowed to the
 * members the socket host touches. Note `bufferedAmount` is **required** and
 * readonly upstream; the projection makes it optional, which is a safe
 * superset — a host that cannot report a queue depth is allowed to omit it.
 */
interface UpstreamUniversalWebSocket {
    readonly bufferedAmount: number;
    close: (code?: number, reason?: string) => void;
    readonly readyState: 0 | 1 | 2 | 3;
    send: (data: string | ArrayBufferLike | ArrayBufferView | Blob) => void;
}

describe("rivetkit projections", () => {
    it("accepts a real actor context where this package expects RivetActorLike", () => {
        expect.assertions(1);

        expectTypeOf<UpstreamActorContextSlice>().toExtend<RivetActorLike>();
        expectTypeOf<UpstreamRawAccess>().toExtend<RivetRawDatabaseLike>();
        expectTypeOf<UpstreamActorSchedule>().toExtend<RivetScheduleLike>();
        expectTypeOf<UpstreamActorCron>().toExtend<RivetCronLike>();
        expectTypeOf<UpstreamScheduledEventInfo>().toExtend<RivetScheduledEventLike>();

        // `expectTypeOf` is compile-time only, so the suite needs one runtime
        // assertion or the leg would pass on an empty test body.
        expect(true).toBe(true);
    });

    it("accepts a real client handle where this package expects a shard stub source", () => {
        expect.assertions(1);

        expectTypeOf<UpstreamActorHandle>().toExtend<RivetActorHandleLike>();
        expectTypeOf<UpstreamActorNamespace>().toExtend<RivetActorNamespaceLike>();
        // The socket host narrows an accepted socket to this projection, so a
        // real `UniversalWebSocket` has to satisfy it.
        expectTypeOf<UpstreamUniversalWebSocket>().toExtend<RivetWebSocketLike>();

        expect(true).toBe(true);
    });
});
