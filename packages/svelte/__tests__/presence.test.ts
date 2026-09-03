import type { FunctionReference, LunoraClient } from "@lunora/client";
import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HeartbeatReference, ListPresentReference } from "../src/presence";
import { presence } from "../src/presence";

const HEARTBEAT = { __lunoraRef: "presence:heartbeat" } as unknown as HeartbeatReference;
const LIST_PRESENT = { __lunoraRef: "presence:listPresent" } as unknown as ListPresentReference;
// `randomSessionId`'s non-`randomUUID` arm (shared/random-session-id.ts) hex-encodes
// 16 bytes of `crypto.getRandomValues`, so the id is exactly 32 lowercase hex chars.
// There is deliberately no arm below that: a runtime with no Web Crypto throws
// rather than mint a `Date.now()` string two sessions can share.
const SESS_ID_PATTERN = /^[\da-f]{32}$/;
/** The message `randomSessionId` throws when no Web Crypto is present at all. */
const NO_WEB_CRYPTO = /no Web Crypto available/;

const createPresenceFakeClient = () => {
    type Callback = (value: unknown) => void;

    const mutationCalls: { args: unknown; functionPath: string }[] = [];
    const subscribeCalls: { args: unknown; callback: Callback; functionPath: string; unsubscribed: boolean }[] = [];
    const setConnectionContextCalls: unknown[] = [];

    // Refcounted connection-context model mirroring the real client: holders keyed
    // by shard, most-recent live holder wins, cleared only when the last releases.
    const connectionContextHolders = new Map<string, { context: Record<string, unknown> }[]>();

    const currentConnectionContext = (shardKey?: string): Record<string, unknown> | undefined => {
        const holders = connectionContextHolders.get(shardKey ?? "");

        return holders && holders.length > 0 ? holders[holders.length - 1]?.context : undefined;
    };

    const client: LunoraClient = {
        acquireConnectionContext: (context: Record<string, unknown>, options?: { shardKey?: string }) => {
            const key = options?.shardKey ?? "";
            const holder = { context };
            const holders = connectionContextHolders.get(key);

            if (holders) {
                holders.push(holder);
            } else {
                connectionContextHolders.set(key, [holder]);
            }

            let released = false;

            return () => {
                if (released) {
                    return;
                }

                released = true;

                const live = connectionContextHolders.get(key);

                if (!live) {
                    return;
                }

                const index = live.indexOf(holder);

                if (index !== -1) {
                    live.splice(index, 1);
                }

                if (live.length === 0) {
                    connectionContextHolders.delete(key);
                }
            };
        },
        mutation: (function_: FunctionReference, args: unknown) => {
            mutationCalls.push({ args, functionPath: function_["__lunoraRef"] });

            return Promise.resolve(undefined);
        },
        setConnectionContext: (context: Record<string, unknown> | undefined) => {
            setConnectionContextCalls.push(context);
        },
        subscribe: (function_: FunctionReference, args: Record<string, unknown>, callback: Callback) => {
            const call = {
                args,
                callback,
                functionPath: function_["__lunoraRef"],
                unsubscribed: false,
            };

            subscribeCalls.push(call);

            return () => {
                call.unsubscribed = true;
            };
        },
    } as unknown as LunoraClient;

    const push = (functionPath: string, args: unknown, value: unknown): void => {
        for (const call of subscribeCalls) {
            if (call.functionPath === functionPath && JSON.stringify(call.args) === JSON.stringify(args)) {
                call.callback(value);
            }
        }
    };

    return { client, currentConnectionContext, mutationCalls, push, setConnectionContextCalls, subscribeCalls };
};

const flushAsync = async (): Promise<void> => {
    await vi.waitFor(() => undefined);
};

