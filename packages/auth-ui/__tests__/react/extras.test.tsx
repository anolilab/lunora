import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthClient } from "../../src/core";
import { pushToast, resetToasts } from "../../src/core";
import { AuthUIProvider, ConsentCard, ErrorToaster, OrganizationLogoCard } from "../../src/react";

const stubClient = (): AuthClient => ({ getSession: vi.fn() }) as unknown as AuthClient;

// eslint-disable-next-line vitest/require-top-level-describe -- one cross-suite teardown hook belongs at the top level.
afterEach(() => {
    resetToasts();
});

describe("errorToaster", () => {
    it("renders nothing until something fails", () => {
        expect.assertions(1);

        const { container } = render(<ErrorToaster />);

        expect(container.textContent).toBe("");
    });

    it("shows a pushed message and lets the user dismiss it", () => {
        expect.assertions(2);

        // Pushed before render: the store notifies outside React's act() scope,
        // and an unacted external-store update is exactly the warning-and-stale
        // -render combination this test would otherwise be asserting around.
        pushToast("Could not sign you in.");
        render(<ErrorToaster />);

        expect(screen.getByRole("status").textContent).toContain("Could not sign you in.");

        fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

        expect(screen.queryByRole("status")).toBeNull();
    });
});

describe("organizationLogoCard", () => {
    it("renders nothing without an upload handler, since there is nowhere to put the bytes", () => {
        expect.assertions(1);

        const { container } = render(
            <AuthUIProvider authClient={stubClient()} discover={false} nav={{ navigate: vi.fn(), replace: vi.fn() }} plugins={{ organization: true }}>
                <OrganizationLogoCard />
            </AuthUIProvider>,
        );

        expect(container.textContent).toBe("");
    });
});

describe("consentCard", () => {
    const consentClient = (overrides: Record<string, unknown> = {}): AuthClient =>
        ({
            getSession: vi.fn(),
            oauth2: {
                consent: vi.fn(() => Promise.resolve({ data: { redirectURI: "https://app.example/cb" }, error: null })),
                getConsent: vi.fn(() => Promise.resolve({ data: { clientName: "Acme", scope: "openid email" }, error: null })),
                ...overrides,
            },
        }) as unknown as AuthClient;

    it("names the application and lists exactly the scopes requested", async () => {
        expect.assertions(3);

        render(
            <AuthUIProvider authClient={consentClient()} discover={false} nav={{ navigate: vi.fn(), replace: vi.fn() }} plugins={{ oauthProvider: true }}>
                <ConsentCard consentId="c1" />
            </AuthUIProvider>,
        );

        await waitFor(() => {
            expect(screen.getByText("Acme")).toBeDefined();
        });

        expect(screen.getByText("Your identity")).toBeDefined();
        expect(screen.getByText("Your email address")).toBeDefined();
    });

    it("offers deny before allow, so the safe answer is reached first", async () => {
        expect.assertions(1);

        render(
            <AuthUIProvider authClient={consentClient()} discover={false} nav={{ navigate: vi.fn(), replace: vi.fn() }} plugins={{ oauthProvider: true }}>
                <ConsentCard consentId="c1" />
            </AuthUIProvider>,
        );

        await waitFor(() => {
            expect(screen.getAllByRole("button").map((button) => button.textContent)).toStrictEqual(["Deny", "Allow"]);
        });
    });
});
