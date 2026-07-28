/**
 * Svelte port: the OAuth-provider cards. The consent flow itself is covered
 * framework-agnostically in `__tests__/core`; these assert what only the Svelte
 * binding can get wrong — that the request reaches the markup, that Deny still
 * comes before Allow in the rendered DOM, that revoke forwards the row's id, and
 * that both cards stay behind the `oauthProvider` gate.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthClient } from "../../src/core";
import { resetFlowWarnings } from "../../src/core";
import { fakeNav } from "../fake-client";
import OAuthHarness from "./OAuthHarness.svelte";

interface OAuthFake {
    client: AuthClient;
    deleteConsent: ReturnType<typeof vi.fn>;
}

/** A client whose only plugin surface is the one these two cards use. */
const oauthClient = (): OAuthFake => {
    const deleteConsent = vi.fn(() => Promise.resolve({ data: { status: true }, error: null }));
    const client = {
        getSession: vi.fn(),
        oauth2: {
            consent: vi.fn(() => Promise.resolve({ data: { redirectURI: "https://app.example/cb" }, error: null })),
            deleteConsent,
            getConsent: vi.fn(() => Promise.resolve({ data: { clientName: "Acme", scope: "openid email" }, error: null })),
            getConsents: vi.fn(() => Promise.resolve({ data: [{ clientId: "acme.example", clientName: "Acme", id: "c1" }], error: null })),
        },
    } as unknown as AuthClient;

    return { client, deleteConsent };
};

afterEach(() => {
    resetFlowWarnings();
    vi.restoreAllMocks();
});

describe("svelte ConsentCard", () => {
    it("names the application and lists exactly the scopes requested", async () => {
        expect.assertions(3);

        render(OAuthHarness, { props: { authClient: oauthClient().client, card: "consent", consentId: "c1", nav: fakeNav() } });

        await waitFor(() => {
            expect(screen.getByText("Acme")).toBeDefined();
        });

        expect(screen.getByText("Your identity")).toBeDefined();
        expect(screen.getByText("Your email address")).toBeDefined();
    });

    it("offers deny before allow, so the safe answer is reached first", async () => {
        expect.assertions(1);

        render(OAuthHarness, { props: { authClient: oauthClient().client, card: "consent", consentId: "c1", nav: fakeNav() } });

        await waitFor(() => {
            expect(screen.getAllByRole("button").map((button) => button.textContent?.trim())).toStrictEqual(["Deny", "Allow"]);
        });
    });

    it("stays hidden when the oauth-provider flow is off", () => {
        expect.assertions(1);

        vi.spyOn(console, "warn").mockImplementation(() => undefined);
        render(OAuthHarness, { props: { authClient: oauthClient().client, card: "consent", consentId: "c1", nav: fakeNav(), oauthProvider: false } });

        expect(screen.queryByText("Authorize application")).toBeNull();
    });
});

describe("svelte AuthorizedAppsCard", () => {
    it("lists the granted consents and revokes the one whose button was pressed", async () => {
        expect.assertions(2);

        const fake = oauthClient();

        render(OAuthHarness, { props: { authClient: fake.client, card: "authorized-apps", nav: fakeNav() } });

        await waitFor(() => {
            expect(screen.getByText("Acme")).toBeDefined();
        });

        await fireEvent.click(screen.getByRole("button", { name: "Revoke access" }));

        expect(fake.deleteConsent).toHaveBeenCalledWith({ id: "c1" });
    });

    it("stays hidden when the oauth-provider flow is off", () => {
        expect.assertions(1);

        vi.spyOn(console, "warn").mockImplementation(() => undefined);
        render(OAuthHarness, { props: { authClient: oauthClient().client, card: "authorized-apps", nav: fakeNav(), oauthProvider: false } });

        expect(screen.queryByText("Authorized applications")).toBeNull();
    });
});
