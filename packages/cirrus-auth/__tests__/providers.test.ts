import { describe, expect, test } from "vitest";

import { emailPassword } from "../src/providers/emailPassword.js";
import { github } from "../src/providers/github.js";
import { google } from "../src/providers/google.js";
import { buildAuthorizeRedirect, deriveCodeChallenge } from "../src/routes/oauth.js";
import { FakeD1 } from "./_fakeD1.js";

describe("providers", () => {
    test("emailPassword contributes the four standard routes", () => {
        const config = emailPassword();
        const routes = config.routes({ secret: "s", sessionTtlSeconds: 1000, cookieName: "c", db: new FakeD1() });

        expect(Object.keys(routes).sort()).toEqual([
            "GET /auth/me",
            "POST /auth/signin",
            "POST /auth/signout",
            "POST /auth/signup",
        ]);
    });

    test("github contributes start + callback routes", () => {
        const routes = github({ clientId: "id", clientSecret: "secret" }).routes({
            secret: "s",
            sessionTtlSeconds: 1000,
            cookieName: "c",
            db: new FakeD1(),
        });

        expect(Object.keys(routes).sort()).toEqual(["GET /auth/oauth/github/callback", "GET /auth/oauth/github/start"]);
    });

    test("google contributes start + callback routes", () => {
        const routes = google({ clientId: "id", clientSecret: "secret" }).routes({
            secret: "s",
            sessionTtlSeconds: 1000,
            cookieName: "c",
            db: new FakeD1(),
        });

        expect(Object.keys(routes).sort()).toEqual(["GET /auth/oauth/google/callback", "GET /auth/oauth/google/start"]);
    });

    test("buildAuthorizeRedirect emits PKCE params", () => {
        const url = buildAuthorizeRedirect(
            {
                id: "github",
                authorizationUrl: "https://github.com/login/oauth/authorize",
                defaultScope: "read:user",
                clientId: "abc",
                clientSecret: "xyz",
            },
            "https://app.example/auth/oauth/github/callback",
            "state-1",
            "challenge-1",
        );

        const parsed = new URL(url);

        expect(parsed.searchParams.get("client_id")).toBe("abc");
        expect(parsed.searchParams.get("response_type")).toBe("code");
        expect(parsed.searchParams.get("scope")).toBe("read:user");
        expect(parsed.searchParams.get("state")).toBe("state-1");
        expect(parsed.searchParams.get("code_challenge")).toBe("challenge-1");
        expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    });

    test("deriveCodeChallenge produces a base64url string", async () => {
        const challenge = await deriveCodeChallenge("verifier-1234567890");

        expect(challenge).toMatch(/^[\w-]+$/);
        expect(challenge.includes("=")).toBe(false);
    });
});
