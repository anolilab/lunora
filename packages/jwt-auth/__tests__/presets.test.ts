import { generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

import { auth0, clerk, supabase, workos } from "../src";

const { privateKey, publicKey } = await generateKeyPair("RS256");
const ec = await generateKeyPair("ES256");

interface SignOptions {
    alg?: string;
    aud?: string;
    exp?: number | string;
}

const sign = async (claims: Record<string, unknown>, iss: string, options: SignOptions = {}): Promise<string> => {
    const alg = options.alg ?? "RS256";
    const jwt = new SignJWT(claims)
        .setProtectedHeader({ alg })
        .setIssuedAt()
        .setIssuer(iss)
        .setExpirationTime(options.exp ?? "1h");

    return (options.aud === undefined ? jwt : jwt.setAudience(options.aud)).sign(alg === "ES256" ? ec.privateKey : privateKey);
};

const bearer = (token: string): Request => new Request("https://api.example.test/_lunora/rpc", { headers: { authorization: `Bearer ${token}` } });

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

describe(clerk, () => {
    const issuer = "https://clerk.example.test";
    const authorizedParties = ["https://app.example.test"];
    const resolveClerk = clerk({ authorizedParties, issuer, keySet: publicKey });

    it("derives the Frontend API from a publishable key", async () => {
        expect.assertions(1);

        const resolve = clerk({ authorizedParties, keySet: publicKey, publishableKey: `pk_test_${btoa("clerk.example.test$")}` });

        await expect(resolve(bearer(await sign({ sub: "user_1" }, issuer)))).resolves.toMatchObject({ userId: "user_1" });
    });

    it("rejects a malformed or missing publishable key at construction, naming the env var", () => {
        expect.assertions(2);

        expect(() => clerk({ authorizedParties, publishableKey: "sk_test_nope" })).toThrow(/publishable key/);
        expect(() => clerk({ authorizedParties, publishableKey: "" })).toThrow(/CLERK_PUBLISHABLE_KEY/);
    });

    it("refuses an empty authorizedParties at construction", () => {
        expect.assertions(2);

        expect(() => clerk({ authorizedParties: [], issuer })).toThrow(/authorizedParties/);
        expect(() => clerk({ authorizedParties: " , ", issuer })).toThrow(/CSRF/);
    });

    it("reads a comma-separated authorizedParties as an env var holds it", async () => {
        expect.assertions(2);

        const resolve = clerk({ authorizedParties: "https://other.example.test, https://app.example.test", issuer, keySet: publicKey });

        await expect(resolve(bearer(await sign({ azp: "https://app.example.test", sub: "user_1" }, issuer)))).resolves.toMatchObject({ userId: "user_1" });
        await expect(resolve(bearer(await sign({ azp: "https://evil.example.test", sub: "user_1" }, issuer)))).resolves.toBeNull();
    });

    it("maps v2 org claims, namespaces the org role and decodes permissions from the fea / per / fpm bitmasks", async () => {
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

        await expect(resolveClerk(bearer(token))).resolves.toStrictEqual({
            exp: expect.any(Number),
            orgId: "org_1",
            orgPermissions: ["org:dashboard:manage", "org:dashboard:read", "org:teams:read"],
            orgRole: "org:admin",
            orgSlug: "acme",
            sessionId: "sess_1",
            userId: "user_1",
        });
    });

    it("never turns an org role into an app-wide RLS role", async () => {
        expect.assertions(2);

        const v2 = await resolveClerk(bearer(await sign({ o: { id: "org_mine", rol: "admin" }, sub: "user_1", v: 2 }, issuer)));
        const v1 = await resolveClerk(bearer(await sign({ org_id: "org_mine", org_role: "org:admin", sub: "user_1" }, issuer)));

        expect(v2).not.toHaveProperty("roles");
        expect(v1).not.toHaveProperty("roles");
    });

    it("aligns fpm with the org-scoped features only, after a user feature, and trims entries", async () => {
        expect.assertions(1);

        const token = await sign(
            { fea: "u:beta, o:dashboard ,ou:teams", o: { fpm: "3, 2", id: "org_1", per: "manage, read", rol: "member" }, sub: "user_1", v: 2 },
            issuer,
        );

        await expect(resolveClerk(bearer(token))).resolves.toMatchObject({
            orgPermissions: ["org:dashboard:manage", "org:dashboard:read", "org:teams:read"],
        });
    });

    it.each([
        ["no fpm", { fea: "o:dashboard", o: { id: "org_1", per: "manage,read", rol: "admin" } }],
        ["a mask count that does not match the org features", { fea: "o:dashboard,o:teams", o: { fpm: "3", id: "org_1", per: "manage,read", rol: "admin" } }],
        ["a non-integer mask", { fea: "o:dashboard", o: { fpm: "x", id: "org_1", per: "manage,read", rol: "admin" } }],
        ["a feature without a scope", { fea: "dashboard", o: { fpm: "1", id: "org_1", per: "manage", rol: "admin" } }],
        ["a v1 list next to a v2 org", { fea: "o:dashboard", o: { id: "org_1", per: "manage", rol: "admin" }, org_permissions: ["org:dashboard:manage"] }],
    ])("forwards no v2 org permissions for %s (fail closed)", async (_label, claims) => {
        expect.assertions(2);

        const identity = await resolveClerk(bearer(await sign({ ...claims, sub: "user_1", v: 2 }, issuer)));

        expect(identity?.orgId).toBe("org_1");
        expect(identity).not.toHaveProperty("orgPermissions");
    });

    it("reads v1 claims when v is not 2, even if an o claim is present", async () => {
        expect.assertions(1);

        const token = await sign(
            { o: { id: "org_v2", rol: "admin" }, org_id: "org_1", org_permissions: ["org:posts:read"], org_role: "org:member", sub: "user_1" },
            issuer,
        );

        await expect(resolveClerk(bearer(token))).resolves.toMatchObject({ orgId: "org_1", orgPermissions: ["org:posts:read"], orgRole: "org:member" });
    });

    it("refuses an unauthorized azp and a pending session, and accepts a token without azp", async () => {
        expect.assertions(3);

        await expect(resolveClerk(bearer(await sign({ azp: "https://evil.example.test", sub: "user_1" }, issuer)))).resolves.toBeNull();
        await expect(resolveClerk(bearer(await sign({ sts: "pending", sub: "user_1" }, issuer)))).resolves.toBeNull();
        await expect(resolveClerk(bearer(await sign({ sub: "user_native" }, issuer)))).resolves.toMatchObject({ userId: "user_native" });
    });

    it("falls back to the __session cookie", async () => {
        expect.assertions(1);

        const token = await sign({ sub: "user_cookie" }, issuer);
        const request = new Request("https://app.example.test/_lunora/ws", { headers: { cookie: `__session=${token}` } });

        await expect(resolveClerk(request)).resolves.toMatchObject({ userId: "user_cookie" });
    });

    it("tolerates Clerk's default 5 s of clock skew and forwards exp with it", async () => {
        expect.assertions(2);

        const exp = nowSeconds() - 2;
        const identity = await resolveClerk(bearer(await sign({ sub: "user_1" }, issuer, { exp })));

        expect(identity?.userId).toBe("user_1");
        // The runtime has no skew allowance, so the forwarded expiry carries the tolerance.
        expect(identity?.exp).toBe(exp + 5);
    });

    it("refuses a token issued in the future", async () => {
        expect.assertions(1);

        const token = await new SignJWT({ sub: "user_1" })
            .setProtectedHeader({ alg: "RS256" })
            .setIssuedAt(nowSeconds() + 600)
            .setIssuer(issuer)
            .setExpirationTime("2h")
            .sign(privateKey);

        await expect(resolveClerk(bearer(token))).resolves.toBeNull();
    });
});

describe(workos, () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    const userClaims = { auth_time: 1_700_000_000, client_id: "client_1", sid: "session_1", sub: "user_01" };

    it("accepts the production user_management issuer and both bare spellings, and maps org / role / permissions", async () => {
        expect.assertions(3);

        const resolve = workos({ clientId: "client_1", keySet: publicKey });
        const claims = { ...userClaims, org_id: "org_1", permissions: ["posts:write"], role: "admin", roles: ["admin"] };

        await expect(resolve(bearer(await sign(claims, "https://api.workos.com/user_management/client_1")))).resolves.toStrictEqual({
            exp: expect.any(Number),
            orgId: "org_1",
            orgRoles: ["admin"],
            permissions: ["posts:write"],
            role: "admin",
            sessionId: "session_1",
            userId: "user_01",
        });
        await expect(resolve(bearer(await sign(claims, "https://api.workos.com")))).resolves.toMatchObject({ userId: "user_01" });
        await expect(resolve(bearer(await sign(claims, "https://api.workos.com/")))).resolves.toMatchObject({ userId: "user_01" });
    });

    it("refuses another client's user_management issuer", async () => {
        expect.assertions(1);

        const token = await sign(userClaims, "https://api.workos.com/user_management/client_other");

        await expect(workos({ clientId: "client_1", keySet: publicKey })(bearer(token))).resolves.toBeNull();
    });

    it("keeps a path passed in authDomain as the exact issuer and serves the JWKS from that host", async () => {
        expect.assertions(3);

        const fetched: string[] = [];

        vi.stubGlobal(
            "fetch",
            vi.fn<(input: Request | string | URL) => Promise<Response>>(async (input) => {
                fetched.push(String(input instanceof Request ? input.url : input));

                return Response.json({ keys: [] });
            }),
        );

        const custom = workos({ authDomain: "auth.example.test/user_management/client_1", clientId: "client_1", keySet: publicKey });

        await expect(custom(bearer(await sign(userClaims, "https://auth.example.test/user_management/client_1")))).resolves.toMatchObject({
            userId: "user_01",
        });
        await expect(custom(bearer(await sign(userClaims, "https://auth.example.test")))).resolves.toBeNull();

        await workos({ authDomain: "auth.example.test", clientId: "client_1" })(bearer(await sign(userClaims, "https://auth.example.test")));

        expect(fetched).toStrictEqual(["https://auth.example.test/sso/jwks/client_1"]);
    });

    it("refuses a token minted for another client", async () => {
        expect.assertions(1);

        const token = await sign({ ...userClaims, client_id: "client_other" }, "https://api.workos.com");

        await expect(workos({ clientId: "client_1", keySet: publicKey })(bearer(token))).resolves.toBeNull();
    });

    it.each([
        ["no sid", { sid: undefined }],
        ["no auth_time", { auth_time: undefined }],
        ["an agent sub_profile", { sub_profile: "agent" }],
        ["a widget sub_type", { sub_type: "widget" }],
    ])("refuses a token with %s, on the expired path too", async (_label, override) => {
        expect.assertions(2);

        const resolve = workos({ clientId: "client_1", keySet: publicKey });
        const claims = { ...userClaims, ...override };
        const issuer = "https://api.workos.com";

        await expect(resolve(bearer(await sign(claims, issuer)))).resolves.toBeNull();
        await expect(resolve(bearer(await sign(claims, issuer, { exp: nowSeconds() - 60 })))).resolves.toBeNull();
    });

    it("forwards the impersonator only from an act object", async () => {
        expect.assertions(2);

        const resolve = workos({ clientId: "client_1", keySet: publicKey });

        await expect(resolve(bearer(await sign({ ...userClaims, act: { sub: "admin@example.test" } }, "https://api.workos.com")))).resolves.toMatchObject({
            impersonator: "admin@example.test",
        });
        await expect(resolve(bearer(await sign({ ...userClaims, act: "admin@example.test" }, "https://api.workos.com")))).resolves.not.toHaveProperty(
            "impersonator",
        );
    });
});

