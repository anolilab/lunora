import type { CryptoKey, JWK } from "jose";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

import { bearerToken, cookieToken, firstToken, headerToken, jwtIdentityResolver, jwtVerifier, verifyJwt } from "../src";

const ISSUER = "https://issuer.example.test";
const AUDIENCE = "https://api.example.test";

const keyA = await generateKeyPair("RS256");
const keyB = await generateKeyPair("RS256");
const attacker = await generateKeyPair("RS256");

const publicJwk = async (key: CryptoKey, kid: string): Promise<JWK> => {
    return { ...(await exportJWK(key)), alg: "RS256", kid, use: "sig" };
};

const jwks = { keys: [await publicJwk(keyA.publicKey, "a")] };

interface SignOptions {
    aud?: string;
    exp?: number | string;
    iss?: string;
    key?: CryptoKey;
    kid?: string;
}

const sign = async (claims: Record<string, unknown>, options: SignOptions = {}): Promise<string> =>
    new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid: options.kid ?? "a" })
        .setIssuedAt()
        .setIssuer(options.iss ?? ISSUER)
        .setAudience(options.aud ?? AUDIENCE)
        .setExpirationTime(options.exp ?? "1h")
        .sign(options.key ?? keyA.privateKey);

const request = (headers: Record<string, string> = {}): Request => new Request("https://app.example.test/_lunora/rpc", { headers });

const resolver = jwtIdentityResolver({ audience: AUDIENCE, issuer: ISSUER, keySet: createLocalJWKSet(jwks) });

