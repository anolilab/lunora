import type { CryptoKey } from "jose";
import { generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import { accessIssuer, verifyAccessJwt } from "../src/verify";

const TEAM = "acme";
const ISSUER = "https://acme.cloudflareaccess.com";
const AUD = "app-aud-tag";

let publicKey: CryptoKey;
let privateKey: CryptoKey;

interface SignOptions {
    alg?: string;
    aud?: string;
    exp?: number | string;
    iss?: string;
    key?: CryptoKey | Uint8Array;
}

const sign = async (claims: Record<string, unknown>, options: SignOptions = {}): Promise<string> =>
    new SignJWT(claims)
        .setProtectedHeader({ alg: options.alg ?? "RS256" })
        .setIssuedAt()
        .setIssuer(options.iss ?? ISSUER)
        .setAudience(options.aud ?? AUD)
        .setExpirationTime(options.exp ?? "2h")
        .sign(options.key ?? privateKey);

beforeAll(async () => {
    ({ privateKey, publicKey } = await generateKeyPair("RS256"));
});

describe("accessIssuer", () => {
    it("expands a bare team name to the cloudflareaccess.com host", () => {
        expect(accessIssuer("acme")).toBe("https://acme.cloudflareaccess.com");
    });

    it("accepts a full host or URL and strips scheme/trailing slash", () => {
        expect(accessIssuer("acme.cloudflareaccess.com")).toBe("https://acme.cloudflareaccess.com");
        expect(accessIssuer("https://acme.cloudflareaccess.com/")).toBe("https://acme.cloudflareaccess.com");
    });

    it("rejects an empty team domain", () => {
        expect(() => accessIssuer("   ")).toThrow(/teamDomain/);
    });
});

describe("verifyAccessJwt", () => {
    it("verifies a well-formed token and returns its claims", async () => {
        const token = await sign({ email: "user@acme.test", groups: ["eng"], sub: "user-1" });

        const claims = await verifyAccessJwt(token, { aud: AUD, keySet: publicKey, teamDomain: TEAM });

        expect(claims.sub).toBe("user-1");
        expect(claims.email).toBe("user@acme.test");
        expect(claims.groups).toEqual(["eng"]);
        expect(claims.iss).toBe(ISSUER);
    });

    it("accepts an array of allowed audiences", async () => {
        const token = await sign({ sub: "user-1" }, { aud: AUD });

        await expect(verifyAccessJwt(token, { aud: ["other", AUD], keySet: publicKey, teamDomain: TEAM })).resolves.toMatchObject({ sub: "user-1" });
    });

    it("rejects a token for a different audience", async () => {
        const token = await sign({ sub: "user-1" }, { aud: "someone-elses-app" });

        await expect(verifyAccessJwt(token, { aud: AUD, keySet: publicKey, teamDomain: TEAM })).rejects.toThrow();
    });

    it("refuses to verify when no audience is configured (missing/empty aud)", async () => {
        const token = await sign({ sub: "user-1" });

        // A missing or empty `aud` makes jose skip the audience check entirely,
        // accepting a token minted for any other app in the same team. The guard
        // throws before `jwtVerify`, so callers fail closed rather than fail open.
        await expect(verifyAccessJwt(token, { aud: undefined as unknown as string, keySet: publicKey, teamDomain: TEAM })).rejects.toThrow(/aud/);
        await expect(verifyAccessJwt(token, { aud: "", keySet: publicKey, teamDomain: TEAM })).rejects.toThrow(/aud/);
        await expect(verifyAccessJwt(token, { aud: [], keySet: publicKey, teamDomain: TEAM })).rejects.toThrow(/aud/);
        await expect(verifyAccessJwt(token, { aud: [""], keySet: publicKey, teamDomain: TEAM })).rejects.toThrow(/aud/);
    });

    it("rejects a token from a different issuer (team)", async () => {
        const token = await sign({ sub: "user-1" }, { iss: "https://evil.cloudflareaccess.com" });

        await expect(verifyAccessJwt(token, { aud: AUD, keySet: publicKey, teamDomain: TEAM })).rejects.toThrow();
    });

    it("rejects an expired token", async () => {
        const token = await sign({ sub: "user-1" }, { exp: Math.floor(Date.now() / 1000) - 3600 });

        await expect(verifyAccessJwt(token, { aud: AUD, keySet: publicKey, teamDomain: TEAM })).rejects.toThrow();
    });

    it("honors clock tolerance for a just-expired token", async () => {
        const token = await sign({ sub: "user-1" }, { exp: Math.floor(Date.now() / 1000) - 10 });

        await expect(verifyAccessJwt(token, { aud: AUD, clockToleranceSec: 60, keySet: publicKey, teamDomain: TEAM })).resolves.toMatchObject({
            sub: "user-1",
        });
    });

    it("rejects an HS256-signed forgery (algorithm is pinned to RS256)", async () => {
        const secret = new TextEncoder().encode("a-shared-secret-that-should-never-be-accepted");
        const token = await sign({ sub: "user-1" }, { alg: "HS256", key: secret });

        await expect(verifyAccessJwt(token, { aud: AUD, keySet: publicKey, teamDomain: TEAM })).rejects.toThrow();
    });

    it("rejects a token signed by an unknown key", async () => {
        const attacker = await generateKeyPair("RS256");
        const token = await sign({ sub: "user-1" }, { key: attacker.privateKey });

        await expect(verifyAccessJwt(token, { aud: AUD, keySet: publicKey, teamDomain: TEAM })).rejects.toThrow();
    });
});
