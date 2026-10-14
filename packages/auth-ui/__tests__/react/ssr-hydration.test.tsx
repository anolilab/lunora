/**
 * The two cards that act on a URL parameter at construction must render the
 * same markup on the server as the hydrating client does.
 *
 * A server has no `location`, so the parameter reads as absent there. Acting on
 * that answer — "no token", "no invitation id" — paints the *failure* state into
 * the SSR HTML, while the client (which does have the parameter) paints the
 * pending state. React 19 recovers from the mismatch by throwing the server tree
 * away, so the user sees an error banner flash on every verification link.
 *
 * Both cards therefore wait for a browser before consuming the parameter, and
 * the server renders the pending state.
 */
import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { AuthClient } from "../../src/core";
import { registerAuthClientPlugins } from "../../src/core";
import { AcceptInvitationCard, AuthUIProvider, VerifyEmailCard } from "../../src/react";
import { fakeNav } from "../fake-client";

/** Nothing settles, so every render below is the first paint. */
const pending = new Promise<never>(() => {});

const ssrClient = (): AuthClient => {
    const client = {
        getSession: () => pending,
        organization: { getInvitation: () => pending },
        verifyEmail: () => pending,
    } as unknown as AuthClient;

    registerAuthClientPlugins(client, { organization: true });

    return client;
};

const tree = (card: ReactElement): ReactElement => (
    <AuthUIProvider authClient={ssrClient()} discover={false} nav={fakeNav()}>
        {card}
    </AuthUIProvider>
);

/** Render with no `location` at all — what a server render actually sees. */
const onServer = (element: ReactElement): string => {
    vi.stubGlobal("location", undefined);

    try {
        return renderToString(element);
    } finally {
        vi.unstubAllGlobals();
    }
};

/** Render with the link's query string in place — what the client sees. */
const onClient = (element: ReactElement, search: string): string => {
    globalThis.history.replaceState(null, "", search);

    return renderToString(element);
};

describe("server markup matches the hydrating client", () => {
    it("verify-email renders the pending note on the server, not the no-token error", () => {
        const server = onServer(tree(<VerifyEmailCard />));

        expect(server).not.toContain("lunora-auth-banner--error");
        expect(server).toContain("Verifying your email");
        expect(server).toBe(onClient(tree(<VerifyEmailCard />), "/auth/verify-email?token=abc"));
    });

    it("accept-invitation renders the skeleton on the server, not the missing-invitation error", () => {
        const server = onServer(tree(<AcceptInvitationCard />));

        expect(server).not.toContain("lunora-auth-banner--error");
        expect(server).toContain("lunora-auth-skeleton");
        expect(server).toBe(onClient(tree(<AcceptInvitationCard />), "/auth/accept-invitation?invitationId=inv_1"));
    });
});
