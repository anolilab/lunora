import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectScope, nextTick, ref } from "vue";

import type { HeartbeatReference, ListPresentReference } from "../src/use-presence";
import { usePresence } from "../src/use-presence";
import { createFakeClient } from "./fake-client";

const HEARTBEAT = { __lunoraRef: "presence:heartbeat" } as unknown as HeartbeatReference;
const LIST_PRESENT = { __lunoraRef: "presence:listPresent" } as unknown as ListPresentReference;
// `randomSessionId`'s non-`randomUUID` arm (shared/random-session-id.ts) hex-encodes
// 16 bytes of `crypto.getRandomValues`, so the id is exactly 32 lowercase hex chars.
// There is deliberately no arm below that: a runtime with no Web Crypto throws
// rather than mint a `Date.now()` string two sessions can share.
const SESS_ID_PATTERN = /^[\da-f]{32}$/;

/**
 * Extend the fake client with a refcounted `acquireConnectionContext` stub that
 * mirrors the real client's contract: register a context for a shard key, return
 * a release fn, and only clear the shard's context once the *last* holder
 * releases (last-acquired-live-holder wins). `contextFor(shardKey)` exposes the
 * current effective context so tests can assert no cross-hook stomp.
 */
const createPresenceFakeClient = () => {
    const fake = createFakeClient();

    // shardKey -> ordered stack of live holders ({ context }).
    const holders = new Map<string, { context: Record<string, unknown> }[]>();

    const acquireConnectionContext = vi.fn<(context: Record<string, unknown>, options?: { shardKey?: string }) => () => void>((context, options = {}) => {
        const key = options.shardKey ?? "";
        const holder = { context };
        const stack = holders.get(key);

        if (stack) {
            stack.push(holder);
        } else {
            holders.set(key, [holder]);
        }

        let released = false;

        return () => {
            if (released) {
                return;
            }

            released = true;

            const live = holders.get(key);

            if (!live) {
                return;
            }

            const index = live.indexOf(holder);

            if (index !== -1) {
                live.splice(index, 1);
            }

            if (live.length === 0) {
                holders.delete(key);
            }
        };
    });

    (fake.client as unknown as Record<string, unknown>)["acquireConnectionContext"] = acquireConnectionContext;

    /** The effective (last-live-holder-wins) context for a shard, or undefined. */
    const contextFor = (shardKey = ""): Record<string, unknown> | undefined => {
        const stack = holders.get(shardKey);

        return stack && stack.length > 0 ? stack[stack.length - 1]?.context : undefined;
    };

    return { ...fake, acquireConnectionContext, contextFor };
};

const flushAsync = async (): Promise<void> => {
    await vi.waitFor(() => undefined);
    await nextTick();
};

