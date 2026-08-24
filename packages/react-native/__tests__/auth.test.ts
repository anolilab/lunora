import { describe, expect, it } from "vitest";

// Import from `../src/bearer` (Expo-free), not `../src/auth` (which re-exports
// `@better-auth/expo/client` → Expo native modules vitest can't load).
import expoBearerToken from "../src/bearer";

describe("expoBearerToken", () => {
    it("extracts the better-auth session token from the Expo cookie string", async () => {
        expect.assertions(1);

        const authClient = { getCookie: () => "better-auth.session_token=abc123.sig; better-auth.session_data=xyz" };

        await expect(expoBearerToken(authClient)).resolves.toBe("abc123.sig");
    });

    it("handles the `__Secure-` cookie prefix", async () => {
        expect.assertions(1);

        const authClient = { getCookie: () => "__Secure-better-auth.session_token=tok.sig" };

        await expect(expoBearerToken(authClient)).resolves.toBe("tok.sig");
    });

    it("finds the token even when a `session_data` cookie comes first", async () => {
        expect.assertions(1);

        const authClient = { getCookie: () => "better-auth.session_data=xyz; better-auth.session_token=abc.sig" };

        await expect(expoBearerToken(authClient)).resolves.toBe("abc.sig");
    });

    it("returns null when signed out (no session cookie)", async () => {
        expect.assertions(1);

        const authClient = { getCookie: () => "" };

        await expect(expoBearerToken(authClient)).resolves.toBeNull();
    });

    it("returns null for a cookie string without a session token", async () => {
        expect.assertions(1);

        const authClient = { getCookie: () => "better-auth.session_data=onlydata" };

        await expect(expoBearerToken(authClient)).resolves.toBeNull();
    });

    /**
     * better-auth 1.7.1 changed `@better-auth/expo`'s `getCookie` from
     * `() => string` to `() => Promise<string>`. Matching the Promise itself
     * tests `"[object Promise]"`, finds no `session_token`, and returns `null`
     * — a signed-in app that behaves as anonymous, with no error anywhere. The
     * sync cases above still pass under a non-awaited implementation, so this
     * is the one that actually pins the fix.
     */
    it("awaits an async `getCookie`, as better-auth 1.7.1 returns", async () => {
        expect.assertions(1);

        const authClient = { getCookie: async () => await Promise.resolve("better-auth.session_token=async.sig") };

        await expect(expoBearerToken(authClient)).resolves.toBe("async.sig");
    });
});
