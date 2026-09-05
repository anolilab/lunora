import type { FunctionReference } from "@lunora/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { presence } from "../src/presence";
import { createFakeClient, createFakeDestroyRef } from "./fake-client";

const heartbeatRef = { __lunoraRef: "presence:heartbeat" } as FunctionReference<"mutation", { roomId: string; sessionId: string }>;
const listPresentRef = { __lunoraRef: "presence:listPresent" } as FunctionReference<"query", { roomId: string }>;

describe(presence, () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("sends a heartbeat on mount and subscribes to listPresent", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        const result = presence("room:1", {
            client: fake.asClient,
            destroyRef: destroy.asDestroyRef,
            heartbeat: heartbeatRef,
            listPresent: listPresentRef,
            sessionId: "sess-1",
        });

        expect(fake.mutationCalls).toHaveLength(1);
        expect(fake.mutationCalls[0]?.functionPath).toBe("presence:heartbeat");
        expect(fake.mutationCalls[0]?.args).toStrictEqual({ roomId: "room:1", sessionId: "sess-1" });

        expect(fake.subscriptions).toHaveLength(1);
        expect(fake.subscriptions[0]?.functionPath).toBe("presence:listPresent");
        expect(fake.subscriptions[0]?.args).toStrictEqual({ roomId: "room:1" });

        expect(fake.connectionContexts).toHaveLength(1);
        expect(fake.connectionContexts[0]?.context).toStrictEqual({ roomId: "room:1", sessionId: "sess-1" });

        expect(result.sessionId).toBe("sess-1");
    });

    it("present signal updates on listPresent push", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        const { present } = presence("room:1", {
            client: fake.asClient,
            destroyRef: destroy.asDestroyRef,
            heartbeat: heartbeatRef,
            listPresent: listPresentRef,
            sessionId: "sess-1",
        });

        expect(present()).toBeUndefined();

        const members = [{ id: "sess-1", name: "Alice" }];
        fake.subscriptions[0]?.push(members);

        expect(present()).toStrictEqual(members);
    });

    it("setData triggers an immediate heartbeat with the new data", () => {
        vi.useFakeTimers();
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        const { setData } = presence("room:1", {
            client: fake.asClient,
            destroyRef: destroy.asDestroyRef,
            heartbeat: heartbeatRef,
            listPresent: listPresentRef,
            sessionId: "sess-1",
        });

        const initialCalls = fake.mutationCalls.length;

        setData({ cursor: { x: 10, y: 20 } });

        expect(fake.mutationCalls).toHaveLength(initialCalls + 1);
        expect(fake.mutationCalls.at(-1)?.args).toStrictEqual({ data: { cursor: { x: 10, y: 20 } }, roomId: "room:1", sessionId: "sess-1" });
    });

    it("tears down interval, context, and subscription on destroy", () => {
        vi.useFakeTimers();
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        presence("room:1", {
            client: fake.asClient,
            destroyRef: destroy.asDestroyRef,
            heartbeat: heartbeatRef,
            listPresent: listPresentRef,
            sessionId: "sess-1",
        });

        expect(fake.subscriptions[0]?.unsubscribed).toBe(false);
        expect(fake.connectionContexts[0]?.released).toBe(false);

        destroy.destroy();

        expect(fake.subscriptions[0]?.unsubscribed).toBe(true);
        expect(fake.connectionContexts[0]?.released).toBe(true);
    });

    // An RLS denial or a session expiry on the `listPresent` subscription used to be
    // dropped on the floor: `present` simply froze at its last value with nothing to
    // read and no handler to call. Matches React's `usePresence` error channel.
    it("surfaces a listPresent subscription error on `error` and through `onError`", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();
        const seen: { code?: string; message: string }[] = [];

        const { error, present } = presence("room:1", {
            client: fake.asClient,
            destroyRef: destroy.asDestroyRef,
            heartbeat: heartbeatRef,
            listPresent: listPresentRef,
            onError: (subscriptionError) => seen.push(subscriptionError),
            sessionId: "sess-1",
        });

        fake.subscriptions[0]?.push([{ sessionId: "sess-1" }]);
        fake.subscriptions[0]?.emitError({ code: "FORBIDDEN", message: "denied" });

        expect(error()?.message).toBe("denied");
        expect(seen).toStrictEqual([{ code: "FORBIDDEN", message: "denied" }]);
        // The last good value is retained — the error is additive, not a reset.
        expect(present()).toStrictEqual([{ sessionId: "sess-1" }]);
    });
});
