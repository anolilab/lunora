import { LunoraClient } from "@lunora/client";
import { get } from "svelte/store";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { authGate } from "../src/auth";

/**
 * The auth-gate stores against a REAL `LunoraClient` whose identity endpoint is
 * unreachable — the offline-reload shape, not a stand-in for it. Derived from
 * `$user !== null` these report `isLoading` forever; the contract in
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

// Every subscribing primitive in this package gates on a browser `window`; the
// vitest env is `node`, so define one for these client-path tests.
/* eslint-disable vitest/require-top-level-describe -- the `window` stub is shared by the describe below */
beforeAll(() => {
    Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
});

afterAll(() => {
    Reflect.deleteProperty(globalThis, "window");
});
/* eslint-enable vitest/require-top-level-describe */

const gateFor = async (fetchImpl: typeof fetch, token: string | null): Promise<{ isAuthenticated: boolean; isLoading: boolean }> => {
    const client = new LunoraClient({ fetch: fetchImpl, url: "https://app.example", WebSocket: DeadSocket as unknown as typeof WebSocket });

    client.setAuthToken(token);

    const gate = authGate(client);
    // Svelte stores are lazy: hold a live subscription so the identity store's
    // first resolve actually runs.
    const stop = gate.isAuthenticated.subscribe(() => {});
    const stopLoading = gate.isLoading.subscribe(() => {});

    await new Promise((resolve) => {
        setTimeout(resolve, 0);
    });

    const snapshot = { isAuthenticated: get(gate.isAuthenticated), isLoading: get(gate.isLoading) };

    stop();
    stopLoading();
    client.close();

    return snapshot;
};

describe("auth gate contract (Svelte)", () => {
    it("reports authenticated for a stored token whose identity endpoint is unreachable", async () => {
        expect.hasAssertions();

        await expect(
            gateFor(
                vi.fn<typeof fetch>(async () => {
                    throw new TypeError("Failed to fetch");
                }),
                "stored-jwt",
            ),
        ).resolves.toStrictEqual({ isAuthenticated: true, isLoading: false });
    });

    it("reports neither when the server answers that there is no session", async () => {
        expect.hasAssertions();

        await expect(
            gateFor(
                vi.fn<typeof fetch>(async () => Response.json({}, { status: 401 })),
                "stale-jwt",
            ),
        ).resolves.toStrictEqual({
            isAuthenticated: false,
            isLoading: false,
        });
    });
});
