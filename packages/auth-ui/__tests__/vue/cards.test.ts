/**
 * Vue port: the binding layer over the shared controllers. The flow logic is
 * covered framework-agnostically in `__tests__/core`; these assert the parts
 * only the Vue layer can get wrong — provide/inject wiring, event binding, the
 * flow gate, and the theme.
 */
import { fireEvent, render, screen } from "@testing-library/vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h } from "vue";

import type { ThemeTokens } from "../../src/core";
import { resetFlowWarnings } from "../../src/core";
import AuthUIProvider from "../../src/vue/AuthUIProvider.vue";
import MagicLinkCard from "../../src/vue/MagicLinkCard.vue";
import SignInCard from "../../src/vue/SignInCard.vue";
import type { FakeClient } from "../fake-client";
import { bareClient, fakeNav, pluginClient } from "../fake-client";

const renderInProvider = (component: unknown, fake: FakeClient, extra: Record<string, unknown> = {}): void => {
    render(
        defineComponent({
            render: () => h(AuthUIProvider, { authClient: fake.client, nav: fakeNav(), ...extra }, { default: () => h(component as never) }),
        }),
    );
};

afterEach(() => {
    resetFlowWarnings();
    vi.restoreAllMocks();
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
                            theme: (defaults: ThemeTokens) => ({ ...defaults, primary: "rebeccapurple" }),
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
