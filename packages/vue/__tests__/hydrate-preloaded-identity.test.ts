import type { Preloaded } from "@lunora/client";
import { LunoraClient } from "@lunora/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Ref } from "vue";
import { createApp, effectScope } from "vue";

import { hydratePreloaded } from "../src/hydrate-preloaded";
import { LUNORA_INJECTION_KEY } from "../src/lunora-provider";
import type { MockSocket } from "./mock-socket";
import { createMockWebSocket } from "./mock-socket";

/**
 * A preloaded value was read for whoever was signed in when the page loaded.
 * Once a sign-out or user switch retires that identity, it must not be shown
 * again — least of all to a component that mounts later for the next user,
 * whose own subscription the server may refuse (nothing then replaces it).
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

const mount = (client: LunoraClient): { data: Ref<{ text: string }[] | undefined>; stop: () => void } => {
    const app = createApp({});

    app.provide(LUNORA_INJECTION_KEY, client);

    const scope = effectScope();
    const data = scope.run(() => app.runWithContext(() => hydratePreloaded(PRELOADED_FOR_A))) as Ref<{ text: string }[] | undefined>;

    return {
        data,
        stop: () => {
            scope.stop();
        },
    };
};

describe("hydratePreloaded across an identity change", () => {
    beforeEach(() => {
        Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });
    });

    afterEach(() => {
        Reflect.deleteProperty(globalThis, "window");
    });

    it("does not show user A's preloaded value to a component that mounts after user B signs in", async () => {
        expect.assertions(1);

        const sockets: MockSocket[] = [];
        const client = createClient(sockets);

        client.setAuthToken("jwt-A", "user-A");
        client.setAuthToken("jwt-B", "user-B");
        await settle();

        const { data, stop } = mount(client);

        await refuse(sockets);

        expect(data.value).toBeUndefined();

        stop();
        client.close();
    });

    it("seeds the preloaded value when no identity has been retired", async () => {
        expect.assertions(2);

        const sockets: MockSocket[] = [];
        const client = createClient(sockets);

        client.setAuthToken("jwt-A", "user-A");

        const { data, stop } = mount(client);

        expect(data.value).toStrictEqual([{ text: "A-secret" }]);

        await refuse(sockets);

        expect(data.value).toStrictEqual([{ text: "A-secret" }]);

        stop();
        client.close();
    });

    it("blanks the value when user B signs in while it is mounted", async () => {
        expect.assertions(2);

        const sockets: MockSocket[] = [];
        const client = createClient(sockets);

        client.setAuthToken("jwt-A", "user-A");

        const { data, stop } = mount(client);

        expect(data.value).toStrictEqual([{ text: "A-secret" }]);

        client.setAuthToken("jwt-B", "user-B");
        await refuse(sockets);

        expect(data.value).toBeUndefined();

        stop();
        client.close();
    });

    it("keeps the value across a token refresh for the same user", async () => {
        expect.assertions(2);

        const sockets: MockSocket[] = [];
        const client = createClient(sockets);

        client.setAuthToken("jwt-A", "user-A");
        client.setAuthToken("jwt-A-refreshed", "user-A");
        await settle();

        const { data, stop } = mount(client);

        expect(data.value).toStrictEqual([{ text: "A-secret" }]);

        client.setAuthToken("jwt-A-refreshed-again", "user-A");
        await settle();

        expect(data.value).toStrictEqual([{ text: "A-secret" }]);

        stop();
        client.close();
    });
});
