import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import { fromServerSchema } from "../src";
import geoIndexFieldNotGeopoint from "../src/lints/static/geo-index-field-not-geopoint";

const run = (schema: ReturnType<typeof defineSchema>) => geoIndexFieldNotGeopoint.run({ schema: fromServerSchema(schema) });

describe("geo_index_field_not_geopoint", () => {
    it("passes when the geo index points at a v.geoPoint() column", () => {
        expect.assertions(1);

        const schema = defineSchema({
            places: defineTable({ location: v.geoPoint(), name: v.string() }).geoIndex("by_location", { field: "location" }),
        });

        expect(run(schema)).toHaveLength(0);
    });

    it("flags a geo index over a non-geoPoint column", () => {
        expect.assertions(2);

        const schema = defineSchema({
            places: defineTable({ location: v.string(), name: v.string() }).geoIndex("by_location", { field: "location" }),
        });

        const findings = run(schema);

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            level: "ERROR",
            name: "geo_index_field_not_geopoint",
            categories: ["SCHEMA"],
            cacheKey: "geo_index_field_not_geopoint:places:by_location:location",
            metadata: { field: "location", index: "by_location", kind: "string", table: "places" },
        });
    });

    it("ignores tables without a geo index", () => {
        expect.assertions(1);

        const schema = defineSchema({
            users: defineTable({ name: v.string() }),
        });

        expect(run(schema)).toHaveLength(0);
    });
});
