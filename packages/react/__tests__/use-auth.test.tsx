import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { useEffect } from "react";
import { describe, expect, it } from "vitest";

import { LunoraProvider } from "../src/lunora-provider";
import useAuth from "../src/use-auth";
import { createMockClient } from "./mock-client";

let setTokenHandle: ((token: string | null) => void) | undefined;

const Display = (): ReactElement => {
    const { setToken, token, user } = useAuth();

    // Capture the handle out of render (an effect) so the test can drive it
    // without reassigning a module-level binding during render.
    useEffect(() => {
        setTokenHandle = setToken;
    }, [setToken]);

    return (
        <div data-testid="display">
            {token ?? "null"}|{user ? user.id : "anon"}
        </div>
    );
};

describe("useAuth", () => {
    it("initial token reflects client.getAuthToken()", () => {
        expect.assertions(1);

        const mock = createMockClient();

        mock.getAuthToken.mockReturnValue("seeded-token");

        render(
            <LunoraProvider client={mock.asClient}>
                <Display />
            </LunoraProvider>,
        );

        expect(screen.getByTestId("display").textContent).toBe("seeded-token|anon");
    });

    it("setToken updates both the hook state and the underlying client", () => {
        expect.assertions(5);

        const mock = createMockClient();

        render(
            <LunoraProvider client={mock.asClient}>
                <Display />
            </LunoraProvider>,
        );

        expect(screen.getByTestId("display").textContent).toBe("null|anon");

        act(() => {
            setTokenHandle!("jwt-123");
        });

        expect(screen.getByTestId("display").textContent).toBe("jwt-123|anon");
        expect(mock.setAuthToken).toHaveBeenCalledWith("jwt-123");

        act(() => {
            setTokenHandle!(null);
        });

        expect(screen.getByTestId("display").textContent).toBe("null|anon");
        expect(mock.setAuthToken).toHaveBeenLastCalledWith(null);
    });

    it("user is null when no token is set", () => {
        expect.assertions(2);

        const mock = createMockClient();

        mock.setCurrentUser({ id: "u_1" });

        render(
            <LunoraProvider client={mock.asClient}>
                <Display />
            </LunoraProvider>,
        );

        // No token ⇒ getCurrentUser is short-circuited, user stays anon.
        expect(screen.getByTestId("display").textContent).toBe("null|anon");
        expect(mock.getCurrentUser).not.toHaveBeenCalled();
    });

    it("populates user after a token is set and the session fetch resolves", async () => {
        expect.hasAssertions();

        const mock = createMockClient();

        mock.setCurrentUser({ email: "a@b.co", id: "u_42" });

        render(
            <LunoraProvider client={mock.asClient}>
                <Display />
            </LunoraProvider>,
        );

        expect(screen.getByTestId("display").textContent).toBe("null|anon");

        act(() => {
            setTokenHandle!("jwt-xyz");
        });

        await waitFor(() => {
            expect(screen.getByTestId("display").textContent).toBe("jwt-xyz|u_42");
        });
    });

    it("clears user on sign-out (token → null)", async () => {
        expect.hasAssertions();

        const mock = createMockClient();

        mock.setCurrentUser({ id: "u_7" });

        render(
            <LunoraProvider client={mock.asClient}>
                <Display />
            </LunoraProvider>,
        );

        // Sign in, then wait for the user to resolve.
        act(() => {
            setTokenHandle!("seeded");
        });

        await waitFor(() => {
            expect(screen.getByTestId("display").textContent).toBe("seeded|u_7");
        });

        // Sign out: token cleared ⇒ user resolves back to anon.
        act(() => {
            setTokenHandle!(null);
        });

        await waitFor(() => {
            expect(screen.getByTestId("display").textContent).toBe("null|anon");
        });
    });
});
