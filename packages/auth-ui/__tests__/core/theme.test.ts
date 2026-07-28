import { describe, expect, it, vi } from "vitest";

import type { AuthClient } from "../../src/core";
import { DEFAULT_THEME_TOKENS, resolveContext, resolveThemeVariables } from "../../src/core";

const authClient = { getSession: vi.fn() } as unknown as AuthClient;

describe("resolveThemeVariables", () => {
    it("emits nothing when no theme is configured", () => {
        expect.assertions(1);

        expect(resolveThemeVariables()).toStrictEqual({});
    });

    it("emits nothing when the theme returns the defaults untouched", () => {
        expect.assertions(1);

        // The whole point: an app that defines its own --border keeps it, because
        // we never shadow a token the caller didn't actually change.
        expect(resolveThemeVariables((defaults) => defaults)).toStrictEqual({});
    });

    it("emits only the changed tokens, kebab-cased as custom properties", () => {
        expect.assertions(1);

        const variables = resolveThemeVariables((defaults) => {
            return { ...defaults, cardForeground: "#111", primary: "rebeccapurple" };
        });

        expect(variables).toStrictEqual({ "--card-foreground": "#111", "--primary": "rebeccapurple" });
    });

    it("exposes defaults that match the stylesheet's fallbacks", () => {
        expect.assertions(2);

        expect(DEFAULT_THEME_TOKENS.radius).toBe("0.5rem");
        expect(DEFAULT_THEME_TOKENS.border).toBe("hsl(228 16% 88%)");
    });
});

describe("resolveContext theme", () => {
    it("puts the resolved variables on the controller context", () => {
        expect.assertions(2);

        const themed = resolveContext({
            authClient,
            nav: { navigate: vi.fn(), replace: vi.fn() },
            theme: (defaults) => {
                return { ...defaults, primary: "#000" };
            },
        });

        expect(themed.themeVariables).toStrictEqual({ "--primary": "#000" });
        expect(resolveContext({ authClient, nav: { navigate: vi.fn(), replace: vi.fn() } }).themeVariables).toStrictEqual({});
    });
});
