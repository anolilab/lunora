import { describe, expect, test } from "vitest";

import * as plugins from "../src/plugins.js";

/**
 * The expansion shipped under `@cirrus/auth/plugins` is intentionally a
 * thin re-export of better-auth's plugin factories. These tests don't
 * exercise the underlying plugin behavior (that's better-auth's domain) —
 * they verify the surface area: each export is present and is the
 * expected shape (callable factory or callable plugin).
 */
describe("@cirrus/auth/plugins", () => {
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
        "siwe",
        "twoFactor",
        "username",
    ] as const;

    test.each(expectedExports)("exports `%s` as a callable factory", (name) => {
        expect.assertions(2);

        expect(plugins).toHaveProperty(name);

        const factory = plugins[name as keyof typeof plugins];

        expect(factory).toBeTypeOf("function");
    });

    test("admin() returns a plugin object with a known shape", () => {
        expect.assertions(2);

        const plugin = plugins.admin();

        expect(plugin).toBeTypeOf("object");
        expect(plugin).toHaveProperty("id");
    });

    test("organization() returns a plugin object with a known shape", () => {
        expect.assertions(2);

        const plugin = plugins.organization();

        expect(plugin).toBeTypeOf("object");
        expect(plugin).toHaveProperty("id");
    });
});
