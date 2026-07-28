import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthClient, DiscoveredConfig } from "../../src/core";
import { discoverAuthConfig, registerAuthClientPlugins, resetAuthConfigDiscovery, resolveContext } from "../../src/core";

const stub = (): AuthClient => ({ getSession: vi.fn() }) as unknown as AuthClient;

const payload = (overrides: Partial<DiscoveredConfig> = {}): DiscoveredConfig => {
    return {
        emailAndPassword: true,
        organization: { allowUserToCreate: true, enabled: false, roles: false, teams: false },
        plugins: [],
        signUp: true,
        socialProviders: [],
        ...overrides,
    };
};

const contextFor = (authClient: AuthClient, discovered?: DiscoveredConfig, plugins?: Parameters<typeof resolveContext>[0]["plugins"]) =>
    resolveContext({ authClient, nav: { navigate: vi.fn(), replace: vi.fn() }, plugins }, discovered);

/**
 * Wait for a discovery handle to leave `loading`, without asserting inside the
 * poll — `vi.waitFor` retries its callback, so an `expect` in there is counted
 * once per attempt and blows `expect.assertions`.
 */
/** An absolute ui-config URL with exactly one slash between origin and path. */
const RESOLVED_URL = /^https?:\/\/[^/]+\/api\/auth\/ui-config$/u;

const settled = async (handle: { getState: () => { status: string } }): Promise<void> => {
    await vi.waitFor(() => {
        if (handle.getState().status === "loading") {
            throw new Error("still loading");
        }
    });
};

// eslint-disable-next-line vitest/require-top-level-describe -- one cross-suite teardown hook belongs at the top level.
afterEach(() => {
    resetAuthConfigDiscovery();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("resolvePlugins precedence", () => {
    it("aNDs the server's answer with the client's registration", () => {
        expect.assertions(2);

        const client = stub();

        // The server has the endpoint but the client plugin was never installed.
        // The endpoint being live does not make the flow usable — `passkey`
        // without `passkeyClient()` has no WebAuthn ceremony to reach it.
        registerAuthClientPlugins(client, { magicLink: true });

        const context = contextFor(client, payload({ plugins: ["magic-link", "passkey"] }));

        expect(context.plugins.magicLink).toBe(true);
        expect(context.plugins.passkey).toBe(false);
    });

    it("hides a flow the client registered but the server does not run", () => {
        expect.assertions(1);

        const client = stub();

        registerAuthClientPlugins(client, { organization: true });

        expect(contextFor(client, payload({ plugins: [] })).plugins.organization).toBe(false);
    });

    it("lets an explicit flag override both sources", () => {
        expect.assertions(2);

        const client = stub();

        registerAuthClientPlugins(client, {});

        expect(contextFor(client, payload({ plugins: [] }), { twoFactor: true }).plugins.twoFactor).toBe(true);
        expect(contextFor(client, payload({ plugins: ["two-factor"] }), { twoFactor: false }).plugins.twoFactor).toBe(false);
    });

    it("falls back to the registration when discovery never answered", () => {
        expect.assertions(2);

        const client = stub();

        registerAuthClientPlugins(client, { emailOtp: true });

        const context = contextFor(client);

        expect(context.plugins.emailOtp).toBe(true);
        expect(context.plugins.passkey).toBe(false);
    });

    it("ignores plugin ids it has no card for", () => {
        expect.assertions(1);

        const client = stub();

        registerAuthClientPlugins(client, { organization: true });

        expect(contextFor(client, payload({ plugins: ["organization", "jwt", "bearer"] })).plugins.organization).toBe(true);
    });
});

describe("discovered config fields", () => {
    it("takes social providers from the server when the app didn't pin them", () => {
        expect.assertions(1);

        expect(contextFor(stub(), payload({ socialProviders: ["github", "google"] })).social).toStrictEqual(["github", "google"]);
    });

    it("lets an explicit social list win, so an app can reorder or trim", () => {
        expect.assertions(1);

        const context = resolveContext(
            { authClient: stub(), nav: { navigate: vi.fn(), replace: vi.fn() }, social: ["google"] },
            payload({ socialProviders: ["github", "google"] }),
        );

        expect(context.social).toStrictEqual(["google"]);
    });

    it("hides the password form when the server reports no credential provider", () => {
        expect.assertions(2);

        expect(contextFor(stub(), payload({ emailAndPassword: false })).credentials).toBe(false);
        // Without discovery the form stays — the pre-existing behaviour.
        expect(contextFor(stub()).credentials).toBe(true);
    });

    it("carries the organization sub-features teams and roles", () => {
        expect.assertions(2);

        const context = contextFor(stub(), payload({ organization: { allowUserToCreate: true, enabled: true, roles: true, teams: true } }));

        expect(context.organization.teams).toBe(true);
        expect(context.organization.roles).toBe(true);
    });
});

describe("discoverAuthConfig", () => {
    beforeEach(() => {
        resetAuthConfigDiscovery();
    });

    it("shares one request per endpoint across callers", async () => {
        expect.assertions(3);

        const fetchMock = vi.fn(() => Promise.resolve({ json: () => Promise.resolve(payload({ plugins: ["admin"] })), ok: true }));

        vi.stubGlobal("fetch", fetchMock);

        const first = discoverAuthConfig("/api/auth");
        const second = discoverAuthConfig("/api/auth");

        await settled(first);

        expect(first.getState().status).toBe("ready");
        // Two providers on one page must not cost two round-trips.
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(second).toBe(first);
    });

    it("normalizes a trailing slash and resolves against the origin", async () => {
        expect.assertions(1);

        const fetchMock = vi.fn(() => Promise.resolve({ json: () => Promise.resolve(payload()), ok: true }));

        vi.stubGlobal("fetch", fetchMock);

        await settled(discoverAuthConfig("/api/auth/"));

        // The regex pins both halves at once: exactly one slash between origin
        // and path (the trailing-slash bug), and an absolute URL (only a
        // browser's `fetch` resolves relative ones — Node's rejects them).
        expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(RESOLVED_URL), expect.anything());
    });

    it("reports unavailable for a 404 rather than throwing", async () => {
        expect.assertions(1);

        vi.stubGlobal(
            "fetch",
            vi.fn(() => Promise.resolve({ json: () => Promise.resolve({}), ok: false })),
        );

        const handle = discoverAuthConfig("/api/auth");

        await settled(handle);

        expect(handle.getState().status).toBe("unavailable");
    });

    it("reports unavailable when the request rejects", async () => {
        expect.assertions(1);

        vi.stubGlobal(
            "fetch",
            vi.fn(() => Promise.reject(new Error("offline"))),
        );

        const handle = discoverAuthConfig("/api/auth");

        await settled(handle);

        expect(handle.getState().status).toBe("unavailable");
    });

    it("rejects a body that isn't the expected shape", async () => {
        expect.assertions(1);

        // A catch-all route answering HTML, or an unrelated JSON endpoint, must
        // not be mistaken for a config that disables every flow.
        vi.stubGlobal(
            "fetch",
            vi.fn(() => Promise.resolve({ json: () => Promise.resolve({ hello: "world" }), ok: true })),
        );

        const handle = discoverAuthConfig("/api/auth");

        await settled(handle);

        expect(handle.getState().status).toBe("unavailable");
    });
});
