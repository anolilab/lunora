import { describe, expect, it } from "vitest";

import { defineIdentity, v } from "../src/index";

/**
 * `defineIdentity` declares the identity claim contract: it brands the
 * declaration with `__lunoraIdentity` (so codegen discovers it), records the
 * reject policy, and exposes a runtime `validate` that runs the declared
 * validators against a resolver's returned claims at the trust boundary.
 */
describe("defineIdentity", () => {
    const contract = defineIdentity({
        kind: v.optional(v.union(v.literal("user"), v.literal("service"))),
        scopes: v.optional(v.array(v.string())),
        tenantId: v.optional(v.string()),
        userId: v.string(),
    });

    it("brands the declaration and defaults onInvalid to 'anonymous'", () => {
        expect.assertions(3);

        expect(contract.__lunoraIdentity).toBe(true);
        expect(contract.onInvalid).toBe("anonymous");
        expect(typeof contract.validate).toBe("function");
    });

    it("honours an explicit onInvalid: 'reject'", () => {
        expect.assertions(1);

        const strict = defineIdentity({ userId: v.string() }, { onInvalid: "reject" });

        expect(strict.onInvalid).toBe("reject");
    });

    it("accepts a valid claim set", () => {
        expect.assertions(1);

        expect(contract.validate({ scopes: ["read"], tenantId: "t_1", userId: "user_42" })).toEqual({ ok: true });
    });

    it("accepts a claim set with only the required userId (optional claims absent)", () => {
        expect.assertions(1);

        expect(contract.validate({ userId: "user_42" })).toEqual({ ok: true });
    });

    it("rejects a claim set whose declared claim has the wrong type", () => {
        expect.assertions(2);

        const result = contract.validate({ tenantId: 42, userId: "user_42" });

        expect(result.ok).toBe(false);
        expect(result).toMatchObject({ ok: false });
    });

    it("rejects a claim set missing the required userId", () => {
        expect.assertions(1);

        expect(contract.validate({ tenantId: "t_1" }).ok).toBe(false);
    });

    it("throws at declaration time when the claim map omits userId entirely", () => {
        expect.assertions(1);

        // Cast around the compile-time guard to prove the runtime guard also fires.
        expect(() => defineIdentity({ tenantId: v.string() } as never)).toThrow(/userId/);
    });

    it("throws at declaration time when userId is a non-string or optional validator", () => {
        expect.assertions(2);

        // Cast around the compile-time guard: a required-but-non-string userId
        // (here a number) still violates the `{ userId: string }` contract, and an
        // optional userId cannot satisfy a required claim — both fail the runtime guard.
        expect(() => defineIdentity({ userId: v.number() } as never)).toThrow(/userId/);
        expect(() => defineIdentity({ userId: v.optional(v.string()) } as never)).toThrow(/userId/);
    });

    it("accepts a string-typed userId declared with a non-plain-string validator kind", () => {
        expect.assertions(2);

        // `v.id(...)` and `v.storage()` infer to string, so the compile-time guard admits
        // them — the runtime guard must not false-reject a legitimately string-typed userId.
        expect(defineIdentity({ userId: v.id("users") }).__lunoraIdentity).toBe(true);
        expect(defineIdentity({ userId: v.storage() }).__lunoraIdentity).toBe(true);
    });
});
