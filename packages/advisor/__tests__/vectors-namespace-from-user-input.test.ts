import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import { fromServerSchema } from "../src";
import vectorsNamespaceFromUserInput from "../src/lints/static/vectors-namespace-from-user-input";
import type { AdvisorVectorNamespaceAccess } from "../src/vector-namespace-accesses";

const schema = () => fromServerSchema(defineSchema({ users: defineTable({ name: v.string() }) }));

describe("vectors_namespace_from_user_input", () => {
    it("flags one WARN finding per evidence row with the right cacheKey and detail", () => {
        expect.assertions(4);

        const vectorNamespaceAccesses: AdvisorVectorNamespaceAccess[] = [
            { exportName: "searchDocs", file: "search", line: 4, method: "query" },
            { exportName: "indexDoc", file: "search", line: 9, method: "upsert" },
        ];
        const findings = vectorsNamespaceFromUserInput.run({ schema: schema(), vectorNamespaceAccesses });

        expect(findings).toHaveLength(2);
        expect(findings[0]).toMatchObject({
            cacheKey: "vectors_namespace_from_user_input:search:4",
            level: "WARN",
            metadata: { exportName: "searchDocs", method: "query" },
            name: "vectors_namespace_from_user_input",
        });
        expect(findings[0]?.detail).toContain("ctx.vectors.query");
        expect(findings[1]?.cacheKey).toBe("vectors_namespace_from_user_input:search:9");
    });

    it("finds nothing when the feeder supplies no vector-namespace evidence", () => {
        expect.assertions(2);

        expect(vectorsNamespaceFromUserInput.run({ schema: schema() })).toHaveLength(0);
        expect(vectorsNamespaceFromUserInput.run({ schema: schema(), vectorNamespaceAccesses: [] })).toHaveLength(0);
    });
});
