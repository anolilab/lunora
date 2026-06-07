import type { FunctionReference } from "@cirrus/client";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CirrusProvider } from "../src/cirrus-provider.js";
import type { HeartbeatReference, ListPresentReference } from "../src/use-presence.js";
import { usePresence } from "../src/use-presence.js";
import { createMockClient } from "./mock-client.js";

const HEARTBEAT = { __cirrusRef: "presence:heartbeat" } as unknown as HeartbeatReference;
const LIST_PRESENT = { __cirrusRef: "presence:listPresent" } as unknown as ListPresentReference;

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
            <CirrusProvider client={mock.asClient}>
                <Roster />
            </CirrusProvider>,
        );

        // Immediate heartbeat on mount.
        await waitFor(() => {
            expect(mock.mutation).toHaveBeenCalledTimes(1);
        });

        expect(mock.mutation.mock.calls[0]?.[0]).toMatchObject({ __cirrusRef: "presence:heartbeat" });
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
            <CirrusProvider client={mock.asClient}>
                <Roster />
            </CirrusProvider>,
        );

        await waitFor(() => {
            expect(mock.subscribe).toHaveBeenCalledTimes(1);
        });

        expect(mock.subscribe.mock.calls[0]?.[0]).toMatchObject({ __cirrusRef: "presence:listPresent" });
        expect(mock.subscribe.mock.calls[0]?.[1]).toMatchObject({ roomId: "room-1" });
        expect(screen.getByTestId("roster").textContent).toBe("pending");

        const members = [{ lastSeen: 5, roomId: "room-1", sessionId: "sess-fixed" }];

        await act(async () => {
            mock.emit("presence:listPresent", members);
        });

        expect(screen.getByTestId("roster").textContent).toBe(JSON.stringify(members));
    });

    it("generates a fallback session id when globalThis.crypto is unavailable (no throw)", () => {
        expect.hasAssertions();

        const mock = createMockClient();
        const originalCrypto = globalThis.crypto;

        // Simulate an SSR / older runtime that leaves `crypto` undefined: reading
        // `.randomUUID` off it would throw a TypeError if the guard only checked
        // the method and not the `crypto` object itself.
        Object.defineProperty(globalThis, "crypto", { configurable: true, value: undefined });

        const Anon = (): ReactElement => {
            const { sessionId } = usePresence("room-anon", { heartbeat: HEARTBEAT, intervalMs: 1000, listPresent: LIST_PRESENT });

            return <div data-testid="anon">{sessionId}</div>;
        };

        try {
            render(
                <CirrusProvider client={mock.asClient}>
                    <Anon />
                </CirrusProvider>,
            );

            const id = screen.getByTestId("anon").textContent;

            expect(id).toMatch(/^sess-/);
        } finally {
            Object.defineProperty(globalThis, "crypto", { configurable: true, value: originalCrypto });
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
            <CirrusProvider client={mock.asClient}>
                <Roster />
            </CirrusProvider>,
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
