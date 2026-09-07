import { describe, expect, it } from "vitest";

// Loaded dynamically rather than as `import * as`: the repo's lint forbids namespace
// imports, and the point of this suite is to inspect the module's key set as a whole
// rather than to name each export twice.
const plugins = await import("../src/plugins");
const enterprisePlugins = await import("../src/plugins-enterprise");

/**
 * The expansion shipped under `@lunora/auth/plugins` is intentionally a thin
 * re-export of better-auth's plugin factories. These tests don't exercise the
 * underlying plugin behavior (that's better-auth's domain) — they lock the surface
 * area: exactly these names, each a callable factory.
 *
 * The list is compared against `Object.keys(plugins)` rather than a hand-written
 * object of the same names, so it fails on an unintended *addition* as well as a
 * removal — and adding a plugin becomes one edit here instead of three.
 * (`createAccessControl` is a builder rather than a plugin factory, but it ships from
 * the same module, so the surface list includes it.)
 */
const EXPECTED_EXPORTS = [
    "admin",
    "anonymous",
    "apiKey",
    "bearer",
    "captcha",
    "createAccessControl",
    "createMcpProtectedRequestHandler",
    "customSession",
    "deviceAuthorization",
    "emailOTP",
    "genericOAuth",
    "haveIBeenPwned",
    "inviteOnly",
    "jwt",
    "lastLoginMethod",
    "magicLink",
    "mcp",
    "multiSession",
    "oAuthProxy",
    "oauthDeviceAuthorization",
    "oauthProvider",
    "oneTap",
    "oneTimeToken",
    "organization",
    "passkey",
    "phoneNumber",
    "requireMcpAuth",
    "scim",
    "siwe",
    "twoFactor",
    "uiConfig",
    "username",
] as const;

/** Same comparator on both sides, so the literal above can stay in readable order. */
const sortNames = (names: ReadonlyArray<string>): string[] => [...names].toSorted((a, b) => a.localeCompare(b));

describe("@lunora/auth/plugins", () => {
    it("exports exactly the curated surface", () => {
        expect.assertions(1);

        // Catches a removal (an upstream rename silently dropping an export) as well as
        // an addition (something re-exported without being documented or tested).
        expect(sortNames(Object.keys(plugins))).toEqual(sortNames(EXPECTED_EXPORTS));
    });

    it.each(EXPECTED_EXPORTS)("exports `%s` as a callable factory", (name) => {
        expect.assertions(1);

        expect(plugins[name]).toBeTypeOf("function");
    });

    it("admin() returns a plugin object with a known shape", () => {
        expect.assertions(2);

        const plugin = plugins.admin();

        expect(plugin).toBeTypeOf("object");
        expect(plugin).toHaveProperty("id");
    });

    it("organization() returns a plugin object with a known shape", () => {
        expect.assertions(2);

        const plugin = plugins.organization();

        expect(plugin).toBeTypeOf("object");
        expect(plugin).toHaveProperty("id");
    });
});

describe("@lunora/auth/plugins/enterprise", () => {
    it("keeps `sso` off the general barrel so its SAML tree stays an optional install", () => {
        expect.assertions(2);

        // The split is the point of the subpath: `@better-auth/sso` statically imports
        // samlify, so every `@lunora/auth` consumer would otherwise pay for it on install.
        expect(Object.keys(plugins)).not.toContain("sso");
        expect(enterprisePlugins.sso).toBeTypeOf("function");
    });
});
