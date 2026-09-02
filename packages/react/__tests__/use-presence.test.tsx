import type { FunctionReference } from "@lunora/client";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LunoraProvider } from "../src/lunora-provider";
import type { HeartbeatReference, ListPresentReference } from "../src/use-presence";
import { usePresence } from "../src/use-presence";
import { createMockClient } from "./mock-client";

const HEARTBEAT = { __lunoraRef: "presence:heartbeat" } as unknown as HeartbeatReference;
const LIST_PRESENT = { __lunoraRef: "presence:listPresent" } as unknown as ListPresentReference;

const Roster = ({ roomId = "room-1" }: { roomId?: string }): ReactElement => {
    const { present, sessionId } = usePresence(roomId, {
        heartbeat: HEARTBEAT,
        intervalMs: 1000,
        listPresent: LIST_PRESENT,
        sessionId: "sess-fixed",
    });

    return (
        <div data-session={sessionId} data-testid="roster">
            {present === undefined ? "pending" : JSON.stringify(present)}
        </div>
    );
};

describe("usePresence", () => {
    beforeEach(() => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("heartbeats on mount and again on each interval tick", async () => {
        expect.hasAssertions();

        const mock = createMockClient();

        render(
            <LunoraProvider client={mock.asClient}>
                <Roster />
            </LunoraProvider>,
        );

        // Immediate heartbeat on mount.
        await waitFor(() => {
            expect(mock.mutation).toHaveBeenCalledTimes(1);
        });

        expect(mock.mutation.mock.calls[0]?.[0]).toMatchObject({ __lunoraRef: "presence:heartbeat" });
        expect(mock.mutation.mock.calls[0]?.[1]).toMatchObject({ roomId: "room-1", sessionId: "sess-fixed" });

        // Two interval ticks → two more heartbeats.
        await act(async () => {
            await vi.advanceTimersByTimeAsync(2000);
        });

        expect(mock.mutation).toHaveBeenCalledTimes(3);
    });

    it("subscribes to listPresent and returns pushed present-list values", async () => {
        expect.hasAssertions();

        const mock = createMockClient();

        render(
            <LunoraProvider client={mock.asClient}>
                <Roster />
            </LunoraProvider>,
        );

        await waitFor(() => {
            expect(mock.subscribe).toHaveBeenCalledTimes(1);
        });

        expect(mock.subscribe.mock.calls[0]?.[0]).toMatchObject({ __lunoraRef: "presence:listPresent" });
        expect(mock.subscribe.mock.calls[0]?.[1]).toMatchObject({ roomId: "room-1" });
        expect(screen.getByTestId("roster").textContent).toBe("pending");

        const members = [{ lastSeen: 5, roomId: "room-1", sessionId: "sess-fixed" }];

        await act(async () => {
            mock.emit("presence:listPresent", members);
        });

        expect(screen.getByTestId("roster").textContent).toBe(JSON.stringify(members));
    });

    it("mints a session id from getRandomValues when crypto.randomUUID is unavailable", () => {
        expect.hasAssertions();

        const mock = createMockClient();
        const originalCrypto = globalThis.crypto;

        // A non-secure origin (a plain-HTTP LAN dev/preview server) leaves
        // `crypto.randomUUID` undefined while still shipping `getRandomValues`.
        Object.defineProperty(globalThis, "crypto", {
            configurable: true,
            value: { getRandomValues: (array: Uint8Array) => array.fill(171) },
        });

        const Anon = (): ReactElement => {
            const { sessionId } = usePresence("room-anon", { heartbeat: HEARTBEAT, intervalMs: 1000, listPresent: LIST_PRESENT });

            return <div data-testid="anon">{sessionId}</div>;
        };

        try {
            render(
                <LunoraProvider client={mock.asClient}>
                    <Anon />
                </LunoraProvider>,
            );

            const id = screen.getByTestId("anon").textContent;

            // The non-`randomUUID` arm hex-encodes 16 bytes (shared/random-session-id.ts).
            // There is deliberately no arm below it: a runtime with no Web Crypto throws
            // rather than mint a `Date.now()` string two sessions can share.
            expect(id).toMatch(/^[\da-f]{32}$/);
        } finally {
            Object.defineProperty(globalThis, "crypto", { configurable: true, value: originalCrypto });
        }
    });

    it("mounts and still heartbeats on an interval when `document` is unavailable, e.g. React Native (RN-01)", async () => {
        expect.hasAssertions();

        const mock = createMockClient();

        // React Native has no `document` global at all — not even `undefined`,
        // the identifier is simply never declared. A bare `document.visibilityState`
        // read (or `document.addEventListener`) throws a ReferenceError on mount
        // without the `typeof document !== "undefined"` guard. `react-dom`
        // creates elements via the container's `ownerDocument`, not the bare
        // global, so rendering into a container created BEFORE deleting the
        // global still works here — letting this test isolate exactly the
        // hook's own (formerly unguarded) `document` reads.
        const container = globalThis.document.createElement("div");

        globalThis.document.body.append(container);

        const originalDocument = globalThis.document;

        // @ts-expect-error -- intentionally deleting a required global to simulate React Native
        delete globalThis.document;

        const root = createRoot(container);

        try {
            expect(() => {
                // eslint-disable-next-line testing-library/no-unnecessary-act -- this is raw `react-dom/client`'s `root.render`, not an RTL util call (the rule name-matches "render" regardless of origin); `act` here is load-bearing so the mount's effects (the heartbeat) flush synchronously before the assertion below.
                act(() => {
                    root.render(
                        <LunoraProvider client={mock.asClient}>
                            <Roster />
                        </LunoraProvider>,
                    );
                });
            }).not.toThrow();

            // The interval heartbeat (not the visibility-driven one, which is
            // itself guarded and simply skipped) fires synchronously as part of
            // mount — asserted here, before `document` is restored, so this
            // stays proof of the mount-time behavior specifically. (Skip RTL's
            // `waitFor`: it resolves its own default container from `document`,
            // which is exactly what this test has deleted.)
            expect(mock.mutation).toHaveBeenCalledTimes(1);
        } finally {
            Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument, writable: true });
            root.unmount();
            container.remove();
        }
    });

    it("stops heart-beating after unmount and releases the subscription", async () => {
        expect.hasAssertions();

        const mock = createMockClient();
        const unsubscribeSpy = vi.fn<() => void>();

        const originalSubscribe = mock.subscribe.getMockImplementation() as (
            functionRef: FunctionReference,
            args: unknown,
            callback: (value: unknown) => void,
        ) => () => void;

        mock.subscribe.mockImplementation((functionRef, args, callback) => {
            const realUnsubscribe = originalSubscribe(functionRef, args, callback);

            return () => {
                unsubscribeSpy();
                realUnsubscribe();
            };
        });

        const view = render(
            <LunoraProvider client={mock.asClient}>
                <Roster />
            </LunoraProvider>,
        );

        await waitFor(() => {
            expect(mock.mutation).toHaveBeenCalledTimes(1);
        });

        view.unmount();

        expect(unsubscribeSpy).toHaveBeenCalledTimes(1);

        const callsAtUnmount = mock.mutation.mock.calls.length;

        // The interval is cleared — advancing time produces no further heartbeats.
        await act(async () => {
            await vi.advanceTimersByTimeAsync(5000);
        });

        expect(mock.mutation).toHaveBeenCalledTimes(callsAtUnmount);
    });
});
