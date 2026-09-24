import { LunoraClient } from "@lunora/client";
import { render } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";

import { Authenticated, AuthLoading, Unauthenticated } from "../src/create-auth";
import { LunoraProvider } from "../src/lunora-provider";

/**
 * The auth gates against a REAL `LunoraClient` whose identity endpoint is
 * unreachable — the offline-reload shape, not a stand-in for it. A gate derived
 * from `user() !== null` renders `LOADING` here forever; the contract in
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

const settle = async (): Promise<void> => {
    await new Promise((resolve) => {
        setTimeout(resolve, 0);
    });
};

const renderGates = async (fetchImpl: typeof fetch, token: string | null): Promise<string> => {
    const client = new LunoraClient({ fetch: fetchImpl, url: "https://app.example", WebSocket: DeadSocket as unknown as typeof WebSocket });

    client.setAuthToken(token);

    const { container } = render(
        () => (
            <>
                <Authenticated>AUTHENTICATED</Authenticated>
                <AuthLoading>LOADING</AuthLoading>
                <Unauthenticated>SIGNED-OUT</Unauthenticated>
            </>
        ),
        { wrapper: (props) => <LunoraProvider client={client}>{props.children}</LunoraProvider> },
    );

    await settle();

    const rendered = container.textContent ?? "";

    client.close();

    return rendered;
};

describe("auth gate contract (Solid)", () => {
    it("renders the authenticated branch for a stored token whose identity endpoint is unreachable", async () => {
        expect.hasAssertions();

        const rendered = await renderGates(
            vi.fn<typeof fetch>(async () => {
                throw new TypeError("Failed to fetch");
            }),
            "stored-jwt",
        );

        expect(rendered).toBe("AUTHENTICATED");
    });

    it("renders the signed-out branch when the server answers that there is no session", async () => {
        expect.hasAssertions();

        const rendered = await renderGates(
            vi.fn<typeof fetch>(async () => Response.json({}, { status: 401 })),
            "stale-jwt",
        );

        expect(rendered).toBe("SIGNED-OUT");
    });
});
