import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import type { AuthClient } from "../../src/core";
import { AppearanceCard, AuthDivider, AuthUIProvider, TwoFactorCard } from "../../src/react";

const stubClient = (): AuthClient => ({ getSession: vi.fn(() => Promise.resolve({ data: null, error: null })) }) as unknown as AuthClient;

const renderWith = (node: ReactElement): ReturnType<typeof render> =>
    render(
        <AuthUIProvider authClient={stubClient()} discover={false} nav={{ navigate: vi.fn(), replace: vi.fn() }}>
            {node}
        </AuthUIProvider>,
    );

describe("authDivider", () => {
    it("names the separator, because its children are presentational", () => {
        expect.assertions(2);

        // A `separator` role makes its subtree presentational: the visible "or"
        // never reaches the accessibility tree, so the only way a screen reader
        // hears it is as the separator's own name.
        const { container } = render(<AuthDivider />);
        const separator = container.querySelector('[role="separator"]');

        expect(separator?.getAttribute("aria-label")).toBe("or");
        expect(separator?.textContent).toBe("or");
    });
});

describe("appearanceCard", () => {
    it("is a named group of toggle buttons, not an unnavigable radio group", () => {
        expect.assertions(3);

        // `role="radio"` would owe the user arrow-key navigation and a single
        // roving tab stop. These are three ordinary buttons, so they say so.
        const { container } = renderWith(<AppearanceCard />);

        expect(container.querySelector('[role="radiogroup"]')).toBeNull();
        expect(screen.getByRole("group").getAttribute("aria-label")).toBe("Appearance");
        expect(screen.getAllByRole("button")).toHaveLength(3);
    });

    it("moves aria-pressed to whichever mode was chosen", () => {
        expect.assertions(2);

        renderWith(<AppearanceCard />);

        const dark = screen.getByRole("button", { name: "Dark" });

        expect(dark.getAttribute("aria-pressed")).toBe("false");

        fireEvent.click(dark);

        expect(dark.getAttribute("aria-pressed")).toBe("true");
    });
});

describe("one-time-code fields", () => {
    it("raises a numeric keyboard for digit codes but not for backup codes", async () => {
        expect.assertions(2);

        // TOTP and emailed OTPs are digits, so a text keyboard on a phone is
        // the wrong one. Backup codes are alphanumeric, so they keep it.
        const { container } = renderWith(<TwoFactorCard />);
        const totp = await screen.findByLabelText("Verification code");

        expect(totp.getAttribute("inputmode")).toBe("numeric");

        fireEvent.click(screen.getByRole("button", { name: "Use a backup code" }));

        const backup = container.querySelector<HTMLInputElement>('input[autocomplete="one-time-code"]');

        expect(backup?.getAttribute("inputmode")).toBeNull();
    });
});

describe("focus ring", () => {
    it("gives every interactive control a visible one", () => {
        expect.assertions(1);

        // The stylesheet is the only thing standing between a keyboard user and
        // an invisible focus position (WCAG 2.4.7). Buttons and links used to
        // fall through to whatever the browser drew, while the text input and
        // the avatar trigger got a custom ring — and disagreed on its colour.
        const css = readFileSync(resolve(process.cwd(), "src/styles/auth-ui.css"), "utf8");
        const ringed = new Set(
            css
                .split("}")
                .filter((block) => block.includes(":focus-visible") && block.includes("outline:"))
                .flatMap((block) => [...block.matchAll(/\.(lunora-auth-[\w-]+):focus-visible/g)].map((match) => match[1])),
        );

        expect(
            [
                "lunora-auth-button",
                "lunora-auth-field__input",
                "lunora-auth-link",
                "lunora-auth-segmented__option",
                "lunora-auth-select",
                "lunora-auth-social__button",
                "lunora-auth-toast__dismiss",
                "lunora-auth-userbutton__trigger",
            ].filter((cls) => !ringed.has(cls)),
        ).toStrictEqual([]);
    });
});
