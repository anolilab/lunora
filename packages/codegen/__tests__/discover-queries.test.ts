import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverQueries from "../src/discover-queries";

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

    it("returns only filtered reads, tagging index presence and table", () => {
        expect.assertions(4);

        const reads = discoverQueries(project, join(workdir, "lunora"));

        // `noFilter` is dropped; the other three filter.
        expect(reads).toHaveLength(3);

        const unindexed = reads.filter((read) => !read.hasIndex && read.table === "messages");

        // `scan` (no index) is flaggable; `indexed` has a `.withIndex` so it is not.
        expect(unindexed).toHaveLength(1);
        expect(reads.some((read) => read.hasIndex && read.table === "messages")).toBe(true);
        // `dynamic` keeps `table: ""` because the argument is not a string literal.
        expect(reads.some((read) => read.table === "")).toBe(true);
    });

    it("records the file (relative, no extension) and a 1-based line", () => {
        expect.assertions(2);

        const reads = discoverQueries(project, join(workdir, "lunora"));
        const scan = reads.find((read) => !read.hasIndex && read.table === "messages");

        expect(scan?.file).toBe("messages");
        expect(scan?.line).toBeGreaterThan(0);
    });
});
