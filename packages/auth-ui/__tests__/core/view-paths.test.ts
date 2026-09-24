/**
 * `<AuthView>` documents mounting at `/auth/:view`, and every route between the
 * screens used to be spelled independently of that: the cards linked to
 * `/sign-up` and `/forgot-password`, `redirects.twoFactor` defaulted to
 * `/two-factor`, and `ForgotPasswordCard` mailed a link to `/reset-password`.
 * On the documented mount none of those exist — a correct password with 2FA on
 * landed on a 404.
 *
 * `viewPaths.base` is now the one place that answers "where do the auth screens
 * live", and everything else derives from it.
 */
import { describe, expect, it, vi } from "vitest";

import type { AuthClient, AuthResponse } from "../../src/core";
import { createForgotPasswordController, createSignInController, resolveContext, viewHref } from "../../src/core";

const ok = <T>(data: T = null as T): Promise<AuthResponse<T>> => Promise.resolve({ data, error: null });

const stubClient = (): AuthClient =>
    ({
        forgetPassword: vi.fn(() => ok({ status: true })),
        signIn: { email: vi.fn(() => ok({ twoFactorRedirect: true })) },
    }) as unknown as AuthClient;

const contextFor = (
    base?: string,
    redirects?: { signIn?: string; twoFactor?: string },
): { client: AuthClient; context: ReturnType<typeof resolveContext>; nav: { navigate: ReturnType<typeof vi.fn>; replace: ReturnType<typeof vi.fn> } } => {
    const client = stubClient();
    const nav = { navigate: vi.fn(), replace: vi.fn() };

    return { client, context: resolveContext({ authClient: client, nav, redirects, viewPaths: { base } }), nav };
};

describe("viewPaths.base", () => {
    it("defaults to root-level routes", () => {
        const { context } = contextFor();

        expect(context.viewPaths.base).toBe("");
        expect(viewHref(context, "signUp")).toBe("/sign-up");
        expect(viewHref(context, "forgotPassword")).toBe("/forgot-password");
        expect(context.redirects.signIn).toBe("/sign-in");
        expect(context.redirects.twoFactor).toBe("/two-factor");
    });

    it("moves every derived route under the mount", () => {
        const { context } = contextFor("/auth");

        expect(viewHref(context, "signUp")).toBe("/auth/sign-up");
        expect(viewHref(context, "forgotPassword")).toBe("/auth/forgot-password");
        expect(viewHref(context, "resetPassword")).toBe("/auth/reset-password");
        expect(context.redirects.signIn).toBe("/auth/sign-in");
        expect(context.redirects.twoFactor).toBe("/auth/two-factor");
    });

    it("normalizes a base written without a leading slash or with a trailing one", () => {
        expect(contextFor("auth/").context.redirects.signIn).toBe("/auth/sign-in");
    });

    it("keeps renamed segments in the derived routes", () => {
        const client = stubClient();
        const context = resolveContext({
            authClient: client,
            nav: { navigate: vi.fn(), replace: vi.fn() },
            viewPaths: { base: "/auth", twoFactor: "mfa" },
        });

        expect(context.redirects.twoFactor).toBe("/auth/mfa");
    });

    it("lets an explicit redirect win over the derived one", () => {
        const { context } = contextFor("/auth", { twoFactor: "/challenge" });

        expect(context.redirects.twoFactor).toBe("/challenge");
    });

    it("sends a two-factor sign-in to the mounted route", async () => {
        const { client, context, nav } = contextFor("/auth");
        const controller = createSignInController(context);

        controller.actions.setField("email", "a@b.co");
        controller.actions.setField("password", "hunter222");
        await controller.actions.submit();

        expect(client.signIn.email as ReturnType<typeof vi.fn>).toHaveBeenCalled();
        expect(nav.replace).toHaveBeenCalledWith("/auth/two-factor");
    });

    it("mails a reset link that resolves under the mount", async () => {
        const { client, context } = contextFor("/auth");
        const controller = createForgotPasswordController(context);

        controller.actions.setField("email", "a@b.co");
        await controller.actions.submit();

        expect(client.forgetPassword as ReturnType<typeof vi.fn>).toHaveBeenCalledWith({ email: "a@b.co", redirectTo: "/auth/reset-password" });
    });
});
