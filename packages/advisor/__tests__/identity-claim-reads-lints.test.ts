import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import { fromServerSchema } from "../src";
import type { AdvisorIdentityClaimRead } from "../src/identity-claim-reads";
import identityUndeclaredClaimTrusted from "../src/lints/static/identity-undeclared-claim-trusted";

const schema = () => fromServerSchema(defineSchema({ users: defineTable({ name: v.string() }) }));

const rows: AdvisorIdentityClaimRead[] = [
    // undeclared claim read → flagged.
    { declared: false, exportName: "postsPolicy", file: "policy", line: 4, key: "role" },
    // declared claim read → not flagged.
    { declared: true, exportName: "postsPolicy", file: "policy", line: 6, key: "tenantId" },
    // userId (always declared) → not flagged.
    { declared: true, exportName: "postsPolicy", file: "policy", line: 8, key: "userId" },
];

describe("identity_undeclared_claim_trusted", () => {
    it("flags only the undeclared claim read", () => {
        expect.assertions(3);

        const findings = identityUndeclaredClaimTrusted.run({ identityClaimReads: rows, schema: schema() });

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            level: "WARN",
            metadata: { exportName: "postsPolicy", file: "policy", key: "role", line: 4 },
            name: "identity_undeclared_claim_trusted",
        });
        expect(findings[0]?.detail).toContain("role");
    });

    it("returns [] when identityClaimReads is undefined", () => {
        expect.assertions(1);

        expect(identityUndeclaredClaimTrusted.run({ schema: schema() })).toHaveLength(0);
    });

    it("returns [] when every read is a declared claim", () => {
        expect.assertions(1);

        const declaredOnly = rows.filter((row) => row.declared);

        expect(identityUndeclaredClaimTrusted.run({ identityClaimReads: declaredOnly, schema: schema() })).toHaveLength(0);
    });
});
