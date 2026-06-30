import type { CryptoKey } from "jose";
import { generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { accessAdminGate } from "../src/admin";

const TEAM = "acme";
const ISSUER = "https://acme.cloudflareaccess.com";
const AUD = "admin-aud-tag";

let publicKey: CryptoKey;
let privateKey: CryptoKey;
let wrongKey: CryptoKey;

const sign = async (claims: Record<string, unknown>, key: CryptoKey = privateKey): Promise<string> =>
    new SignJWT(claims).setProtectedHeader({ alg: "RS256" }).setIssuedAt().setIssuer(ISSUER).setAudience(AUD).setExpirationTime("2h").sign(key);

/** A request carrying the Access JWT in the default header. */
const requestWithHeader = (token: string): Request =>
    new Request("https://app.test/_lunora/admin/functions", { headers: { "cf-access-jwt-assertion": token } });

beforeAll(async () => {
    ({ privateKey, publicKey } = await generateKeyPair("RS256"));
    ({ privateKey: wrongKey } = await generateKeyPair("RS256"));
});

describe("accessAdminGate", () => {
    it("grants when the token verifies and isAdmin returns true", async () => {
        expect.assertions(1);

        const gate = accessAdminGate({ aud: AUD, isAdmin: (claims) => claims.groups?.includes("admins") ?? false, keySet: publicKey, teamDomain: TEAM });
        const token = await sign({ groups: ["admins"], sub: "user-1" });

        await expect(gate(requestWithHeader(token))).resolves.toBe(true);
    });

    it("denies when the token verifies but isAdmin returns false", async () => {
        expect.assertions(1);

        const gate = accessAdminGate({ aud: AUD, isAdmin: (claims) => claims.groups?.includes("admins") ?? false, keySet: publicKey, teamDomain: TEAM });
        const token = await sign({ groups: ["readers"], sub: "user-2" });

        await expect(gate(requestWithHeader(token))).resolves.toBe(false);
    });

    it("awaits an async isAdmin predicate", async () => {
        expect.assertions(1);

        const gate = accessAdminGate({ aud: AUD, isAdmin: (claims) => Promise.resolve(claims.email === "ops@acme.test"), keySet: publicKey, teamDomain: TEAM });
        const token = await sign({ email: "ops@acme.test", sub: "user-3" });

        await expect(gate(requestWithHeader(token))).resolves.toBe(true);
    });

    it("denies (without calling isAdmin) when no token is present", async () => {
        expect.assertions(2);

        const isAdmin = vi.fn(() => true);
        const gate = accessAdminGate({ aud: AUD, isAdmin, keySet: publicKey, teamDomain: TEAM });

        await expect(gate(new Request("https://app.test/_lunora/admin/functions"))).resolves.toBe(false);
        expect(isAdmin).not.toHaveBeenCalled();
    });

    it("denies and reports onError when the token fails verification", async () => {
        expect.assertions(2);

        const onError = vi.fn();
        const gate = accessAdminGate({ aud: AUD, isAdmin: () => true, keySet: publicKey, onError, teamDomain: TEAM });
        const forged = await sign({ sub: "user-4" }, wrongKey);

        await expect(gate(requestWithHeader(forged))).resolves.toBe(false);
        expect(onError).toHaveBeenCalledTimes(1);
    });

    it("reads the token from the CF_Authorization cookie when the header is absent", async () => {
        expect.assertions(1);

        const gate = accessAdminGate({ aud: AUD, isAdmin: () => true, keySet: publicKey, teamDomain: TEAM });
        const token = await sign({ sub: "user-5" });
        const request = new Request("https://app.test/_lunora/admin/functions", { headers: { cookie: `CF_Authorization=${token}` } });

        await expect(gate(request)).resolves.toBe(true);
    });
});
