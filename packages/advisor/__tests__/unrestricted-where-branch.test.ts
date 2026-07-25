import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import { fromServerSchema } from "../src";
import unrestrictedWhereBranch from "../src/lints/static/unrestricted-where-branch";
import type { AdvisorUnrestrictedWhereBranch } from "../src/unrestricted-where-branches";

const schema = () => fromServerSchema(defineSchema({ nodes: defineTable({ text: v.string() }) }));

describe("unrestricted_where_branch", () => {
    it("flags one ERROR finding per evidence row with the right cacheKey and detail", () => {
        expect.assertions(5);

        const unrestrictedWhereBranches: AdvisorUnrestrictedWhereBranch[] = [
            { exportName: "wholeOutline", file: "shapes", form: "empty-object", key: "where", line: 9, owner: "defineShape" },
            { exportName: "readOwn", file: "policies", form: "undefined", key: "when", line: 14, owner: "definePolicy" },
        ];
        const findings = unrestrictedWhereBranch.run({ schema: schema(), unrestrictedWhereBranches });

        expect(findings).toHaveLength(2);
        expect(findings[0]).toMatchObject({
            cacheKey: "unrestricted_where_branch:shapes:9:where",
            level: "ERROR",
            metadata: { exportName: "wholeOutline", form: "empty-object", key: "where", owner: "defineShape" },
            name: "unrestricted_where_branch",
        });
        // The detail has to name the fix, since the whole failure mode is that the
        // wrong spelling looks right.
        expect(findings[0]?.detail).toContain("deny()");
        expect(findings[0]?.detail).toContain("matches every row instead of none");
        expect(findings[1]?.cacheKey).toBe("unrestricted_where_branch:policies:14:when");
    });

    it("names the offending form so `{}` and `undefined` are distinguishable", () => {
        expect.assertions(2);

        const [emptyObject] = unrestrictedWhereBranch.run({
            schema: schema(),
            unrestrictedWhereBranches: [{ exportName: "s", file: "shapes", form: "empty-object", key: "where", line: 1, owner: "defineShape" }],
        });
        const [undefinedForm] = unrestrictedWhereBranch.run({
            schema: schema(),
            unrestrictedWhereBranches: [{ exportName: "s", file: "shapes", form: "undefined", key: "where", line: 1, owner: "defineShape" }],
        });

        expect(emptyObject?.detail).toContain("`{}`");
        expect(undefinedForm?.detail).toContain("`undefined`");
    });

    it("points at the primitive that cannot be written backwards", () => {
        expect.assertions(1);

        // `.ownedBy()` + `owner: true` derives the predicate from the verified
        // identity, so the remediation should mention it rather than only `deny()`.
        expect(unrestrictedWhereBranch.remediation).toContain("ownedBy");
    });

    it("finds nothing when the feeder supplies no evidence", () => {
        expect.assertions(2);

        expect(unrestrictedWhereBranch.run({ schema: schema() })).toHaveLength(0);
        expect(unrestrictedWhereBranch.run({ schema: schema(), unrestrictedWhereBranches: [] })).toHaveLength(0);
    });
});
