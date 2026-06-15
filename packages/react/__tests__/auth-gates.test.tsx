import { act, render, screen } from "@testing-library/react";
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
    it("renders Unauthenticated when no token is set (and settles past loading)", () => {
        expect.assertions(3);

        const mock = createMockClient();

        render(
            <LunoraProvider client={mock.asClient}>
                <Gates />
            </LunoraProvider>,
        );

        expect(screen.getByTestId("out").textContent).toBe("out");
        expect(screen.queryByTestId("in")).toBeNull();
        expect(screen.queryByTestId("loading")).toBeNull();
    });

    it("renders Authenticated when a token is seeded", () => {
        expect.assertions(2);

        const mock = createMockClient();

        mock.getAuthToken.mockReturnValue("seeded-token");

        render(
            <LunoraProvider client={mock.asClient}>
                <Gates />
            </LunoraProvider>,
        );

        expect(screen.getByTestId("in").textContent).toBe("in");
        expect(screen.queryByTestId("out")).toBeNull();
    });

    it("flips from Unauthenticated to Authenticated when a token is set", () => {
        expect.assertions(2);

        const mock = createMockClient();

        render(
            <LunoraProvider client={mock.asClient}>
                <Gates />
            </LunoraProvider>,
        );

        expect(screen.getByTestId("out").textContent).toBe("out");

        act(() => {
            setTokenHandle!("jwt-123");
        });

        expect(screen.getByTestId("in").textContent).toBe("in");
    });
});
