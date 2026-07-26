import { describe, expect, it } from "vitest";

import {
    admin,
    anonymous,
    bearer,
    customSession,
    emailOTP,
    genericOAuth,
    jwt,
    magicLink,
    multiSession,
    oAuthProxy,
    oidcProvider,
    organization,
    phoneNumber,
    scim,
    siwe,
    sso,
    twoFactor,
    username,
} from "../src/plugins";

const plugins = {
    admin,
    anonymous,
    bearer,
    customSession,
    emailOTP,
    genericOAuth,
    jwt,
    magicLink,
    multiSession,
    oAuthProxy,
    oidcProvider,
    organization,
    phoneNumber,
    scim,
    siwe,
    sso,
    twoFactor,
    username,
};

/**
 * The expansion shipped under `@lunora/auth/plugins` is intentionally a
 * thin re-export of better-auth's plugin factories. These tests don't
 * exercise the underlying plugin behavior (that's better-auth's domain) —
 * they verify the surface area: each export is present and is the
 * expected shape (callable factory or callable plugin).
 */
describe("@lunora/auth/plugins", () => {
    const expectedExports = [
        "admin",
        "anonymous",
        "bearer",
        "customSession",
        "emailOTP",
        "genericOAuth",
        "jwt",
        "magicLink",
        "multiSession",
        "oAuthProxy",
        "oidcProvider",
        "organization",
        "phoneNumber",
        "scim",
        "siwe",
        "sso",
        "twoFactor",
        "username",
    ] as const;

    it.each(expectedExports)("exports `%s` as a callable factory", (name) => {
        expect.assertions(2);

        expect(plugins).toHaveProperty(name);

        const factory = plugins[name];

        expect(factory).toBeTypeOf("function");
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
