import { describe, expect, expectTypeOf, it } from "vitest";

import { createAuth } from "../src/create-auth";
import { DEFAULT_AUTH_BASE_PATH, handleAuthRequest } from "../src/handler";
import { sessionPresets } from "../src/session";

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

    it("throws when secret is whitespace-only", () => {
        expect.assertions(1);
        expect(() => createAuth({ secret: "   " })).toThrow(SECRET_PATTERN);
    });

    it("the missing-secret error points at AUTH_SECRET / .dev.vars", () => {
        expect.assertions(2);
        expect(() => createAuth({ secret: "" })).toThrow(/AUTH_SECRET/);
        expect(() => createAuth({ secret: "" })).toThrow(/\.dev\.vars/);
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

    it("forwards a configured session policy to the underlying betterAuth options", () => {
        expect.assertions(3);

        const auth = createAuth({
            secret: "s".repeat(32),
            session: {
                disableSessionRefresh: false,
                expiresIn: 60 * 60 * 24 * 3,
                freshAge: 60 * 5,
                updateAge: 60 * 30,
            },
        });

        expect(auth.options.session?.expiresIn).toBe(60 * 60 * 24 * 3);
        expect(auth.options.session?.updateAge).toBe(60 * 30);
        expect(auth.options.session?.freshAge).toBe(60 * 5);
    });

    it("forwards a session preset to the underlying betterAuth options", () => {
        expect.assertions(2);

        const auth = createAuth({
            secret: "s".repeat(32),
            session: sessionPresets.strict,
        });

        expect(auth.options.session?.expiresIn).toBe(sessionPresets.strict.expiresIn);
        expect(auth.options.session?.updateAge).toBe(sessionPresets.strict.updateAge);
    });

    it("rejects a negative session duration", () => {
        expect.assertions(1);

        expect(() => createAuth({ secret: "s".repeat(32), session: { expiresIn: -1 } })).toThrow(/non-negative/i);
    });

    it("rejects a non-finite session duration", () => {
        expect.assertions(1);

        expect(() => createAuth({ secret: "s".repeat(32), session: { updateAge: Number.POSITIVE_INFINITY } })).toThrow(/finite/i);
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

        const response = await handleAuthRequest(auth, new Request("https://app.test/_lunora/rpc"));

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

    it("dispatches on the exact basePath (no trailing segment)", async () => {
        expect.assertions(1);

        const response = await handleAuthRequest(auth, new Request("https://app.test/api/auth"));

        expect(response).toBeInstanceOf(Response);
    });

    it("does not capture sibling routes sharing the basePath prefix", async () => {
        expect.assertions(1);

        // "/api/authzzz" shares the "/api/auth" prefix but is a different route
        // — the `${base}/` segment-boundary guard must reject it. Pins the
        // behaviour so a refactor to a looser `startsWith(basePath)` can't
        // silently swallow sibling routes.
        const response = await handleAuthRequest(auth, new Request("https://app.test/api/authzzz"));

        expect(response).toBeUndefined();
    });

    it("normalizes a trailing-slash basePath so nested routes still match", async () => {
        expect.assertions(2);

        // A caller passing a trailing-slash basePath ("/auth/") must still
        // route both the exact path and nested paths instead of 404ing.
        const nested = await handleAuthRequest(auth, new Request("https://app.test/auth/get-session"), "/auth/");
        const exact = await handleAuthRequest(auth, new Request("https://app.test/auth"), "/auth/");

        expect(nested).toBeInstanceOf(Response);
        expect(exact).toBeInstanceOf(Response);
    });

    it("dEFAULT_AUTH_BASE_PATH is /api/auth", () => {
        expect.assertions(1);
        expect(DEFAULT_AUTH_BASE_PATH).toBe("/api/auth");
    });
});
