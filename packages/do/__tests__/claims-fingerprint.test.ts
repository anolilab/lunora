import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { canonicalClaims, claimsFingerprint, sha256 } from "../../../shared/claims-fingerprint";

describe("claims fingerprint", () => {
    it.each(["", "abc", "a".repeat(55), "a".repeat(56), "a".repeat(64), "a".repeat(1000), "naïve ☃"])("hashes %j as SHA-256 does", (text) => {
        expect.assertions(1);

        const bytes = new TextEncoder().encode(text);

        expect(Buffer.from(sha256(bytes)).toString("hex")).toBe(createHash("sha256").update(bytes).digest("hex"));
    });

    it("is the same for the same claims in any key order, and ignores the claims a refresh re-issues", () => {
        expect.assertions(2);

        const a = claimsFingerprint("user-1", { exp: 1, iat: 1, orgId: "org-a", role: "member" });
        const b = claimsFingerprint("user-1", { role: "member", orgId: "org-a", jti: "x", exp: 99 });

        expect(a).toBe(b);
        expect(a).toMatch(/^[\w-]{22}$/u);
    });

    it.each([
        ["another org", "user-1", { orgId: "org-b", role: "member" }],
        ["a lost claim", "user-1", { role: "member" }],
        ["another role", "user-1", { orgId: "org-a", role: "admin" }],
        ["another user", "user-2", { orgId: "org-a", role: "member" }],
        ["a nested claim", "user-1", { orgId: "org-a", role: "member", roles: ["a"] }],
    ])("differs for %s", (_name, userId, identity) => {
        expect.assertions(1);

        expect(claimsFingerprint(userId, identity)).not.toBe(claimsFingerprint("user-1", { orgId: "org-a", role: "member" }));
    });

    it("keys the re-auth comparison on the same canonical claims", () => {
        expect.assertions(2);

        expect(canonicalClaims(undefined)).toBe("");
        expect(canonicalClaims({ exp: 1 })).toBe("");
    });
});
