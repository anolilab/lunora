import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import type { AuthClient, AuthResponse } from "../../src/core";
import { AuthUIProvider, AuthView } from "../../src/react";

const ok = <T,>(data: T = null as T): Promise<AuthResponse<T>> => Promise.resolve({ data, error: null });

const renderView = (view?: string, base?: string): void => {
    const nav = { navigate: vi.fn(), replace: vi.fn() };
    const client = {
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
    } as unknown as AuthClient;

    const tree: ReactElement = (
        <AuthUIProvider authClient={client} discover={false} nav={nav} redirects={{ afterSignIn: "/app" }} viewPaths={{ base }}>
            <AuthView view={view} />
        </AuthUIProvider>
    );

    render(tree);
};

/**
 * `AuthView` dispatches the URL segment through a plain object literal, which
 * inherits `Object.prototype`. These segments name inherited members and must
 * still fall back to the sign-in card rather than invoking the inherited
 * member as a route renderer (plan 260).
 */
describe(AuthView, () => {
    it('falls back to sign-in for "valueOf" (pre-fix: throws a TypeError)', () => {
        expect.assertions(1);

        renderView("valueOf");

        expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Sign in");
    });

    it('falls back to sign-in for "constructor" (pre-fix: "Objects are not valid as a React child")', () => {
        expect.assertions(1);

        renderView("constructor");

        expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Sign in");
    });

    it('falls back to sign-in for "toString", and never renders "[object Undefined]" (pre-fix: it is the whole page)', () => {
        expect.assertions(2);

        renderView("toString");

        expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Sign in");
        expect(screen.queryByText("[object Undefined]")).toBeNull();
    });

    it("still renders the sign-up card for a configured segment", () => {
        expect.assertions(1);

        renderView("sign-up");

        expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Create account");
    });

    it("falls back to sign-in for an unrecognized segment", () => {
        expect.assertions(1);

        renderView("definitely-not-a-view");

        expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Sign in");
    });

    it("falls back to sign-in when no segment is given", () => {
        expect.assertions(1);

        renderView();

        expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Sign in");
    });

    /**
     * The mount this component documents. Every link it renders has to stay
     * inside it — the cards used to link to root-level `/sign-up` and
     * `/forgot-password`, which do not exist when the screens live under
     * `/auth/:view`.
     */
    it("keeps its links inside the configured mount", () => {
        expect.assertions(1);

        renderView("sign-in", "/auth");

        expect([...document.querySelectorAll("a")].map((anchor) => anchor.getAttribute("href"))).toStrictEqual(["/auth/forgot-password", "/auth/sign-up"]);
    });
});
