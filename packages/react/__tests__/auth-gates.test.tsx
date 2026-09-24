import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { useEffect } from "react";
import { describe, expect, it } from "vitest";

import { Authenticated, AuthLoading, Unauthenticated } from "../src/auth-gates";
import { LunoraProvider } from "../src/lunora-provider";
import useAuth from "../src/use-auth";
import { createMockClient } from "./mock-client";

let setTokenHandle: ((token: string | null) => void) | undefined;

const Gates = (): ReactElement => {
    const { setToken } = useAuth();

    useEffect(() => {
        setTokenHandle = setToken;
    }, [setToken]);

    return (
        <div data-testid="gates">
            <Authenticated>
                <span data-testid="in">in</span>
            </Authenticated>
            <Unauthenticated>
                <span data-testid="out">out</span>
            </Unauthenticated>
            <AuthLoading>
                <span data-testid="loading">loading</span>
            </AuthLoading>
        </div>
    );
};

describe("auth gate components", () => {
    it("holds the loading gate with no token until the server says there is no session", async () => {
        expect.hasAssertions();

        const mock = createMockClient();

        render(
            <LunoraProvider client={mock.asClient}>
                <Gates />
            </LunoraProvider>,
        );

        // Not `Unauthenticated` yet. A cookie session holds no bearer token, so
        // an absent token is not evidence of being signed out — only the
        // server's answer is, and it has not arrived.
        expect(screen.getByTestId("loading").textContent).toBe("loading");
        expect(screen.queryByTestId("out")).toBeNull();

        await waitFor(() => {
            expect(screen.getByTestId("out").textContent).toBe("out");
        });

        expect(screen.queryByTestId("in")).toBeNull();
        expect(screen.queryByTestId("loading")).toBeNull();
    });

    it("holds the loading gate for a seeded token until its identity resolve settles", async () => {
        expect.hasAssertions();

        const mock = createMockClient();

        mock.getAuthToken.mockReturnValue("seeded-token");
        mock.setCurrentUser({ id: "u_1" });

        render(
            <LunoraProvider client={mock.asClient}>
                <Gates />
            </LunoraProvider>,
        );

        // The shared `AuthStatus` contract: a held credential whose first
        // identity resolve is still in flight is `loading`, in every adapter.
        expect(screen.getByTestId("loading").textContent).toBe("loading");
        expect(screen.queryByTestId("in")).toBeNull();

        await waitFor(() => {
            expect(screen.getByTestId("in").textContent).toBe("in");
        });

        expect(screen.queryByTestId("out")).toBeNull();
    });

    it("flips from Unauthenticated through loading to Authenticated when a token is set", async () => {
        expect.hasAssertions();

        const mock = createMockClient();

        // The server answers "no session" first, so the gates settle on
        // `Unauthenticated` the honest way — by asking — before the sign-in.
        render(
            <LunoraProvider client={mock.asClient}>
                <Gates />
            </LunoraProvider>,
        );

        await waitFor(() => {
            expect(screen.getByTestId("out").textContent).toBe("out");
        });

        mock.setCurrentUser({ id: "u_1" });

        act(() => {
            setTokenHandle!("jwt-123");
        });

        expect(screen.getByTestId("loading").textContent).toBe("loading");

        await waitFor(() => {
            expect(screen.getByTestId("in").textContent).toBe("in");
        });
    });
});