describe(jwtIdentityResolver, () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it("maps a valid bearer token's sub to userId and forwards exp", async () => {
        expect.assertions(2);

        const token = await sign({ sub: "user_1" });
        const identity = await resolver(request({ authorization: `Bearer ${token}` }));

        expect(identity?.userId).toBe("user_1");
        expect(identity?.exp).toBeGreaterThan(Date.now() / 1000);
    });

    it("resolves a missing token to anonymous", async () => {
        expect.assertions(1);

        await expect(resolver(request())).resolves.toBeNull();
    });

    it.each([
        ["wrong issuer", { iss: "https://evil.example.test" }],
        ["wrong audience", { aud: "https://other-api.example.test" }],
        ["foreign signing key", { key: attacker.privateKey }],
    ])("resolves a token with a %s to anonymous and reports it", async (_label, options) => {
        expect.assertions(2);

        const onError = vi.fn<(error: unknown, request: Request) => void>();
        const guarded = jwtIdentityResolver({ audience: AUDIENCE, issuer: ISSUER, keySet: createLocalJWKSet(jwks), onError });
        const token = await sign({ sub: "user_1" }, options);

        await expect(guarded(request({ authorization: `Bearer ${token}` }))).resolves.toBeNull();
        expect(onError).toHaveBeenCalledTimes(1);
    });

    it("resolves a malformed token and an alg:none token to anonymous", async () => {
        expect.assertions(2);

        const none = `${btoa(JSON.stringify({ alg: "none" }))}.${btoa(JSON.stringify({ iss: ISSUER, sub: "user_1" }))}.`;

        await expect(resolver(request({ authorization: "Bearer not.a.jwt" }))).resolves.toBeNull();
        await expect(resolver(request({ authorization: `Bearer ${none}` }))).resolves.toBeNull();
    });

    it("keeps an expired-but-genuine token's identity with its past exp so the runtime answers TOKEN_EXPIRED", async () => {
        expect.assertions(2);

        const past = Math.floor(Date.now() / 1000) - 60;
        const identity = await resolver(request({ authorization: `Bearer ${await sign({ sub: "user_1" }, { exp: past })}` }));

        expect(identity?.userId).toBe("user_1");
        expect(identity?.exp).toBe(past);
    });

    it("does not treat an expired token from the wrong issuer as genuine", async () => {
        expect.assertions(1);

        const past = Math.floor(Date.now() / 1000) - 60;
        const token = await sign({ sub: "user_1" }, { exp: past, iss: "https://evil.example.test" });

        await expect(resolver(request({ authorization: `Bearer ${token}` }))).resolves.toBeNull();
    });

    it("resolves a verified token without sub to anonymous", async () => {
        expect.assertions(1);

        await expect(resolver(request({ authorization: `Bearer ${await sign({})}` }))).resolves.toBeNull();
    });

    it("merges mapped claims, lets them override userId, and treats a null mapping as anonymous", async () => {
        expect.assertions(2);

        const mapped = jwtIdentityResolver({
            claims: (payload) => (payload.blocked === true ? null : { roles: ["admin"], userId: `ext:${String(payload.sub)}` }),
            issuer: ISSUER,
            keySet: createLocalJWKSet(jwks),
        });

        await expect(mapped(request({ authorization: `Bearer ${await sign({ sub: "u" })}` }))).resolves.toMatchObject({ roles: ["admin"], userId: "ext:u" });
        await expect(mapped(request({ authorization: `Bearer ${await sign({ blocked: true, sub: "u" })}` }))).resolves.toBeNull();
    });

    it("never lets mapped claims set the identity's expiry", async () => {
        expect.assertions(2);

        const exp = Math.floor(Date.now() / 1000) + 60;
        const mapped = jwtIdentityResolver({
            claims: () => {
                return { exp: exp + 86_400, expiresAtMs: Date.now() + 86_400_000 };
            },
            issuer: ISSUER,
            keySet: createLocalJWKSet(jwks),
        });
        const identity = await mapped(request({ authorization: `Bearer ${await sign({ sub: "u" }, { exp })}` }));

        expect(identity?.exp).toBe(exp);
        expect(identity).not.toHaveProperty("expiresAtMs");
    });

    it("reads a cookie when the token source falls back to one", async () => {
        expect.assertions(1);

        const fromCookie = jwtIdentityResolver({ issuer: ISSUER, keySet: createLocalJWKSet(jwks), token: firstToken(bearerToken, cookieToken("__session")) });
        const token = await sign({ sub: "user_c" });

        await expect(fromCookie(request({ cookie: `theme=dark; __session=${token}` }))).resolves.toMatchObject({ userId: "user_c" });
    });

    it("throws at construction when neither issuer nor jwksUrl is configured", () => {
        expect.assertions(2);

        expect(() => jwtIdentityResolver({ issuer: "" })).toThrow(/issuer/);
        expect(() => jwtIdentityResolver({ jwksUrl: "http://insecure.example.test/jwks" })).toThrow(/https/);
    });

    it("refetches the remote JWKS on an unknown kid after rotation", async () => {
        expect.assertions(4);

        let served: { keys: JWK[] } = jwks;
        const fetchMock = vi.fn<() => Promise<Response>>(async () => Response.json(served));

        vi.stubGlobal("fetch", fetchMock);
        vi.useFakeTimers({ toFake: ["Date"] });

        const remote = jwtIdentityResolver({ issuer: ISSUER, jwksUrl: "https://issuer.example.test/rotation/jwks.json" });

        await expect(remote(request({ authorization: `Bearer ${await sign({ sub: "user_1" })}` }))).resolves.toMatchObject({ userId: "user_1" });

        // The provider rotates to key B; jose holds A, so a B-signed token misses and triggers one refetch
        // once its cooldown has passed.
        served = { keys: [await publicJwk(keyA.publicKey, "a"), await publicJwk(keyB.publicKey, "b")] };
        vi.advanceTimersByTime(60_000);

        const rotated = await sign({ sub: "user_2" }, { key: keyB.privateKey, kid: "b" });

        await expect(remote(request({ authorization: `Bearer ${rotated}` }))).resolves.toMatchObject({ userId: "user_2" });
        expect(fetchMock).toHaveBeenCalledTimes(2);

        // Cached: a repeat verification does not fetch again.
        await remote(request({ authorization: `Bearer ${rotated}` }));

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("discovers the JWKS from the issuer's OIDC configuration and retries a failed discovery", async () => {
        expect.assertions(3);

        const issuer = "https://discovery.example.test";
        let discoveryUp = false;
        const fetchMock = vi.fn<(input: Request | string | URL) => Promise<Response>>(async (input) => {
            const url = String(input instanceof Request ? input.url : input);

            if (url.endsWith("/.well-known/openid-configuration")) {
                return discoveryUp ? Response.json({ issuer, jwks_uri: `${issuer}/keys` }) : new Response("down", { status: 503 });
            }

            return Response.json(jwks);
        });

        vi.stubGlobal("fetch", fetchMock);

        const discovered = jwtIdentityResolver({ issuer });
        const token = await sign({ sub: "user_d" }, { iss: issuer });

        await expect(discovered(request({ authorization: `Bearer ${token}` }))).resolves.toBeNull();

        discoveryUp = true;

        await expect(discovered(request({ authorization: `Bearer ${token}` }))).resolves.toMatchObject({ userId: "user_d" });
        expect(fetchMock.mock.calls.map(([input]) => String(input instanceof Request ? input.url : input))).toContain(`${issuer}/keys`);
    });

    it("requires exp by default", async () => {
        expect.assertions(1);

        const token = await new SignJWT({ sub: "user_1" })
            .setProtectedHeader({ alg: "RS256", kid: "a" })
            .setIssuer(ISSUER)
            .setAudience(AUDIENCE)
            .sign(keyA.privateKey);

        await expect(resolver(request({ authorization: `Bearer ${token}` }))).resolves.toBeNull();
    });

    it("accepts an iat a few seconds ahead of the worker's clock and refuses one minutes ahead", async () => {
        expect.assertions(2);

        const issuedAhead = async (seconds: number): Promise<string> =>
            new SignJWT({ sub: "user_1" })
                .setProtectedHeader({ alg: "RS256", kid: "a" })
                .setIssuedAt(Math.floor(Date.now() / 1000) + seconds)
                .setIssuer(ISSUER)
                .setAudience(AUDIENCE)
                .setExpirationTime("1h")
                .sign(keyA.privateKey);

        await expect(resolver(request({ authorization: `Bearer ${await issuedAhead(5)}` }))).resolves.toMatchObject({ userId: "user_1" });
        await expect(resolver(request({ authorization: `Bearer ${await issuedAhead(120)}` }))).resolves.toBeNull();
    });

    it("forwards exp plus the clock tolerance it was accepted under", async () => {
        expect.assertions(1);

        const exp = Math.floor(Date.now() / 1000) - 5;
        const lenient = jwtIdentityResolver({ audience: AUDIENCE, clockTolerance: 30, issuer: ISSUER, keySet: createLocalJWKSet(jwks) });

        await expect(lenient(request({ authorization: `Bearer ${await sign({ sub: "user_1" }, { exp })}` }))).resolves.toMatchObject({ exp: exp + 30 });
    });

    it("refuses OIDC discovery for a non-https issuer at construction", () => {
        expect.assertions(1);

        expect(() => jwtIdentityResolver({ issuer: "http://issuer.example.test" })).toThrow(/https `issuer`/);
    });

    it("refuses a malformed https jwksUrl or issuer at construction, not per request", () => {
        expect.assertions(2);

        expect(() => jwtIdentityResolver({ jwksUrl: "https://[bad" })).toThrow(/https URL/);
        expect(() => jwtIdentityResolver({ issuer: "https://[bad" })).toThrow(/https `issuer`/);
    });

    it("refuses a discovery document that names another issuer", async () => {
        expect.assertions(2);

        const issuer = "https://mismatch.example.test";
        const fetchMock = vi.fn<(input: Request | string | URL) => Promise<Response>>(async (input) => {
            const url = String(input instanceof Request ? input.url : input);

            return url.endsWith("/.well-known/openid-configuration")
                ? Response.json({ issuer: "https://evil.example.test", jwks_uri: `${issuer}/keys` })
                : Response.json(jwks);
        });

        vi.stubGlobal("fetch", fetchMock);

        const discovered = jwtIdentityResolver({ issuer });

        await expect(discovered(request({ authorization: `Bearer ${await sign({ sub: "user_d" }, { iss: issuer })}` }))).resolves.toBeNull();
        expect(fetchMock.mock.calls.map(([input]) => String(input instanceof Request ? input.url : input))).not.toContain(`${issuer}/keys`);
    });
});

describe(jwtVerifier, () => {
    const verify = jwtVerifier({ audience: AUDIENCE, issuer: ISSUER, keySet: createLocalJWKSet(jwks), token: headerToken("x-assertion") });

    it("returns the payload of a valid token read from a custom header", async () => {
        expect.assertions(1);

        await expect(verify(request({ "x-assertion": await sign({ sub: "user_1" }) }))).resolves.toMatchObject({ expired: false, payload: { sub: "user_1" } });
    });

    it("reports a throwing token source to onError and resolves anonymous", async () => {
        expect.assertions(2);

        const onError = vi.fn<(error: unknown) => void>();
        const throwing = jwtVerifier({
            issuer: ISSUER,
            keySet: createLocalJWKSet(jwks),
            onError,
            token: () => {
                throw new Error("unparseable");
            },
        });

        await expect(throwing(request())).resolves.toBeUndefined();
        expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "unparseable" }), expect.any(Request));
    });

    it("applies the key-source checks to a direct verifyJwt call", async () => {
        expect.assertions(1);

        await expect(verifyJwt(await sign({ sub: "user_1" }), { issuer: "http://issuer.example.test" })).rejects.toThrow(/https `issuer`/);
    });

    it("flags an expired-but-genuine token and drops an expired forgery", async () => {
        expect.assertions(2);

        const past = Math.floor(Date.now() / 1000) - 60;

        await expect(verify(request({ "x-assertion": await sign({ sub: "user_1" }, { exp: past }) }))).resolves.toMatchObject({ expired: true });
        await expect(verify(request({ "x-assertion": await sign({ sub: "user_1" }, { exp: past, key: attacker.privateKey }) }))).resolves.toBeUndefined();
    });
});
