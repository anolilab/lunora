import { act, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { CirrusProvider } from "../src/cirrus-provider.js";
import useAuth from "../src/use-auth.js";
import { createMockClient } from "./mock-client.js";

let setTokenHandle: ((token: string | null) => void) | undefined;

const Display = (): ReactElement => {
    const { setToken, token, user } = useAuth();

    setTokenHandle = setToken;

    return (
        <div data-testid="display">
            {token ?? "null"}
|
{user ? "user" : "anon"}
        </div>
    );
};

describe("useAuth", () => {
    it("initial token reflects client.getAuthToken()", () => {
        expect.assertions(1);

        const mock = createMockClient();

        mock.getAuthToken.mockReturnValue("seeded-token");

        render(
            <CirrusProvider client={mock.asClient}>
                <Display />
            </CirrusProvider>,
        );

        expect(screen.getByTestId("display").textContent).toBe("seeded-token|anon");
    });

    it("setToken updates both the hook state and the underlying client", () => {
        expect.assertions(5);

        const mock = createMockClient();

        render(
            <CirrusProvider client={mock.asClient}>
                <Display />
            </CirrusProvider>,
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
});
