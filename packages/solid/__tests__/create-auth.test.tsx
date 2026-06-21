import type { LunoraClient, Unsubscribe, User } from "@lunora/client";
import { render } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";

import { createAuth } from "../src/create-auth";
import { LunoraProvider } from "../src/lunora-provider";

const createAuthFakeClient = () => {
    let token: string | null = null;

    let currentUser: User | null = null;
    const tokenListeners = new Set<(t: string | null) => void>();

    const setAuthToken = vi.fn<(next: string | null) => undefined>((next) => {
        token = next;
        for (const listener of tokenListeners) listener(next);
    });

    const getAuthToken = vi.fn<() => string | null>(() => token);

    const onAuthTokenChange = vi.fn<(listener: (tokenValue: string | null) => void) => Unsubscribe>((listener) => {
        tokenListeners.add(listener);

        return () => {
            tokenListeners.delete(listener);
        };
    });

    const getCurrentUser = vi.fn<() => Promise<User | null>>(async () => currentUser);

    const setCurrentUser = (user: User | null) => {
        currentUser = user;
    };

    const client = {
        getAuthToken,
        getCurrentUser,
        onAuthTokenChange,
        setAuthToken,
    } as unknown as LunoraClient;

    return { client, getAuthToken, getCurrentUser, onAuthTokenChange, setAuthToken, setCurrentUser };
};

const flushMicrotasks = async (): Promise<void> => {
    await vi.waitFor(() => undefined);
};

describe("createAuth (Solid)", () => {
    it("token reflects current client token", () => {
        const fake = createAuthFakeClient();

        const { container } = render(
            () => {
                const { token } = createAuth();

                return <pre>{token() ?? "null"}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.client}>{props.children}</LunoraProvider> },
        );

        expect(container.textContent).toBe("null");
    });

    it("setToken forwards to the client", () => {
        const fake = createAuthFakeClient();
        let capturedSetToken: ((t: string | null) => void) | undefined;

        render(
            () => {
                const { setToken, token } = createAuth();
                capturedSetToken = setToken;

                return <pre>{token() ?? "null"}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.client}>{props.children}</LunoraProvider> },
        );

        capturedSetToken!("jwt-abc");

        expect(fake.setAuthToken).toHaveBeenCalledWith("jwt-abc");
    });

    it("user resolves after token is set", async () => {
        const fake = createAuthFakeClient();
        fake.setCurrentUser({ id: "u_1" });
        let capturedSetToken: ((t: string | null) => void) | undefined;

        const { container } = render(
            () => {
                const { setToken, user } = createAuth();
                capturedSetToken = setToken;

                return <pre>{user() ? (user() as User).id : "anon"}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.client}>{props.children}</LunoraProvider> },
        );

        expect(container.textContent).toBe("anon");

        capturedSetToken!("jwt-abc");
        await flushMicrotasks();

        expect(container.textContent).toBe("u_1");
    });
});
