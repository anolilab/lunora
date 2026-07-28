import { describe, expect, it } from "vitest";

import { deriveUiConfig, uiConfig } from "../src/ui-config";

/** The subset of resolved better-auth options `deriveUiConfig` reads. */
const options = (overrides: Record<string, unknown> = {}) => ({
    emailAndPassword: { enabled: true },
    plugins: [],
    socialProviders: {},
    ...overrides,
});

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

        expect(deriveUiConfig(options({ plugins: [{ id: "organization" }] })).organization.enabled).toBe(true);
    });

    it("withholds fields an app opted out of exposing", () => {
        expect.assertions(3);

        const payload = deriveUiConfig(options({ plugins: [{ id: "organization" }], socialProviders: { github: {} } }), {
            expose: { organization: false, plugins: false, socialProviders: false },
        });

        expect(payload.plugins).toStrictEqual([]);
        expect(payload.socialProviders).toStrictEqual([]);
        expect(payload.organization.enabled).toBe(false);
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

        expect(Object.keys(payload).toSorted()).toStrictEqual(["emailAndPassword", "organization", "plugins", "signUp", "socialProviders"]);
    });
});

describe("uiConfig", () => {
    it("registers one GET endpoint under a stable plugin id", () => {
        expect.assertions(2);

        const plugin = uiConfig();

        expect(plugin.id).toBe("lunora-ui-config");
        expect(plugin.endpoints.getUiConfig.path).toBe("/ui-config");
    });

    it("honours a custom path", () => {
        expect.assertions(1);

        expect(uiConfig({ path: "/public-config" }).endpoints.getUiConfig.path).toBe("/public-config");
    });
});
