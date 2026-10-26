import { generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";

import { auth0, clerk, supabase, workos } from "../src";

const { privateKey, publicKey } = await generateKeyPair("RS256");
const ec = await generateKeyPair("ES256");

const sign = async (claims: Record<string, unknown>, iss: string, aud?: string, alg = "RS256"): Promise<string> => {
    const jwt = new SignJWT(claims).setProtectedHeader({ alg }).setIssuedAt().setIssuer(iss).setExpirationTime("1h");

    return (aud === undefined ? jwt : jwt.setAudience(aud)).sign(alg === "ES256" ? ec.privateKey : privateKey);
};

const bearer = (token: string): Request => new Request("https://api.example.test/_lunora/rpc", { headers: { authorization: `Bearer ${token}` } });

describe(clerk, () => {
    const issuer = "https://clerk.example.test";

    it("derives the Frontend API from a publishable key", async () => {
        expect.assertions(1);

        const resolve = clerk({ keySet: publicKey, publishableKey: `pk_test_${btoa("clerk.example.test$")}` });

        await expect(resolve(bearer(await sign({ sub: "user_1" }, issuer)))).resolves.toMatchObject({ userId: "user_1" });
    });

    it("rejects a malformed publishable key at construction", () => {
        expect.assertions(1);

        expect(() => clerk({ publishableKey: "sk_test_nope" })).toThrow(/publishable key/);
    });

    it("maps v2 org claims and decodes permissions from the fea / per / fpm bitmasks", async () => {
        expect.assertions(1);

        // Clerk's documented example: dashboard gets manage+read (3 = 0b11), teams only read (2 = 0b10).
        const token = await sign(
            {
                azp: "https://app.example.test",
                fea: "o:dashboard,o:teams",
                o: { fpm: "3,2", id: "org_1", per: "manage,read", rol: "admin", slg: "acme" },
                sid: "sess_1",
                sub: "user_1",
                v: 2,
            },
            issuer,
        );

        await expect(clerk({ issuer, keySet: publicKey })(bearer(token))).resolves.toStrictEqual({
            exp: expect.any(Number),
            orgId: "org_1",
            orgPermissions: ["org:dashboard:manage", "org:dashboard:read", "org:teams:read"],
            orgRole: "admin",
            orgSlug: "acme",
            roles: ["admin"],
            sessionId: "sess_1",
            userId: "user_1",
        });
    });

    it.each([
        ["no fpm", { fea: "o:dashboard", o: { id: "org_1", per: "manage,read", rol: "admin" } }],
        ["a mask count that does not match fea", { fea: "o:dashboard,o:teams", o: { fpm: "3", id: "org_1", per: "manage,read", rol: "admin" } }],
        ["a non-integer mask", { fea: "o:dashboard", o: { fpm: "x", id: "org_1", per: "manage,read", rol: "admin" } }],
        ["a v1 list next to a v2 org", { fea: "o:dashboard", o: { id: "org_1", per: "manage", rol: "admin" }, org_permissions: ["org:dashboard:manage"] }],
    ])("forwards no v2 org permissions for %s (fail closed)", async (_label, claims) => {
        expect.assertions(2);

        const identity = await clerk({ issuer, keySet: publicKey })(bearer(await sign({ ...claims, sub: "user_1" }, issuer)));

        expect(identity?.orgId).toBe("org_1");
        expect(identity).not.toHaveProperty("orgPermissions");
    });

    it("skips user-scoped features when decoding v2 org permissions", async () => {
        expect.assertions(1);

        const token = await sign({ fea: "u:beta,o:teams", o: { fpm: "1,1", id: "org_1", per: "read", rol: "member" }, sub: "user_1" }, issuer);

        await expect(clerk({ issuer, keySet: publicKey })(bearer(token))).resolves.toMatchObject({ orgPermissions: ["org:teams:read"] });
    });

    it("maps v1 org claims and strips the org: role prefix", async () => {
        expect.assertions(1);

        const token = await sign({ org_id: "org_1", org_permissions: ["org:posts:read"], org_role: "org:member", sub: "user_1" }, issuer);

        await expect(clerk({ issuer, keySet: publicKey })(bearer(token))).resolves.toMatchObject({
            orgId: "org_1",
            orgPermissions: ["org:posts:read"],
            roles: ["member"],
        });
    });

    it("refuses an unauthorized azp and a pending session", async () => {
        expect.assertions(2);

        const resolve = clerk({ authorizedParties: ["https://app.example.test"], issuer, keySet: publicKey });

        await expect(resolve(bearer(await sign({ azp: "https://evil.example.test", sub: "user_1" }, issuer)))).resolves.toBeNull();
        await expect(resolve(bearer(await sign({ sts: "pending", sub: "user_1" }, issuer)))).resolves.toBeNull();
    });

    it("falls back to the __session cookie", async () => {
        expect.assertions(1);

        const token = await sign({ sub: "user_cookie" }, issuer);
        const request = new Request("https://app.example.test/_lunora/ws", { headers: { cookie: `__session=${token}` } });

        await expect(clerk({ issuer, keySet: publicKey })(request)).resolves.toMatchObject({ userId: "user_cookie" });
    });
});

describe(workos, () => {
    it("accepts both iss spellings and maps org / role / permissions", async () => {
        expect.assertions(2);

        const resolve = workos({ clientId: "client_1", keySet: publicKey });
        const claims = { client_id: "client_1", org_id: "org_1", permissions: ["posts:write"], role: "admin", sid: "session_1", sub: "user_01" };

        await expect(resolve(bearer(await sign(claims, "https://api.workos.com")))).resolves.toMatchObject({
            orgId: "org_1",
            permissions: ["posts:write"],
            role: "admin",
            roles: ["admin"],
            sessionId: "session_1",
            userId: "user_01",
        });
        await expect(resolve(bearer(await sign(claims, "https://api.workos.com/")))).resolves.toMatchObject({ userId: "user_01" });
    });

    it("refuses a token minted for another client", async () => {
        expect.assertions(1);

        const token = await sign({ client_id: "client_other", sub: "user_01" }, "https://api.workos.com");

        await expect(workos({ clientId: "client_1", keySet: publicKey })(bearer(token))).resolves.toBeNull();
    });
});

describe(auth0, () => {
    it("checks the trailing-slash issuer and the API audience", async () => {
        expect.assertions(2);

        const resolve = auth0({ audience: "https://api.example.test", domain: "acme.auth0.com", keySet: publicKey });

        await expect(
            resolve(
                bearer(await sign({ org_id: "org_1", permissions: ["read:posts"], sub: "auth0|1" }, "https://acme.auth0.com/", "https://api.example.test")),
            ),
        ).resolves.toMatchObject({
            orgId: "org_1",
            permissions: ["read:posts"],
            userId: "auth0|1",
        });
        await expect(resolve(bearer(await sign({ sub: "auth0|1" }, "https://acme.auth0.com/", "https://other.example.test")))).resolves.toBeNull();
    });
});

describe("auth0 machine tokens", () => {
    it("resolves a client-credentials token to anonymous unless allowClientCredentials is set", async () => {
        expect.assertions(2);

        const token = await sign({ gty: "client-credentials", sub: "abc@clients" }, "https://acme.auth0.com/", "https://api.example.test");
        const options = { audience: "https://api.example.test", domain: "acme.auth0.com", keySet: publicKey };

        await expect(auth0(options)(bearer(token))).resolves.toBeNull();
        await expect(auth0({ ...options, allowClientCredentials: true })(bearer(token))).resolves.toMatchObject({ userId: "abc@clients" });
    });
});

describe(supabase, () => {
    it("verifies an ES256 user token and refuses an anon-audience one", async () => {
        expect.assertions(2);

        const resolve = supabase({ keySet: ec.publicKey, projectUrl: "https://ref.supabase.co" });
        const issuer = "https://ref.supabase.co/auth/v1";

        await expect(
            resolve(bearer(await sign({ email: "a@b.test", role: "authenticated", sub: "uuid-1" }, issuer, "authenticated", "ES256"))),
        ).resolves.toMatchObject({
            email: "a@b.test",
            role: "authenticated",
            userId: "uuid-1",
        });
        await expect(resolve(bearer(await sign({ sub: "uuid-1" }, issuer, "anon", "ES256")))).resolves.toBeNull();
    });

    it("resolves an anonymous sign-in to anonymous unless allowAnonymousUsers is set", async () => {
        expect.assertions(2);

        const token = await sign({ is_anonymous: true, role: "authenticated", sub: "uuid-guest" }, "https://ref.supabase.co/auth/v1", "authenticated", "ES256");

        await expect(supabase({ keySet: ec.publicKey, projectUrl: "https://ref.supabase.co" })(bearer(token))).resolves.toBeNull();
        await expect(
            supabase({ allowAnonymousUsers: true, keySet: ec.publicKey, projectUrl: "https://ref.supabase.co" })(bearer(token)),
        ).resolves.toMatchObject({
            isAnonymous: true,
            userId: "uuid-guest",
        });
    });
});
