/**
 * Vue port: the binding layer over the shared controllers. The flow logic is
 * covered framework-agnostically in `__tests__/core`; these assert the parts
 * only the Vue layer can get wrong — provide/inject wiring, event binding, the
 * flow gate, and the theme.
 */
import { fireEvent, render, screen } from "@testing-library/vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h } from "vue";

import type { AuthClient, ThemeTokens } from "../../src/core";
import { resetFlowWarnings } from "../../src/core";
import AuthUIProvider from "../../src/vue/AuthUIProvider.vue";
import MagicLinkCard from "../../src/vue/MagicLinkCard.vue";
import ResetPasswordCard from "../../src/vue/ResetPasswordCard.vue";
import ResetPasswordOtpCard from "../../src/vue/ResetPasswordOtpCard.vue";
import SignInCard from "../../src/vue/SignInCard.vue";
import SignUpCard from "../../src/vue/SignUpCard.vue";
import type { FakeClient } from "../fake-client";
import { bareClient, fakeNav, pluginClient } from "../fake-client";

const renderInProvider = (component: unknown, fake: FakeClient, extra: Record<string, unknown> = {}, componentProps: Record<string, unknown> = {}): void => {
    render(
        defineComponent({
            render: () => h(AuthUIProvider, { authClient: fake.client, nav: fakeNav(), ...extra }, { default: () => h(component as never, componentProps) }),
        }),
    );
};

afterEach(() => {
    resetFlowWarnings();
    vi.restoreAllMocks();
    // jsdom keeps the URL across tests otherwise, and the reset-password suite
    // below relies on a clean starting point.
    window.history.pushState({}, "", "/");
});

describe("vue SignInCard", () => {
    it("renders the fields and submits the typed credentials", async () => {
        expect.assertions(2);

        const fake = bareClient();

        renderInProvider(SignInCard, fake);

        expect(screen.getByLabelText("Email")).toBeDefined();

        await fireEvent.update(screen.getByLabelText("Email"), "a@b.co");
        await fireEvent.update(screen.getByLabelText("Password"), "hunter2hunter2");
        await fireEvent.submit(screen.getByRole("button", { name: "Sign in" }));

        expect(fake.signInEmail).toHaveBeenCalledWith(expect.objectContaining({ email: "a@b.co", password: "hunter2hunter2" }));
    });

    it("shows a field error instead of calling the client when a field is empty", async () => {
        expect.assertions(2);

        const fake = bareClient();

        renderInProvider(SignInCard, fake);

        await fireEvent.submit(screen.getByRole("button", { name: "Sign in" }));

        expect(screen.getByText("Email is required.")).toBeDefined();
        expect(fake.signInEmail).not.toHaveBeenCalled();
    });
});

describe("vue flow gate", () => {
    it("hides MagicLinkCard when the client has no magic-link plugin", () => {
        expect.assertions(1);

        vi.spyOn(console, "warn").mockImplementation(() => undefined);
        renderInProvider(MagicLinkCard, bareClient());

        expect(screen.queryByRole("button", { name: "Email me a link" })).toBeNull();
    });

    it("renders MagicLinkCard when the plugin is present on the client", () => {
        expect.assertions(1);

        renderInProvider(MagicLinkCard, pluginClient());

        expect(screen.getByRole("button", { name: "Email me a link" })).toBeDefined();
    });
});

describe("vue PasswordStrength", () => {
    it("re-derives the checklist as the password is typed", async () => {
        expect.assertions(4);

        renderInProvider(SignUpCard, bareClient());

        // Nothing to show for an empty field.
        expect(document.querySelector(".lunora-auth-strength")).toBeNull();

        await fireEvent.update(screen.getByLabelText("Password"), "short");

        const unmet = document.querySelector(".lunora-auth-strength__item") as HTMLElement;

        expect(unmet.className).not.toContain("lunora-auth-strength__item--met");
        expect(unmet.textContent).toContain("At least 8 characters");

        // The prop is a `computed`, not a setup-time snapshot, so the same node
        // flips to met without a remount.
        await fireEvent.update(screen.getByLabelText("Password"), "hunter2hunter2");

        expect((document.querySelector(".lunora-auth-strength__item") as HTMLElement).className).toContain("lunora-auth-strength__item--met");
    });
});

