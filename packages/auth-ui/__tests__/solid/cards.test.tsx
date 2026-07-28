/**
 * Solid port: the binding layer over the shared controllers. Flow logic is
 * covered framework-agnostically in `__tests__/core`; these assert what only the
 * Solid layer can get wrong — context wiring, the store seam, the flow gate,
 * and the theme.
 */
import { fireEvent, render, screen } from "@solidjs/testing-library";
import type { JSX } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthUIConfig } from "../../src/core";
import { resetFlowWarnings } from "../../src/core";
import { MagicLinkCard, SignInCard, SignUpCard } from "../../src/solid";
import { AuthUIProvider } from "../../src/solid/provider";
import { bareClient, fakeNav, pluginClient } from "../fake-client";

const renderCard = (card: () => JSX.Element, authClient: AuthUIConfig["authClient"], theme?: AuthUIConfig["theme"]): ReturnType<typeof render> =>
    render(() => (
        <AuthUIProvider authClient={authClient} nav={fakeNav()} theme={theme}>
            {card()}
        </AuthUIProvider>
    ));

afterEach(() => {
    resetFlowWarnings();
    vi.restoreAllMocks();
});

describe("solid SignInCard", () => {
    it("renders the fields and submits the typed credentials", () => {
        expect.assertions(2);

        const fake = bareClient();

        renderCard(() => <SignInCard />, fake.client);

        expect(screen.getByLabelText("Email")).toBeDefined();

        fireEvent.input(screen.getByLabelText("Email"), { target: { value: "a@b.co" } });
        fireEvent.input(screen.getByLabelText("Password"), { target: { value: "hunter2hunter2" } });
        fireEvent.submit(screen.getByRole("button", { name: "Sign in" }));

        expect(fake.signInEmail).toHaveBeenCalledWith(expect.objectContaining({ email: "a@b.co", password: "hunter2hunter2" }));
    });

    it("shows a field error instead of calling the client when a field is empty", () => {
        expect.assertions(2);

        const fake = bareClient();

        renderCard(() => <SignInCard />, fake.client);
        fireEvent.submit(screen.getByRole("button", { name: "Sign in" }));

        expect(screen.getByText("Email is required.")).toBeDefined();
        expect(fake.signInEmail).not.toHaveBeenCalled();
    });
});

describe("solid flow gate", () => {
    it("hides MagicLinkCard when the client has no magic-link plugin", () => {
        expect.assertions(1);

        vi.spyOn(console, "warn").mockImplementation(() => undefined);
        renderCard(() => <MagicLinkCard />, bareClient().client);

        expect(screen.queryByRole("button", { name: "Email me a link" })).toBeNull();
    });

    it("renders MagicLinkCard when the plugin is present on the client", () => {
        expect.assertions(1);

        renderCard(() => <MagicLinkCard />, pluginClient().client);

        expect(screen.getByRole("button", { name: "Email me a link" })).toBeDefined();
    });
});

describe("solid PasswordStrength", () => {
    it("re-derives the checklist as the password is typed", () => {
        expect.assertions(4);

        const { container } = renderCard(() => <SignUpCard />, bareClient().client);

        // Nothing to show for an empty field.
        expect(container.querySelector(".lunora-auth-strength")).toBeNull();

        fireEvent.input(screen.getByLabelText("Password"), { target: { value: "short" } });

        const unmet = container.querySelector(".lunora-auth-strength__item") as HTMLElement;

        expect(unmet.className).not.toContain("lunora-auth-strength__item--met");
        expect(unmet.textContent).toContain("At least 8 characters");

        // The requirements are read through a function, not captured once, so
        // the same node flips to met.
        fireEvent.input(screen.getByLabelText("Password"), { target: { value: "hunter2hunter2" } });

        expect((container.querySelector(".lunora-auth-strength__item") as HTMLElement).className).toContain("lunora-auth-strength__item--met");
    });
});

describe("solid theme", () => {
    it("applies only the changed tokens to the card", () => {
        expect.assertions(2);

        const { container } = renderCard(
            () => <SignInCard />,
            bareClient().client,
            (defaults) => ({ ...defaults, primary: "rebeccapurple" }),
        );
        const card = container.querySelector(".lunora-auth-card") as HTMLElement;

        expect(card.style.getPropertyValue("--primary")).toBe("rebeccapurple");
        expect(card.style.getPropertyValue("--border")).toBe("");
    });
});
