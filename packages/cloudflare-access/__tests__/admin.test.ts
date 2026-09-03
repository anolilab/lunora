import type { CryptoKey } from "jose";
import { generateKeyPair, SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";

import { accessAdminGate } from "../src/admin";
import type { AccessClaims } from "../src/types";

const TEAM = "acme";
const ISSUER = "https://acme.cloudflareaccess.com";
const AUD = "admin-aud-tag";

const { privateKey, publicKey } = await generateKeyPair("RS256");
const { privateKey: wrongKey } = await generateKeyPair("RS256");

const sign = async (claims: Record<string, unknown>, key: CryptoKey = privateKey): Promise<string> =>
    new SignJWT(claims).setProtectedHeader({ alg: "RS256" }).setIssuedAt().setIssuer(ISSUER).setAudience(AUD).setExpirationTime("2h").sign(key);

/** A request carrying the Access JWT in the default header. */
const requestWithHeader = (token: string): Request =>
    new Request("https://app.test/_lunora/admin/functions", { headers: { "cf-access-jwt-assertion": token } });

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

    it("denies when isAdmin returns a truthy non-boolean", async () => {
        expect.assertions(1);

        // `isAdmin` is the whole authorization boundary and its verdict feeds the
        // runtime's `adminGate`, which GRANTS on truthy. An untyped predicate
        // returning the matched group (`claims.groups.find(...)`) rather than a
        // boolean must not become a grant.
        const gate = accessAdminGate({
            aud: AUD,
            isAdmin: (claims) => claims.groups?.find((group) => group === "admins") as unknown as boolean,
            keySet: publicKey,
            teamDomain: TEAM,
        });
        const token = await sign({ groups: ["admins"], sub: "user-3" });

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

        const isAdmin = vi.fn<(claims: AccessClaims) => boolean>(() => true);
        const gate = accessAdminGate({ aud: AUD, isAdmin, keySet: publicKey, teamDomain: TEAM });

        await expect(gate(new Request("https://app.test/_lunora/admin/functions"))).resolves.toBe(false);
        expect(isAdmin).not.toHaveBeenCalled();
    });

    it("denies and reports onError when the token fails verification", async () => {
        expect.assertions(2);

        const onError = vi.fn<(error: unknown, request: Request) => void>();
        const gate = accessAdminGate({ aud: AUD, isAdmin: () => true, keySet: publicKey, onError, teamDomain: TEAM });
        const forged = await sign({ sub: "user-4" }, wrongKey);

        await expect(gate(requestWithHeader(forged))).resolves.toBe(false);
        expect(onError).toHaveBeenCalledTimes(1);
    });

    it("throws at factory time when aud is missing (fail fast, not deny-all)", () => {
        expect.assertions(1);

        expect(() => accessAdminGate({ aud: "", isAdmin: () => true, keySet: publicKey, teamDomain: TEAM })).toThrow(/aud/);
    });

    it("throws at factory time when isAdmin is missing (the whole boundary, not an implicit grant)", () => {
        expect.assertions(1);

        // The type requires it; an untyped caller or an `as` cast does not. Without
        // this the gate threw a bare TypeError per request, which the runtime
        // degrades to "no grant" — a silent fallback to the bearer with no log.
        expect(() => accessAdminGate({ aud: AUD, keySet: publicKey, teamDomain: TEAM } as unknown as Parameters<typeof accessAdminGate>[0])).toThrow(
            /`isAdmin` is required/,
        );
    });

    it("throws at factory time when teamDomain is empty", () => {
        expect.assertions(1);

        expect(() => accessAdminGate({ aud: AUD, isAdmin: () => true, keySet: publicKey, teamDomain: "   " })).toThrow(/teamDomain/);
    });

    it("reads the token from the CF_Authorization cookie when the header is absent", async () => {
        expect.assertions(1);

        const gate = accessAdminGate({ aud: AUD, isAdmin: () => true, keySet: publicKey, teamDomain: TEAM });
        const token = await sign({ sub: "user-5" });
        const request = new Request("https://app.test/_lunora/admin/functions", { headers: { cookie: `CF_Authorization=${token}` } });

        await expect(gate(request)).resolves.toBe(true);
    });
});
