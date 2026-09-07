/**
 * The Vue half of the invariant `__tests__/react/ssr-hydration.test.tsx` pins:
 * the two cards that act on a URL parameter at construction must render the same
 * markup on the server as the hydrating client does.
 *
 * The guard itself (`isBrowser`) lives in `core/` and serves every port, so the
 * decision is shared — but "does this port render the pending branch on the
 * server" is a per-port question, and Vue is the second port that can answer it
 * cheaply: `vue/server-renderer` runs against the same components these tests
 * already mount. Svelte and Solid both need their components recompiled in SSR
 * mode — a second vitest project with its own plugin configuration each — and
 * Angular has no compiler in this package at all, so those three are covered by
 * the core guard and their own render tests.
 */
import { describe, expect, it, vi } from "vitest";
import type { Component } from "vue";
import { createSSRApp, defineComponent, h } from "vue";
import { renderToString } from "vue/server-renderer";

import type { AuthClient } from "../../src/core";
import { registerAuthClientPlugins } from "../../src/core";
import AcceptInvitationCard from "../../src/vue/AcceptInvitationCard.vue";
import AuthUIProvider from "../../src/vue/AuthUIProvider.vue";
import VerifyEmailCard from "../../src/vue/VerifyEmailCard.vue";
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

const tree = (card: Component): Component =>
    defineComponent({
        render: () => h(AuthUIProvider, { authClient: ssrClient(), discover: false, nav: fakeNav() }, { default: () => h(card) }),
    });

/** Render with no `location` at all — what a server render actually sees. */
const onServer = async (card: Component): Promise<string> => {
    vi.stubGlobal("location", undefined);

    try {
        return await renderToString(createSSRApp(tree(card)));
    } finally {
        vi.unstubAllGlobals();
    }
};

/** Render with the link's query string in place — what the client sees. */
const onClient = async (card: Component, search: string): Promise<string> => {
    globalThis.history.replaceState(null, "", search);

    return renderToString(createSSRApp(tree(card)));
};

describe("server markup matches the hydrating client", () => {
    it("verify-email renders the pending note on the server, not the no-token error", async () => {
        expect.assertions(3);

        const server = await onServer(VerifyEmailCard);

        expect(server).not.toContain("lunora-auth-banner--error");
        expect(server).toContain("Verifying your email");
        expect(server).toBe(await onClient(VerifyEmailCard, "/auth/verify-email?token=abc"));
    });

    it("accept-invitation renders the skeleton on the server, not the missing-invitation error", async () => {
        expect.assertions(3);

        const server = await onServer(AcceptInvitationCard);

        expect(server).not.toContain("lunora-auth-banner--error");
        expect(server).toContain("lunora-auth-skeleton");
        expect(server).toBe(await onClient(AcceptInvitationCard, "/auth/accept-invitation?invitationId=inv_1"));
    });
});
