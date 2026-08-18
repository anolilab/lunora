import type { LunoraClient, Unsubscribe, User } from "@lunora/client";
import { Authenticated, AuthLoading, createAuth, LunoraProvider, Unauthenticated } from "@lunora/solid";
import { render } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";

/**
 * `createAuth` and the three auth gates under Solid 2.0.
 *
 * The gates are the one construct in the adapter TypeScript cannot check on
 * either major: `create-auth.ts` narrows `Show` through a double cast, because
 * both majors ship it as overload sets that differ from each other and whose
 * first entry demands `keyed`. It then feeds that cast to `createComponent`
 * rather than JSX so a single build serves 1.x and 2.0. Nothing but a render
 * proves the cast still describes the real component.
 */

const createAuthFakeClient = (options: { user?: User | null; userResolves?: boolean } = {}) => {
    const { user: currentUser = null, userResolves = true } = options;

    let token: string | null = null;
    const tokenListeners = new Set<(next: string | null) => void>();

    const setAuthToken = vi.fn<(next: string | null) => undefined>((next) => {
        token = next;

        for (const listener of tokenListeners) {
            listener(next);
        }
    });

    const getAuthToken = vi.fn<() => string | null>(() => token);

    const onAuthTokenChange = vi.fn<(listener: (next: string | null) => void) => Unsubscribe>((listener) => {
        tokenListeners.add(listener);

        return () => {
            tokenListeners.delete(listener);
        };
    });

    // `userResolves: false` models the in-flight window the `AuthLoading` gate
    // exists for: a token is set but `getCurrentUser` has not come back yet.
    const getCurrentUser = vi.fn<() => Promise<User | null>>(async () => (userResolves ? currentUser : new Promise<never>(() => {})));

    const client = { getAuthToken, getCurrentUser, onAuthTokenChange, setAuthToken } as unknown as LunoraClient;

    return { client, getAuthToken, getCurrentUser, onAuthTokenChange, setAuthToken };
};

/** Let the identity store's `getCurrentUser` promise land, then settle reads. */
const settle = async (): Promise<void> => {
    await vi.waitFor(() => undefined);
    flush();
};

describe("createAuth on Solid 2", () => {
    it("token reflects the current client token", () => {
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
        let capturedSetToken: ((next: string | null) => void) | undefined;

        render(
            () => {
                const { setToken, token } = createAuth();

                capturedSetToken = setToken;

                return <pre>{token() ?? "null"}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.client}>{props.children}</LunoraProvider> },
        );

        capturedSetToken?.("jwt-abc");

        expect(fake.setAuthToken).toHaveBeenCalledWith("jwt-abc");
    });

    it("user resolves after the token is set", async () => {
        const fake = createAuthFakeClient({ user: { id: "u_1" } });
        let capturedSetToken: ((next: string | null) => void) | undefined;

        const { container } = render(
            () => {
                const { setToken, user } = createAuth();

                capturedSetToken = setToken;

                return <pre>{user()?.id ?? "anon"}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.client}>{props.children}</LunoraProvider> },
        );

        expect(container.textContent).toBe("anon");

        capturedSetToken?.("jwt-abc");
        await settle();

        expect(container.textContent).toBe("u_1");
    });
});

describe("auth gates on Solid 2", () => {
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
        const fake = createAuthFakeClient({ user: { id: "u_1" } });

        const rendered = render(() => gates(), {
            wrapper: (props) => <LunoraProvider client={fake.client}>{props.children}</LunoraProvider>,
        });

        await settle();

        expect(rendered.queryByTestId("out")).not.toBeNull();
        expect(rendered.queryByTestId("in")).toBeNull();
        expect(rendered.queryByTestId("loading")).toBeNull();
    });

    it("flips to the authenticated gate once the user resolves", async () => {
        const fake = createAuthFakeClient({ user: { id: "u_1" } });
        let capturedSetToken: ((next: string | null) => void) | undefined;

        const rendered = render(
            () => {
                const { setToken } = createAuth();

                capturedSetToken = setToken;

                return gates();
            },
            { wrapper: (props) => <LunoraProvider client={fake.client}>{props.children}</LunoraProvider> },
        );

        capturedSetToken?.("jwt-abc");
        await settle();

        expect(rendered.queryByTestId("in")).not.toBeNull();
        expect(rendered.queryByTestId("out")).toBeNull();
        expect(rendered.queryByTestId("loading")).toBeNull();
    });

    it("holds the loading gate while the user is still resolving", async () => {
        const fake = createAuthFakeClient({ userResolves: false });
        let capturedSetToken: ((next: string | null) => void) | undefined;

        const rendered = render(
            () => {
                const { setToken } = createAuth();

                capturedSetToken = setToken;

                return gates();
            },
            { wrapper: (props) => <LunoraProvider client={fake.client}>{props.children}</LunoraProvider> },
        );

        capturedSetToken?.("jwt-abc");
        await settle();

        expect(rendered.queryByTestId("loading")).not.toBeNull();
        expect(rendered.queryByTestId("in")).toBeNull();
        expect(rendered.queryByTestId("out")).toBeNull();
    });
});
