import type { LunoraClient, Unsubscribe, User } from "@lunora/client";
import { get } from "svelte/store";
import { describe, expect, it, vi } from "vitest";

import { auth, authGate } from "../src/auth";

const createAuthFakeClient = () => {
    let token: string | null = null;

    let currentUser: User | null = null;
    const tokenListeners = new Set<(t: string | null) => void>();

    const setAuthToken = vi.fn((next: string | null) => {
        token = next;
        for (const listener of tokenListeners) listener(next);
    });

    const getAuthToken = vi.fn((): string | null => token);

    const onAuthTokenChange = vi.fn((listener: (tokenValue: string | null) => void): Unsubscribe => {
        tokenListeners.add(listener);

        return () => {
            tokenListeners.delete(listener);
        };
    });

    const getCurrentUser = vi.fn(async (): Promise<User | null> => currentUser);

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
