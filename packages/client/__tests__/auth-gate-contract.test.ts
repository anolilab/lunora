import { describe, expect, it, vi } from "vitest";

import { getIdentityStore, isAuthenticatedStatus, isLoadingStatus } from "../src/auth";
import { LunoraClient } from "../src/lunora-client";

/**
 * The auth-gate contract, at the one place all five UI adapters read it.
 *
 * `getCurrentUser()` used to fold a failed fetch into `null`, which is also how
 * it reports "the server says you have no session". Every adapter then derived
 * its gate from that single sentinel and they disagreed about the result: the
 * `token && user` adapters spun their loading fallback for the whole offline
 * period, while the token-only one rendered the app with `user === null`, so any
 * `user`-branching UI read signed out. These pin the third state that separates
 * the two and the mapping every adapter now shares.
 */

const flush = async (): Promise<void> => {
    for (let index = 0; index < 5; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- intentional sequential drain of promise ticks
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });
    }
};

const jsonResponse = (body: unknown, init?: ResponseInit): Response =>
    Response.json(body, { headers: { "content-type": "application/json" }, status: 200, ...init });

/** A socket that never connects — these tests never need a live shard. */
const createDeadSocket = (): typeof WebSocket => {
    /* eslint-disable class-methods-use-this -- an inert socket double: no method touches instance state, which is the point. */
    class WS {
        public readyState = 0;

        public constructor(public readonly url: string) {}

        public addEventListener(): void {}

        public close(): void {}

        public send(): void {}
    }

    return WS as unknown as typeof WebSocket;
};

const offlineFetch = (): typeof fetch =>
    vi.fn<typeof fetch>(async () => {
        throw new TypeError("Failed to fetch");
    });

describe("getCurrentUser — unreachable is not signed out", () => {
    it("rejects when the identity endpoint cannot be reached", async () => {
        expect.assertions(1);

        const client = new LunoraClient({ fetch: offlineFetch(), url: "https://app.example", WebSocket: createDeadSocket() });

        client.setAuthToken("stored-jwt");

        await expect(client.getCurrentUser()).rejects.toThrow("Failed to fetch");

        client.close();
    });

    it("still resolves null when the server answers that there is no session", async () => {
        expect.assertions(1);

        const client = new LunoraClient({
            fetch: vi.fn<typeof fetch>(async () => jsonResponse({}, { status: 401 })),
            url: "https://app.example",
            WebSocket: createDeadSocket(),
        });

        client.setAuthToken("stale-jwt");

        await expect(client.getCurrentUser()).resolves.toBeNull();

        client.close();
    });
});

describe("identity store status", () => {
    it("reports 'unreachable' — gated as authenticated — for a stored token on an offline reload", async () => {
        expect.assertions(4);

        const client = new LunoraClient({ fetch: offlineFetch(), url: "https://app.example", WebSocket: createDeadSocket() });

        // The shape of a reload: the token is restored before anything mounts.
        client.setAuthToken("stored-jwt");

        const store = getIdentityStore(client);

        store.subscribe(() => undefined);
        await flush();

        expect(store.getStatus()).toBe("unreachable");
        expect(store.getUser()).toBeNull();
        // The credential is held and nothing contradicted it, so the gate opens
        // rather than spinning a fallback for the whole offline period.
        expect(isAuthenticatedStatus(store.getStatus())).toBe(true);
        expect(isLoadingStatus(store.getStatus())).toBe(false);

        client.close();
    });

    it("reports 'unauthenticated' when the server answers that there is no session", async () => {
        expect.assertions(2);

        const client = new LunoraClient({
            fetch: vi.fn<typeof fetch>(async () => jsonResponse({}, { status: 401 })),
            url: "https://app.example",
            WebSocket: createDeadSocket(),
        });

        client.setAuthToken("stale-jwt");

        const store = getIdentityStore(client);

        store.subscribe(() => undefined);
        await flush();

        expect(store.getStatus()).toBe("unauthenticated");
        expect(isAuthenticatedStatus(store.getStatus())).toBe(false);

        client.close();
    });

    it("keeps the resolved user when the endpoint goes unreachable mid-session", async () => {
        expect.assertions(4);

        let reachable = true;

        const fetchMock = vi.fn<typeof fetch>(async () => {
            if (!reachable) {
                throw new TypeError("Failed to fetch");
            }

            return jsonResponse({ user: { email: "a@b.co", id: "u_1" } });
        });

        const client = new LunoraClient({ fetch: fetchMock, url: "https://app.example", WebSocket: createDeadSocket() });
        const store = getIdentityStore(client);

        store.subscribe(() => undefined);
        client.setAuthToken("jwt-1");
        await flush();

        expect(store.getStatus()).toBe("authenticated");

        // The network drops and the app rotates its JWT — the refresh cannot be
        // answered. The identity already on screen must survive it.
        reachable = false;
        client.setAuthToken("jwt-2");
        await flush();

        expect(store.getStatus()).toBe("unreachable");
        expect(store.getUser()).toStrictEqual({ email: "a@b.co", id: "u_1" });
        expect(isAuthenticatedStatus(store.getStatus())).toBe(true);

        client.close();
    });

    it("notifies subscribers when only the status changes", async () => {
        expect.assertions(2);

        const client = new LunoraClient({ fetch: offlineFetch(), url: "https://app.example", WebSocket: createDeadSocket() });
        const store = getIdentityStore(client);
        const changes: string[] = [];

        store.subscribe(() => changes.push(store.getStatus()));
        client.setAuthToken("stored-jwt");
        await flush();

        // `user` is `null` throughout, so a store that only fanned out on a user
        // change would leave every gate stuck on its initial render.
        expect(store.getUser()).toBeNull();
        expect(changes).toContain("unreachable");

        client.close();
    });
});
