import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectScope, nextTick } from "vue";

import type { HeartbeatReference, ListPresentReference } from "../src/use-presence";
import { usePresence } from "../src/use-presence";
import { createFakeClient } from "./fake-client";

const HEARTBEAT = { __lunoraRef: "presence:heartbeat" } as unknown as HeartbeatReference;
const LIST_PRESENT = { __lunoraRef: "presence:listPresent" } as unknown as ListPresentReference;
const SESS_ID_PATTERN = /^sess-/;

/** Extend the fake client with `setConnectionContext` stub. */
const createPresenceFakeClient = () => {
    const fake = createFakeClient();
    const setConnectionContext = vi.fn();

    (fake.client as unknown as Record<string, unknown>)["setConnectionContext"] = setConnectionContext;

    return { ...fake, setConnectionContext };
};

const flushAsync = async (): Promise<void> => {
    await vi.waitFor(() => undefined);
    await nextTick();
};

describe("usePresence (Vue)", () => {
    beforeEach(() => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    afterEach(() => {
        vi.useRealTimers();
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

    it("generates fallback session id when crypto is unavailable", () => {
        const fake = createPresenceFakeClient();
        // eslint-disable-next-line n/no-unsupported-features/node-builtins -- accessing globalThis.crypto to save/restore it for the test
        const originalCrypto = globalThis.crypto;

        Object.defineProperty(globalThis, "crypto", { configurable: true, value: undefined });

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
});
