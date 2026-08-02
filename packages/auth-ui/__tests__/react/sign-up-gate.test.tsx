import { render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resetAuthConfigDiscovery } from "../../src/core";
import { AuthUIProvider, AuthView, SignInCard, SignUpCard } from "../../src/react";
import { bareClient, fakeNav } from "../fake-client";

/** Stub `GET {basePath}/ui-config` reporting `signUp: false` — the server closed self-serve sign-up. */
const stubSignUpClosed = (): void => {
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
            return {
                json: async () => {
                    return {
                        emailAndPassword: true,
                        organization: { allowUserToCreate: true, enabled: false, roles: false, teams: false },
                        plugins: [],
                        signUp: false,
                        socialProviders: [],
                    };
                },
                ok: true,
            };
        }),
    );
};

afterEach(() => {
    resetAuthConfigDiscovery();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

const renderInProvider = (children: ReactElement): void => {
    const { client } = bareClient();

    render(
        <AuthUIProvider authClient={client} nav={fakeNav()} redirects={{ afterSignIn: "/app" }}>
            {children}
        </AuthUIProvider>,
    );
};

/**
 * With self-serve sign-up closed on the server (`emailAndPassword.disableSignUp`),
 * `SignUpCard` still rendered a full form, `AuthView` still routed `/auth/sign-up`
 * to it, and `SignInCard`'s footer still advertised the link — `signUp` was
 * resolved onto `ControllerContext` but nothing read it (plan 278).
 */
describe("signUp gate", () => {
    it("signUpCard renders no form when signUp is closed", async () => {
        stubSignUpClosed();
        renderInProvider(<SignUpCard />);

        await waitFor(() => {
            // SignUpCard renders nothing when gated, so no heading of any kind
            // is left on the page — the card's usual title is "Create account".
            expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
        });
    });

    it('authView view="sign-up" falls back to the sign-in card when signUp is closed', async () => {
        stubSignUpClosed();
        renderInProvider(<AuthView view="sign-up" />);

        await waitFor(() => {
            expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Sign in");
        });
    });

    it("signInCard hides the sign-up footer link when signUp is closed", async () => {
        stubSignUpClosed();
        renderInProvider(<SignInCard />);

        await waitFor(() => {
            expect(screen.queryByText("Don't have an account?", { exact: false })).toBeNull();
        });
    });
});
