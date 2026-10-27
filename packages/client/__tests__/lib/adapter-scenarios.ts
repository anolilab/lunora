import { LunoraError } from "@lunora/errors";
import { expect, vi } from "vitest";

/**
 * Behavioural parity across the six framework adapters (react, vue, solid,
 * svelte, angular, react-native). `adapter-export-parity.test.ts` proves every
 * adapter EXPORTS the same features; this proves they BEHAVE the same. Each
 * scenario drives one shared fake client through a thin per-adapter
 * {@link AdapterDriver} (in that adapter's `__tests__/parity.test.ts`) and
 * asserts only what a consumer can observe — so a guard or error shape that
 * exists in one adapter but not another is a red test, not an audit finding.
 *
 * Every adapter runs every scenario: none of the four features driven here has
 * a `{ gap }` entry in the export-parity manifest. Add a scenario when a drift
 * escapes it; add a driver method only for a feature all six ship.
 *
 * Test-only and imported by relative path, so no adapter gains a runtime edge
 * on `@lunora/client`'s test tree.
 */

/** Structural stand-in for a `FunctionReference`. */
interface FakeRef {
    readonly __lunoraRef: string;
}

/** The raw, wire-shaped error a subscription reports (`SubscriptionError`). */
interface WireError {
    code?: string;
    message: string;
}

interface SubscribeCall {
    args: unknown;
    options: { onError?: (error: WireError) => void; shardKey?: string } | undefined;
    ref: string;
    unsubscribed: boolean;
}

type MutationMock = ReturnType<typeof vi.fn<(ref: FakeRef, args: unknown, options?: unknown) => Promise<unknown>>>;

interface ParityClient {
    /** The fake, typed loosely — each driver casts it to `LunoraClient`. */
    client: unknown;
    /** Fire `onError` on every live subscription of `ref`. */
    emitError: (ref: string, error: WireError) => void;
    /** Pretend the client already holds `value` as `ref`'s `lastValue`. */
    hold: (ref: string, value: unknown) => void;
    mutation: MutationMock;
    subscribeCalls: SubscribeCall[];
}

/** A mounted primitive: read its current value, then tear it down the way the framework would. */
interface Mounted<T> {
    current: () => T;
    dispose: () => void;
}

/** The four features every adapter ships, behind one shape. Each driver mounts with its own framework's renderer. */
interface AdapterDriver {
    /** Run `fn` inside the framework's update batch (React's `act`); a plain call elsewhere. */
    act: (fn: () => Promise<void> | void) => Promise<void>;
    mutation: (client: unknown, ref: FakeRef) => Mounted<(args: Record<string, unknown>) => Promise<unknown>>;
    /** Mounts presence on {@link PRESENCE}'s room; must throw synchronously when the adapter rejects `intervalMs`. */
    presence: (client: unknown, options: { intervalMs: number }) => Mounted<unknown>;
    query: (client: unknown, ref: FakeRef, args: Record<string, unknown>, options?: { shardKey?: string }) => Mounted<unknown>;
    subscription: (client: unknown, ref: FakeRef, args: Record<string, unknown>, options: { onError: (error: unknown) => void }) => Mounted<unknown>;
}

const PRESENCE = {
    heartbeat: { __lunoraRef: "presence:heartbeat" } as FakeRef,
    listPresent: { __lunoraRef: "presence:listPresent" } as FakeRef,
    roomId: "room-1",
    sessionId: "sess-fixed",
} as const;

const LIST: FakeRef = { __lunoraRef: "messages:list" };
const SEND: FakeRef = { __lunoraRef: "messages:send" };

/**
 * One fake `LunoraClient` for every adapter: the union of the surface their
 * providers and primitives touch. `subscribe` replays a held `lastValue`
 * synchronously, exactly as the real client does on attach.
 */
const createParityClient = (): ParityClient => {
    const held = new Map<string, unknown>();
    const subscribeCalls: SubscribeCall[] = [];
    const mutation: MutationMock = vi.fn<(ref: FakeRef, args: unknown, options?: unknown) => Promise<unknown>>(async () => undefined);

    const subscribe = (ref: FakeRef, args: unknown, callback: (value: unknown) => void, options?: SubscribeCall["options"]): (() => void) => {
        const call: SubscribeCall = { args, options, ref: ref.__lunoraRef, unsubscribed: false };

        subscribeCalls.push(call);

        if (held.has(call.ref)) {
            callback(held.get(call.ref));
        }

        return () => {
            call.unsubscribed = true;
        };
    };

    const client = {
        acquireConnectionContext: () => () => undefined,
        action: async () => undefined,
        canQueueOffline: () => true,
        close: () => undefined,
        connectionStatus: () => "idle",
        currentIdentity: () => null,
        expectIdentityResolution: () => undefined,
        getAuthToken: () => null,
        getCurrentUser: async () => null,
        // No socket: a query with no held value takes the HTTP path, which this fake never settles.
        getWebSocketImpl: () => undefined,
        identityEpoch: () => 0,
        isReady: true,
        mutation,
        onAuthTokenChange: () => () => undefined,
        onConnectionStatus: () => () => undefined,
        onIdentityChange: () => () => undefined,
        // A held value stands for an already-open subscription's `lastValue`.
        peekActiveQuerySnapshot: (functionPath: string) => {
            return { answered: held.has(functionPath), present: held.has(functionPath), value: held.get(functionPath) };
        },
        peekHydratedQuery: () => undefined,
        peekHydratedQueryByKey: () => undefined,
        query: async () =>
            new Promise<never>(() => {
                // Never settles: the scenarios exercise the live subscription, not the HTTP snapshot.
            }),
        setAuthToken: () => undefined,
        setConnectionContext: () => undefined,
        subscribe,
        whenReady: async () => undefined,
    };

    return {
        client,
        emitError: (ref, error) => {
            for (const call of subscribeCalls) {
                if (call.ref === ref && !call.unsubscribed) {
                    call.options?.onError?.(error);
                }
            }
        },
        hold: (ref, value) => {
            held.set(ref, value);
        },
        mutation,
        subscribeCalls,
    };
};

