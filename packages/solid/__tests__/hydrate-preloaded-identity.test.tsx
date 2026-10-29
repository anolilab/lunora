import type { Preloaded } from "@lunora/client";
import { LunoraClient } from "@lunora/client";
import { render } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";

import hydratePreloaded from "../src/hydrate-preloaded";
import { LunoraProvider } from "../src/lunora-provider";
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

const mount = (client: LunoraClient): HTMLElement =>
    render(
        () => {
            const data = hydratePreloaded(PRELOADED_FOR_A);

            return (
                <pre>
                    {data()
                        ?.map((row) => row.text)
                        .join(",") ?? "(none)"}
                </pre>
            );
        },
        { wrapper: (props) => <LunoraProvider client={client}>{props.children}</LunoraProvider> },
    ).container;

describe("hydratePreloaded across an identity change", () => {
    it("does not show user A's preloaded value to a component that mounts after user B signs in", async () => {
        expect.assertions(1);

        const sockets: MockSocket[] = [];
        const client = createClient(sockets);

        client.setAuthToken("jwt-A", "user-A");
        client.setAuthToken("jwt-B", "user-B");
        await settle();

        const screen = mount(client);

        await settle();
        await refuse(sockets);

        expect(screen.textContent).toBe("(none)");

        client.close();
    });

    it("seeds the preloaded value when no identity has been retired", async () => {
        expect.assertions(2);

        const sockets: MockSocket[] = [];
        const client = createClient(sockets);

        client.setAuthToken("jwt-A", "user-A");

        const screen = mount(client);

        expect(screen.textContent).toBe("A-secret");

        await settle();
        await refuse(sockets);

        expect(screen.textContent).toBe("A-secret");

        client.close();
    });

    it("blanks the value when user B signs in while it is mounted", async () => {
        expect.assertions(2);

        const sockets: MockSocket[] = [];
        const client = createClient(sockets);

        client.setAuthToken("jwt-A", "user-A");

        const screen = mount(client);

        expect(screen.textContent).toBe("A-secret");

        await settle();
        client.setAuthToken("jwt-B", "user-B");
        await refuse(sockets);

        expect(screen.textContent).toBe("(none)");

        client.close();
    });

    it("keeps the value across a token refresh for the same user", async () => {
        expect.assertions(2);

        const sockets: MockSocket[] = [];
        const client = createClient(sockets);

        client.setAuthToken("jwt-A", "user-A");
        client.setAuthToken("jwt-A-refreshed", "user-A");
        await settle();

        const screen = mount(client);

        expect(screen.textContent).toBe("A-secret");

        await settle();
        client.setAuthToken("jwt-A-refreshed-again", "user-A");
        await settle();

        expect(screen.textContent).toBe("A-secret");

        client.close();
    });

    it("blanks the value when user B signs in between creation and mount", async () => {
        expect.assertions(1);

        const sockets: MockSocket[] = [];
        const client = createClient(sockets);

        client.setAuthToken("jwt-A", "user-A");

        // Mount callbacks are deferred, so the switch lands after the seed is
        // taken but before the identity listener is registered.
        const { container } = render(
            () => {
                const data = hydratePreloaded(PRELOADED_FOR_A);

                client.setAuthToken("jwt-B", "user-B");

                return (
                    <pre>
                        {data()
                            ?.map((row) => row.text)
                            .join(",") ?? "(none)"}
                    </pre>
                );
            },
            { wrapper: (props) => <LunoraProvider client={client}>{props.children}</LunoraProvider> },
        );

        await settle();
        await refuse(sockets);

        expect(container.textContent).toBe("(none)");

        client.close();
    });
});
