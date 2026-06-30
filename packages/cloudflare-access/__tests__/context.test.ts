import { describe, expect, it, vi } from "vitest";

import type { AccessContextInput, AccessFacade } from "../src/context";
import { accessContext, accessFacade } from "../src/context";

/**
 * Drive `accessContext` once: build a ctx whose `auth.getIdentity()` returns
 * `identity`, run the middleware, and report the `ctx.access` facade that reached
 * `next`.
 */
const run = async (identity: Record<string, unknown> | null): Promise<AccessFacade> => {
    const auth: AccessContextInput["auth"] = {
        getIdentity: () => identity,
        userId: identity ? "user-1" : null,
    };
    const ctx = { auth } satisfies AccessContextInput;

    let captured: { ctx: Record<string, unknown> } | undefined;

    const next = vi.fn<(arguments_?: { ctx: Record<string, unknown> }) => Promise<Record<string, unknown>>>((arguments_) => {
        captured = arguments_;

        return Promise.resolve({ ...ctx, ...arguments_?.ctx });
    });

    await accessContext()({ ctx, next });

    return captured?.ctx["access"] as AccessFacade;
};

/** A resolver-shaped envelope: promoted fields plus the full claim set under `access`. */
const identity = (claims: Record<string, unknown>, promoted: Record<string, unknown> = {}): Record<string, unknown> => {
    return {
        access: claims,
        ...promoted,
    };
};

describe("accessContext", () => {
    it("surfaces the verified claims, email, and groups for an SSO identity", async () => {
        expect.assertions(5);

        const access = await run(
            identity({ email: "dev@acme.test", groups: ["eng", "ops"], sub: "user-1" }, { email: "dev@acme.test", groups: ["eng", "ops"] }),
        );

        expect(access.authenticated).toBe(true);
        expect(access.email).toBe("dev@acme.test");
        expect(access.groups).toStrictEqual(["eng", "ops"]);
        expect(access.userId).toBe("user-1");
        expect(access.claims?.sub).toBe("user-1");
    });

    it("resolves hasGroup against the verified groups", async () => {
        expect.assertions(2);

        const access = await run(identity({ groups: ["ops"] }, { groups: ["ops"] }));

        expect(access.hasGroup("ops")).toBe(true);
        expect(access.hasGroup("admin")).toBe(false);
    });

    it("surfaces commonName for a service token with no email", async () => {
        expect.assertions(2);

        const access = await run(identity({ common_name: "ci-bot", sub: "" }, { commonName: "ci-bot" }));

        expect(access.commonName).toBe("ci-bot");
        expect(access.email).toBeUndefined();
    });

    it("reads anonymous for an identity with no nested `access` claim set", async () => {
        expect.assertions(3);

        // A non-Access identity (e.g. a better-auth session resolved under
        // composeResolvers, or a custom mapClaims that dropped `access`) carries no
        // verified Access claim envelope. `ctx.access` surfaces ONLY Access
        // identities, so it must not misreport a foreign identity as authenticated.
        const access = await run({ email: "betterauth@acme.test", groups: ["x"] });

        expect(access.authenticated).toBe(false);
        expect(access.email).toBeUndefined();
        expect(access.claims).toBeUndefined();
    });

    it("ignores non-string entries in the groups claim", async () => {
        expect.assertions(1);

        const access = await run(identity({ groups: ["ok", 42, null, "fine"] }));

        expect(access.groups).toStrictEqual(["ok", "fine"]);
    });

    it("attaches the anonymous facade when no identity is resolved", async () => {
        expect.assertions(5);

        const access = await run(null);

        expect(access.authenticated).toBe(false);
        expect(access.claims).toBeUndefined();
        expect(access.userId).toBeUndefined();
        expect(access.groups).toStrictEqual([]);
        expect(access.hasGroup("anything")).toBe(false);
    });
});

describe("accessFacade", () => {
    // The pure factory codegen wires onto every ctx — called synchronously with
    // the resolved identity/userId locals at ctx-build time.
    it("builds the facade synchronously from a resolved identity", () => {
        expect.assertions(3);

        const access = accessFacade(identity({ email: "dev@acme.test", groups: ["eng"] }, { email: "dev@acme.test", groups: ["eng"] }), "user-1");

        expect(access.authenticated).toBe(true);
        expect(access.email).toBe("dev@acme.test");
        expect(access.userId).toBe("user-1");
    });

    it("returns the anonymous facade for a null or undefined identity", () => {
        expect.assertions(2);

        expect(accessFacade(null, null).authenticated).toBe(false);
        expect(accessFacade(undefined, undefined).authenticated).toBe(false);
    });
});
