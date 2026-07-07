import type { User } from "@lunora/client";
import { describe, expect, it } from "vitest";

import { auth } from "../src/auth";
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
