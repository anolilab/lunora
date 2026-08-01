import type { User } from "@lunora/client";
import { describe, expect, it } from "vitest";

import { auth, authGate } from "../src/auth";
import { createFakeClient, createFakeDestroyRef } from "./fake-client";

const flushAsync = (): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, 0);
    });

describe(auth, () => {
    it("seeds token from the client and null user until resolved", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        const { token, user } = auth({ client: fake.asClient, destroyRef: destroy.asDestroyRef });

        expect(token()).toBeNull();
        expect(user()).toBeNull();
    });

    it("setToken updates the token signal", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        const { setToken } = auth({ client: fake.asClient, destroyRef: destroy.asDestroyRef });

        setToken("jwt-abc");

        expect(fake.asClient.getAuthToken()).toBe("jwt-abc");
    });

    it("resolves the user after setToken fires onAuthTokenChange", async () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();
        const testUser: User = { id: "u1", name: "Alice" };

        fake.setCurrentUser(testUser);

        const { token, user, setToken } = auth({ client: fake.asClient, destroyRef: destroy.asDestroyRef });

        setToken("jwt-abc");
        fake.emitAuthTokenChange();

        expect(token()).toBe("jwt-abc");

        await flushAsync();

        expect(user()).toStrictEqual(testUser);
    });

    it("clears the user on sign-out (setToken(null))", async () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();
        const testUser: User = { id: "u1", name: "Alice" };

        fake.setCurrentUser(testUser);

        const { token, user, setToken } = auth({ client: fake.asClient, destroyRef: destroy.asDestroyRef });

        setToken("jwt-abc");
        fake.emitAuthTokenChange();
        await flushAsync();

        expect(user()).toStrictEqual(testUser);

        setToken(null);
        fake.emitAuthTokenChange();
        await flushAsync();

        expect(token()).toBeNull();
        expect(user()).toBeNull();
    });

    it("removes auth listeners on destroy (store's per-client listener remains)", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        auth({ client: fake.asClient, destroyRef: destroy.asDestroyRef });

        // 2 listeners: store's refresh + auth's token updater
        expect(fake.tokenListeners).toHaveLength(2);

        destroy.destroy();

        // Store's per-client refresh listener remains; auth's token updater is removed
        expect(fake.tokenListeners).toHaveLength(1);
    });
});

describe(authGate, () => {
    it("is neither loading nor authenticated before a token is set (signed out)", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        const { isAuthenticated, isLoading } = authGate({ client: fake.asClient, destroyRef: destroy.asDestroyRef });

        expect(isAuthenticated()).toBe(false);
        expect(isLoading()).toBe(false);
    });

    it("is loading once a token is set but the user hasn't resolved yet", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        const { isAuthenticated, isLoading } = authGate({ client: fake.asClient, destroyRef: destroy.asDestroyRef });

        fake.asClient.setAuthToken("jwt-abc");
        fake.emitAuthTokenChange();

        expect(isLoading()).toBe(true);
        expect(isAuthenticated()).toBe(false);
    });

    it("is authenticated once the token is set and the user has resolved", async () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();
        const testUser: User = { id: "u1", name: "Alice" };

        fake.setCurrentUser(testUser);

        const { isAuthenticated, isLoading } = authGate({ client: fake.asClient, destroyRef: destroy.asDestroyRef });

        fake.asClient.setAuthToken("jwt-abc");
        fake.emitAuthTokenChange();
        await flushAsync();

        expect(isAuthenticated()).toBe(true);
        expect(isLoading()).toBe(false);
    });

    it("returns to signed out (neither authenticated nor loading) on sign-out", async () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();
        const testUser: User = { id: "u1", name: "Alice" };

        fake.setCurrentUser(testUser);

        const { isAuthenticated, isLoading } = authGate({ client: fake.asClient, destroyRef: destroy.asDestroyRef });

        fake.asClient.setAuthToken("jwt-abc");
        fake.emitAuthTokenChange();
        await flushAsync();

        expect(isAuthenticated()).toBe(true);

        fake.asClient.setAuthToken(null);
        fake.emitAuthTokenChange();
        await flushAsync();

        expect(isAuthenticated()).toBe(false);
        expect(isLoading()).toBe(false);
    });
});
