import type { CryptoKey } from "jose";
import { generateKeyPair, SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";

import { composeResolvers, createAccessResolver } from "../src/resolver";
import type { ResolvedIdentityLike } from "../src/types";

const TEAM = "acme";
const ISSUER = "https://acme.cloudflareaccess.com";
const AUD = "app-aud-tag";

const { privateKey, publicKey } = await generateKeyPair("RS256");

const sign = async (claims: Record<string, unknown>, key: CryptoKey = privateKey): Promise<string> =>
    new SignJWT(claims).setProtectedHeader({ alg: "RS256" }).setIssuedAt().setIssuer(ISSUER).setAudience(AUD).setExpirationTime("2h").sign(key);

const requestWithHeader = (token: string): Request => new Request("https://app.test/_lunora/rpc", { headers: { "cf-access-jwt-assertion": token } });

const requestWithCookie = (token: string, cookie = "CF_Authorization"): Request =>
    new Request("https://app.test/", { headers: { cookie: `foo=bar; ${cookie}=${token}; baz=qux` } });

describe("createAccessResolver", () => {
    it("resolves an SSO identity from the Cf-Access-Jwt-Assertion header", async () => {
        expect.assertions(6);

        const resolve = createAccessResolver({ aud: AUD, keySet: publicKey, teamDomain: TEAM });
        const token = await sign({ email: "user@acme.test", groups: ["eng", "admins"], sub: "user-1" });

        const identity = await resolve(requestWithHeader(token));

        expect(identity).not.toBeNull();
        expect(identity?.userId).toBe("user-1");
        expect(identity?.email).toBe("user@acme.test");
        expect(identity?.groups).toEqual(["eng", "admins"]);
        expect(typeof identity?.exp).toBe("number");
        expect((identity?.access as { email?: string }).email).toBe("user@acme.test");
    });

    it("falls back to the CF_Authorization cookie", async () => {
        expect.assertions(1);

        const resolve = createAccessResolver({ aud: AUD, keySet: publicKey, teamDomain: TEAM });
        const token = await sign({ email: "user@acme.test", sub: "user-2" });

        const identity = await resolve(requestWithCookie(token));

        expect(identity?.userId).toBe("user-2");
    });

    it("derives userId from common_name for a service token (empty sub)", async () => {
        expect.assertions(3);

        const resolve = createAccessResolver({ aud: AUD, keySet: publicKey, teamDomain: TEAM });
        const token = await sign({ common_name: "ci-bot", sub: "" });

        const identity = await resolve(requestWithHeader(token));

        expect(identity?.userId).toBe("ci-bot");
        expect(identity?.commonName).toBe("ci-bot");
        expect(identity?.email).toBeUndefined();
    });

    it("returns null when no token is present (anonymous)", async () => {
        expect.assertions(1);

        const resolve = createAccessResolver({ aud: AUD, keySet: publicKey, teamDomain: TEAM });

        await expect(resolve(new Request("https://app.test/"))).resolves.toBeNull();
    });

    it("fails closed to null on a bad token and calls onError", async () => {
        expect.assertions(2);

        const onError = vi.fn<(error: unknown, request: Request) => void>();
        const resolve = createAccessResolver({ aud: AUD, keySet: publicKey, onError, teamDomain: TEAM });
        const attacker = await generateKeyPair("RS256");
        const forged = await sign({ sub: "user-1" }, attacker.privateKey);

        const identity = await resolve(requestWithHeader(forged));

        expect(identity).toBeNull();
        expect(onError).toHaveBeenCalledTimes(1);
    });

    it("does not call onError when there is simply no token", async () => {
        expect.assertions(1);

        const onError = vi.fn<(error: unknown, request: Request) => void>();
        const resolve = createAccessResolver({ aud: AUD, keySet: publicKey, onError, teamDomain: TEAM });

        await resolve(new Request("https://app.test/"));

        expect(onError).not.toHaveBeenCalled();
    });

    it("throws at factory time when aud is missing (fail fast, not silent-anonymous)", () => {
        expect.assertions(1);

        expect(() => createAccessResolver({ aud: "", keySet: publicKey, teamDomain: TEAM })).toThrow(/aud/);
    });

    it("throws at factory time when teamDomain is empty", () => {
        expect.assertions(1);

        expect(() => createAccessResolver({ aud: AUD, keySet: publicKey, teamDomain: "   " })).toThrow(/teamDomain/);
    });

    it("treats empty-string email/common_name as anonymous rather than minting userId ''", async () => {
        expect.assertions(1);

        const resolve = createAccessResolver({ aud: AUD, keySet: publicKey, teamDomain: TEAM });
        const token = await sign({ common_name: "", email: "", sub: "" });

        await expect(resolve(requestWithHeader(token))).resolves.toBeNull();
    });

    it("falls back to the derived id when mapClaims returns an empty userId", async () => {
        expect.assertions(1);

        const resolve = createAccessResolver({
            aud: AUD,
            keySet: publicKey,
            mapClaims: () => {
                return { userId: "" };
            },
            teamDomain: TEAM,
        });
        const token = await sign({ sub: "user-7" });

        const identity = await resolve(requestWithHeader(token));

        expect(identity?.userId).toBe("user-7");
    });

    it("mints the mapped roles as an identity claim, where both RLS paths read them", async () => {
        expect.assertions(2);

        const resolve = createAccessResolver({
            aud: AUD,
            keySet: publicKey,
            roles: { "idp-admins": "admin", "idp-billing": ["billing", "viewer"] },
            teamDomain: TEAM,
        });
        const token = await sign({ groups: ["idp-admins", "idp-billing", "idp-unmapped"], sub: "user-1" });

        const identity = await resolve(requestWithHeader(token));

        // `roles` is the claim `readIdentityRoles` reads — on the request path
        // AND on the live-shape path, which runs no middleware at all.
        expect(identity?.roles).toEqual(["admin", "billing", "viewer"]);
        expect(identity?.groups).toEqual(["idp-admins", "idp-billing", "idp-unmapped"]);
    });

    it("mints no roles claim when the option is omitted or nothing maps", async () => {
        expect.assertions(2);

        const unmapped = createAccessResolver({ aud: AUD, keySet: publicKey, teamDomain: TEAM });
        const dropped = createAccessResolver({ aud: AUD, keySet: publicKey, roles: () => undefined, teamDomain: TEAM });
        const token = await sign({ groups: ["idp-admins"], sub: "user-1" });

        const withoutOption = await unmapped(requestWithHeader(token));
        const withDroppedGroups = await dropped(requestWithHeader(token));

        // Granting every group name as a role by default would hand existing
        // deployments permissions their policies never intended.
        expect(withoutOption?.roles).toBeUndefined();
        expect(withDroppedGroups?.roles).toBeUndefined();
    });

    it("lets mapClaims replace the mapped roles", async () => {
        expect.assertions(1);

        const resolve = createAccessResolver({
            aud: AUD,
            keySet: publicKey,
            mapClaims: () => {
                return { roles: ["support"] };
            },
            roles: { "idp-admins": "admin" },
            teamDomain: TEAM,
        });
        const token = await sign({ groups: ["idp-admins"], sub: "user-1" });
        const identity = await resolve(requestWithHeader(token));

        expect(identity?.roles).toEqual(["support"]);
    });

    it("lets mapClaims override the derived userId and add claims", async () => {
        expect.assertions(2);

        const resolve = createAccessResolver({
            aud: AUD,
            keySet: publicKey,
            mapClaims: (claims) => {
                return { tenant: "acme", userId: `cf:${String(claims.sub)}` };
            },
            teamDomain: TEAM,
        });
        const token = await sign({ sub: "user-1" });

        const identity = await resolve(requestWithHeader(token));

        expect(identity?.userId).toBe("cf:user-1");
        expect(identity?.tenant).toBe("acme");
    });
});

describe("composeResolvers", () => {
    it("returns the first non-null identity", async () => {
        expect.assertions(1);

        const anon = (): null => null;
        const access = createAccessResolver({ aud: AUD, keySet: publicKey, teamDomain: TEAM });
        const token = await sign({ sub: "user-9" });

        const resolve = composeResolvers(anon, access);

        const identity = await resolve(requestWithHeader(token));

        expect(identity?.userId).toBe("user-9");
    });

    it("falls through to a later resolver when earlier ones abstain", async () => {
        expect.assertions(1);

        const fallback = (): ResolvedIdentityLike => {
            return { userId: "session-user" };
        };
        const access = createAccessResolver({ aud: AUD, keySet: publicKey, teamDomain: TEAM });

        const resolve = composeResolvers(access, fallback);

        // No Access token → access resolver returns null → fallback wins.
        const identity = await resolve(new Request("https://app.test/"));

        expect(identity?.userId).toBe("session-user");
    });

    it("returns null when every resolver abstains", async () => {
        expect.assertions(1);

        const resolve = composeResolvers(
            () => null,
            () => null,
        );

        await expect(resolve(new Request("https://app.test/"))).resolves.toBeNull();
    });
});
