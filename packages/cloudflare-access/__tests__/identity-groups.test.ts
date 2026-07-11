import { describe, expect, it } from "vitest";

import readIdentityGroups from "../src/identity-groups";

// The single group reader shared by `ctx.access` (context.ts) and `accessRoles`
// (roles.ts). These lock its contract so the two consumers can never drift.
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
});
