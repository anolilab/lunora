import type { BetterAuthClientPlugin } from "better-auth/client";
import { describe, expect, it, vi } from "vitest";

import { onSessionChanged } from "../../../shared/session-change";
import { createLunoraAuthClient, lunoraAuthPlugins, lunoraSessionSync, notifyLunoraSessionChange } from "../src/auth-client-plugins";

// Deterministic plugin identity for the order assertion — better-auth's real
// plugin `id`s are internal and drift between versions, so each factory is
// stubbed to a plain `{ id }` instead. The mocks intentionally replace the
// modules without importing the originals (the real factories pull in browser
// globals) — `prefer-import-in-mock` would force that import, so it is disabled
// per-call.
// eslint-disable-next-line vitest/prefer-import-in-mock -- see comment above
vi.mock("better-auth/client/plugins", () => {
    const stub = (id: string) => () => {
        return { id };
    };

    return {
        adminClient: stub("admin"),
        anonymousClient: stub("anonymous"),
        deviceAuthorizationClient: stub("deviceAuthorization"),
        emailOTPClient: stub("emailOtp"),
        lastLoginMethodClient: stub("lastLoginMethod"),
        magicLinkClient: stub("magicLink"),
        multiSessionClient: stub("multiSession"),
        oneTapClient: stub("oneTap"),
        organizationClient: stub("organization"),
        phoneNumberClient: stub("phoneNumber"),
        twoFactorClient: stub("twoFactor"),
        usernameClient: stub("username"),
    };
});

// eslint-disable-next-line vitest/prefer-import-in-mock -- stub, not a re-export
vi.mock("@better-auth/passkey/client", () => {
    return {
        passkeyClient: () => {
            return { id: "passkey" };
        },
    };
});
// eslint-disable-next-line vitest/prefer-import-in-mock -- stub, not a re-export
vi.mock("@better-auth/oauth-provider/client", () => {
    return {
        oauthProviderClient: () => {
            return { id: "oauthProvider" };
        },
    };
});

describe("lunoraAuthPlugins", () => {
    it("returns nothing when every toggle is off", () => {
        expect.assertions(2);

        expect(lunoraAuthPlugins()).toStrictEqual([]);
        expect(lunoraAuthPlugins({})).toStrictEqual([]);
    });

    it("assembles plugins in the legacy toggle-check order", () => {
        expect.assertions(1);

        const allOn = {
            admin: true,
            anonymous: true,
            deviceAuthorization: true,
            emailOtp: true,
            lastLoginMethod: true,
            magicLink: true,
            multiSession: true,
            oauthProvider: true,
            organization: true,
            passkey: true,
            phoneNumber: true,
            twoFactor: true,
            username: true,
        };

        const ids = lunoraAuthPlugins(allOn).map((plugin) => (plugin as { id: string }).id);

        // The pre-refactor toggle-check sequence — observable via the assembled
        // array, so it is pinned rather than left to object-key ordering.
        expect(ids).toStrictEqual([
            "organization",
            "twoFactor",
            "passkey",
            "magicLink",
            "emailOtp",
            "admin",
            "username",
            "phoneNumber",
            "multiSession",
            "anonymous",
            "deviceAuthorization",
            "lastLoginMethod",
            "oauthProvider",
        ]);
    });

    it("includes one plugin per enabled toggle", () => {
        expect.assertions(2);

        expect(lunoraAuthPlugins({ organization: true })).toHaveLength(1);
        expect(lunoraAuthPlugins({ admin: true, emailOtp: true, magicLink: true, organization: true, passkey: true, twoFactor: true })).toHaveLength(6);
    });
});

