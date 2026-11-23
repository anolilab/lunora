import { act, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { StrictMode } from "react";
import { describe, expect, it } from "vitest";

import { LunoraProvider } from "../src/lunora-provider";
import type { HeartbeatReference, ListPresentReference } from "../src/use-presence";
import { usePresence } from "../src/use-presence";
import { createMockClient } from "./mock-client";

const HEARTBEAT = { __lunoraRef: "presence:heartbeat" } as unknown as HeartbeatReference;
const LIST_PRESENT = { __lunoraRef: "presence:listPresent" } as unknown as ListPresentReference;

const View = ({ roomId }: { roomId: string }): ReactElement => {
    // A long interval, so only a room-change heartbeat can reach the new room within the test.
    const { error, present } = usePresence(roomId, { heartbeat: HEARTBEAT, intervalMs: 60_000, listPresent: LIST_PRESENT, sessionId: "s1" });

    return <div data-testid="view">{`${roomId}:${present === undefined ? "loading" : JSON.stringify(present)}|err=${error?.message ?? "-"}`}</div>;
};

/** Joins room-a with a `leave` reference, so its teardown sends one. */
const LeavingRoomA = (): ReactElement => {
    usePresence("room-a", {
        heartbeat: HEARTBEAT,
        intervalMs: 60_000,
        leave: { __lunoraRef: "presence:leave" },
        listPresent: LIST_PRESENT,
        sessionId: "s1",
    });

    return <div />;
};

const inRoom =
    (roomId: string) =>
    (args: unknown): boolean =>
        (args as { roomId: string }).roomId === roomId;

describe("usePresence — room change", () => {
    it("sends Strict Mode's rejoin heartbeat only after the replayed leave of the same room has settled", async () => {
        expect.hasAssertions();

        const leaveLanded = Promise.withResolvers<undefined>();
        const leaveSent = Promise.withResolvers<undefined>();
        const rejoined = Promise.withResolvers<undefined>();
        const mock = createMockClient();
        const sent = (): string[] => mock.mutation.mock.calls.map((call) => (call[0] as Record<string, string>)["__lunoraRef"] ?? "");

        mock.mutation.mockImplementation((reference: unknown): unknown => {
            const name = (reference as Record<string, string>)["__lunoraRef"];

            if (name === "presence:leave") {
                leaveSent.resolve(undefined);

                return leaveLanded.promise;
            }

            if (sent().filter((entry) => entry === "presence:heartbeat").length === 2) {
                rejoined.resolve(undefined);
            }

            return Promise.resolve(undefined);
        });

        render(
            <StrictMode>
                <LunoraProvider client={mock.asClient}>
                    <LeavingRoomA />
                </LunoraProvider>
            </StrictMode>,
        );

        await act(async () => {
            await leaveSent.promise;
        });

        expect(sent()).toStrictEqual(["presence:heartbeat", "presence:leave"]);

        await act(async () => {
            leaveLanded.resolve(undefined);
            await rejoined.promise;
        });

        expect(sent()).toStrictEqual(["presence:heartbeat", "presence:leave", "presence:heartbeat"]);
    });

    it("sends a room's leave only after the heartbeat still in flight for it has settled", async () => {
        expect.hasAssertions();

        const heartbeatLanded = Promise.withResolvers<undefined>();
        const mock = createMockClient();
        const sent = (): string[] => mock.mutation.mock.calls.map((call) => (call[0] as Record<string, string>)["__lunoraRef"] ?? "");

        mock.mutation.mockImplementation((reference: unknown): unknown =>
            (reference as Record<string, string>)["__lunoraRef"] === "presence:heartbeat" ? heartbeatLanded.promise : Promise.resolve(undefined),
        );

        const view = render(
            <LunoraProvider client={mock.asClient}>
                <LeavingRoomA />
            </LunoraProvider>,
        );

        view.unmount();

        expect(sent()).toStrictEqual(["presence:heartbeat"]);

        await act(async () => {
            heartbeatLanded.resolve(undefined);
            await heartbeatLanded.promise;
        });

        expect(sent()).toStrictEqual(["presence:heartbeat", "presence:leave"]);
    });

    it("leaves each room it stops showing, and the last one on unmount, through the leave mutation", async () => {
        expect.hasAssertions();

        const Leaving = ({ roomId }: { roomId: string }): ReactElement => {
            usePresence(roomId, {
                heartbeat: HEARTBEAT,
                intervalMs: 60_000,
                leave: { __lunoraRef: "presence:leave" },
                listPresent: LIST_PRESENT,
                sessionId: "s1",
            });

            return <div />;
        };
        const mock = createMockClient();
        const view = render(
            <LunoraProvider client={mock.asClient}>
                <Leaving roomId="room-a" />
            </LunoraProvider>,
        );

        view.rerender(
            <LunoraProvider client={mock.asClient}>
                <Leaving roomId="room-b" />
            </LunoraProvider>,
        );
        view.unmount();

        await act(async () => {
            await Promise.resolve();
        });

        expect(
            mock.mutation.mock.calls.filter((call) => (call[0] as { __lunoraRef: string }).__lunoraRef === "presence:leave").map((call) => call[1]),
        ).toStrictEqual([
            { roomId: "room-a", sessionId: "s1" },
            { roomId: "room-b", sessionId: "s1" },
        ]);
    });

    it("heartbeats into the new room at once, not on the next interval tick", async () => {
        expect.hasAssertions();

        const mock = createMockClient();
        const view = render(
            <LunoraProvider client={mock.asClient}>
                <View roomId="room-a" />
            </LunoraProvider>,
        );

        view.rerender(
            <LunoraProvider client={mock.asClient}>
                <View roomId="room-b" />
            </LunoraProvider>,
        );

        await act(async () => {
            await Promise.resolve();
        });

        const rooms = mock.mutation.mock.calls.map((call) => (call[1] as { roomId: string }).roomId);

        expect(rooms).toStrictEqual(["room-a", "room-b"]);
    });

    it("does not list the previous room's members, or its error, under the new room", async () => {
        expect.hasAssertions();

        const mock = createMockClient();
        const view = render(
            <LunoraProvider client={mock.asClient}>
                <View roomId="room-a" />
            </LunoraProvider>,
        );

        act(() => {
            mock.emit("presence:listPresent", ["alice"], inRoom("room-a"));
            mock.emitError("presence:listPresent", { code: "FORBIDDEN", message: "denied in a" }, inRoom("room-a"));
        });

        expect(screen.getByTestId("view").textContent).toBe('room-a:["alice"]|err=denied in a');

        view.rerender(
            <LunoraProvider client={mock.asClient}>
                <View roomId="room-b" />
            </LunoraProvider>,
        );

        expect(screen.getByTestId("view").textContent).toBe("room-b:loading|err=-");

        act(() => {
            mock.emit("presence:listPresent", ["bob"], inRoom("room-b"));
        });

        expect(screen.getByTestId("view").textContent).toBe('room-b:["bob"]|err=-');
    });

    it("does not bring back a room's old list after a round trip through a room that never answered", () => {
        expect.hasAssertions();

        const mock = createMockClient();
        const tree = (roomId: string): ReactElement => (
            <LunoraProvider client={mock.asClient}>
                <View roomId={roomId} />
            </LunoraProvider>
        );
        const view = render(tree("room-a"));

        act(() => {
            mock.emit("presence:listPresent", ["alice"], inRoom("room-a"));
        });

        view.rerender(tree("room-b"));
        view.rerender(tree("room-a"));

        expect(screen.getByTestId("view").textContent).toBe("room-a:loading|err=-");
    });
});