describe("usePresence (Vue)", () => {
    beforeEach(() => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        // The composable gates its heartbeat/interval/subscription on a browser
        // `window`; the vitest env is `node` (no `window`), so define one for the
        // client-path tests. The SSR test below removes it to exercise the guard.
        Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    });

    afterEach(() => {
        vi.useRealTimers();
        Reflect.deleteProperty(globalThis, "window");
    });

    /** The fake client with `subscribe` replaced, for the setup-order edge cases. */
    const withSubscribe = (fake: ReturnType<typeof createPresenceFakeClient>, wrap: (original: (...args: never[]) => () => void) => unknown): void => {
        const client = fake.client as unknown as Record<string, unknown>;
        const original = (client["subscribe"] as (...args: never[]) => () => void).bind(fake.client);

        client["subscribe"] = wrap(original);
    };

    it("leaves each room it stops showing, and the last one on dispose, through the leave mutation", async () => {
        expect.assertions(1);

        const fake = createPresenceFakeClient();
        const scope = effectScope();
        const room = ref("a");
        const LEAVE = { __lunoraRef: "presence:leave" } as never;
        const leftB = Promise.withResolvers<undefined>();

        // A leave waits for its room's heartbeat to settle, so the last one is awaited, not assumed.
        fake.mutationSpy.mockImplementation((reference: unknown, args: unknown): unknown => {
            if ((reference as Record<string, unknown>)["__lunoraRef"] === "presence:leave" && (args as { roomId: string }).roomId === "b") {
                leftB.resolve(undefined);
            }

            return Promise.resolve(undefined);
        });

        scope.run(() =>
            fake.provide(() =>
                usePresence(room, { heartbeat: HEARTBEAT, intervalMs: 60_000, leave: LEAVE, listPresent: LIST_PRESENT, sessionId: "sess-fixed" }),
            ),
        );
        await flushAsync();
        room.value = "b";
        await flushAsync();
        scope.stop();
        await leftB.promise;

        expect(
            fake.mutationSpy.mock.calls
                .filter((call) => (call[0] as Record<string, unknown>)["__lunoraRef"] === "presence:leave")
                .map((call) => call[1] as unknown),
        ).toStrictEqual([
            { roomId: "a", sessionId: "sess-fixed" },
            { roomId: "b", sessionId: "sess-fixed" },
        ]);
    });

    it("sends a room's leave only after the heartbeat still in flight for it has settled", async () => {
        expect.assertions(2);

        const fake = createPresenceFakeClient();
        const scope = effectScope();
        const heartbeatLanded = Promise.withResolvers<undefined>();
        const LEAVE = { __lunoraRef: "presence:leave" } as never;
        const sent = (): unknown[] => fake.mutationSpy.mock.calls.map((call) => (call[0] as Record<string, unknown>)["__lunoraRef"]);

        const leaveSent = Promise.withResolvers<undefined>();

        fake.mutationSpy.mockImplementation((reference: unknown): unknown => {
            const name = (reference as Record<string, unknown>)["__lunoraRef"];

            if (name === "presence:leave") {
                leaveSent.resolve(undefined);
            }

            return name === "presence:heartbeat" ? heartbeatLanded.promise : Promise.resolve(undefined);
        });

        scope.run(() =>
            fake.provide(() =>
                usePresence("a", { heartbeat: HEARTBEAT, intervalMs: 60_000, leave: LEAVE, listPresent: LIST_PRESENT, sessionId: "sess-fixed" }),
            ),
        );
        scope.stop();

        expect(sent()).toStrictEqual(["presence:heartbeat"]);

        heartbeatLanded.resolve(undefined);
        await leaveSent.promise;

        expect(sent()).toStrictEqual(["presence:heartbeat", "presence:leave"]);
    });

    it("never queues a heartbeat for offline replay", async () => {
        expect.assertions(1);

        const fake = createPresenceFakeClient();
        const scope = effectScope();

        scope.run(() =>
            fake.provide(() => usePresence("room-1", { heartbeat: HEARTBEAT, intervalMs: 500, listPresent: LIST_PRESENT, sessionId: "sess-fixed" })),
        );
        await flushAsync();

        expect(fake.mutationSpy.mock.calls[0]?.[2]).toMatchObject({ onlineOnly: true });

        scope.stop();
    });

    it("does not read a room getter during SSR", () => {
        expect.assertions(1);

        Reflect.deleteProperty(globalThis, "window");

        const fake = createPresenceFakeClient();
        const scope = effectScope();
        const room = (): string => {
            throw new Error("window.location is not available on the server");
        };

        expect(() =>
            scope.run(() =>
                fake.provide(() => usePresence(room, { heartbeat: HEARTBEAT, intervalMs: 500, listPresent: LIST_PRESENT, sessionId: "sess-fixed" })),
            ),
        ).not.toThrow();

        scope.stop();
    });

    it("rolls a room's setup back when subscribing to it throws", () => {
        expect.assertions(2);

        const fake = createPresenceFakeClient();
        const scope = effectScope();

        withSubscribe(fake, () => () => {
            throw new Error("client closed");
        });

        expect(() =>
            scope.run(() =>
                fake.provide(() => usePresence("room-1", { heartbeat: HEARTBEAT, intervalMs: 500, listPresent: LIST_PRESENT, sessionId: "sess-fixed" })),
            ),
        ).toThrow("client closed");
        expect(fake.contextFor()).toBeUndefined();

        scope.stop();
    });

    it("disposes a room whose scope stops while its subscription replays a refusal", async () => {
        expect.assertions(2);

        const fake = createPresenceFakeClient();
        const scope = effectScope();

        // A replayed refusal reaches onError before subscribe returns.
        withSubscribe(fake, (original) => (...args: never[]) => {
            const unsubscribe = original(...args);
            const options = (args as unknown[])[3] as { onError?: (error: unknown) => void };

            options.onError?.({ code: "FORBIDDEN", message: "no" });

            return unsubscribe;
        });

        scope.run(() =>
            fake.provide(() =>
                usePresence("room-1", {
                    heartbeat: HEARTBEAT,
                    intervalMs: 500,
                    listPresent: LIST_PRESENT,
                    onError: () => {
                        scope.stop();
                    },
                    sessionId: "sess-fixed",
                }),
            ),
        );
        await flushAsync();

        expect(fake.unsubscribeSpy).toHaveBeenCalledTimes(1);
        expect(fake.contextFor()).toBeUndefined();
    });

    it("opens the room a refusal switched to while the first room was opening", async () => {
        expect.assertions(1);

        const fake = createPresenceFakeClient();
        const scope = effectScope();
        const room = ref("a");
        let refused = false;

        withSubscribe(fake, (original) => (...args: never[]) => {
            const unsubscribe = original(...args);
            const options = (args as unknown[])[3] as { onError?: (error: unknown) => void };

            if (!refused) {
                refused = true;
                options.onError?.({ code: "FORBIDDEN", message: "no" });
            }

            return unsubscribe;
        });

        scope.run(() =>
            fake.provide(() =>
                usePresence(room, {
                    heartbeat: HEARTBEAT,
                    intervalMs: 500,
                    listPresent: LIST_PRESENT,
                    onError: () => {
                        room.value = "b";
                    },
                    sessionId: "sess-fixed",
                }),
            ),
        );
        await flushAsync();

        expect(fake.subscribeCalls.at(-1)?.args).toStrictEqual({ roomId: "b" });

        scope.stop();
    });

    it("throws a RangeError for a non-positive intervalMs", () => {
        expect.assertions(1);

        const fake = createPresenceFakeClient();
        const scope = effectScope();

        expect(() =>
            scope.run(() =>
                fake.provide(() => usePresence("room-1", { heartbeat: HEARTBEAT, intervalMs: 0, listPresent: LIST_PRESENT, sessionId: "sess-fixed" })),
            ),
        ).toThrow(RangeError);

        scope.stop();
    });

    it("heartbeats on mount and again on each interval tick", async () => {
        const fake = createPresenceFakeClient();

        const scope = effectScope();

        scope.run(() =>
            fake.provide(() =>
                usePresence("room-1", {
                    heartbeat: HEARTBEAT,
                    intervalMs: 500,
                    listPresent: LIST_PRESENT,
                    sessionId: "sess-fixed",
                }),
            ),
        );

        await flushAsync();

        // Immediate heartbeat on mount.
        expect(fake.mutationSpy).toHaveBeenCalledTimes(1);
        expect(fake.mutationSpy.mock.calls[0]?.[0]).toMatchObject({ __lunoraRef: "presence:heartbeat" });
        expect(fake.mutationSpy.mock.calls[0]?.[1]).toMatchObject({ roomId: "room-1", sessionId: "sess-fixed" });

        // Two interval ticks → two more heartbeats.
        await vi.advanceTimersByTimeAsync(1000);
        await flushAsync();

        expect(fake.mutationSpy).toHaveBeenCalledTimes(3);

        scope.stop();
    });

    it("subscribes to listPresent and returns pushed values", async () => {
        const fake = createPresenceFakeClient();

        const scope = effectScope();
        const result = scope.run(() =>
            fake.provide(() =>
                usePresence("room-1", {
                    heartbeat: HEARTBEAT,
                    intervalMs: 500,
                    listPresent: LIST_PRESENT,
                    sessionId: "sess-fixed",
                }),
            ),
        )!;

        await flushAsync();

        expect(fake.subscribeCalls).toHaveLength(1);
        expect(fake.subscribeCalls[0]?.functionPath).toBe("presence:listPresent");
        expect(fake.subscribeCalls[0]?.args).toMatchObject({ roomId: "room-1" });
        expect(result.present.value).toBeUndefined();

        const members = [{ lastSeen: 5, roomId: "room-1", sessionId: "sess-fixed" }];

        fake.push("presence:listPresent", { roomId: "room-1" }, members);
        await flushAsync();

        expect(result.present.value).toStrictEqual(members);

        scope.stop();
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
            const scope = effectScope();
            const result = scope.run(() =>
                fake.provide(() =>
                    usePresence("room-1", {
                        heartbeat: HEARTBEAT,
                        intervalMs: 500,
                        listPresent: LIST_PRESENT,
                    }),
                ),
            )!;

            expect(result.sessionId).toMatch(SESS_ID_PATTERN);

            scope.stop();
        } finally {
            Object.defineProperty(globalThis, "crypto", { configurable: true, value: originalCrypto });
        }
    });

    it("stops heartbeating and unsubscribes when scope is stopped", async () => {
        const fake = createPresenceFakeClient();

        const scope = effectScope();

        scope.run(() =>
            fake.provide(() =>
                usePresence("room-1", {
                    heartbeat: HEARTBEAT,
                    intervalMs: 500,
                    listPresent: LIST_PRESENT,
                    sessionId: "sess-fixed",
                }),
            ),
        );

        await flushAsync();

        expect(fake.mutationSpy).toHaveBeenCalledTimes(1);

        scope.stop();

        const callsAtStop = fake.mutationSpy.mock.calls.length;

        // No more heartbeats after scope is stopped.
        await vi.advanceTimersByTimeAsync(2000);
        await flushAsync();

        expect(fake.mutationSpy).toHaveBeenCalledTimes(callsAtStop);
        expect(fake.unsubscribeSpy).toHaveBeenCalledTimes(1);
    });

    it("follows a reactive room id: leaves the old room, joins the new one at once, and drops the old room's data", async () => {
        expect.assertions(9);

        const fake = createPresenceFakeClient();
        const room = ref("a");
        const scope = effectScope();
        const result = scope.run(() =>
            fake.provide(() =>
                usePresence(room, {
                    // A long interval, so only a room-change heartbeat can reach the new room.
                    heartbeat: HEARTBEAT,
                    intervalMs: 60_000,
                    listPresent: LIST_PRESENT,
                    sessionId: "sess-fixed",
                }),
            ),
        )!;

        fake.push("presence:listPresent", { roomId: "a" }, ["alice"]);

        expect(result.present.value).toStrictEqual(["alice"]);
        expect(fake.acquireConnectionContext).toHaveBeenCalledTimes(1);

        room.value = "b";
        await nextTick();

        expect(fake.mutationSpy.mock.calls.map((call) => (call[1] as { roomId: string }).roomId)).toStrictEqual(["a", "b"]);
        expect(fake.unsubscribeSpy).toHaveBeenCalledTimes(1);
        expect(fake.subscribeCalls.map((call) => call.args)).toStrictEqual([{ roomId: "a" }, { roomId: "b" }]);
        expect(fake.contextFor()).toStrictEqual({ roomId: "b", sessionId: "sess-fixed" });
        expect(result.present.value).toBeUndefined();

        // A late push for the room that was left must not appear under the new one.
        fake.subscribeCalls[0]?.callback(["stale"]);

        expect(result.present.value).toBeUndefined();

        fake.push("presence:listPresent", { roomId: "b" }, ["bob"]);

        expect(result.present.value).toStrictEqual(["bob"]);

        scope.stop();
    });

    it("two concurrent presence hooks do not clear each other's connection context (refcount)", async () => {
        const fake = createPresenceFakeClient();

        const scopeA = effectScope();
        scopeA.run(() =>
            fake.provide(() =>
                usePresence("room-1", {
                    heartbeat: HEARTBEAT,
                    intervalMs: 500,
                    listPresent: LIST_PRESENT,
                    sessionId: "sess-a",
                }),
            ),
        );

        const scopeB = effectScope();
        scopeB.run(() =>
            fake.provide(() =>
                usePresence("room-1", {
                    heartbeat: HEARTBEAT,
                    intervalMs: 500,
                    listPresent: LIST_PRESENT,
                    sessionId: "sess-b",
                }),
            ),
        );

        await flushAsync();

        // Both hooks acquired the (default) shard's connection context.
        expect(fake.acquireConnectionContext).toHaveBeenCalledTimes(2);
        expect(fake.contextFor()).toMatchObject({ roomId: "room-1", sessionId: "sess-b" });

        // Stopping the second scope releases only its holder; the first hook's
        // context survives instead of being cleared (the old last-clearer-wins bug).
        scopeB.stop();
        await flushAsync();

        expect(fake.contextFor()).toMatchObject({ roomId: "room-1", sessionId: "sess-a" });

        // Stopping the last scope finally clears the shard's context.
        scopeA.stop();
        await flushAsync();

        expect(fake.contextFor()).toBeUndefined();
    });

    it("does not heartbeat, open an interval, or subscribe during SSR (no window)", async () => {
        const fake = createPresenceFakeClient();

        // Simulate the server render: no browser `window`.
        Reflect.deleteProperty(globalThis, "window");

        const scope = effectScope();
        const result = scope.run(() =>
            fake.provide(() =>
                usePresence("room-1", {
                    heartbeat: HEARTBEAT,
                    intervalMs: 500,
                    listPresent: LIST_PRESENT,
                    sessionId: "sess-fixed",
                }),
            ),
        )!;

        await flushAsync();

        // No setup-time heartbeat write, no live subscription, no connection context.
        expect(fake.mutationSpy).not.toHaveBeenCalled();
        expect(fake.subscribeCalls).toHaveLength(0);
        expect(fake.acquireConnectionContext).not.toHaveBeenCalled();

        // No leaked interval: advancing time fires no further heartbeats.
        await vi.advanceTimersByTimeAsync(2000);
        await flushAsync();

        expect(fake.mutationSpy).not.toHaveBeenCalled();

        // The session id is still returned so the caller has a stable handle.
        expect(result.sessionId).toBe("sess-fixed");

        scope.stop();
    });

    // An RLS denial or a session expiry on the `listPresent` subscription used to be
    // dropped on the floor: `present` simply froze at its last value with nothing to
    // read and no handler to call. Matches React's `usePresence` error channel.
    it("setData during SSR (no window) sends no heartbeat", async () => {
        const fake = createPresenceFakeClient();

        Reflect.deleteProperty(globalThis, "window");

        const scope = effectScope();
        const result = scope.run(() =>
            fake.provide(() =>
                usePresence("room-1", {
                    heartbeat: HEARTBEAT,
                    intervalMs: 500,
                    listPresent: LIST_PRESENT,
                    sessionId: "sess-fixed",
                }),
            ),
        )!;

        result.setData({ status: "typing" });
        await flushAsync();

        expect(fake.mutationSpy).not.toHaveBeenCalled();

        scope.stop();
    });

    it("setData while mounted sends a heartbeat carrying the new data", async () => {
        const fake = createPresenceFakeClient();

        const scope = effectScope();
        const result = scope.run(() =>
            fake.provide(() =>
                usePresence("room-1", {
                    heartbeat: HEARTBEAT,
                    intervalMs: 500,
                    listPresent: LIST_PRESENT,
                    sessionId: "sess-fixed",
                }),
            ),
        )!;

        await flushAsync();

        expect(fake.mutationSpy).toHaveBeenCalledTimes(1);

        result.setData({ status: "typing" });
        await flushAsync();

        expect(fake.mutationSpy).toHaveBeenCalledTimes(2);
        expect(fake.mutationSpy.mock.calls[1]?.[1]).toMatchObject({ roomId: "room-1", sessionId: "sess-fixed", data: { status: "typing" } });

        scope.stop();
    });

    it("setData after the scope stops sends no heartbeat", async () => {
        const fake = createPresenceFakeClient();

        const scope = effectScope();
        const result = scope.run(() =>
            fake.provide(() =>
                usePresence("room-1", {
                    heartbeat: HEARTBEAT,
                    intervalMs: 500,
                    listPresent: LIST_PRESENT,
                    sessionId: "sess-fixed",
                }),
            ),
        )!;

        await flushAsync();
        scope.stop();

        const callsAtStop = fake.mutationSpy.mock.calls.length;

        result.setData({ status: "typing" });
        await flushAsync();

        expect(fake.mutationSpy).toHaveBeenCalledTimes(callsAtStop);
    });

    it("surfaces a listPresent subscription error on `error` and through `onError`", async () => {
        const fake = createPresenceFakeClient();
        const seen: { code?: string; message: string }[] = [];

        const scope = effectScope();
        const result = scope.run(() =>
            fake.provide(() =>
                usePresence("room-1", {
                    heartbeat: HEARTBEAT,
                    listPresent: LIST_PRESENT,
                    onError: (subscriptionError) => seen.push(subscriptionError),
                    sessionId: "sess-fixed",
                }),
            ),
        )!;

        await flushAsync();

        const call = fake.subscribeCalls[0]!;

        call.callback([{ sessionId: "sess-fixed" }]);
        call.options.onError?.({ code: "FORBIDDEN", message: "denied" });

        expect(result.error.value?.message).toBe("denied");
        expect(seen).toStrictEqual([{ code: "FORBIDDEN", message: "denied" }]);
        // The last good value is retained — the error is additive, not a reset.
        expect(result.present.value).toStrictEqual([{ sessionId: "sess-fixed" }]);

        scope.stop();
    });
});
