/**
 * Server discovery, from the Vue side.
 *
 * This is the one thing a Vue port can get wrong that React cannot. React
 * re-renders every consumer when the context is rebuilt, so a card's flow gate
 * and a controller's `autoLoad` are re-decided for free. Vue never re-runs a
 * component's `setup()`, so those decisions stay frozen on the pre-discovery
 * verdict unless they are read *through* the context ref — a `computed` gate,
 * and a controller factory that re-reads it on rebuild. That is what these
 * assert, for the gate (`v-if`) and for the auto-load that rides along with it,
 * under both provider forms: the reactive read is what makes `createAuthUI`
 * (which has no subtree to re-create) behave identically to `<AuthUIProvider>`.
 *
 * Lives in its own file so the module-level request cache in `core/discovery.ts`
 * cannot leak into `cards.test.ts`, which deliberately runs against a deployment
 * with no `uiConfig()` endpoint at all.
 */
import { render, screen } from "@testing-library/vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, nextTick } from "vue";

import type { AuthClient } from "../../src/core";
import { registerAuthClientPlugins, resetAuthConfigDiscovery, resetFlowWarnings } from "../../src/core";
import AuthUIProvider from "../../src/vue/AuthUIProvider.vue";
import MultiSessionCard from "../../src/vue/MultiSessionCard.vue";
import PasskeysCard from "../../src/vue/PasskeysCard.vue";
import { createAuthUI } from "../../src/vue/provider";
import { fakeNav, ok } from "../fake-client";

/**
 * A client that *registered* both flows, the way `lunora/auth-ui/client.ts`
 * would. Both cards therefore render on the first paint; only the server can
 * take that back.
 */
const registeredClient = (): { client: AuthClient; listDeviceSessions: ReturnType<typeof vi.fn> } => {
    const listDeviceSessions = vi.fn(() => ok([]));
    const client = {
        getSession: vi.fn(() => ok({ user: { email: "a@b.co" } })),
        multiSession: { listDeviceSessions },
        passkey: { addPasskey: vi.fn(() => ok({})), listUserPasskeys: vi.fn(() => ok([])) },
        signIn: { email: vi.fn(() => ok({})), social: vi.fn(() => ok({})) },
    } as unknown as AuthClient;

    registerAuthClientPlugins(client, { multiSession: true, passkey: true });

    return { client, listDeviceSessions };
};

/** Stub `GET {basePath}/ui-config` with a deployment reporting exactly `plugins`. */
const stubUiConfig = (plugins: ReadonlyArray<string>): void => {
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
            return {
                json: async () => {
                    return {
                        emailAndPassword: true,
                        organization: { enabled: false, roles: false, teams: false },
                        plugins,
                        signUp: true,
                        socialProviders: [],
                    };
                },
                ok: true,
            };
        }),
    );
};

const renderInProvider = (component: unknown, client: AuthClient): void => {
    render(
        defineComponent({
            render: () => h(AuthUIProvider, { authClient: client, nav: fakeNav() }, { default: () => h(component as never) }),
        }),
    );
};

/**
 * Discovery resolves on the microtask queue; the macrotask turn drains it, and
 * Vue flushes the identity swap — and the re-render every gate reading it causes
 * — on the tick after. Deterministic, so the assertions below need no polling.
 */
const settleDiscovery = async (): Promise<void> => {
    await new Promise((resolve) => {
        setTimeout(resolve, 0);
    });
    await nextTick();
};

