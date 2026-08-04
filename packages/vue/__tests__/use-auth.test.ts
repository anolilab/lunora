import type { LunoraClient, Unsubscribe, User } from "@lunora/client";
import { describe, expect, it, vi } from "vitest";
import { createApp, effectScope, nextTick } from "vue";

import { LUNORA_INJECTION_KEY } from "../src/lunora-provider";
import { useAuth } from "../src/use-auth";

/** A minimal fake client exercising only the auth surface. */
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

    const app = createApp({});
    app.provide(LUNORA_INJECTION_KEY, client);
    const provide = <T>(fn: () => T): T => app.runWithContext(fn);

    return { client, getAuthToken, getCurrentUser, onAuthTokenChange, provide, setAuthToken, setCurrentUser };
};

const flushAsync = async (): Promise<void> => {
    await vi.waitFor(() => undefined);
    await nextTick();
};

describe("useAuth (Vue)", () => {
    it("token reflects current client token", () => {
        const fake = createAuthFakeClient();
        fake.setAuthToken("tok-1");

        const scope = effectScope();
        const { token } = scope.run(() => fake.provide(() => useAuth()))!;

        expect(token.value).toBe("tok-1");

        scope.stop();
    });

    it("setToken forwards to the client", async () => {
        const fake = createAuthFakeClient();

        const scope = effectScope();
        const { setToken, token } = scope.run(() => fake.provide(() => useAuth()))!;

        expect(token.value).toBeNull();

        setToken("jwt-abc");
        await nextTick();

        expect(fake.setAuthToken).toHaveBeenCalledWith("jwt-abc");
        expect(token.value).toBe("jwt-abc");

        scope.stop();
    });

    it("user resolves after token is set", async () => {
        const fake = createAuthFakeClient();
        fake.setCurrentUser({ id: "u_1" });

        const scope = effectScope();
        const { setToken, user } = scope.run(() => fake.provide(() => useAuth()))!;

        expect(user.value).toBeNull();

        setToken("jwt-abc");
        await flushAsync();

        expect(user.value).toStrictEqual({ id: "u_1" });

        scope.stop();
    });

    it("user clears on sign-out", async () => {
        const fake = createAuthFakeClient();
        fake.setCurrentUser({ id: "u_1" });

        const scope = effectScope();
        const { setToken, user } = scope.run(() => fake.provide(() => useAuth()))!;

        setToken("jwt-abc");
        await flushAsync();

        expect(user.value).toStrictEqual({ id: "u_1" });

        setToken(null);
        await nextTick();

        expect(user.value).toBeNull();

        scope.stop();
    });
});
