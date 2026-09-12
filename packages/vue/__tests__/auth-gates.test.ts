// @vitest-environment jsdom
import { LunoraClient } from "@lunora/client";
import { describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick } from "vue";

import { Authenticated, AuthLoading, Unauthenticated } from "../src/auth-gates";
import { LUNORA_INJECTION_KEY } from "../src/lunora-provider";

/**
 * The auth gates against a REAL `LunoraClient` whose identity endpoint is
 * unreachable — the offline-reload shape, not a stand-in for it. A gate derived
 * from `user !== null` renders `LOADING` here forever; the contract in
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

const renderGates = async (fetchImpl: typeof fetch, token: string | null): Promise<string> => {
    const client = new LunoraClient({ fetch: fetchImpl, url: "https://app.example", WebSocket: DeadSocket as unknown as typeof WebSocket });

    client.setAuthToken(token);

    const root = defineComponent({
        setup() {
            return () => [
                h(Authenticated, null, { default: () => h("span", "AUTHENTICATED") }),
                h(AuthLoading, null, { default: () => h("span", "LOADING") }),
                h(Unauthenticated, null, { default: () => h("span", "SIGNED-OUT") }),
            ];
        },
    });

    const app = createApp(root);

    app.provide(LUNORA_INJECTION_KEY, client);

    const container = document.createElement("div");

    app.mount(container);

    await nextTick();
    await new Promise((resolve) => {
        setTimeout(resolve, 0);
    });
    await nextTick();

    const rendered = container.textContent ?? "";

    app.unmount();
    client.close();

    return rendered;
};

describe("auth gates (Vue)", () => {
    it("renders the authenticated branch for a stored token whose identity endpoint is unreachable", async () => {
        expect.assertions(1);

        const rendered = await renderGates(
            vi.fn<typeof fetch>(async () => {
                throw new TypeError("Failed to fetch");
            }),
            "stored-jwt",
        );

        expect(rendered).toBe("AUTHENTICATED");
    });

    it("renders the signed-out branch when the server answers that there is no session", async () => {
        expect.assertions(1);

        const rendered = await renderGates(
            vi.fn<typeof fetch>(async () => Response.json({}, { status: 401 })),
            "stale-jwt",
        );

        expect(rendered).toBe("SIGNED-OUT");
    });
});