interface Scenario {
    name: string;
    run: (driver: AdapterDriver) => Promise<void>;
}

// Each scenario is a named const so its `expect`s read as a helper's, run from the adapter's `it`.

// Svelte once handed `onError` a normalised `LunoraError`; every other adapter forwards the raw wire error.
const subscriptionOnErrorGetsRawWireError = async (driver: AdapterDriver): Promise<void> => {
    const fake = createParityClient();
    const onError = vi.fn<(error: unknown) => void>();
    const mounted = driver.subscription(fake.client, LIST, { channel: "c1" }, { onError });

    await driver.act(() => {
        fake.emitError(LIST.__lunoraRef, { code: "FORBIDDEN", message: "denied" });
    });

    expect(onError).toHaveBeenCalledTimes(1);
    // Strict: a plain `{ code, message }`, not an Error subclass that merely carries `.code`.
    expect(onError.mock.calls[0]?.[0]).toStrictEqual({ code: "FORBIDDEN", message: "denied" });

    mounted.dispose();
};

// `intervalMs` was once validated in Angular only.
const presenceRejectsBadInterval = async (driver: AdapterDriver): Promise<void> => {
    const fake = createParityClient();

    expect(() => driver.presence(fake.client, { intervalMs: 0 })).toThrow(RangeError);
    expect(() => driver.presence(fake.client, { intervalMs: Number.NaN })).toThrow(RangeError);
};

const queryReplaysHeldValueSynchronously = async (driver: AdapterDriver): Promise<void> => {
    const fake = createParityClient();

    fake.hold(LIST.__lunoraRef, ["held"]);

    const mounted = driver.query(fake.client, LIST, { channel: "c1" });

    // No await between mount and read: the replayed value must already be there.
    expect(mounted.current()).toStrictEqual(["held"]);

    mounted.dispose();
};

const disposeStopsPresence = async (driver: AdapterDriver): Promise<void> => {
    vi.useFakeTimers();

    let mounted: ReturnType<AdapterDriver["presence"]> | undefined;

    try {
        const fake = createParityClient();

        mounted = driver.presence(fake.client, { intervalMs: 1000 });

        vi.advanceTimersByTime(1000);

        // Mount heartbeat plus one tick: the interval is live before dispose.
        expect(fake.mutation).toHaveBeenCalledTimes(2);
        expect(fake.subscribeCalls.map((call) => call.ref)).toContain(PRESENCE.listPresent.__lunoraRef);

        mounted.dispose();
        mounted = undefined;

        const subscribesAtDispose = fake.subscribeCalls.length;

        vi.advanceTimersByTime(10_000);

        expect(fake.mutation).toHaveBeenCalledTimes(2);
        expect(fake.subscribeCalls).toHaveLength(subscribesAtDispose);
        expect(fake.subscribeCalls.every((call) => call.unsubscribed)).toBe(true);
    } finally {
        // A failed assertion above must not leave the mount live for later tests.
        mounted?.dispose();
        vi.useRealTimers();
    }
};

const mutationRejectionKeepsCode = async (driver: AdapterDriver): Promise<void> => {
    const fake = createParityClient();
    const mounted = driver.mutation(fake.client, SEND);

    fake.mutation.mockRejectedValueOnce(new LunoraError("CONFLICT", "write conflict"));

    let rejection: unknown;

    await driver.act(async () => {
        rejection = await mounted
            .current()({ text: "hi" })
            .then(
                () => undefined,
                (error: unknown) => error,
            );
    });

    expect(rejection).toMatchObject({ code: "CONFLICT", message: "write conflict" });

    mounted.dispose();
};

const queryForwardsShardKey = async (driver: AdapterDriver): Promise<void> => {
    const fake = createParityClient();
    const mounted = driver.query(fake.client, LIST, { channel: "c1" }, { shardKey: "room:7" });

    expect(fake.subscribeCalls).toHaveLength(1);
    expect(fake.subscribeCalls[0]?.options?.shardKey).toBe("room:7");

    mounted.dispose();
};

/** Run from each adapter's `parity.test.ts` as `it.each(scenarios)("$name", ({ run }) => run(driver))`. */
const scenarios: Scenario[] = [
    { name: "subscription onError receives the raw wire error, code intact", run: subscriptionOnErrorGetsRawWireError },
    { name: "presence rejects a non-positive or non-finite intervalMs with a RangeError", run: presenceRejectsBadInterval },
    { name: "query delivers the client's held lastValue synchronously on mount", run: queryReplaysHeldValueSynchronously },
    { name: "dispose stops the presence heartbeat and unsubscribes", run: disposeStopsPresence },
    { name: "a rejected mutation surfaces the same LunoraError code", run: mutationRejectionKeepsCode },
    { name: "query forwards shardKey to client.subscribe unchanged", run: queryForwardsShardKey },
];

export type { AdapterDriver, FakeRef, Mounted, ParityClient, Scenario, WireError };
export { createParityClient, PRESENCE, scenarios };
