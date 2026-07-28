import { describe, expect, it, vi } from "vitest";

import { createLunoraAuthClient, lunoraAuthPlugins } from "../src/auth-client-plugins";

describe("lunoraAuthPlugins", () => {
    it("returns nothing when every toggle is off", () => {
        expect.assertions(2);

        expect(lunoraAuthPlugins()).toStrictEqual([]);
        expect(lunoraAuthPlugins({})).toStrictEqual([]);
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

        const createAuthClient = vi.fn((options: Record<string, unknown>) => options);

        createLunoraAuthClient(createAuthClient, { plugins: { organization: true, twoFactor: true } });

        const options = createAuthClient.mock.calls[0]?.[0] as { plugins: unknown[] };

        expect(createAuthClient).toHaveBeenCalledTimes(1);
        expect(options.plugins).toHaveLength(2);
    });

    it("appends extraPlugins after the standard set", () => {
        expect.assertions(1);

        const mine = { id: "mine" } as never;
        const createAuthClient = vi.fn((options: Record<string, unknown>) => options);

        createLunoraAuthClient(createAuthClient, { extraPlugins: [mine], plugins: { organization: true } });

        const options = createAuthClient.mock.calls[0]?.[0] as { plugins: unknown[] };

        expect(options.plugins.at(-1)).toBe(mine);
    });

    it("forwards unknown options through untouched", () => {
        expect.assertions(2);

        const createAuthClient = vi.fn((options: Record<string, unknown>) => options);

        createLunoraAuthClient(createAuthClient, { baseURL: "https://example.test", fetchOptions: { credentials: "include" } });

        const options = createAuthClient.mock.calls[0]?.[0] as { baseURL: string; fetchOptions: unknown };

        expect(options.baseURL).toBe("https://example.test");
        expect(options.fetchOptions).toStrictEqual({ credentials: "include" });
    });

    it("defaults baseURL to the current origin, and to undefined off the browser", () => {
        expect.assertions(2);

        const createAuthClient = vi.fn((options: Record<string, unknown>) => options);

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