describe("createLunoraAuthClient", () => {
    it("passes the assembled plugin array to the caller's createAuthClient", () => {
        expect.assertions(2);

        const createAuthClient = vi.fn<(options: Record<string, unknown>) => Record<string, unknown>>((options) => options);

        createLunoraAuthClient(createAuthClient, { plugins: { organization: true, twoFactor: true } });

        const options = createAuthClient.mock.calls[0]?.[0] as { plugins: unknown[] };

        expect(createAuthClient).toHaveBeenCalledTimes(1);
        // The two toggled plugins, behind `lunoraSessionSync`, which is always first.
        expect(options.plugins.map((plugin) => (plugin as { id: string }).id)).toStrictEqual(["lunora-session-sync", "organization", "twoFactor"]);
    });

    it("appends extraPlugins after the standard set", () => {
        expect.assertions(1);

        const mine = { id: "mine" } as never;
        const createAuthClient = vi.fn<(options: Record<string, unknown>) => Record<string, unknown>>((options) => options);

        createLunoraAuthClient(createAuthClient, { extraPlugins: [mine], plugins: { organization: true } });

        const options = createAuthClient.mock.calls[0]?.[0] as { plugins: unknown[] };

        expect(options.plugins.at(-1)).toBe(mine);
    });

    it("forwards unknown options through untouched", () => {
        expect.assertions(2);

        const createAuthClient = vi.fn<(options: Record<string, unknown>) => Record<string, unknown>>((options) => options);

        createLunoraAuthClient(createAuthClient, { baseURL: "https://example.test", fetchOptions: { credentials: "include" } });

        const options = createAuthClient.mock.calls[0]?.[0] as { baseURL: string; fetchOptions: unknown };

        expect(options.baseURL).toBe("https://example.test");
        expect(options.fetchOptions).toStrictEqual({ credentials: "include" });
    });

    it("defaults baseURL to the current origin, and to undefined off the browser", () => {
        expect.assertions(2);

        const createAuthClient = vi.fn<(options: Record<string, unknown>) => Record<string, unknown>>((options) => options);

        // No `location` in this environment — SSR degrades rather than throwing.
        createLunoraAuthClient(createAuthClient, {});

        expect((createAuthClient.mock.calls[0]?.[0] as { baseURL?: string }).baseURL).toBeUndefined();

        vi.stubGlobal("location", { origin: "https://app.test" });
        createLunoraAuthClient(createAuthClient, {});

        expect((createAuthClient.mock.calls[1]?.[0] as { baseURL?: string }).baseURL).toBe("https://app.test");

        vi.unstubAllGlobals();
    });

    it("returns whatever the caller's factory returned", () => {
        expect.assertions(1);

        const client = { marker: true };

        expect(createLunoraAuthClient(() => client)).toBe(client);
    });
});

describe("lunoraSessionSync", () => {
    type Hook = (context: { request: { method?: string } }) => void;

    const onSuccessOf = (): Hook => {
        const plugin = lunoraSessionSync() as unknown as { fetchPlugins: { hooks: { onSuccess: Hook } }[] };
        const hook = plugin.fetchPlugins[0]?.hooks.onSuccess;

        if (hook === undefined) {
            throw new Error("lunoraSessionSync installs no onSuccess hook");
        }

        return hook;
    };

    it("tells every Lunora client after an auth request that can change the session", () => {
        expect.assertions(1);

        const heard: string[] = [];
        const release = onSessionChanged(() => heard.push("changed"));
        const onSuccess = onSuccessOf();

        onSuccess({ request: { method: "POST" } });
        onSuccess({ request: { method: "post" } });
        // A read — `/get-session` itself — changes nothing and must not loop.
        onSuccess({ request: { method: "GET" } });
        onSuccess({ request: {} });

        release();

        expect(heard).toStrictEqual(["changed", "changed"]);
    });

    it("is a better-auth client plugin", () => {
        expect.assertions(1);

        // Compile-time: the narrow return type still fits `createAuthClient`.
        const plugin: BetterAuthClientPlugin = lunoraSessionSync();

        expect(plugin.id).toBe("lunora-session-sync");
    });

    it("notifyLunoraSessionChange reaches every registered listener", async () => {
        expect.assertions(1);

        const heard: number[] = [];
        const releases = [onSessionChanged(() => heard.push(1)), onSessionChanged(() => heard.push(2))];

        await notifyLunoraSessionChange();

        for (const release of releases) {
            release();
        }

        expect(heard).toStrictEqual([1, 2]);
    });
});
