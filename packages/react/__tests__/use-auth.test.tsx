import { LunoraClient } from "@lunora/client";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";

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

    it("unsubscribes the store's token-change listener once the last hook unmounts", async () => {
        expect.hasAssertions();

        const mock = createMockClient();

        mock.setCurrentUser({ id: "u_9" });

        const view = render(
            <LunoraProvider client={mock.asClient}>
                <Display />
            </LunoraProvider>,
        );

        // Resolve identity once so the store is live.
        act(() => {
            setTokenHandle!("tok-1");
        });

        await waitFor(() => {
            expect(screen.getByTestId("display").textContent).toBe("tok-1|u_9");
        });

        const callsBeforeUnmount = mock.getCurrentUser.mock.calls.length;

        // Unmount the only hook: the store's token-change listener must be torn
        // down so it no longer fires (no dangling fetch-on-change side effect).
        view.unmount();

        // A token rotation after unmount must NOT trigger another identity
        // resolve — the listener is gone. (The cached store stays in the WeakMap;
        // only its live subscription comes and goes with subscriber presence.)
        act(() => {
            mock.asClient.setAuthToken("tok-2");
        });

        await Promise.resolve();

        expect(mock.getCurrentUser).toHaveBeenCalledTimes(callsBeforeUnmount);
    });

    // Against a REAL `LunoraClient`, not the mock: `setToken` takes no subject
    // (and no shipped adapter passes one), so the offline-queue identity has to
    // come from somewhere else or a routine JWT refresh reads as a user switch
    // and discards the user's queued writes and read cache. The client
    // establishes it from the session resolve this hook already triggers.
    it("keys the client's offline identity on the resolved user id, not the token bytes", async () => {
        expect.hasAssertions();

        const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
            const authorization = ((init?.headers ?? {}) as Record<string, string>)["authorization"] ?? "";

            const url = input instanceof Request ? input.url : String(input);

            return url.includes("get-session") && authorization !== ""
                ? Response.json({ user: { id: "u_42" } }, { status: 200 })
                : Response.json({ result: null }, { status: 200 });
        });
        const client = new LunoraClient({ fetch: fetchMock, url: "https://app.example" });

        render(
            <LunoraProvider client={client}>
                <Display />
            </LunoraProvider>,
        );

        act(() => {
            setTokenHandle!("jwt-1");
        });

        await waitFor(() => {
            expect(client.currentIdentity()).toBe("subj:u_42");
        });

        // The refresh every app does. Same identity ⇒ nothing is discarded.
        act(() => {
            setTokenHandle!("jwt-2");
        });

        expect(client.currentIdentity()).toBe("subj:u_42");

        client.close();
    });
});
