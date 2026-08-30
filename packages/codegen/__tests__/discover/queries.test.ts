import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverQueries from "../../src/discover/queries";

const FUNCTIONS = `
    import { query } from "@lunora/server";

    const dynamicTable = "messages";

    export const scan = query({ args: {}, handler: (ctx) => ctx.db.query("messages").filter((row) => row.read).collect() });

    export const indexed = query({
        args: {},
        handler: (ctx) => ctx.db.query("messages").withIndex("byRoom", (q) => q.eq("roomId", "x")).filter((row) => row.read).collect(),
    });

    export const noFilter = query({ args: {}, handler: (ctx) => ctx.db.query("messages").collect() });

    export const dynamic = query({ args: {}, handler: (ctx) => ctx.db.query(dynamicTable).filter((row) => row.read).collect() });

    export const geo = query({
        args: {},
        handler: (ctx) => ctx.db.query("places").withGeoIndex("byLocation", (q) => q.near({ lat: 1, lng: 2 }, 500)).collect(),
    });

    export const thenned = query({ args: {}, handler: (ctx) => ctx.db.query("messages").collect().then((rows) => rows.slice(0, 5)) });

    export const capped = query({ args: {}, handler: (ctx) => ctx.db.query("messages").take(10) });

    export const handedOn = query({ args: {}, handler: (ctx) => ctx.db.query("messages").order("desc") });
`;

let workdir: string;
let project: Project;

describe("discoverQueries", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-queries-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        writeFileSync(join(workdir, "lunora", "messages.ts"), FUNCTIONS, "utf8");
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    /** The single read discovered inside a given exported query. */
    const readIn = (exportName: string) => discoverQueries(project, join(workdir, "lunora")).find((read) => read.exportName === exportName);

    it("returns every read, tagging filter, index presence, and table", () => {
        expect.assertions(4);

        const reads = discoverQueries(project, join(workdir, "lunora"));

        // Every read, including the unfiltered ones: they are not
        // `filter_without_index` candidates (that lint gates on `hasFilter`), but
        // a bare unindexed `.collect()` is exactly what `unbounded_collect` looks
        // for, and dropping it here is what made that read invisible to any lint.
        expect(reads).toHaveLength(8);

        // `scan` (no index) is flaggable; `indexed` has a `.withIndex` so it is not.
        expect(reads.filter((read) => !read.hasIndex && read.hasFilter && read.table === "messages")).toHaveLength(1);
        expect(reads.some((read) => read.hasIndex && read.table === "messages")).toBe(true);
        // `dynamic` keeps `table: ""` because the argument is not a string literal.
        expect(reads.some((read) => read.table === "")).toBe(true);
    });

    it("reports the unfiltered, unindexed collect that unbounded_collect consumes", () => {
        expect.assertions(1);

        expect(readIn("noFilter")).toMatchObject({ hasFilter: false, hasIndex: false, table: "messages", terminal: "collect" });
    });

    it("counts withGeoIndex as narrowing, so an idiomatic geo read is not an unbounded scan", () => {
        expect.assertions(1);

        // A geo read resolves a geohash-prefix range plus a distance refine, and
        // is normally written with no `.filter()` — so without this it would land
        // on `unbounded_collect`'s exact trigger. `geo_index_unused` remediates by
        // telling authors to write this very chain.
        expect(readIn("geo")).toMatchObject({ hasIndex: true, table: "places" });
    });

    it("reports the last recognised terminal, not the last chained call", () => {
        expect.assertions(2);

        // `.collect().then(...)` keeps the chain walk going, so the literal last
        // method is a promise combinator. The read is still an unbounded collect.
        expect(readIn("thenned")?.terminal).toBe("collect");
        expect(readIn("capped")?.terminal).toBe("take");
    });

    it("leaves the terminal undefined when the chain reaches none", () => {
        expect.assertions(1);

        // A reader handed on without being materialized: nothing to judge, so the
        // terminal-shaped lints skip it rather than being handed a guess.
        expect(readIn("handedOn")?.terminal).toBeUndefined();
    });

    it("records the file (relative, no extension) and a 1-based line", () => {
        expect.assertions(2);

        const reads = discoverQueries(project, join(workdir, "lunora"));
        const scan = reads.find((read) => !read.hasIndex && read.hasFilter && read.table === "messages");

        expect(scan?.file).toBe("messages");
        expect(scan?.line).toBeGreaterThan(0);
    });
});
