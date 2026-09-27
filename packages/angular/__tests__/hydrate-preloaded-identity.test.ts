import type { Preloaded } from "@lunora/client";
import { LunoraClient } from "@lunora/client";
import { describe, expect, it, vi } from "vitest";

import { hydratePreloaded } from "../src/hydrate-preloaded";
import { createFakeDestroyRef } from "./fake-client";
import type { MockSocket } from "./mock-socket";
import { createMockWebSocket } from "./mock-socket";

/**
 * A preloaded value was read for whoever was signed in when the page loaded.
 * Once a sign-out or user switch retires that identity, it must not be shown
 * again — least of all to a component created later for the next user, whose
 * own subscription the server may refuse (nothing then replaces it).
 */

const FAST_RECONNECT = { initialDelayMs: 1, jitter: false, maxDelayMs: 1 } as const;

const PRELOADED_FOR_A: Preloaded<{ text: string }[]> = {
    __lunoraPreloaded: true,
    args: {},
    functionPath: "messages:mine",
    value: [{ text: "A-secret" }],
};

const settle = async (): Promise<void> => {
    for (let index = 0; index < 10; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- drain promise ticks in order
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });
    }
};

/** Open the newest socket and refuse each subscribe frame it carries. */
const refuse = async (sockets: MockSocket[]): Promise<void> => {
    const socket = sockets.at(-1);

    socket?.open();
    await settle();

    for (const frame of socket?.sent ?? []) {
        if (frame.type === "subscribe") {
            socket?.receive({ error: { code: "FORBIDDEN", message: "no" }, id: frame.id, type: "error" });
        }
    }

    await settle();
};

const createClient = (sockets: MockSocket[]): LunoraClient =>
    new LunoraClient({
        fetch: vi.fn<typeof fetch>(async () => Response.json({ result: [] })),
        reconnect: FAST_RECONNECT,
        url: "https://app.example",
        WebSocket: createMockWebSocket(sockets),
    });

const mount = (client: LunoraClient): { data: () => unknown; destroy: () => void } => {
    const destroyRef = createFakeDestroyRef();
    const { data } = hydratePreloaded(PRELOADED_FOR_A, { client, destroyRef: destroyRef.asDestroyRef });

    return { data, destroy: destroyRef.destroy };
};

describe("hydratePreloaded across an identity change", () => {
    it("does not show user A's preloaded value to a component created after user B signs in", async () => {
        expect.assertions(1);

        const sockets: MockSocket[] = [];
        const client = createClient(sockets);

        client.setAuthToken("jwt-A", "user-A");
        client.setAuthToken("jwt-B", "user-B");
        await settle();

        const { data, destroy } = mount(client);

        await refuse(sockets);

        expect(data()).toBeUndefined();

        destroy();
        client.close();
    });

    it("seeds the preloaded value when no identity has been retired", async () => {
        expect.assertions(2);

        const sockets: MockSocket[] = [];
        const client = createClient(sockets);

        client.setAuthToken("jwt-A", "user-A");

        const { data, destroy } = mount(client);

        expect(data()).toStrictEqual([{ text: "A-secret" }]);

        await refuse(sockets);

        expect(data()).toStrictEqual([{ text: "A-secret" }]);

        destroy();
        client.close();
    });

    it("blanks the value when user B signs in while it is mounted", async () => {
        expect.assertions(2);

        const sockets: MockSocket[] = [];
        const client = createClient(sockets);

        client.setAuthToken("jwt-A", "user-A");

        const { data, destroy } = mount(client);

        expect(data()).toStrictEqual([{ text: "A-secret" }]);

        client.setAuthToken("jwt-B", "user-B");
        await refuse(sockets);

        expect(data()).toBeUndefined();

        destroy();
        client.close();
    });

    it("keeps the value across a token refresh for the same user", async () => {
        expect.assertions(2);

        const sockets: MockSocket[] = [];
        const client = createClient(sockets);

        client.setAuthToken("jwt-A", "user-A");
        client.setAuthToken("jwt-A-refreshed", "user-A");
        await settle();

        const { data, destroy } = mount(client);

        expect(data()).toStrictEqual([{ text: "A-secret" }]);

        client.setAuthToken("jwt-A-refreshed-again", "user-A");
        await settle();

        expect(data()).toStrictEqual([{ text: "A-secret" }]);

        destroy();
        client.close();
    });
});
