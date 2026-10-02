import { describe, expect, it } from "vitest";

import validateJurisdiction from "../src/cloudflare/validate-jurisdiction";
import type { WranglerConfig } from "../src/cloudflare/wrangler-config";
import type { SchemaInfo } from "../src/schema-info";

const euSchema: SchemaInfo = { hasD1GlobalTable: false, hasHyperdriveGlobalTable: false, jurisdiction: "eu" };

const warningsFor = (wrangler: unknown, schema: SchemaInfo | undefined = euSchema): string[] => {
    const warnings: string[] = [];

    validateJurisdiction(wrangler as WranglerConfig, schema, warnings);

    return warnings;
};

describe(validateJurisdiction, () => {
    it("checks nothing without a schema jurisdiction", () => {
        expect.assertions(1);

        const wrangler = { kv_namespaces: [{ binding: "CACHE" }], r2_buckets: [{ binding: "UPLOADS", bucket_name: "uploads" }] };

        expect(warningsFor(wrangler, { hasD1GlobalTable: false, hasHyperdriveGlobalTable: false })).toStrictEqual([]);
    });

    it("asks for --jurisdiction on a KV namespace that still has to be created, and leaves a created one alone", () => {
        expect.assertions(2);

        const warnings = warningsFor({ kv_namespaces: [{ binding: "CACHE" }, { binding: "SESSIONS", id: "abc" }] });

        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('kv_namespaces[0] ("CACHE")');
    });

    it("warns about an R2 binding that names no jurisdiction, or another one", () => {
        expect.assertions(2);

        const warnings = warningsFor({
            r2_buckets: [
                { binding: "UPLOADS", bucket_name: "uploads" },
                { binding: "AVATARS", bucket_name: "avatars", jurisdiction: "fedramp" },
                { binding: "DOCS", bucket_name: "docs", jurisdiction: "eu" },
            ],
        });

        expect(warnings).toHaveLength(2);
        expect(warnings[1]).toContain('names the "fedramp" jurisdiction');
    });

    it("keeps the raw index when the array holds non-object entries", () => {
        expect.assertions(2);

        const warnings = warningsFor({ kv_namespaces: [null, { binding: "CACHE" }], r2_buckets: [null, { binding: "UPLOADS", bucket_name: "uploads" }] });

        expect(warnings[0]).toContain('kv_namespaces[1] ("CACHE")');
        expect(warnings[1]).toContain('r2_buckets[1] ("UPLOADS")');
    });

    it("treats a non-string jurisdiction as none", () => {
        expect.assertions(1);

        expect(warningsFor({ r2_buckets: [{ binding: "UPLOADS", bucket_name: "uploads", jurisdiction: 42 }] })[0]).toContain("names no jurisdiction");
    });
});
