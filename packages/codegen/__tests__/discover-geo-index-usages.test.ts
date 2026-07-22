import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverGeoIndexUsages from "../src/discover-geo-index-usages";

const PLACES = `
    import { query } from "@lunora/server";

    const dynamicName = "by_location";

    // Conventional literal name via the query reader.
    export const nearby = query({
        args: {},
        handler: async (ctx) =>
            ctx.db.query("places").withGeoIndex("by_location", (q) => q.near({ lat: 1, lng: 2 }, 1000)).collect(),
    });

    // Table-reader form.
    export const around = query({
        args: {},
        handler: async (ctx) => ctx.db.places.withGeoIndex("by_location", (q) => q.within({})).collect(),
    });

    // Dynamic (non-literal) name — discovered with indexName "".
    export const dynamic = query({
        args: {},
        handler: async (ctx) => ctx.db.query("places").withGeoIndex(dynamicName, (q) => q).collect(),
    });

    // Not a geo read — a plain filter chain.
    export const plain = query({ args: {}, handler: (ctx) => ctx.db.query("places").filter(() => true) });
`;

let workdir: string;
let project: Project;

describe("discoverGeoIndexUsages", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-geo-usages-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        writeFileSync(join(workdir, "lunora", "places.ts"), PLACES, "utf8");
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("records literal index names from both the query and table-reader forms", () => {
        expect.assertions(2);

        const usages = discoverGeoIndexUsages(project, join(workdir, "lunora"));
        const literal = usages.filter((usage) => usage.indexName === "by_location");

        expect(literal).toHaveLength(2);
        expect(literal.every((usage) => usage.file === "places")).toBe(true);
    });

    it("records a non-literal name argument as an empty indexName", () => {
        expect.assertions(1);

        const usages = discoverGeoIndexUsages(project, join(workdir, "lunora"));

        expect(usages.some((usage) => usage.indexName === "")).toBe(true);
    });

    it("ignores chains that don't call withGeoIndex", () => {
        expect.assertions(1);

        const usages = discoverGeoIndexUsages(project, join(workdir, "lunora"));

        // Only the three withGeoIndex sites — the plain filter chain is not one.
        expect(usages).toHaveLength(3);
    });
});
