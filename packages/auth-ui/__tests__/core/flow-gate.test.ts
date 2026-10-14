import { createAuthClient } from "better-auth/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthClient, ControllerContext, PluginFlags } from "../../src/core";
import { derivePluginFlags, FLOW_NAMES, isFlowEnabled, registerAuthClientPlugins, resetFlowWarnings, resolveContext } from "../../src/core";

const stub = (): AuthClient => ({ getSession: vi.fn() }) as unknown as AuthClient;

const contextFor = (authClient: AuthClient, plugins?: PluginFlags): ControllerContext =>
    resolveContext({ authClient, nav: { navigate: vi.fn(), replace: vi.fn() }, plugins });

// One cross-suite teardown hook, deliberately at the top level.
afterEach(() => {
    resetFlowWarnings();
    vi.restoreAllMocks();
});

describe("derivePluginFlags", () => {
    it("returns what the client registered", () => {
        expect.assertions(3);

        const client = stub();

        registerAuthClientPlugins(client, { magicLink: true, organization: true });

        const flags = derivePluginFlags(client);

        expect(flags.magicLink).toBe(true);
        expect(flags.organization).toBe(true);
        expect(flags.twoFactor).toBe(false);
    });

    it("reports every flow off for a client registered with no plugins", () => {
        expect.assertions(1);

        const client = stub();

        registerAuthClientPlugins(client, {});

        // Built from FLOW_NAMES rather than spelled out: the point of the
        // assertion is "every flow is off", not "these seven are". A literal
        // here fails whenever a flow is added, which says nothing about the gate.
        expect(derivePluginFlags(client)).toStrictEqual(Object.fromEntries(FLOW_NAMES.map((flow) => [flow, false])));
    });

    it("leaves every flow on for a client that never registered", () => {
        expect.assertions(2);

        // An app that built its client by hand tells us nothing, and hiding a card
        // we cannot reason about is the worse failure — so nothing is hidden.
        expect(derivePluginFlags(stub()).organization).toBe(true);
        expect(derivePluginFlags(stub()).passkey).toBe(true);
    });

    it("survives a null or undefined client instead of throwing", () => {
        expect.assertions(2);

        expect(derivePluginFlags(undefined).organization).toBe(true);
        expect(derivePluginFlags(null).organization).toBe(true);
    });

    /**
     * The regression that made the first version of this module a no-op:
     * `createAuthClient` returns a dynamic-path proxy, so *any* property path
     * answers with a callable. Probing the client cannot work, in either
     * direction — this test fails the moment someone reintroduces it.
     */
    it("does not try to infer plugins from a real better-auth client's shape", () => {
        expect.assertions(3);

        const real = createAuthClient({ baseURL: "http://localhost" }) as unknown as Record<string, Record<string, unknown>>;

        // Proof the proxy answers for anything at all…
        expect(real.organization?.list).toBeTypeOf("function");
        expect(real.notAPlugin?.notAMethod).toBeTypeOf("function");

        // …so an unregistered real client is treated as unknown, not as fully-featured detection.
        expect(derivePluginFlags(real)).toStrictEqual(derivePluginFlags(stub()));
    });
});

describe("resolveContext plugin flags", () => {
    it("defaults each flag to the client's registration", () => {
        expect.assertions(2);

        const enabled = stub();
        const disabled = stub();

        registerAuthClientPlugins(enabled, { organization: true });
        registerAuthClientPlugins(disabled, {});

        expect(contextFor(enabled).plugins.organization).toBe(true);
        expect(contextFor(disabled).plugins.organization).toBe(false);
    });

    it("lets an explicit flag override the registration in both directions", () => {
        expect.assertions(2);

        const client = stub();

        registerAuthClientPlugins(client, {});

        expect(contextFor(client, { organization: true }).plugins.organization).toBe(true);

        const enabled = stub();

        registerAuthClientPlugins(enabled, { organization: true });

        expect(contextFor(enabled, { organization: false }).plugins.organization).toBe(false);
    });
});

describe("isFlowEnabled", () => {
    it("passes an enabled flow through without warning", () => {
        expect.assertions(2);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const client = stub();

        registerAuthClientPlugins(client, { organization: true });

        expect(isFlowEnabled(contextFor(client), "organization", "OrganizationsCard")).toBe(true);
        expect(warn).not.toHaveBeenCalled();
    });

    it("warns once per component, naming the flow and the fix", () => {
        expect.assertions(3);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const client = stub();

        registerAuthClientPlugins(client, {});

        const context = contextFor(client);

        expect(isFlowEnabled(context, "magicLink", "MagicLinkCard")).toBe(false);

        // A re-rendering card must not spam the console.
        isFlowEnabled(context, "magicLink", "MagicLinkCard");

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.[0]).toContain("MagicLinkCard");
    });
});
