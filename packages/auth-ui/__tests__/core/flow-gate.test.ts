import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthClient, ControllerContext } from "../../src/core";
import { derivePluginFlags, isFlowEnabled, resetFlowWarnings, resolveContext } from "../../src/core";

const bare = { getSession: vi.fn() } as unknown as AuthClient;

const withPlugins = {
    ...bare,
    emailOtp: { sendVerificationOtp: vi.fn() },
    organization: { list: vi.fn() },
    passkey: { addPasskey: vi.fn() },
    signIn: { magicLink: vi.fn() },
    twoFactor: { enable: vi.fn() },
} as unknown as AuthClient;

const contextFor = (authClient: AuthClient, plugins?: Parameters<typeof resolveContext>[0]["plugins"]): ControllerContext =>
    resolveContext({ authClient, nav: { navigate: vi.fn(), replace: vi.fn() }, plugins });

// eslint-disable-next-line vitest/require-top-level-describe -- one cross-suite teardown hook belongs at the top level.
afterEach(() => {
    resetFlowWarnings();
    vi.restoreAllMocks();
});

describe("derivePluginFlags", () => {
    it("reports every flow off for a client built without plugins", () => {
        expect.assertions(1);

        expect(derivePluginFlags(bare)).toStrictEqual({
            admin: false,
            apiKey: false,
            emailOtp: false,
            magicLink: false,
            organization: false,
            passkey: false,
            twoFactor: false,
        });
    });

    it("detects each plugin from the method it installs on the client", () => {
        expect.assertions(5);

        const flags = derivePluginFlags(withPlugins);

        expect(flags.magicLink).toBe(true);
        expect(flags.emailOtp).toBe(true);
        expect(flags.organization).toBe(true);
        expect(flags.passkey).toBe(true);
        expect(flags.twoFactor).toBe(true);
    });

    it("survives a null or undefined client instead of throwing", () => {
        expect.assertions(1);

        expect(derivePluginFlags(undefined).organization).toBe(false);
    });
});

describe("resolveContext plugin flags", () => {
    it("defaults each flag to what the client supports", () => {
        expect.assertions(2);

        expect(contextFor(withPlugins).plugins.organization).toBe(true);
        expect(contextFor(bare).plugins.organization).toBe(false);
    });

    it("lets an explicit flag override detection in both directions", () => {
        expect.assertions(2);

        expect(contextFor(bare, { organization: true }).plugins.organization).toBe(true);
        expect(contextFor(withPlugins, { organization: false }).plugins.organization).toBe(false);
    });
});

describe("isFlowEnabled", () => {
    it("passes an enabled flow through without warning", () => {
        expect.assertions(2);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        expect(isFlowEnabled(contextFor(withPlugins), "organization", "OrganizationsCard")).toBe(true);
        expect(warn).not.toHaveBeenCalled();
    });

    it("warns once per component, naming the flow and the fix", () => {
        expect.assertions(3);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const context = contextFor(bare);

        expect(isFlowEnabled(context, "magicLink", "MagicLinkCard")).toBe(false);

        // A re-rendering card must not spam the console.
        isFlowEnabled(context, "magicLink", "MagicLinkCard");

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.[0]).toContain("MagicLinkCard");
    });
});
