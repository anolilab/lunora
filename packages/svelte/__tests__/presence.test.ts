import type { FunctionReference, LunoraClient } from "@lunora/client";
import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HeartbeatReference, ListPresentReference } from "../src/presence";
import { presence } from "../src/presence";

const HEARTBEAT = { __lunoraRef: "presence:heartbeat" } as unknown as HeartbeatReference;
const LIST_PRESENT = { __lunoraRef: "presence:listPresent" } as unknown as ListPresentReference;
const SESS_ID_PATTERN = /^sess-/;

const createPresenceFakeClient = () => {
    type Callback = (value: unknown) => void;

    const mutationCalls: { args: unknown; functionPath: string }[] = [];
    const subscribeCalls: { args: unknown; callback: Callback; functionPath: string; unsubscribed: boolean }[] = [];
    const setConnectionContextCalls: unknown[] = [];

    const client: LunoraClient = {
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

    return { client, mutationCalls, push, setConnectionContextCalls, subscribeCalls };
};

const flushAsync = async (): Promise<void> => {
    await vi.waitFor(() => undefined);
};

describe("presence (Svelte)", () => {
    beforeEach(() => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    afterEach(() => {
        vi.useRealTimers();
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

    it("generates fallback session id when crypto is unavailable", () => {
        const fake = createPresenceFakeClient();
        // eslint-disable-next-line n/no-unsupported-features/node-builtins -- accessing globalThis.crypto to save/restore it for the test
        const originalCrypto = globalThis.crypto;

        Object.defineProperty(globalThis, "crypto", { configurable: true, value: undefined });

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
});
