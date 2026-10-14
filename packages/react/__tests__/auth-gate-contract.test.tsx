import { LunoraClient } from "@lunora/client";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { Authenticated, AuthLoading, Unauthenticated } from "../src/auth-gates";
import { LunoraProvider } from "../src/lunora-provider";
import useAuth from "../src/use-auth";

/**
 * The auth gates against a REAL `LunoraClient` whose identity endpoint is
 * unreachable — the offline-reload shape, not a stand-in for it.
 *
 * React's gate always followed the credential, so it already rendered here; what
 * it could NOT do was tell a caller why `user` was `null`, so any `user`-branching
 * UI read signed out. `status` is that answer, and it is the same one the other
 * four adapters now gate on.
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

const Probe = (): ReactElement => {
    const { status, user } = useAuth();

    return <div data-testid="probe">{`${status}|${JSON.stringify(user)}`}</div>;
};

const mountGates = (fetchImpl: typeof fetch, token: string | null): LunoraClient => {
    const client = new LunoraClient({ fetch: fetchImpl, url: "https://app.example", WebSocket: DeadSocket as unknown as typeof WebSocket });

    client.setAuthToken(token);

    render(
        <LunoraProvider client={client}>
            <Authenticated>
                <span data-testid="gate">AUTHENTICATED</span>
            </Authenticated>
            <AuthLoading>
                <span data-testid="gate">LOADING</span>
            </AuthLoading>
            <Unauthenticated>
                <span data-testid="gate">SIGNED-OUT</span>
            </Unauthenticated>
            <Probe />
        </LunoraProvider>,
    );

    return client;
};

describe("auth gate contract (React)", () => {
    it("stays authenticated and reports 'unreachable' for a stored token whose identity endpoint is down", async () => {
        expect.hasAssertions();

        const client = mountGates(
            vi.fn<typeof fetch>(async () => {
                throw new TypeError("Failed to fetch");
            }),
            "stored-jwt",
        );

        await waitFor(() => {
            expect(screen.getByTestId("probe").textContent).toBe("unreachable|null");
        });

        // `user` is null, but the UI is told why — signed out is a different answer.
        expect(screen.getByTestId("gate").textContent).toBe("AUTHENTICATED");

        client.close();
    });

    it("renders the signed-out branch when the server answers that there is no session", async () => {
        expect.hasAssertions();

        const client = mountGates(
            vi.fn<typeof fetch>(async () => Response.json({}, { status: 401 })),
            "stale-jwt",
        );

        await waitFor(() => {
            expect(screen.getByTestId("probe").textContent).toBe("unauthenticated|null");
        });

        expect(screen.getByTestId("gate").textContent).toBe("SIGNED-OUT");

        client.close();
    });
});
