import type { LunoraClient, Unsubscribe, User } from "@lunora/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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

// The composable gates its listeners on a browser `window` (the SSR guard the
// other subscribing composables in this package apply); the vitest env is
// `node`, so define one or every test below would silently exercise the SSR
// path instead of the one it means to. Mirrors the stub in `use-flag.test.ts`.
/* eslint-disable vitest/require-top-level-describe -- the `window` stub is shared by every describe in this file, so it belongs at file scope */
beforeAll(() => {
    Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
});

afterAll(() => {
    Reflect.deleteProperty(globalThis, "window");
});
/* eslint-enable vitest/require-top-level-describe */

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

describe("useAuth during SSR", () => {
    // `setup()` runs inside `renderToString`, and that render scope is never
    // stopped — so `onScopeDispose` never fires and unguarded listeners stay
    // registered on the client for the lifetime of the server process. The
    // identity subscribe also kicks off `getCurrentUser()`, a round-trip against
    // a client whose URL does not resolve server-side.
    it("registers no listener and fetches no identity without a browser window", () => {
        expect.assertions(4);

        const original = Reflect.getOwnPropertyDescriptor(globalThis, "window");

        Reflect.deleteProperty(globalThis, "window");

        try {
            const fake = createAuthFakeClient();
            const scope = effectScope();

            // The identity store registers its own token listener when it is
            // created, so read the baseline before the composable runs.
            const { baseline, result } = scope.run(() => {
                const before = fake.onAuthTokenChange.mock.calls.length;

                return { baseline: before, result: fake.provide(() => useAuth()) };
            })!;

            // Exactly one: the identity store's own, registered when it is
            // created. The composable's token listener must not be added.
            expect(fake.onAuthTokenChange).toHaveBeenCalledTimes(baseline + 1);
            expect(fake.getCurrentUser).not.toHaveBeenCalled();
            expect(result.token.value).toBeNull();
            expect(result.user.value).toBeNull();

            scope.stop();
        } finally {
            if (original) {
                Object.defineProperty(globalThis, "window", original);
            }
        }
    });
});
