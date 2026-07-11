import { describe, expect, it, vi } from "vitest";

import { expoBearerToken } from "../src/auth";

// `../src/auth` re-exports `@better-auth/expo/client`, which pulls in Expo native
// modules vitest can't load — stub it (vitest hoists this above the import) so
// only the pure `expoBearerToken` runs.
vi.mock(import('@better-auth/expo/client'), () => {
    return {
        expoClient: () => {
            return {};
        },
        setupExpoFocusManager: () => {},
        setupExpoOnlineManager: () => {},
    };
});

describe("expoBearerToken", () => {
    it("extracts the better-auth session token from the Expo cookie string", () => {
        expect.assertions(1);

        const authClient = { getCookie: () => "better-auth.session_token=abc123.sig; better-auth.session_data=xyz" };

        expect(expoBearerToken(authClient)).toBe("abc123.sig");
    });

    it("handles the `__Secure-` cookie prefix", () => {
        expect.assertions(1);

        const authClient = { getCookie: () => "__Secure-better-auth.session_token=tok.sig" };

        expect(expoBearerToken(authClient)).toBe("tok.sig");
    });

    it("finds the token even when a `session_data` cookie comes first", () => {
        expect.assertions(1);

        const authClient = { getCookie: () => "better-auth.session_data=xyz; better-auth.session_token=abc.sig" };

        expect(expoBearerToken(authClient)).toBe("abc.sig");
    });

    it("returns null when signed out (no session cookie)", () => {
        expect.assertions(1);

        const authClient = { getCookie: () => "" };

        expect(expoBearerToken(authClient)).toBeNull();
    });

    it("returns null for a cookie string without a session token", () => {
        expect.assertions(1);

        const authClient = { getCookie: () => "better-auth.session_data=onlydata" };

        expect(expoBearerToken(authClient)).toBeNull();
    });
});
