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

    it("drops an internal procedure's write to INFO and redirects it at the public callers", () => {
        expect.assertions(5);

        // LUNORA_ISSUES #37. The first large port had 9 of these and all 9 were
        // `internalMutation`. An internal procedure is not reachable by a caller
        // — that is the entire point of the visibility split — so "any caller can
        // act as any user" is false there, and taking the subject from `args` is
        // the correct shape. At ERROR the rule had zero signal; under #35 it
        // would have blocked the build on nine correct functions.
        const ownerFieldWrites: AdvisorOwnerFieldWrite[] = [
            { exportName: "saveMemory", field: "userId", file: "memory", line: 12, method: "insert", visibility: "internal" },
            { exportName: "createPin", field: "userId", file: "pins", line: 20, method: "insert", visibility: "public" },
        ];
        const findings = ownerFieldFromArgsNotAuth.run({ ownerFieldWrites, schema: schema() });

        expect(findings[0]).toMatchObject({ level: "INFO", metadata: { visibility: "internal" } });
        // Not silent: the public procedure forwarding raw args into it IS the
        // vector, so the finding stays as the breadcrumb pointing there.
        expect(findings[0]?.detail).toContain("Audit the PUBLIC procedures");
        expect(findings[0]?.detail).toContain("expected for an `internal` procedure");

        // The public-facing case is untouched and still blocks.
        expect(findings[1]).toMatchObject({ level: "ERROR", metadata: { visibility: "public" } });
        expect(findings[1]?.detail).toContain("any caller can write rows owned by another user/tenant");
    });

    it("keeps ERROR when the feeder could not attribute a visibility", () => {
        expect.assertions(1);

        // A write outside any recognised procedure gets no visibility. Defaulting
        // to the safe reading (report it) matters more than the false-positive
        // rate here — the alternative silently drops a real IDOR.
        const ownerFieldWrites: AdvisorOwnerFieldWrite[] = [{ exportName: "helper", field: "userId", file: "lib", line: 3, method: "insert" }];

        expect(ownerFieldFromArgsNotAuth.run({ ownerFieldWrites, schema: schema() })[0]).toMatchObject({ level: "ERROR" });
    });

    it("finds nothing when the feeder supplies no owner-write evidence", () => {
        expect.assertions(2);

        expect(ownerFieldFromArgsNotAuth.run({ schema: schema() })).toHaveLength(0);
        expect(ownerFieldFromArgsNotAuth.run({ ownerFieldWrites: [], schema: schema() })).toHaveLength(0);
    });
});
