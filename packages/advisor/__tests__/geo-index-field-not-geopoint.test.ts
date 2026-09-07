import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import { fromServerSchema } from "../src";
import geoIndexFieldNotGeopoint from "../src/lints/static/geo-index-field-not-geopoint";
import type { AdvisorSchema } from "../src/schema";

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

    it("ignores a geo index over an Object.prototype member that is not a declared column", () => {
        expect.assertions(1);

        const schema: AdvisorSchema = {
            tables: [
                {
                    columnKinds: { name: "string" },
                    fields: ["name"],
                    indexes: [{ fields: ["constructor"], kind: "geo", name: "by_location" }],
                    name: "places",
                    relations: [],
                },
            ],
        };

        expect(geoIndexFieldNotGeopoint.run({ schema })).toHaveLength(0);
    });

    it("ignores tables without a geo index", () => {
        expect.assertions(1);

        const schema = defineSchema({
            users: defineTable({ name: v.string() }),
        });

        expect(run(schema)).toHaveLength(0);
    });
});