describe(auth0, () => {
    const options = { audience: "https://api.example.test", domain: "acme.auth0.com", keySet: publicKey };
    const issuer = "https://acme.auth0.com/";
    const aud = "https://api.example.test";

    it("checks the trailing-slash issuer and the API audience, and splits scope", async () => {
        expect.assertions(2);

        const resolve = auth0(options);

        await expect(
            resolve(bearer(await sign({ org_id: "org_1", permissions: ["read:posts"], scope: "openid read:posts", sub: "auth0|1" }, issuer, { aud }))),
        ).resolves.toMatchObject({
            orgId: "org_1",
            permissions: ["read:posts"],
            scopes: ["openid", "read:posts"],
            userId: "auth0|1",
        });
        await expect(resolve(bearer(await sign({ sub: "auth0|1" }, issuer, { aud: "https://other.example.test" })))).resolves.toBeNull();
    });

    it.each([
        ["an Auth0-profile client-credentials token", { gty: "client-credentials", sub: "abc@clients" }],
        ["an RFC 9068 client-credentials token (no gty)", { client_id: "abc", sub: "abc@clients" }],
        ["an agent token without the @clients suffix", { sub: "agent_1", sub_profile: "ai_agent" }],
    ])("resolves %s to anonymous unless allowClientCredentials is set", async (_label, claims) => {
        expect.assertions(2);

        const token = await sign(claims, issuer, { aud });

        await expect(auth0(options)(bearer(token))).resolves.toBeNull();
        await expect(auth0({ ...options, allowClientCredentials: true })(bearer(token))).resolves.toMatchObject({ userId: claims.sub });
    });

    it("accepts a user token that names a user sub_profile", async () => {
        expect.assertions(1);

        await expect(auth0(options)(bearer(await sign({ sub: "auth0|1", sub_profile: "user" }, issuer, { aud })))).resolves.toMatchObject({
            userId: "auth0|1",
        });
    });
});

