import type { LunoraClient, Unsubscribe, User } from "@lunora/client";
import { render } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";

import { Authenticated, AuthLoading, createAuth, Unauthenticated } from "../src/create-auth";
import { LunoraProvider } from "../src/lunora-provider";

const createAuthFakeClient = (userResolves = true) => {
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

    // `userResolves: false` models the in-flight window `AuthLoading` exists for:
    // a token is set but `getCurrentUser` has not come back yet.
    const getCurrentUser = vi.fn<() => Promise<User | null>>(async () => (userResolves ? currentUser : new Promise<never>(() => {})));

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

/**
 * The three gates are the one construct in this package TypeScript cannot check:
 * `create-auth.ts` narrows `Show` through a double cast — both majors ship it as
 * overload sets that differ from each other and whose first entry demands
 * `keyed` — then hands the result to `createComponent` rather than JSX so one
 * build serves Solid 1.x and 2.0. Only a render proves the cast still describes
 * the real component. The Solid 2 half lives in `tests/solid-v2-adapter`.
 */
describe("auth gates (Solid)", () => {
    const gates = () => (
        <>
            <Authenticated>
                <span data-testid="in">in</span>
            </Authenticated>
            <AuthLoading>
                <span data-testid="loading">loading</span>
            </AuthLoading>
            <Unauthenticated>
                <span data-testid="out">out</span>
            </Unauthenticated>
        </>
    );

    it("shows only the signed-out gate before a token arrives", async () => {
        const fake = createAuthFakeClient();
        fake.setCurrentUser({ id: "u_1" });

        const rendered = render(() => gates(), {
            wrapper: (props) => <LunoraProvider client={fake.client}>{props.children}</LunoraProvider>,
        });

        await flushMicrotasks();

        expect(rendered.queryByTestId("out")).not.toBeNull();
        expect(rendered.queryByTestId("in")).toBeNull();
        expect(rendered.queryByTestId("loading")).toBeNull();
    });

    it("flips to the authenticated gate once the user resolves", async () => {
        const fake = createAuthFakeClient();
        fake.setCurrentUser({ id: "u_1" });
        let capturedSetToken: ((t: string | null) => void) | undefined;

        const rendered = render(
            () => {
                const { setToken } = createAuth();
                capturedSetToken = setToken;

                return gates();
            },
            { wrapper: (props) => <LunoraProvider client={fake.client}>{props.children}</LunoraProvider> },
        );

        capturedSetToken!("jwt-abc");
        await flushMicrotasks();

        expect(rendered.queryByTestId("in")).not.toBeNull();
        expect(rendered.queryByTestId("out")).toBeNull();
        expect(rendered.queryByTestId("loading")).toBeNull();
    });

    it("holds the loading gate while the user is still resolving", async () => {
        const fake = createAuthFakeClient(false);
        let capturedSetToken: ((t: string | null) => void) | undefined;

        const rendered = render(
            () => {
                const { setToken } = createAuth();
                capturedSetToken = setToken;

                return gates();
            },
            { wrapper: (props) => <LunoraProvider client={fake.client}>{props.children}</LunoraProvider> },
        );

        capturedSetToken!("jwt-abc");
        await flushMicrotasks();

        expect(rendered.queryByTestId("loading")).not.toBeNull();
        expect(rendered.queryByTestId("in")).toBeNull();
        expect(rendered.queryByTestId("out")).toBeNull();
    });
});
