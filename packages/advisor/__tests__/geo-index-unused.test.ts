import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import type { AdvisorGeoIndexUsage } from "../src";
import { fromServerSchema } from "../src";
import geoIndexUnused from "../src/lints/static/geo-index-unused";

const schema = () =>
    fromServerSchema(
        defineSchema({
            places: defineTable({ location: v.geoPoint(), name: v.string() }).geoIndex("by_location", { field: "location" }),
        }),
    );

const run = (geoIndexUsages?: AdvisorGeoIndexUsage[]) => geoIndexUnused.run({ geoIndexUsages, schema: schema() });

describe("geo_index_unused", () => {
    it("finds nothing when no usage evidence is supplied (runtime caller)", () => {
        expect.assertions(1);

        expect(run()).toHaveLength(0);
    });

    it("flags a geo index no handler queries via withGeoIndex", () => {
        expect.assertions(2);

        const findings = run([]);

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            cacheKey: "geo_index_unused:places:by_location",
            categories: ["SCHEMA"],
            level: "INFO",
            metadata: { index: "by_location", table: "places" },
            name: "geo_index_unused",
        });
    });

    it("is clean when a handler reads the geo index via withGeoIndex", () => {
        expect.assertions(1);

        const usages: AdvisorGeoIndexUsage[] = [{ file: "nearby", indexName: "by_location", line: 4 }];

        expect(run(usages)).toHaveLength(0);
    });

    it("suppresses entirely when any usage passes a non-literal index name", () => {
        expect.assertions(1);

        const usages: AdvisorGeoIndexUsage[] = [{ file: "nearby", indexName: "", line: 4 }];

        expect(run(usages)).toHaveLength(0);
    });

    it("ignores a used geo index name that belongs to another declaration", () => {
        expect.assertions(1);

        const usages: AdvisorGeoIndexUsage[] = [{ file: "nearby", indexName: "some_other_index", line: 4 }];

        // by_location is still unqueried → one finding.
        expect(run(usages)).toHaveLength(1);
    });
});