beforeEach(() => {
    // The handle cache is keyed by URL and module-level, so without this every
    // test after the first would reuse the first one's answer.
    resetAuthConfigDiscovery();
    // A gated-off card warns once naming itself; that is the point of the gate,
    // not a failure, so it doesn't need to be in the output.
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
    resetFlowWarnings();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("vue discovery", () => {
    it("drops a card whose flow the client registered but the server does not have", async () => {
        expect.assertions(2);

        stubUiConfig([]);
        renderInProvider(MultiSessionCard, registeredClient().client);

        // The client's own registration is all that is known on the first paint.
        expect(screen.getByRole("heading", { name: "Switch account" })).toBeDefined();

        await settleDiscovery();

        expect(screen.queryByRole("heading", { name: "Switch account" })).toBeNull();
    });

    it("drops PasskeysCard on the same answer", async () => {
        expect.assertions(2);

        stubUiConfig([]);
        renderInProvider(PasskeysCard, registeredClient().client);

        expect(screen.getByRole("heading", { name: "Passkeys" })).toBeDefined();

        await settleDiscovery();

        expect(screen.queryByRole("heading", { name: "Passkeys" })).toBeNull();
    });

    it("re-decides the auto-load with the gate rather than refetching a flow that is now off", async () => {
        expect.assertions(3);

        stubUiConfig([]);

        const { client, listDeviceSessions } = registeredClient();

        renderInProvider(MultiSessionCard, client);

        // One load, from the mount where the flow still looked enabled.
        expect(listDeviceSessions).toHaveBeenCalledTimes(1);

        await settleDiscovery();

        expect(screen.queryByRole("heading", { name: "Switch account" })).toBeNull();
        // The rebuilt controller took `autoLoad: false` from the re-run gate. A
        // blind rebuild would have fired a second request for a plugin the
        // deployment does not have.
        expect(listDeviceSessions).toHaveBeenCalledTimes(1);
    });

    it("keeps the card when the server confirms the flow", async () => {
        expect.assertions(2);

        stubUiConfig(["multi-session"]);
        renderInProvider(MultiSessionCard, registeredClient().client);

        expect(screen.getByRole("heading", { name: "Switch account" })).toBeDefined();

        await settleDiscovery();

        expect(screen.getByRole("heading", { name: "Switch account" })).toBeDefined();
    });

    it("rebuilds the controller on the app-plugin form, which has no subtree to re-create", async () => {
        expect.assertions(2);

        stubUiConfig(["multi-session"]);

        const { client, listDeviceSessions } = registeredClient();

        render(MultiSessionCard, { global: { plugins: [createAuthUI({ authClient: client, nav: fakeNav() })] } });

        expect(listDeviceSessions).toHaveBeenCalledTimes(1);

        await settleDiscovery();

        // `useController` swapped to the discovered context on its own, with no
        // provider component involved.
        expect(listDeviceSessions).toHaveBeenCalledTimes(2);
    });

    /*
     * The case the reactive gates exist for. `createAuthUI` has no component
     * boundary, so nothing here can remount the card: if the `v-if` were a
     * boolean read in `setup()` it would still say "on" after the server said
     * otherwise, and this card would sit on screen driving a plugin the
     * deployment does not have.
     */
    it("drops a gated card on the app-plugin form, which cannot remount it", async () => {
        expect.assertions(2);

        stubUiConfig([]);

        render(MultiSessionCard, { global: { plugins: [createAuthUI({ authClient: registeredClient().client, nav: fakeNav() })] } });

        expect(screen.getByRole("heading", { name: "Switch account" })).toBeDefined();

        await settleDiscovery();

        expect(screen.queryByRole("heading", { name: "Switch account" })).toBeNull();
    });

    it("re-decides the auto-load from the gate on the app-plugin form too", async () => {
        expect.assertions(2);

        stubUiConfig([]);

        const { client, listDeviceSessions } = registeredClient();

        render(MultiSessionCard, { global: { plugins: [createAuthUI({ authClient: client, nav: fakeNav() })] } });

        expect(listDeviceSessions).toHaveBeenCalledTimes(1);

        await settleDiscovery();

        // The rebuilt controller read `autoLoad` off the *current* gate, not the
        // boolean the factory closed over at setup.
        expect(listDeviceSessions).toHaveBeenCalledTimes(1);
    });
});
