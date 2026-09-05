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

    it("derives userId identically to the JWT path, ignoring the platform-only user_uuid", async () => {
        expect.assertions(3);

        const resolve = createAccessResolver();

        // `userId` is the ownership key RLS and `serverDefault` stamp rows with, so
        // a deployment switching from a hostname-scoped application to a
        // Worker-scoped policy must keep resolving each user to the same id.
        // Preferring `user_uuid` (which only this path emits) would re-key every
        // user on that switch and orphan their rows behind RLS.
        const bySub = await resolve(request(), undefined, contextWith({ email: "user@acme.test", sub: "user-1", user_uuid: "uuid-9" }));
        const byEmail = await resolve(request(), undefined, contextWith({ email: "user@acme.test", sub: "", user_uuid: "uuid-9" }));
        const byCommonName = await resolve(request(), undefined, contextWith({ common_name: "ci-bot", sub: "" }));

        expect(bySub?.userId).toBe("user-1");
        expect(byEmail?.userId).toBe("user@acme.test");
        expect(byCommonName?.userId).toBe("ci-bot");
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

    it("falls through to the JWT when the platform identity yields no usable id", async () => {
        expect.assertions(2);

        const onError = vi.fn<(error: unknown, request: Request) => void>();
        const resolve = createAccessResolver({ aud: AUD, keySet: publicKey, onError, teamDomain: TEAM });
        const token = await sign({ email: "jwt@acme.test", sub: "jwt-user" });

        // `{}` is an object, so a nullish-coalescing fallthrough keeps it and
        // the configured JWT fallback is never consulted: the caller presenting
        // a valid Cf-Access-Jwt-Assertion resolves anonymous, RLS denies, and
        // `onError` never fires because nothing was verified.
        const identity = await resolve(request({ "cf-access-jwt-assertion": token }), undefined, contextWith({}));

        expect(identity?.userId).toBe("jwt-user");
        expect(onError).not.toHaveBeenCalled();
    });

    it("stays anonymous when neither the platform identity nor the JWT yields an id", async () => {
        expect.assertions(1);

        const resolve = createAccessResolver({ aud: AUD, keySet: publicKey, teamDomain: TEAM });

        // Fail-closed is unchanged: no usable platform id and no token at all.
        await expect(resolve(request(), undefined, contextWith({ country: "DE" }))).resolves.toBeNull();
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

        expect(() => createAccessResolver({ teamDomain: TEAM })).toThrow(/must both be set/);
        expect(() => createAccessResolver({ aud: AUD })).toThrow(/must both be set/);
    });

    it("throws when the JWT options are named but their env values are unset", () => {
        expect.assertions(2);

        // The classic broken deployment: an app wired for a hostname-scoped Access
        // application, deployed to an environment where neither secret was set.
        // Reading the VALUES would make this a worker that boots happily and
        // resolves every caller to anonymous — the presence of the keys is what
        // says "this deployment intends to verify JWTs".
        expect(() => createAccessResolver({ aud: undefined, teamDomain: undefined })).toThrow(/must both be set/);
        // Naming neither is the legal platform-identity-only mode.
        expect(() =>
            createAccessResolver({
                mapClaims: (claims) => {
                    return { tenant: claims.email };
                },
            }),
        ).not.toThrow();
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

    it("does NOT accept a Worker-scoped identity when a dedicated admin aud is configured", async () => {
        expect.assertions(3);

        // The inverse of the resolver's precedence, and deliberately so. A
        // configured `aud` is the narrow boundary — a dedicated Access application
        // over /_lunora/admin. A policy later attached to the Worker is typically
        // broad ("anyone at the company"); letting it satisfy this gate would hand
        // the whole admin plane to everyone that policy admits, silently.
        const isAdmin = vi.fn<() => boolean>(() => true);
        const gate = accessAdminGate({ aud: AUD, isAdmin, keySet: publicKey, teamDomain: TEAM });

        await expect(gate(request(), contextWith({ groups: ["everyone"], sub: "broad-policy-user" }))).resolves.toBe(false);
        expect(isAdmin).not.toHaveBeenCalled();

        const token = await sign({ groups: ["lunora-admins"], sub: "admin-user" });

        await expect(gate(request({ "cf-access-jwt-assertion": token }), contextWith({ sub: "broad-policy-user" }))).resolves.toBe(true);
    });
});
