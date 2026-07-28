/**
 * The extras have no form flow to exercise, so what is worth asserting here is
 * what only the Vue binding can get wrong: that the module-level toast store
 * reaches a mounted component, that the captcha widget is rendered after the
 * host element exists and torn down again on unmount, and that One Tap fires
 * exactly once.
 */
import { fireEvent, render, screen } from "@testing-library/vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h } from "vue";

import * as captchaModule from "../../src/core/captcha";
import * as oneTapModule from "../../src/core/one-tap";
import { pushToast, resetToasts } from "../../src/core/toast";
import AuthUIProvider from "../../src/vue/AuthUIProvider.vue";
import Captcha from "../../src/vue/Captcha.vue";
import ErrorToaster from "../../src/vue/ErrorToaster.vue";
import OneTap from "../../src/vue/OneTap.vue";
import OrganizationLogoCard from "../../src/vue/OrganizationLogoCard.vue";
import { fakeNav, pluginClient } from "../fake-client";

// The toast store is module-level, so a leftover toast would surface in a
// sibling suite rather than here.
afterEach(() => {
    resetToasts();
    vi.restoreAllMocks();
});

describe("vue ErrorToaster", () => {
    it("renders nothing until a toast is pushed", () => {
        expect.assertions(1);

        const { container } = render(ErrorToaster);

        expect(container.querySelector(".lunora-auth-toaster")).toBeNull();
    });

    it("renders a pushed toast and drops it again when dismissed", async () => {
        expect.assertions(2);

        render(ErrorToaster);
        pushToast("Could not sign in with GitHub.");
        // Wait a tick: the store push lands in a `shallowRef`, and Vue patches
        // the DOM on the next microtask.
        await Promise.resolve();

        expect(screen.getByRole("status").textContent).toContain("Could not sign in with GitHub.");

        await fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

        expect(screen.queryByRole("status")).toBeNull();
    });
});

describe("vue extras", () => {
    it("renders the captcha host, prompts One Tap once, and tears the widget down on unmount", async () => {
        expect.assertions(6);

        const teardown = vi.fn();
        const renderSpy = vi.spyOn(captchaModule, "renderCaptcha").mockReturnValue(teardown);
        const promptSpy = vi.spyOn(oneTapModule, "promptOneTap").mockResolvedValue(undefined);
        const fake = pluginClient();

        // eslint-disable-next-line vitest/unbound-method, @typescript-eslint/unbound-method -- `render` from @testing-library/vue is a free function, not a method needing `this`.
        const { container, unmount } = render(
            defineComponent({
                render: () =>
                    h(
                        AuthUIProvider,
                        {
                            authClient: fake.client,
                            avatar: { upload: async () => "https://example.test/logo.png" },
                            nav: fakeNav(),
                            plugins: { oneTap: true, organization: true },
                        },
                        { default: () => [h(OneTap), h(Captcha, { provider: "hcaptcha", siteKey: "abc" }), h(OrganizationLogoCard)] },
                    ),
            }),
        );

        await Promise.resolve();

        expect(container.querySelector(".lunora-auth-captcha")).not.toBeNull();
        expect(renderSpy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ provider: "hcaptcha", siteKey: "abc" }));
        expect(promptSpy).toHaveBeenCalledTimes(1);
        expect(screen.getByLabelText("Upload photo")).toBeDefined();
        expect(screen.getByRole("button", { name: "Upload photo" })).toBeDefined();

        unmount();

        expect(teardown).toHaveBeenCalledTimes(1);
    });

    it("renders no captcha host without a site key", () => {
        expect.assertions(1);

        const fake = pluginClient();

        const { container } = render(
            defineComponent({
                render: () => h(AuthUIProvider, { authClient: fake.client, nav: fakeNav() }, { default: () => h(Captcha, { provider: "hcaptcha" }) }),
            }),
        );

        expect(container.querySelector(".lunora-auth-captcha")).toBeNull();
    });
});
