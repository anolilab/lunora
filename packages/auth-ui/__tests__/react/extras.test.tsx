import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthClient } from "../../src/core";
import { pushToast, resetToasts } from "../../src/core";
import { AuthUIProvider, ConsentCard, ErrorToaster, OrganizationLogoCard, ResetPasswordCard, SignUpCard, TwoFactorSetupCard } from "../../src/react";

const stubClient = (): AuthClient => ({ getSession: vi.fn() }) as unknown as AuthClient;

// One cross-suite teardown hook, deliberately at the top level.
afterEach(() => {
    resetToasts();
    // jsdom keeps the URL across tests otherwise, and the reset-password suite
    // below relies on a clean starting point.
    window.history.pushState({}, "", "/");
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

describe("password policy reaches the cards", () => {
    it("renders the configured rules, not the defaults", async () => {
        expect.assertions(2);

        // Regression: the policy config existed and `resolveContext` honoured
        // it, but every provider rebuilt its config field-by-field and dropped
        // the field — so a configured policy was silently unreachable and the
        // checklist always showed the default length rule alone.
        render(
            <AuthUIProvider
                authClient={{ getSession: vi.fn(() => Promise.resolve({ data: null, error: null })) }}
                discover={false}
                nav={{ navigate: vi.fn(), replace: vi.fn() }}
                password={{ minLength: 12, requireUppercase: true }}
            >
                <SignUpCard />
            </AuthUIProvider>,
        );

        fireEvent.change(screen.getByLabelText("Password"), { target: { value: "abc" } });

        await waitFor(() => {
            expect(screen.getByText("At least 12 characters")).toBeDefined();
        });

        expect(screen.getByText("At least one uppercase letter")).toBeDefined();
    });
});

describe("two-factor setup without a password", () => {
    const clientWith = (accounts: unknown[]) =>
        ({
            getSession: vi.fn(() => Promise.resolve({ data: null, error: null })),
            listAccounts: vi.fn(() => Promise.resolve({ data: accounts, error: null })),
            twoFactor: { enable: vi.fn(), verifyTotp: vi.fn() },
        }) as unknown as AuthClient;

    const renderCard = (client: AuthClient) =>
        render(
            <AuthUIProvider authClient={client} discover={false} nav={{ navigate: vi.fn(), replace: vi.fn() }} plugins={{ twoFactor: true }}>
                <TwoFactorSetupCard />
            </AuthUIProvider>,
        );

    it("explains why, rather than vanishing, for an OAuth-only account", async () => {
        expect.assertions(1);

        // A security setting that is simply absent reads as "this app doesn't
        // support 2FA", which sends people looking for a setting that is there.
        renderCard(clientWith([{ id: "a1", providerId: "github" }]));

        await waitFor(() => {
            expect(screen.getByText("Set a password before turning on two-factor authentication.")).toBeDefined();
        });
    });

    it("offers enrolment when a credential row exists", async () => {
        expect.assertions(1);

        renderCard(clientWith([{ id: "a1", providerId: "credential" }]));

        await waitFor(() => {
            expect(screen.queryByText("Set a password before turning on two-factor authentication.")).toBeNull();
        });
    });
});

describe("resetPasswordCard reads the token from the URL", () => {
    const renderCard = (client: AuthClient) =>
        render(
            <AuthUIProvider authClient={client} discover={false} nav={{ navigate: vi.fn(), replace: vi.fn() }}>
                <ResetPasswordCard />
            </AuthUIProvider>,
        );

    it("submits the ?token= from the URL when no prop is passed", async () => {
        expect.assertions(1);

        window.history.pushState({}, "", "/reset-password?token=abc");

        const resetPassword = vi.fn(() => Promise.resolve({ data: {}, error: null }));
        const client = { getSession: vi.fn(), resetPassword } as unknown as AuthClient;

        renderCard(client);

        fireEvent.change(screen.getByLabelText("Password"), { target: { value: "hunter2hunter2" } });
        fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "hunter2hunter2" } });
        fireEvent.click(screen.getByRole("button", { name: "Set new password" }));

        await waitFor(() => {
            expect(resetPassword).toHaveBeenCalledWith(expect.objectContaining({ token: "abc" }));
        });
    });

    it("lets an explicit prop win over the URL", async () => {
        expect.assertions(1);

        window.history.pushState({}, "", "/reset-password?token=from-url");

        const resetPassword = vi.fn(() => Promise.resolve({ data: {}, error: null }));
        const client = { getSession: vi.fn(), resetPassword } as unknown as AuthClient;

        render(
            <AuthUIProvider authClient={client} discover={false} nav={{ navigate: vi.fn(), replace: vi.fn() }}>
                <ResetPasswordCard token="from-prop" />
            </AuthUIProvider>,
        );

        fireEvent.change(screen.getByLabelText("Password"), { target: { value: "hunter2hunter2" } });
        fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "hunter2hunter2" } });
        fireEvent.click(screen.getByRole("button", { name: "Set new password" }));

        await waitFor(() => {
            expect(resetPassword).toHaveBeenCalledWith(expect.objectContaining({ token: "from-prop" }));
        });
    });
});
