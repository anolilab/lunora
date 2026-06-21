import { act, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { LunoraProvider } from "../src/lunora-provider";
import useConnectionStatus from "../src/use-connection-status";
import { createMockClient } from "./mock-client";

const Status = (): ReactElement => {
    const status = useConnectionStatus();

    return <div data-testid="status">{status}</div>;
};

describe("useConnectionStatus", () => {
    it("renders the client's current aggregate status", () => {
        expect.assertions(1);

        const mock = createMockClient();

        mock.setConnectionStatus("connected");

        render(
            <LunoraProvider client={mock.asClient}>
                <Status />
            </LunoraProvider>,
        );

        expect(screen.getByTestId("status").textContent).toBe("connected");
    });

    it("re-renders on every status transition", () => {
        expect.assertions(4);

        const mock = createMockClient();

        render(
            <LunoraProvider client={mock.asClient}>
                <Status />
            </LunoraProvider>,
        );

        // Default status before any transition.
        expect(screen.getByTestId("status").textContent).toBe("idle");

        act(() => {
            mock.setConnectionStatus("connecting");
        });

        expect(screen.getByTestId("status").textContent).toBe("connecting");

        act(() => {
            mock.setConnectionStatus("connected");
        });

        expect(screen.getByTestId("status").textContent).toBe("connected");

        act(() => {
            mock.setConnectionStatus("offline");
        });

        expect(screen.getByTestId("status").textContent).toBe("offline");
    });

    it("unsubscribes from the client on unmount", () => {
        expect.assertions(2);

        const mock = createMockClient();

        const { unmount } = render(
            <LunoraProvider client={mock.asClient}>
                <Status />
            </LunoraProvider>,
        );

        expect(mock.onConnectionStatus).toHaveBeenCalledTimes(1);

        unmount();

        // A transition after unmount must not throw (the listener detached) and
        // the hook must have torn its subscription down — exercised by emitting
        // post-unmount, which would call into a stale listener if it leaked.
        act(() => {
            mock.setConnectionStatus("offline");
        });

        expect(screen.queryByTestId("status")).toBeNull();
    });
});
