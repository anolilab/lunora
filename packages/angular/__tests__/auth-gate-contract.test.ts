import { LunoraClient } from "@lunora/client";
import { describe, expect, it, vi } from "vitest";

import { auth, authGate } from "../src/auth";
import { createFakeDestroyRef } from "./fake-client";

/**
 * The auth-gate signals against a REAL `LunoraClient` whose identity endpoint is
 * unreachable — the offline-reload shape, not a stand-in for it. Derived from
 * `user() !== null` these report `isLoading` forever; the contract in
 * `@lunora/client/auth` says a held credential nothing has contradicted is
 * authenticated.
 */

/** A socket that never connects — the gates need no live shard. */
/* eslint-disable class-methods-use-this -- an inert socket double: no method touches instance state, which is the point. */
class DeadSocket {
    public readyState = 0;

    public constructor(public readonly url: string) {}

    public addEventListener(): void {}

    public close(): void {}

    public send(): void {}
}

const flushAsync = (): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, 0);
    });

const clientWith = (fetchImpl: typeof fetch, token: string | null): LunoraClient => {
    const client = new LunoraClient({ fetch: fetchImpl, url: "https://app.example", WebSocket: DeadSocket as unknown as typeof WebSocket });

    client.setAuthToken(token);

    return client;
};

describe("auth gate contract (Angular)", () => {
    it("reports authenticated and status 'unreachable' for a stored token whose identity endpoint is down", async () => {
        expect.assertions(4);

        const client = clientWith(
            vi.fn<typeof fetch>(async () => {
                throw new TypeError("Failed to fetch");
            }),
            "stored-jwt",
        );
        const destroy = createFakeDestroyRef();

        const gate = authGate({ client, destroyRef: destroy.asDestroyRef });
        const { status, user } = auth({ client, destroyRef: destroy.asDestroyRef });

        await flushAsync();

        expect(gate.isAuthenticated()).toBe(true);
        expect(gate.isLoading()).toBe(false);
        expect(status()).toBe("unreachable");
        // The gate is open with no user record — a UI that branches on `user`
        // must read `status`, not treat `null` as signed out.
        expect(user()).toBeNull();

        client.close();
    });

    it("reports neither when the server answers that there is no session", async () => {
        expect.assertions(3);

        const client = clientWith(
            vi.fn<typeof fetch>(async () => Response.json({}, { status: 401 })),
            "stale-jwt",
        );
        const destroy = createFakeDestroyRef();

        const gate = authGate({ client, destroyRef: destroy.asDestroyRef });
        const { status } = auth({ client, destroyRef: destroy.asDestroyRef });

        await flushAsync();

        expect(gate.isAuthenticated()).toBe(false);
        expect(gate.isLoading()).toBe(false);
        expect(status()).toBe("unauthenticated");

        client.close();
    });
});
