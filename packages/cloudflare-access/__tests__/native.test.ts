import type { CryptoKey } from "jose";
import { generateKeyPair, SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";

import type { AccessIdentityLike, ExecutionContextLike } from "../../../shared/execution-context";
import { accessAdminGate } from "../src/admin";
import { createAccessResolver } from "../src/resolver";

const TEAM = "acme";
const ISSUER = "https://acme.cloudflareaccess.com";
const AUD = "app-aud-tag";

const { privateKey, publicKey } = await generateKeyPair("RS256");

const sign = async (claims: Record<string, unknown>, key: CryptoKey = privateKey): Promise<string> =>
    new SignJWT(claims).setProtectedHeader({ alg: "RS256" }).setIssuedAt().setIssuer(ISSUER).setAudience(AUD).setExpirationTime("2h").sign(key);

const request = (headers: Record<string, string> = {}): Request => new Request("https://app.test/_lunora/rpc", { headers });

/** An `ExecutionContext` shaped like the one Cloudflare hands a Worker protected by Access. */
const contextWith = (identity: AccessIdentityLike | null | undefined): ExecutionContextLike => {
    return { access: { getIdentity: () => Promise.resolve(identity) } };
};

describe("createAccessResolver — platform identity (Worker-scoped Access)", () => {
    it("resolves the identity Access attached to the execution context, with no JWT config at all", async () => {
        expect.assertions(4);

        const resolve = createAccessResolver();

        const identity = await resolve(request(), undefined, contextWith({ email: "user@acme.test", groups: ["eng"], sub: "user-1" }));

        expect(identity?.userId).toBe("user-1");
        expect(identity?.email).toBe("user@acme.test");
        expect(identity?.groups).toEqual(["eng"]);
        expect((identity?.access as { email?: string }).email).toBe("user@acme.test");
    });

    it("normalizes object-shaped groups to their names, matching the JWT path", async () => {
        expect.assertions(1);

        const resolve = createAccessResolver();

        const identity = await resolve(
            request(),
            undefined,
            contextWith({ groups: [{ id: "g1", name: "eng" }, { id: "g2", name: "ops" }, { id: "g3" }, 42], sub: "user-1" }),
        );

        expect(identity?.groups).toEqual(["eng", "ops"]);
    });

    it("falls back to user_uuid, then email, when the IdP emits no sub", async () => {
        expect.assertions(2);

        const resolve = createAccessResolver();

        const byUuid = await resolve(request(), undefined, contextWith({ email: "user@acme.test", sub: "", user_uuid: "uuid-9" }));
        const byEmail = await resolve(request(), undefined, contextWith({ email: "user@acme.test" }));

        expect(byUuid?.userId).toBe("uuid-9");
        expect(byEmail?.userId).toBe("user@acme.test");
    });

    it("is anonymous when Access did not authenticate the request (no ctx.access)", async () => {
        expect.assertions(2);

        const resolve = createAccessResolver();

        await expect(resolve(request(), undefined, {})).resolves.toBeNull();
        await expect(resolve(request())).resolves.toBeNull();
    });

    it("fails closed to anonymous when getIdentity throws or yields nothing", async () => {
        expect.assertions(2);

        const resolve = createAccessResolver();
        const throwing: ExecutionContextLike = {
            access: {
                getIdentity: () => {
                    throw new Error("platform read failed");
                },
            },
        };

        await expect(resolve(request(), undefined, throwing)).resolves.toBeNull();

        await expect(resolve(request(), undefined, contextWith(null))).resolves.toBeNull();
    });

    it("prefers the platform identity over a verifiable JWT on the same request", async () => {
        expect.assertions(1);

        const resolve = createAccessResolver({ aud: AUD, keySet: publicKey, teamDomain: TEAM });
        const token = await sign({ email: "jwt@acme.test", sub: "jwt-user" });

        const identity = await resolve(request({ "cf-access-jwt-assertion": token }), undefined, contextWith({ sub: "platform-user" }));

        expect(identity?.userId).toBe("platform-user");
    });

    it("still verifies the JWT when the request carries no platform identity", async () => {
        expect.assertions(1);

        const resolve = createAccessResolver({ aud: AUD, keySet: publicKey, teamDomain: TEAM });
        const token = await sign({ email: "jwt@acme.test", sub: "jwt-user" });

        const identity = await resolve(request({ "cf-access-jwt-assertion": token }), undefined, {});

        expect(identity?.userId).toBe("jwt-user");
    });

    it("throws at construction when only one half of the JWT config is supplied", () => {
        expect.assertions(2);

        expect(() => createAccessResolver({ teamDomain: TEAM })).toThrow(/configured together/);
        expect(() => createAccessResolver({ aud: AUD })).toThrow(/configured together/);
    });
});

describe("accessAdminGate — platform identity", () => {
    it("grants from the execution-context identity with no JWT config", async () => {
        expect.assertions(2);

        const gate = accessAdminGate({ isAdmin: (claims) => claims.groups?.includes("lunora-admins") ?? false });

        await expect(gate(request(), contextWith({ groups: ["lunora-admins"], sub: "u1" }))).resolves.toBe(true);
        await expect(gate(request(), contextWith({ groups: ["eng"], sub: "u1" }))).resolves.toBe(false);
    });

    it("denies when Access did not authenticate the request", async () => {
        expect.assertions(2);

        const isAdmin = vi.fn<() => boolean>(() => true);
        const gate = accessAdminGate({ isAdmin });

        await expect(gate(request(), {})).resolves.toBe(false);
        expect(isAdmin).not.toHaveBeenCalled();
    });
});
