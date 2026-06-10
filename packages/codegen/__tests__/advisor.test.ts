import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { formatAdvisories, lintSchema } from "../src/advisor";
import discoverSchema from "../src/discover-schema";
import { runCodegen } from "../src/index";

/** Build a `SchemaIR` from in-memory schema source (no disk). */
const irFrom = (schemaSource: string) => {
    const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: true });
    const schemaPath = "/virtual/cirrus/schema.ts";

    project.createSourceFile(schemaPath, schemaSource);

    return discoverSchema(project, schemaPath);
};

const UNINDEXED = `
    import { defineSchema, defineTable, v } from "@cirrus/server";

    export const schema = defineSchema({
        users: defineTable({ name: v.string() }),
        posts: defineTable({ authorId: v.id("users"), title: v.string() }).relations((r) => ({
            author: r.one("users", { field: "authorId" }),
        })),
    });
`;

const INDEXED = `
    import { defineSchema, defineTable, v } from "@cirrus/server";

    export const schema = defineSchema({
        users: defineTable({ name: v.string() }),
        posts: defineTable({ authorId: v.id("users"), title: v.string() })
            .index("byAuthorId", ["authorId"])
            .relations((r) => ({ author: r.one("users", { field: "authorId" }) })),
    });
`;

describe("lintSchema (codegen → advisor)", () => {
    it("flags an unindexed `one`-relation FK from the discovered IR", () => {
        expect.assertions(3);

        const findings = lintSchema(irFrom(UNINDEXED));

        expect(findings).toHaveLength(1);
        expect(findings[0]?.name).toBe("unindexed_foreign_key");
        expect(findings[0]?.metadata).toMatchObject({ fkColumn: "authorId", table: "posts" });
    });

    it("passes once the FK column leads an index", () => {
        expect.assertions(1);

        expect(lintSchema(irFrom(INDEXED))).toHaveLength(0);
    });
});

describe("formatAdvisories", () => {
    it("returns an empty string when there are no findings", () => {
        expect.assertions(1);

        expect(formatAdvisories([])).toBe("");
    });

    it("renders a summary header plus one line per finding", () => {
        expect.assertions(2);

        const out = formatAdvisories(lintSchema(irFrom(UNINDEXED)));

        expect(out).toContain("@cirrus/codegen: 1 schema advisor finding");
        expect(out).toContain("[INFO] unindexed_foreign_key:");
    });
});

describe("runCodegen lint integration", () => {
    let workdir: string;

    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "cirrus-advisor-"));
        mkdirSync(join(workdir, "cirrus"), { recursive: true });
        writeFileSync(join(workdir, "cirrus", "schema.ts"), UNINDEXED, "utf8");
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("returns advisories in the result (codegen does not print them)", () => {
        expect.assertions(2);

        const names = runCodegen({ projectRoot: workdir }).advisories.map((advisory) => advisory.name);

        // The FK lint fires on the schema; the write feeder also flags `posts`
        // (no `ctx.db.insert("posts", …)` in the fixture functions).
        expect(names).toContain("unindexed_foreign_key");
        expect(names).toContain("table_without_insert");
    });

    it("respects `lint: false` — no findings", () => {
        expect.assertions(1);

        expect(runCodegen({ lint: false, projectRoot: workdir }).advisories).toHaveLength(0);
    });

    it("still computes advisories on a dry run", () => {
        expect.assertions(1);

        expect(runCodegen({ dryRun: true, projectRoot: workdir }).advisories.map((advisory) => advisory.name)).toContain("unindexed_foreign_key");
    });

    it("flags a filter-without-index read discovered in a function body", () => {
        expect.assertions(2);

        // A query function that filters `posts` without narrowing by an index.
        writeFileSync(
            join(workdir, "cirrus", "posts.ts"),
            `import { query } from "@cirrus/server";\nexport const list = query({ args: {}, handler: (ctx) => ctx.db.query("posts").filter((row) => row.published).collect() });\n`,
            "utf8",
        );

        const names = runCodegen({ projectRoot: workdir }).advisories.map((advisory) => advisory.name);

        expect(names).toContain("filter_without_index");
        expect(names).toContain("unindexed_foreign_key");
    });

    it("emits the advisories into the generated shard for the getAdvisories RPC", () => {
        expect.assertions(3);

        const { shard } = runCodegen({ projectRoot: workdir }).generated;

        // The generated subclass overrides `advisories()` with the baked list,
        // so the DO's `getAdvisories` admin RPC can serve them to the studio.
        expect(shard).toContain("const CIRRUS_ADVISORIES: AdvisoryFinding[] =");
        expect(shard).toContain("protected override advisories(): AdvisoryFinding[]");
        expect(shard).toContain("unindexed_foreign_key");
    });

    it("emits an empty advisory list under `lint: false`", () => {
        expect.assertions(1);

        expect(runCodegen({ lint: false, projectRoot: workdir }).generated.shard).toContain("const CIRRUS_ADVISORIES: AdvisoryFinding[] = [];");
    });
});
