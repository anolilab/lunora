import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import type { AuthClient, AuthResponse } from "../../src/core";
import { AuthUIProvider, SignInCard } from "../../src/react";

const ok = <T,>(data: T = null as T): Promise<AuthResponse<T>> => Promise.resolve({ data, error: null });

const renderCard = (client: AuthClient): { nav: { navigate: ReturnType<typeof vi.fn>; replace: ReturnType<typeof vi.fn> } } => {
    const nav = { navigate: vi.fn(), replace: vi.fn() };

    const tree: ReactElement = (
        <AuthUIProvider authClient={client} nav={nav} redirects={{ afterSignIn: "/app" }}>
            <SignInCard />
        </AuthUIProvider>
    );

    render(tree);

    return { nav };
};

const stubClient = (): AuthClient =>
    ({
        emailOtp: { sendVerificationOtp: vi.fn(() => ok()) },
        forgetPassword: vi.fn(() => ok()),
        resetPassword: vi.fn(() => ok()),
        signIn: {
            email: vi.fn(() => ok({ user: { email: "a@b.co" } })),
            emailOtp: vi.fn(() => ok()),
            magicLink: vi.fn(() => ok()),
            social: vi.fn(() => ok()),
        },
        signUp: { email: vi.fn(() => ok()) },
        twoFactor: { disable: vi.fn(), enable: vi.fn(), verifyOtp: vi.fn(), verifyTotp: vi.fn() },
    }) as unknown as AuthClient;

describe(SignInCard, () => {
    it("renders the sign-in form", () => {
        renderCard(stubClient());

        expect(screen.getByLabelText("Email")).toBeDefined();
        expect(screen.getByLabelText("Password")).toBeDefined();
    });

    it("submits credentials and navigates on success", async () => {
        const client = stubClient();
        const { nav } = renderCard(client);

        fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@b.co" } });
        fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret1234" } });
        fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

        await waitFor(() => {
            expect(client.signIn.email as ReturnType<typeof vi.fn>).toHaveBeenCalled();
            expect(nav.replace).toHaveBeenCalledWith("/app");
        });
    });

    it("shows a validation error for an empty email", async () => {
        renderCard(stubClient());

        fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

        await waitFor(() => {
            expect(screen.getByText("Email is required.")).toBeDefined();
        });
    });
});
