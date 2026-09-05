/* eslint-disable no-underscore-dangle -- `__lunoraRef` is the Lunora function-reference field */
import type { FunctionReference, LunoraClient } from "@lunora/client";
import { render } from "@solidjs/testing-library";
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
});