describe(supabase, () => {
    it("verifies an ES256 user token and refuses an anon-audience one", async () => {
        expect.assertions(2);

        const resolve = supabase({ keySet: ec.publicKey, projectUrl: "https://ref.supabase.co" });
        const issuer = "https://ref.supabase.co/auth/v1";

        await expect(
            resolve(bearer(await sign({ email: "a@b.test", role: "authenticated", sub: "uuid-1" }, issuer, { alg: "ES256", aud: "authenticated" }))),
        ).resolves.toMatchObject({
            email: "a@b.test",
            role: "authenticated",
            userId: "uuid-1",
        });
        await expect(resolve(bearer(await sign({ sub: "uuid-1" }, issuer, { alg: "ES256", aud: "anon" })))).resolves.toBeNull();
    });

    it("resolves an anonymous sign-in to anonymous unless allowAnonymousUsers is set", async () => {
        expect.assertions(2);

        const token = await sign({ is_anonymous: true, role: "authenticated", sub: "uuid-guest" }, "https://ref.supabase.co/auth/v1", {
            alg: "ES256",
            aud: "authenticated",
        });

        await expect(supabase({ keySet: ec.publicKey, projectUrl: "https://ref.supabase.co" })(bearer(token))).resolves.toBeNull();
        await expect(
            supabase({ allowAnonymousUsers: true, keySet: ec.publicKey, projectUrl: "https://ref.supabase.co" })(bearer(token)),
        ).resolves.toMatchObject({
            isAnonymous: true,
            userId: "uuid-guest",
        });
    });
});
