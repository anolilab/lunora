/**
 * Svelte port: the binding layer over the shared controllers. Flow logic is
 * covered framework-agnostically in `__tests__/core`; these assert what only the
 * Svelte layer can get wrong — context wiring, the store seam, the flow gate,
 * and the theme.
 */
import { fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ThemeTokens } from "../../src/core";
import { resetFlowWarnings } from "../../src/core";
import { bareClient, fakeNav, pluginClient } from "../fake-client";
import Harness from "./Harness.svelte";

afterEach(() => {
    resetFlowWarnings();
    vi.restoreAllMocks();
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

describe("svelte theme", () => {
    it("applies only the changed tokens to the card", () => {
        expect.assertions(2);

        const { container } = render(Harness, {
            props: {
                authClient: bareClient().client,
                card: "sign-in",
                nav: fakeNav(),
                theme: (defaults: ThemeTokens) => ({ ...defaults, primary: "rebeccapurple" }),
            },
        });

        const card = container.querySelector(".lunora-auth-card") as HTMLElement;

        expect(card.style.getPropertyValue("--primary")).toBe("rebeccapurple");
        expect(card.style.getPropertyValue("--border")).toBe("");
    });
});