describe("presence (Svelte)", () => {
    beforeEach(() => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        // `presence` gates its heartbeat/interval/listener/connection-context wiring
        // on a browser `window` (SVELTE-01); the vitest env is `node` (no `window`),
        // so define one for these client-path tests. The SSR test below removes it
        // to exercise the guard, mirroring `@lunora/vue`'s `use-presence.test.ts`.
        Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    });

    afterEach(() => {
        vi.useRealTimers();
        Reflect.deleteProperty(globalThis, "window");
    });

    it("heartbeats on mount and again on each interval tick", async () => {
        const fake = createPresenceFakeClient();

        const handle = presence(fake.client, "room-1", {
            heartbeat: HEARTBEAT,
            intervalMs: 500,
            listPresent: LIST_PRESENT,
            sessionId: "sess-fixed",
        });

        await flushAsync();

        // Immediate heartbeat on call.
        expect(fake.mutationCalls).toHaveLength(1);
        expect(fake.mutationCalls[0]?.functionPath).toBe("presence:heartbeat");
        expect(fake.mutationCalls[0]?.args).toMatchObject({ roomId: "room-1", sessionId: "sess-fixed" });

        // Two interval ticks → two more heartbeats.
        await vi.advanceTimersByTimeAsync(1000);
        await flushAsync();

        expect(fake.mutationCalls).toHaveLength(3);

        handle.teardown();
    });

    it("subscribes to listPresent and returns pushed values", async () => {
        const fake = createPresenceFakeClient();

        const handle = presence(fake.client, "room-1", {
            heartbeat: HEARTBEAT,
            intervalMs: 500,
            listPresent: LIST_PRESENT,
            sessionId: "sess-fixed",
        });

        // Subscribe by reading the store (Svelte readable starts subscription on first subscriber).
        const stopPresent = handle.present.subscribe(() => {});

        await flushAsync();

        expect(fake.subscribeCalls).toHaveLength(1);
        expect(fake.subscribeCalls[0]?.functionPath).toBe("presence:listPresent");
        expect(fake.subscribeCalls[0]?.args).toMatchObject({ roomId: "room-1" });
        expect(get(handle.present)).toBeUndefined();

        const members = [{ lastSeen: 5, roomId: "room-1", sessionId: "sess-fixed" }];

        fake.push("presence:listPresent", { roomId: "room-1" }, members);
        await flushAsync();

        expect(get(handle.present)).toStrictEqual(members);

        stopPresent();
        handle.teardown();
    });

    it("mints a session id from getRandomValues when crypto.randomUUID is unavailable", () => {
        const fake = createPresenceFakeClient();
        // eslint-disable-next-line n/no-unsupported-features/node-builtins -- accessing globalThis.crypto to save/restore it for the test
        const originalCrypto = globalThis.crypto;

        // A non-secure origin (a plain-HTTP LAN dev/preview server) leaves
        // `crypto.randomUUID` undefined while still shipping `getRandomValues`.
        Object.defineProperty(globalThis, "crypto", {
            configurable: true,
            value: { getRandomValues: (array: Uint8Array) => array.fill(171) },
        });

        try {
            const handle = presence(fake.client, "room-1", {
                heartbeat: HEARTBEAT,
                intervalMs: 500,
                listPresent: LIST_PRESENT,
            });

            expect(handle.sessionId).toMatch(SESS_ID_PATTERN);

            handle.teardown();
        } finally {
            Object.defineProperty(globalThis, "crypto", { configurable: true, value: originalCrypto });
        }
    });

    it("refuses to mint a session id when Web Crypto is absent entirely", () => {
        const fake = createPresenceFakeClient();
        // eslint-disable-next-line n/no-unsupported-features/node-builtins -- accessing globalThis.crypto to save/restore it for the test
        const originalCrypto = globalThis.crypto;

        Object.defineProperty(globalThis, "crypto", { configurable: true, value: undefined });

        try {
            // `randomSessionId` used to fall back to `Date.now().toString(36)` here.
            // That is not an id: two sessions opened in the same millisecond collide
            // onto one presence row, and the value is guessable. Throwing is correct.
            expect(() =>
                presence(fake.client, "room-1", {
                    heartbeat: HEARTBEAT,
                    intervalMs: 500,
                    listPresent: LIST_PRESENT,
                }),
            ).toThrow(NO_WEB_CRYPTO);
        } finally {
            Object.defineProperty(globalThis, "crypto", { configurable: true, value: originalCrypto });
        }
    });

    it("stops heartbeating after teardown", async () => {
        const fake = createPresenceFakeClient();

        const handle = presence(fake.client, "room-1", {
            heartbeat: HEARTBEAT,
            intervalMs: 500,
            listPresent: LIST_PRESENT,
            sessionId: "sess-fixed",
        });

        await flushAsync();

        expect(fake.mutationCalls).toHaveLength(1);

        handle.teardown();

        const callsAtTeardown = fake.mutationCalls.length;

        await vi.advanceTimersByTimeAsync(2000);
        await flushAsync();

        expect(fake.mutationCalls).toHaveLength(callsAtTeardown);
    });

    it("teardown is idempotent — releases the connection context exactly once (FINDING 3 regression)", () => {
        let releaseCalls = 0;

        const client = {
            acquireConnectionContext: () => () => {
                releaseCalls += 1;
            },
            mutation: () => Promise.resolve(undefined),
            subscribe: () => () => undefined,
        } as unknown as LunoraClient;

        const handle = presence(client, "room-1", {
            heartbeat: HEARTBEAT,
            intervalMs: 500,
            listPresent: LIST_PRESENT,
            sessionId: "sess-idem",
        });

        // The auto-wired `onDestroy` and a manual `handle.teardown()` may both
        // fire in a real component; teardown must guard so the release runs once.
        handle.teardown();
        handle.teardown();

        expect(releaseCalls).toBe(1);
    });

    it("two concurrent presence stores don't clear each other's context (refcount)", () => {
        const fake = createPresenceFakeClient();

        const first = presence(fake.client, "room-1", {
            heartbeat: HEARTBEAT,
            intervalMs: 500,
            listPresent: LIST_PRESENT,
            sessionId: "sess-a",
        });

        const second = presence(fake.client, "room-1", {
            heartbeat: HEARTBEAT,
            intervalMs: 500,
            listPresent: LIST_PRESENT,
            sessionId: "sess-b",
        });

        // Most-recently acquired live holder wins.
        expect(fake.currentConnectionContext()).toStrictEqual({ roomId: "room-1", sessionId: "sess-b" });

        // Tearing down the second falls back to the first's context — not cleared.
        second.teardown();

        expect(fake.currentConnectionContext()).toStrictEqual({ roomId: "room-1", sessionId: "sess-a" });

        // Tearing down the last holder finally clears the context.
        first.teardown();

        expect(fake.currentConnectionContext()).toBeUndefined();
    });

    it("does not heartbeat, open an interval, subscribe, or acquire connection context during SSR (no window) (SVELTE-01)", async () => {
        const fake = createPresenceFakeClient();

        // Simulate the server render: no browser `window` (this package pairs
        // with `@lunora/nuxt`'s server rendering, where a component's init runs
        // inside `renderToString` with no `window`).
        Reflect.deleteProperty(globalThis, "window");

        const handle = presence(fake.client, "room-1", {
            heartbeat: HEARTBEAT,
            intervalMs: 500,
            listPresent: LIST_PRESENT,
            sessionId: "sess-fixed",
        });

        // Reading the store ("rendering" it) must not trigger a live WS
        // subscription server-side either.
        const stopPresent = handle.present.subscribe(() => undefined);

        await flushAsync();

        // No setup-time heartbeat write, no live subscription, no connection
        // context acquired.
        expect(fake.mutationCalls).toHaveLength(0);
        expect(fake.subscribeCalls).toHaveLength(0);
        expect(fake.currentConnectionContext()).toBeUndefined();

        // No leaked interval: advancing time fires no further heartbeats.
        await vi.advanceTimersByTimeAsync(2000);
        await flushAsync();

        expect(fake.mutationCalls).toHaveLength(0);

        // The store stays at its inert initial value.
        expect(get(handle.present)).toBeUndefined();

        stopPresent();

        // Teardown itself must not throw with nothing to release/clear.
        expect(() => {
            handle.teardown();
        }).not.toThrow();
    });
});
