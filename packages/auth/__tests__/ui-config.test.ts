import { describe, expect, it } from "vitest";

import { deriveUiConfig, uiConfig } from "../src/ui-config";

/** The subset of resolved better-auth options `deriveUiConfig` reads. */
const options = (overrides: Record<string, unknown> = {}) => {
    return {
        emailAndPassword: { enabled: true },
        plugins: [],
        socialProviders: {},
        ...overrides,
    };
};

describe("deriveUiConfig", () => {
    it("reports the enabled plugin ids, sorted", () => {
        expect.assertions(1);

        const payload = deriveUiConfig(options({ plugins: [{ id: "two-factor" }, { id: "organization" }, { id: "magic-link" }] }));

        expect(payload.plugins).toStrictEqual(["magic-link", "organization", "two-factor"]);
    });

    it("reports the configured social providers, sorted", () => {
        expect.assertions(1);

        const payload = deriveUiConfig(options({ socialProviders: { google: {}, github: {} } }));

        expect(payload.socialProviders).toStrictEqual(["github", "google"]);
    });

    it("merges extraProviders for genericOAuth, which is not in socialProviders", () => {
        expect.assertions(1);

        const payload = deriveUiConfig(options({ socialProviders: { github: {} } }), { extraProviders: ["acme-sso"] });

        expect(payload.socialProviders).toStrictEqual(["acme-sso", "github"]);
    });

    it("reports sign-up closed when the password provider disables it", () => {
        expect.assertions(2);

        expect(deriveUiConfig(options({ emailAndPassword: { disableSignUp: true, enabled: true } })).signUp).toBe(false);
        expect(deriveUiConfig(options()).signUp).toBe(true);
    });

    it("reports sign-up closed for an OAuth-only deployment", () => {
        expect.assertions(2);

        // There is no sign-up *form* to gate when there is no password provider,
        // so `signUp` must not claim one is open.
        const payload = deriveUiConfig(options({ emailAndPassword: { enabled: false } }));

        expect(payload.emailAndPassword).toBe(false);
        expect(payload.signUp).toBe(false);
    });

    it("reports the organization plugin", () => {
        expect.assertions(1);

        expect(deriveUiConfig(options({ plugins: [{ id: "organization" }] })).organization?.enabled).toBe(true);
    });

    it("omits an undisclosed field entirely rather than emptying it", () => {
        expect.assertions(4);

        const payload = deriveUiConfig(options({ plugins: [{ id: "organization" }], socialProviders: { github: {} } }), {
            expose: { organization: false, plugins: false, socialProviders: false },
        });

        /*
         * `plugins: []` would be indistinguishable from "runs no plugins", and
         * the client ANDs the server's answer with its own registration — so an
         * emptied list silently switches off every gated card instead of merely
         * withholding the list. Absent means "not disclosed".
         */
        expect("plugins" in payload).toBe(false);
        expect("socialProviders" in payload).toBe(false);
        expect("organization" in payload).toBe(false);
        // Non-optional facts are still reported.
        expect(payload.emailAndPassword).toBe(true);
    });

    it("never leaks a secret, session policy, or rate-limit policy", () => {
        expect.assertions(1);

        // The payload is unauthenticated, so its shape is a security boundary:
        // anything added here is public. `AuthAdmin.config` keeps the rest.
        const payload = deriveUiConfig(
            options({
                rateLimit: { max: 10, window: 60 },
                secret: "super-secret",
                session: { expiresIn: 604_800 },
            }),
        );

        expect(Object.keys(payload).toSorted((a, b) => a.localeCompare(b))).toStrictEqual([
            "emailAndPassword",
            "organization",
            "plugins",
            "signUp",
            "socialProviders",
        ]);
    });
});

describe("uiConfig", () => {
    it("registers one GET endpoint under a stable plugin id", () => {
        expect.assertions(3);

        const plugin = uiConfig();

        expect(plugin.id).toBe("lunora-ui-config");
        expect(Object.keys(plugin.endpoints ?? {})).toStrictEqual(["getUiConfig"]);
        expect(plugin.endpoints?.["getUiConfig"]?.path).toBe("/ui-config");
    });

    it("honours a custom path", () => {
        expect.assertions(1);

        expect(uiConfig({ path: "/public-config" }).endpoints?.["getUiConfig"]?.path).toBe("/public-config");
    });
});
