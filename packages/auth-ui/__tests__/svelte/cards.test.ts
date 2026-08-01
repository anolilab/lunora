/**
 * Svelte port: the binding layer over the shared controllers. Flow logic is
 * covered framework-agnostically in `__tests__/core`; these assert what only the
 * Svelte layer can get wrong — context wiring, the store seam, the flow gate,
 * and the theme.
 */
import { fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthClient, ThemeTokens } from "../../src/core";
import { pushToast, resetFlowWarnings, resetToasts } from "../../src/core";
import ErrorToaster from "../../src/svelte/ErrorToaster.svelte";
import { bareClient, fakeNav, pluginClient } from "../fake-client";
import Harness from "./Harness.svelte";

afterEach(() => {
    resetFlowWarnings();
    // The toast store is module-level, so a leftover toast would otherwise show
    // up in whichever test renders <ErrorToaster> next.
    resetToasts();
    vi.restoreAllMocks();
    // jsdom keeps the URL across tests otherwise, and the reset-password suite
    // below relies on a clean starting point.
    globalThis.history.pushState({}, "", "/");
});

describe("svelte SignInCard", () => {
    it("renders the fields and submits the typed credentials", async () => {
        expect.assertions(2);

        const fake = bareClient();

        render(Harness, { props: { authClient: fake.client, card: "sign-in", nav: fakeNav() } });

        expect(screen.getByLabelText("Email")).toBeDefined();

        await fireEvent.input(screen.getByLabelText("Email"), { target: { value: "a@b.co" } });
        await fireEvent.input(screen.getByLabelText("Password"), { target: { value: "hunter2hunter2" } });
        await fireEvent.submit(screen.getByRole("button", { name: "Sign in" }));

        expect(fake.signInEmail).toHaveBeenCalledWith(expect.objectContaining({ email: "a@b.co", password: "hunter2hunter2" }));
    });

    it("shows a field error instead of calling the client when a field is empty", async () => {
        expect.assertions(2);

        const fake = bareClient();

        render(Harness, { props: { authClient: fake.client, card: "sign-in", nav: fakeNav() } });

        await fireEvent.submit(screen.getByRole("button", { name: "Sign in" }));

        expect(screen.getByText("Email is required.")).toBeDefined();
        expect(fake.signInEmail).not.toHaveBeenCalled();
    });
});

describe("svelte flow gate", () => {
    it("hides MagicLinkCard when the client has no magic-link plugin", () => {
        expect.assertions(1);

        vi.spyOn(console, "warn").mockImplementation(() => undefined);
        render(Harness, { props: { authClient: bareClient().client, card: "magic-link", nav: fakeNav() } });

        expect(screen.queryByRole("button", { name: "Email me a link" })).toBeNull();
    });

    it("renders MagicLinkCard when the plugin is present on the client", () => {
        expect.assertions(1);

        render(Harness, { props: { authClient: pluginClient().client, card: "magic-link", nav: fakeNav() } });

        expect(screen.getByRole("button", { name: "Email me a link" })).toBeDefined();
    });
});

describe("svelte PasswordStrength", () => {
    it("re-derives the checklist as the password is typed", async () => {
        expect.assertions(4);

        const { container } = render(Harness, { props: { authClient: bareClient().client, card: "sign-up", nav: fakeNav() } });

        // Nothing to show for an empty field.
        expect(container.querySelector(".lunora-auth-strength")).toBeNull();

        await fireEvent.input(screen.getByLabelText("Password"), { target: { value: "short" } });

        const unmet = container.querySelector(".lunora-auth-strength__item") as HTMLElement;

        expect(unmet.className).not.toContain("lunora-auth-strength__item--met");
        expect(unmet.textContent).toContain("At least 8 characters");

        // `$derived`, not a one-time read, so the same node flips to met.
        await fireEvent.input(screen.getByLabelText("Password"), { target: { value: "hunter2hunter2" } });

        expect((container.querySelector(".lunora-auth-strength__item") as HTMLElement).className).toContain("lunora-auth-strength__item--met");
    });
});

describe("svelte theme", () => {
    it("applies only the changed tokens to the card", () => {
        expect.assertions(2);

        const { container } = render(Harness, {
            props: {
                authClient: bareClient().client,
                card: "sign-in",
                nav: fakeNav(),
                theme: (defaults: ThemeTokens) => {
                    return { ...defaults, primary: "rebeccapurple" };
                },
            },
        });

        const card = container.querySelector(".lunora-auth-card") as HTMLElement;

        expect(card.style.getPropertyValue("--primary")).toBe("rebeccapurple");
        expect(card.style.getPropertyValue("--border")).toBe("");
    });
});

describe("svelte ResetPasswordCard reads the token from the URL", () => {
    it("submits the ?token= from the URL when no prop is passed", async () => {
        expect.assertions(1);

        globalThis.history.pushState({}, "", "/reset-password?token=abc");

        const resetPassword = vi.fn(() => Promise.resolve({ data: {}, error: null }));
        const authClient = { getSession: vi.fn(), resetPassword } as unknown as AuthClient;

        render(Harness, { props: { authClient, card: "reset-password", nav: fakeNav() } });

        await fireEvent.input(screen.getByLabelText("Password"), { target: { value: "hunter2hunter2" } });
        await fireEvent.input(screen.getByLabelText("Confirm password"), { target: { value: "hunter2hunter2" } });
        await fireEvent.submit(screen.getByRole("button", { name: "Set new password" }));

        expect(resetPassword).toHaveBeenCalledWith(expect.objectContaining({ token: "abc" }));
    });

    it("lets an explicit prop win over the URL", async () => {
        expect.assertions(1);

        globalThis.history.pushState({}, "", "/reset-password?token=from-url");

        const resetPassword = vi.fn(() => Promise.resolve({ data: {}, error: null }));
        const authClient = { getSession: vi.fn(), resetPassword } as unknown as AuthClient;

        render(Harness, { props: { authClient, card: "reset-password", nav: fakeNav(), token: "from-prop" } });

        await fireEvent.input(screen.getByLabelText("Password"), { target: { value: "hunter2hunter2" } });
        await fireEvent.input(screen.getByLabelText("Confirm password"), { target: { value: "hunter2hunter2" } });
        await fireEvent.submit(screen.getByRole("button", { name: "Set new password" }));

        expect(resetPassword).toHaveBeenCalledWith(expect.objectContaining({ token: "from-prop" }));
    });
});

describe("svelte ErrorToaster", () => {
    it("mounts the aria-live region before any toast arrives, empty", () => {
        expect.assertions(2);

        // Regression: the wrapper was gated on `toasts.length > 0`, so the
        // very first toast was pushed before assistive tech was watching the
        // region — a live region only announces changes made AFTER it exists
        // in the accessibility tree, so that first failure went unannounced.
        const { container } = render(ErrorToaster);
        const toaster = container.querySelector(".lunora-auth-toaster");

        expect(toaster).not.toBeNull();
        expect(toaster?.getAttribute("aria-live")).toBe("polite");
    });

    it("renders a pushed toast and drops it again when dismissed", async () => {
        expect.assertions(3);

        render(ErrorToaster);
        await tick();

        expect(screen.queryByRole("status")).toBeNull();

        pushToast("Could not sign out.");
        await tick();

        expect(screen.getByText("Could not sign out.")).toBeDefined();

        await fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

        expect(screen.queryByText("Could not sign out.")).toBeNull();
    });
});
