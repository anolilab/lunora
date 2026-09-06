import type { LunoraClient, Unsubscribe, User } from "@lunora/client";
import { get } from "svelte/store";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { auth, authGate } from "../src/auth";

const createAuthFakeClient = () => {
    let token: string | null = null;

    let currentUser: User | null = null;
    const tokenListeners = new Set<(t: string | null) => void>();

    const setAuthToken = vi.fn<(next: string | null) => void>((next) => {
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

const flushAsync = async (): Promise<void> => {
    await vi.waitFor(() => undefined);
};

// The stores gate their listeners on a browser `window` (the SSR guard every
// other subscribing primitive in this package applies); the vitest env is
// `node`, so define one or every test below would silently exercise the SSR
// path instead of the one it means to. Mirrors the same stub in `flag.test.ts`.
/* eslint-disable vitest/require-top-level-describe -- the `window` stub is shared by every describe in this file, so it belongs at file scope */
beforeAll(() => {
    Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
});

afterAll(() => {
    Reflect.deleteProperty(globalThis, "window");
});
/* eslint-enable vitest/require-top-level-describe */

describe("auth store (Svelte)", () => {
    it("token starts as null when no token is set", () => {
        const fake = createAuthFakeClient();
        const { token } = auth(fake.client);

        const stop = token.subscribe(() => {});

        expect(get(token)).toBeNull();

        stop();
    });

    it("setToken updates the token store", () => {
        const fake = createAuthFakeClient();
        const { setToken, token } = auth(fake.client);

        const stop = token.subscribe(() => {});

        setToken("jwt-abc");

        expect(fake.setAuthToken).toHaveBeenCalledWith("jwt-abc");
        expect(get(token)).toBe("jwt-abc");

        stop();
    });

    it("user resolves after token is set", async () => {
        const fake = createAuthFakeClient();
        fake.setCurrentUser({ id: "u_1" });

        const { setToken, user } = auth(fake.client);

        const stop = user.subscribe(() => {});

        expect(get(user)).toBeNull();

        setToken("jwt-abc");
        await flushAsync();

        expect(get(user)).toStrictEqual({ id: "u_1" });

        stop();
    });

    it("user clears on sign-out", async () => {
        const fake = createAuthFakeClient();
        fake.setCurrentUser({ id: "u_1" });

        const { setToken, user } = auth(fake.client);
        const stop = user.subscribe(() => {});

        setToken("jwt-abc");
        await flushAsync();

        expect(get(user)).toStrictEqual({ id: "u_1" });

        setToken(null);
        await flushAsync();

        expect(get(user)).toBeNull();

        stop();
    });
});

describe("authGate store (Svelte)", () => {
    it("is neither loading nor authenticated before a token is set (signed out)", () => {
        const fake = createAuthFakeClient();
        const { isAuthenticated, isLoading } = authGate(fake.client);

        const stopA = isAuthenticated.subscribe(() => {});
        const stopL = isLoading.subscribe(() => {});

        expect(get(isAuthenticated)).toBe(false);
        expect(get(isLoading)).toBe(false);

        stopA();
        stopL();
    });

    it("is loading once a token is set but the user hasn't resolved yet", () => {
        const fake = createAuthFakeClient();
        const { isAuthenticated, isLoading } = authGate(fake.client);

        const stopA = isAuthenticated.subscribe(() => {});
        const stopL = isLoading.subscribe(() => {});

        fake.setAuthToken("jwt-abc");

        expect(get(isLoading)).toBe(true);
        expect(get(isAuthenticated)).toBe(false);

        stopA();
        stopL();
    });

    it("is authenticated once the token is set and the user has resolved", async () => {
        const fake = createAuthFakeClient();
        fake.setCurrentUser({ id: "u_1" });

        const { isAuthenticated, isLoading } = authGate(fake.client);

        const stopA = isAuthenticated.subscribe(() => {});
        const stopL = isLoading.subscribe(() => {});

        fake.setAuthToken("jwt-abc");
        await flushAsync();

        expect(get(isAuthenticated)).toBe(true);
        expect(get(isLoading)).toBe(false);

        stopA();
        stopL();
    });

    it("returns to signed out on sign-out", async () => {
        const fake = createAuthFakeClient();
        fake.setCurrentUser({ id: "u_1" });

        const { isAuthenticated, isLoading } = authGate(fake.client);

        const stopA = isAuthenticated.subscribe(() => {});
        const stopL = isLoading.subscribe(() => {});

        fake.setAuthToken("jwt-abc");
        await flushAsync();

        expect(get(isAuthenticated)).toBe(true);

        fake.setAuthToken(null);
        await flushAsync();

        expect(get(isAuthenticated)).toBe(false);
        expect(get(isLoading)).toBe(false);

        stopA();
        stopL();
    });
});

describe("auth stores during SSR", () => {
    // A `readable`'s start function runs on its first subscriber, and `$token` /
    // `$user` in a template subscribe during `renderToString`. The user store's
    // first subscribe is not merely a listener registration: the identity store
    // kicks off `getCurrentUser()` on it, so an unguarded server render issues a
    // network round-trip against a client whose URL does not resolve there.
    it("registers no listener and fetches no identity without a browser window", () => {
        expect.assertions(4);

        const original = Reflect.getOwnPropertyDescriptor(globalThis, "window");

        Reflect.deleteProperty(globalThis, "window");

        try {
            const fake = createAuthFakeClient();
            const { token, user } = auth(fake.client);

            // The identity store registers its own token listener when it is
            // created, independent of these stores — measure the delta from there.
            const baseline = fake.onAuthTokenChange.mock.calls.length;

            const stopToken = token.subscribe(() => {});
            const stopUser = user.subscribe(() => {});

            expect(fake.onAuthTokenChange).toHaveBeenCalledTimes(baseline);
            expect(fake.getCurrentUser).not.toHaveBeenCalled();
            expect(get(token)).toBeNull();
            expect(get(user)).toBeNull();

            stopToken();
            stopUser();
        } finally {
            if (original) {
                Object.defineProperty(globalThis, "window", original);
            }
        }
    });
});
