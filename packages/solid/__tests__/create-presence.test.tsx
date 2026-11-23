/* eslint-disable no-underscore-dangle -- `__lunoraRef` is the Lunora function-reference field */
import type { FunctionReference, LunoraClient } from "@lunora/client";
import { render } from "@solidjs/testing-library";
import { createRoot, createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HeartbeatReference, ListPresentReference } from "../src/create-presence";
import { createPresence } from "../src/create-presence";
import { LunoraProvider } from "../src/lunora-provider";

const HEARTBEAT = { __lunoraRef: "presence:heartbeat" } as unknown as HeartbeatReference;
const LIST_PRESENT = { __lunoraRef: "presence:listPresent" } as unknown as ListPresentReference;
// `randomSessionId`'s non-`randomUUID` arm (shared/random-session-id.ts) hex-encodes
// 16 bytes of `crypto.getRandomValues`, so the id is exactly 32 lowercase hex chars.
// There is deliberately no arm below that: a runtime with no Web Crypto throws
// rather than mint a `Date.now()` string two sessions can share.
const SESS_ID_PATTERN = /^[\da-f]{32}$/;

const createPresenceFakeClient = () => {
    type Callback = (value: unknown) => void;

    const mutationCalls: { args: unknown; functionPath: string }[] = [];
    const subscribeCalls: {
        args: unknown;
        callback: Callback;
        functionPath: string;
        onError?: (error: { code?: string; message: string }) => void;
        unsubscribed: boolean;
    }[] = [];
    // Each acquired connection-context holder; `released` flips when the returned
    // release fn runs, so tests can assert refcounted (non-stomping) behaviour.
    const connectionContextHolders: { context: Record<string, unknown>; released: boolean }[] = [];

    const client: LunoraClient = {
        acquireConnectionContext: (context: Record<string, unknown>) => {
            const holder = { context, released: false };

            connectionContextHolders.push(holder);

            return () => {
                holder.released = true;
            };
        },
        mutation: (function_: FunctionReference, args: unknown) => {
            mutationCalls.push({ args, functionPath: function_.__lunoraRef });

            return Promise.resolve(undefined);
        },
        onConnectionStatus: () => () => undefined,
        subscribe: (
            function_: FunctionReference,
            args: Record<string, unknown>,
            callback: Callback,
            options?: { onError?: (error: { code?: string; message: string }) => void },
        ) => {
            const call = {
                args,
                callback,
                functionPath: function_.__lunoraRef,
                onError: options?.onError,
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

    return { client, connectionContextHolders, mutationCalls, push, subscribeCalls };
};

const flushAsync = async (): Promise<void> => {
    await vi.waitFor(() => undefined);
};

describe("createPresence (Solid)", () => {
    beforeEach(() => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("throws a RangeError for a non-positive intervalMs", () => {
        expect.assertions(1);

        const fake = createPresenceFakeClient();

        expect(() =>
            render(
                () => {
                    createPresence("room-1", { heartbeat: HEARTBEAT, intervalMs: 0, listPresent: LIST_PRESENT, sessionId: "sess-fixed" });

                    return <div />;
                },
                { wrapper: (props) => <LunoraProvider client={fake.client}>{props.children}</LunoraProvider> },
            ),
        ).toThrow(RangeError);
    });

    it("heartbeats on mount and again on each interval tick", async () => {
        const fake = createPresenceFakeClient();

        render(
            () => {
                createPresence("room-1", {
                    heartbeat: HEARTBEAT,
                    intervalMs: 500,
                    listPresent: LIST_PRESENT,
                    sessionId: "sess-fixed",
                });

                return <div />;
            },
            { wrapper: (props) => <LunoraProvider client={fake.client}>{props.children}</LunoraProvider> },
        );

        await flushAsync();

        // Immediate heartbeat on mount.
        expect(fake.mutationCalls).toHaveLength(1);
        expect(fake.mutationCalls[0]?.functionPath).toBe("presence:heartbeat");
        expect(fake.mutationCalls[0]?.args).toMatchObject({ roomId: "room-1", sessionId: "sess-fixed" });

        // Two interval ticks → two more heartbeats.
        await vi.advanceTimersByTimeAsync(1000);
        await flushAsync();

        expect(fake.mutationCalls).toHaveLength(3);
    });

    it("setData called during render sends no heartbeat before mount", async () => {
        // jsdom cannot run a real server render; a render-body call runs before
        // `onMounted`, which is the same pre-mount path an SSR render takes.
        const fake = createPresenceFakeClient();
        let mutationsBeforeMount = -1;

        render(
            () => {
                const { setData } = createPresence("room-1", {
                    heartbeat: HEARTBEAT,
                    intervalMs: 500,
                    listPresent: LIST_PRESENT,
                    sessionId: "sess-fixed",
                });

                setData({ status: "typing" });
                mutationsBeforeMount = fake.mutationCalls.length;

                return <div />;
            },
            { wrapper: (props) => <LunoraProvider client={fake.client}>{props.children}</LunoraProvider> },
        );

        expect(mutationsBeforeMount).toBe(0);

        await flushAsync();

        // The stored value is still delivered by the first mount heartbeat.
        expect(fake.mutationCalls).toHaveLength(1);
        expect(fake.mutationCalls[0]?.args).toMatchObject({ data: { status: "typing" }, roomId: "room-1" });
    });

    it("setData after mount sends a heartbeat carrying the new data", async () => {
        const fake = createPresenceFakeClient();
        let setDataFn: ((next: Record<string, unknown> | undefined) => void) | undefined;

        render(
            () => {
                const { setData } = createPresence("room-1", {
                    heartbeat: HEARTBEAT,
                    intervalMs: 500,
                    listPresent: LIST_PRESENT,
                    sessionId: "sess-fixed",
                });

                setDataFn = setData;

                return <div />;
            },
            { wrapper: (props) => <LunoraProvider client={fake.client}>{props.children}</LunoraProvider> },
        );

        await flushAsync();

        expect(fake.mutationCalls).toHaveLength(1);

        setDataFn?.({ status: "typing" });

        expect(fake.mutationCalls).toHaveLength(2);
        expect(fake.mutationCalls[1]?.args).toMatchObject({ data: { status: "typing" }, roomId: "room-1" });
    });

    it("subscribes to listPresent and returns pushed values", async () => {
        const fake = createPresenceFakeClient();
        let capturedPresent: (() => unknown) | undefined;

        render(
            () => {
                const { present } = createPresence("room-1", {
                    heartbeat: HEARTBEAT,
                    intervalMs: 500,
                    listPresent: LIST_PRESENT,
                    sessionId: "sess-fixed",
                });
                capturedPresent = present;

                return <div />;
            },
            { wrapper: (props) => <LunoraProvider client={fake.client}>{props.children}</LunoraProvider> },
        );

        await flushAsync();

        expect(fake.subscribeCalls).toHaveLength(1);
        expect(fake.subscribeCalls[0]?.functionPath).toBe("presence:listPresent");
        expect(fake.subscribeCalls[0]?.args).toMatchObject({ roomId: "room-1" });
        expect(capturedPresent!()).toBeUndefined();

        const members = [{ lastSeen: 5, roomId: "room-1", sessionId: "sess-fixed" }];

        fake.push("presence:listPresent", { roomId: "room-1" }, members);
        await flushAsync();

        expect(capturedPresent!()).toStrictEqual(members);
    });

    it("mints a session id from getRandomValues when crypto.randomUUID is unavailable", async () => {
        const fake = createPresenceFakeClient();
        // eslint-disable-next-line n/no-unsupported-features/node-builtins -- accessing globalThis.crypto to save/restore it for the test
        const originalCrypto = globalThis.crypto;

        // A non-secure origin (a plain-HTTP LAN dev/preview server) leaves
        // `crypto.randomUUID` undefined while still shipping `getRandomValues`.
        Object.defineProperty(globalThis, "crypto", {
            configurable: true,
            value: { getRandomValues: (array: Uint8Array) => array.fill(171) },
        });

        let capturedSessionId: string | undefined;

        try {
            render(
                () => {
                    const { sessionId } = createPresence("room-1", {
                        heartbeat: HEARTBEAT,
                        intervalMs: 500,
                        listPresent: LIST_PRESENT,
                    });
                    capturedSessionId = sessionId;

                    return <div />;
                },
                { wrapper: (props) => <LunoraProvider client={fake.client}>{props.children}</LunoraProvider> },
            );

            await flushAsync();

            expect(capturedSessionId).toMatch(SESS_ID_PATTERN);
        } finally {
            Object.defineProperty(globalThis, "crypto", { configurable: true, value: originalCrypto });
        }
    });

    it("stops heartbeating and unsubscribes on unmount", async () => {
        const fake = createPresenceFakeClient();

        const { unmount } = render(
            () => {
                createPresence("room-1", {
                    heartbeat: HEARTBEAT,
                    intervalMs: 500,
                    listPresent: LIST_PRESENT,
                    sessionId: "sess-fixed",
                });

                return <div />;
            },
            { wrapper: (props) => <LunoraProvider client={fake.client}>{props.children}</LunoraProvider> },
        );

        await flushAsync();

        expect(fake.mutationCalls).toHaveLength(1);

        unmount();

        const callsAtUnmount = fake.mutationCalls.length;

        await vi.advanceTimersByTimeAsync(2000);
        await flushAsync();

        expect(fake.mutationCalls).toHaveLength(callsAtUnmount);
        expect(fake.subscribeCalls[0]?.unsubscribed).toBe(true);
    });

    it("two concurrent presence hooks don't clear each other's connection context (refcount)", async () => {
        const fake = createPresenceFakeClient();

        // First hook.
        const first = render(
            () => {
                createPresence("room-1", {
                    heartbeat: HEARTBEAT,
                    intervalMs: 500,
                    listPresent: LIST_PRESENT,
                    sessionId: "sess-a",
                });

                return <div />;
            },
            { wrapper: (props) => <LunoraProvider client={fake.client}>{props.children}</LunoraProvider> },
        );

        // Second hook on the same client/shard.
        const second = render(
            () => {
                createPresence("room-1", {
                    heartbeat: HEARTBEAT,
                    intervalMs: 500,
                    listPresent: LIST_PRESENT,
                    sessionId: "sess-b",
                });

                return <div />;
            },
            { wrapper: (props) => <LunoraProvider client={fake.client}>{props.children}</LunoraProvider> },
        );

        await flushAsync();

        // Both hooks acquired their own holder; neither released yet.
        expect(fake.connectionContextHolders).toHaveLength(2);
        expect(fake.connectionContextHolders.every((holder) => !holder.released)).toBe(true);

        // Unmount the first hook — only its holder releases, the second's stays live.
        first.unmount();
        await flushAsync();

        expect(fake.connectionContextHolders[0]?.released).toBe(true);
        expect(fake.connectionContextHolders[1]?.released).toBe(false);

        // Unmount the second hook — now its holder releases too.
        second.unmount();
        await flushAsync();

        expect(fake.connectionContextHolders[1]?.released).toBe(true);
    });

    // An RLS denial or a session expiry on the `listPresent` subscription used to be
    // dropped on the floor: `present` simply froze at its last value with nothing to
    // read and no handler to call. Matches React's `usePresence` error channel.
    it("surfaces a listPresent subscription error on `error` and through `onError`", async () => {
        const fake = createPresenceFakeClient();
        const seen: { code?: string; message: string }[] = [];
        let captured: ReturnType<typeof createPresence> | undefined;

        render(
            () => {
                captured = createPresence("room-1", {
                    heartbeat: HEARTBEAT,
                    listPresent: LIST_PRESENT,
                    onError: (subscriptionError) => seen.push(subscriptionError),
                    sessionId: "sess-fixed",
                });

                return <pre />;
            },
            { wrapper: (props) => <LunoraProvider client={fake.client}>{props.children}</LunoraProvider> },
        );

        await flushAsync();

        const call = fake.subscribeCalls[0]!;

        call.callback([{ sessionId: "sess-fixed" }]);
        call.onError?.({ code: "FORBIDDEN", message: "denied" });

        expect(captured!.error()?.message).toBe("denied");
        expect(seen).toStrictEqual([{ code: "FORBIDDEN", message: "denied" }]);
        // The last good value is retained — the error is additive, not a reset.
        expect(captured!.present()).toStrictEqual([{ sessionId: "sess-fixed" }]);
    });

    it("follows a reactive room id: leaves the old room, joins the new one at once, and drops the old room's data", async () => {
        expect.assertions(9);

        const fake = createPresenceFakeClient();
        const [room, setRoom] = createSignal("a");
        let captured: ReturnType<typeof createPresence> | undefined;

        render(
            () => {
                // A long interval, so only a room-change heartbeat can reach the new room.
                captured = createPresence(room, { heartbeat: HEARTBEAT, intervalMs: 60_000, listPresent: LIST_PRESENT, sessionId: "sess-fixed" });

                return <div />;
            },
            { wrapper: (props) => <LunoraProvider client={fake.client}>{props.children}</LunoraProvider> },
        );

        await flushAsync();

        fake.push("presence:listPresent", { roomId: "a" }, ["alice"]);

        expect(captured!.present()).toStrictEqual(["alice"]);

        setRoom("b");
        await flushAsync();

        expect(fake.mutationCalls.map((call) => (call.args as { roomId: string }).roomId)).toStrictEqual(["a", "b"]);
        expect(fake.subscribeCalls.map((call) => call.unsubscribed)).toStrictEqual([true, false]);
        expect(fake.subscribeCalls.map((call) => call.args)).toStrictEqual([{ roomId: "a" }, { roomId: "b" }]);
        expect(fake.connectionContextHolders.map((holder) => holder.context)).toStrictEqual([
            { roomId: "a", sessionId: "sess-fixed" },
            { roomId: "b", sessionId: "sess-fixed" },
        ]);
        expect(fake.connectionContextHolders.map((holder) => holder.released)).toStrictEqual([true, false]);
        expect(captured!.present()).toBeUndefined();

        // A late push for the room that was left must not appear under the new one.
        fake.subscribeCalls[0]?.callback(["stale"]);

        expect(captured!.present()).toBeUndefined();

        fake.push("presence:listPresent", { roomId: "b" }, ["bob"]);

        expect(captured!.present()).toStrictEqual(["bob"]);
    });

    it("keeps the room armed when the room id accessor re-runs to the same value", async () => {
        expect.assertions(3);

        const fake = createPresenceFakeClient();
        const [org, setOrg] = createSignal({ id: "acme" });
        let captured: ReturnType<typeof createPresence> | undefined;

        render(
            () => {
                captured = createPresence(() => `${org().id}:lobby`, {
                    heartbeat: HEARTBEAT,
                    intervalMs: 60_000,
                    listPresent: LIST_PRESENT,
                    sessionId: "sess-fixed",
                });

                return <div />;
            },
            { wrapper: (props) => <LunoraProvider client={fake.client}>{props.children}</LunoraProvider> },
        );

        await flushAsync();

        fake.push("presence:listPresent", { roomId: "acme:lobby" }, ["alice"]);

        // A new object with the same id: the accessor re-runs, the room string does not change.
        setOrg({ id: "acme" });
        await flushAsync();

        expect(fake.subscribeCalls).toHaveLength(1);
        expect(fake.connectionContextHolders).toHaveLength(1);
        expect(captured!.present()).toStrictEqual(["alice"]);
    });

    it("leaves each room it stops showing, and the last one on unmount, through the leave mutation", async () => {
        expect.assertions(1);

        const fake = createPresenceFakeClient();
        const leftB = Promise.withResolvers<undefined>();
        // A leave waits for its room's heartbeat to settle, so the last one is awaited, not assumed.
        const mutation = vi.spyOn(fake.client, "mutation").mockImplementation(async (reference, args) => {
            if ((reference as unknown as Record<string, string>)["__lunoraRef"] === "presence:leave" && (args as { roomId: string }).roomId === "b") {
                leftB.resolve(undefined);
            }

            return undefined;
        });
        const [room, setRoom] = createSignal("a");
        const LEAVE = { __lunoraRef: "presence:leave" } as never;

        const view = render(
            () => {
                createPresence(room, { heartbeat: HEARTBEAT, intervalMs: 60_000, leave: LEAVE, listPresent: LIST_PRESENT, sessionId: "sess-fixed" });

                return <div />;
            },
            { wrapper: (props) => <LunoraProvider client={fake.client}>{props.children}</LunoraProvider> },
        );

        await flushAsync();
        setRoom("b");
        await flushAsync();
        view.unmount();
        await leftB.promise;

        expect(
            mutation.mock.calls.filter((call) => (call[0] as { __lunoraRef: string }).__lunoraRef === "presence:leave").map((call) => call[1]),
        ).toStrictEqual([
            { roomId: "a", sessionId: "sess-fixed" },
            { roomId: "b", sessionId: "sess-fixed" },
        ]);
    });

    it("sends a room's leave only after the heartbeat still in flight for it has settled", async () => {
        expect.assertions(2);

        const fake = createPresenceFakeClient();
        const heartbeatLanded = Promise.withResolvers<undefined>();
        const LEAVE = { __lunoraRef: "presence:leave" } as never;
        const leaveSent = Promise.withResolvers<undefined>();
        const mutation = vi.spyOn(fake.client, "mutation").mockImplementation(async (reference) => {
            const name = (reference as unknown as Record<string, string>)["__lunoraRef"];

            if (name === "presence:leave") {
                leaveSent.resolve(undefined);
            }

            return name === "presence:heartbeat" ? heartbeatLanded.promise : undefined;
        });
        const sent = (): string[] => mutation.mock.calls.map((call) => (call[0] as unknown as Record<string, string>)["__lunoraRef"] ?? "");

        const view = render(
            () => {
                createPresence("a", { heartbeat: HEARTBEAT, intervalMs: 60_000, leave: LEAVE, listPresent: LIST_PRESENT, sessionId: "sess-fixed" });

                return <div />;
            },
            { wrapper: (props) => <LunoraProvider client={fake.client}>{props.children}</LunoraProvider> },
        );

        await flushAsync();
        view.unmount();

        expect(sent()).toStrictEqual(["presence:heartbeat"]);

        heartbeatLanded.resolve(undefined);
        await leaveSent.promise;

        expect(sent()).toStrictEqual(["presence:heartbeat", "presence:leave"]);
    });

    it("releases a room whose root is disposed while its subscription replays a refusal", async () => {
        expect.assertions(2);

        const fake = createPresenceFakeClient();
        const original = fake.client.subscribe.bind(fake.client);
        let disposeRoot = (): void => {};

        // A replayed refusal reaches onError before subscribe returns.
        vi.spyOn(fake.client, "subscribe").mockImplementation((...args: Parameters<typeof original>) => {
            const unsubscribe = original(...args);

            fake.subscribeCalls.at(-1)?.onError?.({ code: "FORBIDDEN", message: "no" });

            return unsubscribe;
        });

        const Presence = (): null => {
            createPresence("a", {
                heartbeat: HEARTBEAT,
                intervalMs: 60_000,
                listPresent: LIST_PRESENT,
                onError: () => {
                    disposeRoot();
                },
                sessionId: "sess-fixed",
            });

            return null;
        };

        createRoot((dispose) => {
            disposeRoot = dispose;

            return (
                <LunoraProvider client={fake.client}>
                    <Presence />
                </LunoraProvider>
            );
        });

        await flushAsync();

        expect(fake.connectionContextHolders.map((holder) => holder.released)).toStrictEqual([true]);
        expect(fake.subscribeCalls.map((call) => call.unsubscribed)).toStrictEqual([true]);
    });

    it("sends the room's leave once when its root is disposed while its subscription replays a refusal", async () => {
        expect.assertions(1);

        const fake = createPresenceFakeClient();
        const original = fake.client.subscribe.bind(fake.client);
        const leaveSent = Promise.withResolvers<undefined>();
        const LEAVE = { __lunoraRef: "presence:leave" } as never;
        const mutation = vi.spyOn(fake.client, "mutation").mockImplementation(async (reference) => {
            if ((reference as unknown as Record<string, string>)["__lunoraRef"] === "presence:leave") {
                leaveSent.resolve(undefined);
            }

            return undefined;
        });
        let disposeRoot = (): void => {};

        // A replayed refusal reaches onError before subscribe returns.
        vi.spyOn(fake.client, "subscribe").mockImplementation((...args: Parameters<typeof original>) => {
            const unsubscribe = original(...args);

            fake.subscribeCalls.at(-1)?.onError?.({ code: "FORBIDDEN", message: "no" });

            return unsubscribe;
        });

        const Presence = (): null => {
            createPresence("a", {
                heartbeat: HEARTBEAT,
                intervalMs: 60_000,
                leave: LEAVE,
                listPresent: LIST_PRESENT,
                onError: () => {
                    disposeRoot();
                },
                sessionId: "sess-fixed",
            });

            return null;
        };

        createRoot((dispose) => {
            disposeRoot = dispose;

            return (
                <LunoraProvider client={fake.client}>
                    <Presence />
                </LunoraProvider>
            );
        });

        await leaveSent.promise;

        expect(
            mutation.mock.calls.filter((call) => (call[0] as unknown as Record<string, string>)["__lunoraRef"] === "presence:leave").map((call) => call[1]),
        ).toStrictEqual([{ roomId: "a", sessionId: "sess-fixed" }]);
    });

    it("never queues a heartbeat for offline replay", async () => {
        expect.assertions(1);

        const fake = createPresenceFakeClient();
        const mutation = vi.spyOn(fake.client, "mutation");

        render(
            () => {
                createPresence("a", { heartbeat: HEARTBEAT, intervalMs: 60_000, listPresent: LIST_PRESENT, sessionId: "sess-fixed" });

                return <div />;
            },
            { wrapper: (props) => <LunoraProvider client={fake.client}>{props.children}</LunoraProvider> },
        );

        await flushAsync();

        expect(mutation.mock.calls[0]?.[2]).toMatchObject({ onlineOnly: true });
    });

    it("does not read the room accessor without a browser global (SSR)", () => {
        expect.assertions(1);

        const fake = createPresenceFakeClient();
        const room = vi.fn<() => string>(() => {
            throw new Error("window.location is not available on the server");
        });

        vi.stubGlobal("window", undefined);

        try {
            render(
                () => {
                    createPresence(room, { heartbeat: HEARTBEAT, intervalMs: 60_000, listPresent: LIST_PRESENT, sessionId: "sess-fixed" });

                    return <div />;
                },
                { wrapper: (props) => <LunoraProvider client={fake.client}>{props.children}</LunoraProvider> },
            );
        } finally {
            vi.unstubAllGlobals();
        }

        expect(room).not.toHaveBeenCalled();
    });

    it("rolls a room's setup back when subscribing to it throws", async () => {
        expect.assertions(2);

        const fake = createPresenceFakeClient();

        vi.spyOn(fake.client, "subscribe").mockImplementation(() => {
            throw new Error("client closed");
        });

        expect(() =>
            render(
                () => {
                    createPresence("a", { heartbeat: HEARTBEAT, intervalMs: 60_000, listPresent: LIST_PRESENT, sessionId: "sess-fixed" });

                    return <div />;
                },
                { wrapper: (props) => <LunoraProvider client={fake.client}>{props.children}</LunoraProvider> },
            ),
        ).toThrow("client closed");

        await flushAsync();

        expect(fake.connectionContextHolders.map((holder) => holder.released)).toStrictEqual([true]);
    });
});
