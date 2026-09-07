import { describe, expect, it } from "vitest";

import { isAccessIdentity, readIdentityGroups } from "../src/identity-groups";

// The single group reader shared by `ctx.access` (context.ts) and the RLS roles
// the resolver mints (resolver.ts). These lock its contract so the two consumers
// can never drift.
describe("readIdentityGroups", () => {
    it("reads the promoted top-level groups, keeping only string entries", () => {
        expect.assertions(1);

        expect(readIdentityGroups({ groups: ["a", 1, null, "b"] })).toStrictEqual(["a", "b"]);
    });

    it("falls back to the nested access.groups when groups is not promoted", () => {
        expect.assertions(1);

        expect(readIdentityGroups({ access: { groups: ["x", "y"] } })).toStrictEqual(["x", "y"]);
    });

    it("prefers the promoted top-level groups over the nested access.groups", () => {
        expect.assertions(1);

        expect(readIdentityGroups({ access: { groups: ["nested"] }, groups: ["promoted"] })).toStrictEqual(["promoted"]);
    });

    it("returns undefined when neither promoted nor nested yields a group array", () => {
        expect.assertions(1);

        expect(readIdentityGroups({ email: "a@b.c" })).toBeUndefined();
    });

    it("reads a foreign envelope's promoted groups — provenance is the caller's gate", () => {
        expect.assertions(2);

        // The reader vouches for shape only. `isAccessIdentity` is what says the
        // envelope came from Access, and both consumers must check it first.
        expect(readIdentityGroups({ groups: ["admin"] })).toStrictEqual(["admin"]);
        expect(isAccessIdentity({ groups: ["admin"] })).toBe(false);
    });
});

describe("isAccessIdentity", () => {
    it("is true only for an envelope carrying the verified claim set under access", () => {
        expect.assertions(4);

        expect(isAccessIdentity({ access: { email: "a@b.c" } })).toBe(true);
        expect(isAccessIdentity({ access: {} })).toBe(true);
        expect(isAccessIdentity({ email: "a@b.c", groups: ["admin"] })).toBe(false);
        expect(isAccessIdentity({ access: "not-an-object" })).toBe(false);
    });
});
