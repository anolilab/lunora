import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import { fromServerSchema } from "../src";
import ownerFieldFromArgsNotAuth from "../src/lints/static/owner-field-from-args-not-auth";
import type { AdvisorOwnerFieldWrite } from "../src/owner-field-writes";

const schema = () => fromServerSchema(defineSchema({ users: defineTable({ name: v.string() }) }));

describe("owner_field_from_args_not_auth", () => {
    it("flags one ERROR finding per evidence row with the right cacheKey and detail", () => {
        expect.assertions(4);

        const ownerFieldWrites: AdvisorOwnerFieldWrite[] = [
            { exportName: "createPost", field: "userId", file: "posts", line: 4, method: "insert" },
            { exportName: "movePost", field: "tenantId", file: "posts", line: 9, method: "patch" },
        ];
        const findings = ownerFieldFromArgsNotAuth.run({ ownerFieldWrites, schema: schema() });

        expect(findings).toHaveLength(2);
        expect(findings[0]).toMatchObject({
            cacheKey: "owner_field_from_args_not_auth:posts:4:userId",
            level: "ERROR",
            metadata: { exportName: "createPost", field: "userId", method: "insert" },
            name: "owner_field_from_args_not_auth",
        });
        expect(findings[0]?.detail).toContain("userId");
        expect(findings[1]?.cacheKey).toBe("owner_field_from_args_not_auth:posts:9:tenantId");
    });

    it("finds nothing when the feeder supplies no owner-write evidence", () => {
        expect.assertions(2);

        expect(ownerFieldFromArgsNotAuth.run({ schema: schema() })).toHaveLength(0);
        expect(ownerFieldFromArgsNotAuth.run({ ownerFieldWrites: [], schema: schema() })).toHaveLength(0);
    });
});