describe("vue theme", () => {
    it("applies only the changed tokens to the card", () => {
        expect.assertions(2);

        const { container } = render(
            defineComponent({
                render: () =>
                    h(
                        AuthUIProvider,
                        {
                            authClient: bareClient().client,
                            nav: fakeNav(),
                            theme: (defaults: ThemeTokens) => {
                                return { ...defaults, primary: "rebeccapurple" };
                            },
                        },
                        { default: () => h(SignInCard) },
                    ),
            }),
        );

        const card = container.querySelector(".lunora-auth-card") as HTMLElement;

        expect(card.style.getPropertyValue("--primary")).toBe("rebeccapurple");
        expect(card.style.getPropertyValue("--border")).toBe("");
    });
});

describe("vue ResetPasswordCard reads the token from the URL", () => {
    it("submits the ?token= from the URL when no prop is passed", async () => {
        expect.assertions(1);

        window.history.pushState({}, "", "/reset-password?token=abc");

        const resetPassword = vi.fn(() => Promise.resolve({ data: {}, error: null }));
        const fake = { client: { getSession: vi.fn(), resetPassword } as unknown as AuthClient, signInEmail: vi.fn() };

        renderInProvider(ResetPasswordCard, fake);

        await fireEvent.update(screen.getByLabelText("Password"), "hunter2hunter2");
        await fireEvent.update(screen.getByLabelText("Confirm password"), "hunter2hunter2");
        await fireEvent.submit(screen.getByRole("button", { name: "Set new password" }));

        expect(resetPassword).toHaveBeenCalledWith(expect.objectContaining({ token: "abc" }));
    });

    it("lets an explicit prop win over the URL", async () => {
        expect.assertions(1);

        window.history.pushState({}, "", "/reset-password?token=from-url");

        const resetPassword = vi.fn(() => Promise.resolve({ data: {}, error: null }));
        const fake = { client: { getSession: vi.fn(), resetPassword } as unknown as AuthClient, signInEmail: vi.fn() };

        renderInProvider(ResetPasswordCard, fake, {}, { token: "from-prop" });

        await fireEvent.update(screen.getByLabelText("Password"), "hunter2hunter2");
        await fireEvent.update(screen.getByLabelText("Confirm password"), "hunter2hunter2");
        await fireEvent.submit(screen.getByRole("button", { name: "Set new password" }));

        expect(resetPassword).toHaveBeenCalledWith(expect.objectContaining({ token: "from-prop" }));
    });
});

describe("vue ResetPasswordOtpCard", () => {
    it("redeems the emailed code and sets a new password", async () => {
        expect.assertions(1);

        const resetPassword = vi.fn(() => Promise.resolve({ data: {}, error: null }));
        const fake = { client: { emailOtp: { resetPassword }, getSession: vi.fn() } as unknown as AuthClient, signInEmail: vi.fn() };

        renderInProvider(ResetPasswordOtpCard, fake, { discover: false, forgotPassword: { method: "otp" } });

        await fireEvent.update(screen.getByLabelText("Email"), "ada@example.com");
        await fireEvent.update(screen.getByLabelText("Verification code"), "123456");
        await fireEvent.update(screen.getByLabelText("Password"), "hunter2hunter2");
        await fireEvent.update(screen.getByLabelText("Confirm password"), "hunter2hunter2");
        await fireEvent.submit(screen.getByRole("button", { name: "Set new password" }));

        expect(resetPassword).toHaveBeenCalledWith({ email: "ada@example.com", otp: "123456", password: "hunter2hunter2" });
    });
});
