import { describe, expect, expectTypeOf, it } from "vitest";

import { createAuth } from "../src/create-auth.js";
import { DEFAULT_AUTH_BASE_PATH, handleAuthRequest } from "../src/handler.js";

const SECRET_PATTERN = /secret/i;

/**
 * Unit smoke tests for the better-auth wrapper. End-to-end coverage lives in
 * the playground's e2e suite where we have a real D1 (Miniflare) — these
 * tests focus on the wrapper's invariants (secret required, request routing,
 * unrelated paths skipped).
 */
describe("createAuth", () => {
    it("throws when secret is missing", () => {
        expect.assertions(1);
        expect(() => createAuth({ secret: "" })).toThrow(SECRET_PATTERN);
    });

    it("returns an instance with handler + api + options", () => {
        expect.assertions(2);

        const auth = createAuth({
            emailAndPassword: { enabled: true },
            secret: "s".repeat(32),
        });

        expectTypeOf(auth.handler).toBeFunction();

        expect(auth.api).toBeDefined();
        expect(auth.options.secret).toBe("s".repeat(32));
    });
});

describe("handleAuthRequest", () => {
    const auth = createAuth({
        emailAndPassword: { enabled: true },
        secret: "s".repeat(32),
    });

    it("returns undefined for paths outside the auth base path", async () => {
        expect.assertions(1);

        const response = await handleAuthRequest(auth, new Request("https://app.test/api/other/thing"));

        expect(response).toBeUndefined();
    });

    it("returns undefined for the runtime's RPC path", async () => {
        expect.assertions(1);

        const response = await handleAuthRequest(auth, new Request("https://app.test/_cirrus/rpc"));

        expect(response).toBeUndefined();
    });

    it("delegates to auth.handler for /api/auth/* paths", async () => {
        expect.assertions(1);

        // Better-auth returns a real Response even when the underlying op
        // fails (e.g. no DB) — we just need to assert we *got* a Response,
        // proving routing dispatched.
        const response = await handleAuthRequest(auth, new Request("https://app.test/api/auth/get-session"));

        expect(response).toBeInstanceOf(Response);
    });

    it("honours a custom basePath", async () => {
        expect.assertions(1);

        const response = await handleAuthRequest(auth, new Request("https://app.test/auth/get-session"), "/auth");

        expect(response).toBeInstanceOf(Response);
    });

    it("dEFAULT_AUTH_BASE_PATH is /api/auth", () => {
        expect.assertions(1);
        expect(DEFAULT_AUTH_BASE_PATH).toBe("/api/auth");
    });
});
