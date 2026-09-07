import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthClient } from "../../src/core";
import { pushToast, resetToasts } from "../../src/core";
import {
    AuthUIProvider,
    ConsentCard,
    ErrorToaster,
    ForgotPasswordCard,
    OrganizationLogoCard,
    ResetPasswordCard,
    ResetPasswordOtpCard,
    SignUpCard,
    TwoFactorCard,
    TwoFactorSetupCard,
} from "../../src/react";

const stubClient = (): AuthClient => ({ getSession: vi.fn() }) as unknown as AuthClient;

// One cross-suite teardown hook, deliberately at the top level.
afterEach(() => {
    resetToasts();
    // jsdom keeps the URL across tests otherwise, and the reset-password suite
    // below relies on a clean starting point.
    globalThis.history.pushState({}, "", "/");
});

describe("errorToaster", () => {
    it("mounts the aria-live region before any toast arrives, empty", () => {
        expect.assertions(2);

        // Regression: the component returned `null` until the first toast
        // existed, so that toast was pushed before assistive tech was
        // watching the region — a live region only announces changes made
        // AFTER it exists in the accessibility tree, so the first failure
        // went unannounced.
        const { container } = render(<ErrorToaster />);
        const toaster = container.querySelector(".lunora-auth-toaster");

        expect(toaster).not.toBeNull();
        expect(toaster?.getAttribute("aria-live")).toBe("polite");
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

        globalThis.history.pushState({}, "", "/reset-password?token=abc");

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

        globalThis.history.pushState({}, "", "/reset-password?token=from-url");

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

describe("resetPasswordOtpCard", () => {
    it("redeems the emailed code and sets a new password", async () => {
        expect.assertions(1);

        const resetPassword = vi.fn(() => Promise.resolve({ data: {}, error: null }));
        const client = { emailOtp: { resetPassword }, getSession: vi.fn() } as unknown as AuthClient;

        render(
            <AuthUIProvider authClient={client} discover={false} forgotPassword={{ method: "otp" }} nav={{ navigate: vi.fn(), replace: vi.fn() }}>
                <ResetPasswordOtpCard />
            </AuthUIProvider>,
        );

        fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@example.com" } });
        fireEvent.change(screen.getByLabelText("Verification code"), { target: { value: "123456" } });
        fireEvent.change(screen.getByLabelText("Password"), { target: { value: "hunter2hunter2" } });
        fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "hunter2hunter2" } });
        fireEvent.click(screen.getByRole("button", { name: "Set new password" }));

        await waitFor(() => {
            expect(resetPassword).toHaveBeenCalledWith({ email: "ada@example.com", otp: "123456", password: "hunter2hunter2" });
        });
    });
});

describe("twoFactorCard backup-code toggle", () => {
    const renderCard = (client: AuthClient) =>
        render(
            <AuthUIProvider authClient={client} discover={false} nav={{ navigate: vi.fn(), replace: vi.fn() }} plugins={{ twoFactor: true }}>
                <TwoFactorCard />
            </AuthUIProvider>,
        );

    it("switches to the backup-code form and submits it instead of the TOTP one", async () => {
        expect.assertions(2);

        const verifyTotp = vi.fn(() => Promise.resolve({ data: {}, error: null }));
        const verifyBackupCode = vi.fn(() => Promise.resolve({ data: {}, error: null }));
        const client = { getSession: vi.fn(), twoFactor: { verifyBackupCode, verifyTotp } } as unknown as AuthClient;

        renderCard(client);

        fireEvent.click(screen.getByRole("button", { name: "Use a backup code" }));
        fireEvent.change(screen.getByLabelText("Backup code"), { target: { value: "abc-def-ghi" } });
        fireEvent.click(screen.getByRole("button", { name: "Verify" }));

        await waitFor(() => {
            expect(verifyBackupCode).toHaveBeenCalledWith(expect.objectContaining({ code: "abc-def-ghi" }));
        });

        expect(verifyTotp).not.toHaveBeenCalled();
    });

    it("switches back to the authenticator form", async () => {
        expect.assertions(2);

        const verifyTotp = vi.fn(() => Promise.resolve({ data: {}, error: null }));
        const verifyBackupCode = vi.fn(() => Promise.resolve({ data: {}, error: null }));
        const client = { getSession: vi.fn(), twoFactor: { verifyBackupCode, verifyTotp } } as unknown as AuthClient;

        renderCard(client);

        fireEvent.click(screen.getByRole("button", { name: "Use a backup code" }));
        fireEvent.click(screen.getByRole("button", { name: "Use your authenticator app instead" }));

        expect(screen.getByLabelText("Verification code")).toBeDefined();

        fireEvent.change(screen.getByLabelText("Verification code"), { target: { value: "123456" } });
        fireEvent.click(screen.getByRole("button", { name: "Verify" }));

        await waitFor(() => {
            expect(verifyTotp).toHaveBeenCalledWith(expect.objectContaining({ code: "123456" }));
        });
    });
});

describe("in-card links follow viewPaths, not redirects.signIn", () => {
    /*
     * The two are different questions. `redirects.signIn` is "where does a guard
     * send an unauthenticated user", which an app legitimately points at its own
     * gate route carrying a `?returnTo` — following it from a card's own "Back
     * to sign in" would take the user out of the auth screens instead of one
     * card back.
     */
    it("keeps a card's own back-link on the mounted sign-in screen", () => {
        expect.assertions(2);

        render(
            <AuthUIProvider
                authClient={stubClient()}
                discover={false}
                nav={{ navigate: vi.fn(), replace: vi.fn() }}
                redirects={{ signIn: "/gate?returnTo=%2Fapp" }}
                viewPaths={{ base: "/auth" }}
            >
                <ForgotPasswordCard />
            </AuthUIProvider>,
        );

        const link = screen.getByRole("link", { name: "Back to sign in" });

        expect(link.getAttribute("href")).toBe("/auth/sign-in");
        expect(link.getAttribute("href")).not.toBe("/gate?returnTo=%2Fapp");
    });
});
