import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { formatAdvisories, lintSchema, mapSchema } from "../src/advisor";
import discoverSchema from "../src/discover-schema";
import { runCodegen } from "../src/index";

/** Build a `SchemaIR` from in-memory schema source (no disk). */
const irFrom = (schemaSource: string) => {
    const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: true });
    const schemaPath = "/virtual/lunora/schema.ts";

    project.createSourceFile(schemaPath, schemaSource);

    return discoverSchema(project, schemaPath);
};

const UNINDEXED = `
    import { defineSchema, defineTable, v } from "@lunora/server";

    export const schema = defineSchema({
        users: defineTable({ name: v.string() }),
        posts: defineTable({ authorId: v.id("users"), title: v.string() }).relations((r) => ({
            author: r.one("users", { field: "authorId" }),
        })),
    });
`;

const INDEXED = `
    import { defineSchema, defineTable, v } from "@lunora/server";

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

        const findings = lintSchema({ schema: irFrom(UNINDEXED) });

        expect(findings).toHaveLength(1);
        expect(findings[0]?.name).toBe("unindexed_foreign_key");
        expect(findings[0]?.metadata).toMatchObject({ fkColumn: "authorId", table: "posts" });
    });

    it("passes once the FK column leads an index", () => {
        expect.assertions(1);

        expect(lintSchema({ schema: irFrom(INDEXED) })).toHaveLength(0);
    });
});

describe("formatAdvisories", () => {
    it("returns an empty string when there are no findings", () => {
        expect.assertions(1);

        expect(formatAdvisories([])).toBe("");
    });

    it("renders a summary header plus one line per finding", () => {
        expect.assertions(2);

        const out = formatAdvisories(lintSchema({ schema: irFrom(UNINDEXED) }));

        expect(out).toContain("@lunora/codegen: 1 schema advisor finding");
        expect(out).toContain("[INFO] unindexed_foreign_key:");
    });
});

describe("runCodegen lint integration", () => {
    let workdir: string;

    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-advisor-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        writeFileSync(join(workdir, "lunora", "schema.ts"), UNINDEXED, "utf8");
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
            join(workdir, "lunora", "posts.ts"),
            `import { query } from "@lunora/server";\nexport const list = query({ args: {}, handler: (ctx) => ctx.db.query("posts").filter((row) => row.published).collect() });\n`,
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
        expect(shard).toContain("const LUNORA_ADVISORIES: AdvisoryFinding[] =");
        expect(shard).toContain("protected override advisories(): AdvisoryFinding[]");
        expect(shard).toContain("unindexed_foreign_key");
    });

    it("emits an empty advisory list under `lint: false`", () => {
        expect.assertions(1);

        expect(runCodegen({ lint: false, projectRoot: workdir }).generated.shard).toContain("const LUNORA_ADVISORIES: AdvisoryFinding[] = [];");
    });

    it("flags replication shapes targeting an unknown table and a `.global()` table (full discover → lint path)", () => {
        expect.assertions(4);

        // A schema with a sharded `messages` (poke-live) and a global `users` (D1 tier).
        writeFileSync(
            join(workdir, "lunora", "schema.ts"),
            `import { defineSchema, defineTable, v } from "@lunora/server";
export const schema = defineSchema({
    messages: defineTable({ text: v.string() }).shardBy("text"),
    users: defineTable({ email: v.string() }).global(),
});
`,
            "utf8",
        );
        // One shape over the global table (poll-tier WARN) and one over a typo'd table (unknown ERROR).
        writeFileSync(
            join(workdir, "lunora", "shapes.ts"),
            `import { defineShape } from "@lunora/server";
export const allUsers = defineShape({ table: "users", where: () => ({}) });
export const ghost = defineShape({ table: "mesages", where: () => ({}) });
`,
            "utf8",
        );

        const findings = runCodegen({ projectRoot: workdir }).advisories;
        const byName = (name: string) => findings.filter((finding) => finding.name === name);

        expect(byName("shape_targets_global_table")).toHaveLength(1);
        expect(byName("shape_targets_global_table")[0]?.metadata).toMatchObject({ exportName: "allUsers", table: "users" });
        expect(byName("shape_unknown_table")).toHaveLength(1);
        expect(byName("shape_unknown_table")[0]?.metadata).toMatchObject({ exportName: "ghost", table: "mesages" });
    });

    it('flags a `.public()` table with a PII column under `.rls("required")` (full discover → lint path)', () => {
        expect.assertions(2);

        writeFileSync(
            join(workdir, "lunora", "schema.ts"),
            `import { defineSchema, defineTable, v } from "@lunora/server";
export const schema = defineSchema({
    accounts: defineTable({ email: v.string() }).public(),
}).rls("required");
`,
            "utf8",
        );

        const findings = runCodegen({ projectRoot: workdir }).advisories;
        const finding = findings.find((advisory) => advisory.name === "public_table_rls_optout_confusion");

        expect(finding).toBeDefined();
        expect(finding?.metadata).toMatchObject({ columns: ["email"], table: "accounts" });
    });

    it("flags `.extend()` enabling allowUnauthenticatedShardAccess on an RLS-gapped schema (full discover → lint path)", () => {
        expect.assertions(2);

        // The fixture schema (UNINDEXED) never calls `.rls("required")`, so it already has an RLS gap.
        writeFileSync(
            join(workdir, "lunora", "server.ts"),
            `import { defineApp } from "@lunora/runtime";
export const app = defineApp().extend(() => ({ allowUnauthenticatedShardAccess: true })).build();
`,
            "utf8",
        );

        const findings = runCodegen({ projectRoot: workdir }).advisories;
        const finding = findings.find((advisory) => advisory.name === "allow_unauthenticated_shard_access_enabled");

        expect(finding).toBeDefined();
        expect(finding?.metadata).toMatchObject({ callee: "extend", file: "server" });
    });
});

describe("mapSchema (codegen → advisor coverage map)", () => {
    const STAMP = "2026-07-30T00:00:00.000Z";

    it("scores the same evidence lintSchema lints, penalising the unindexed schema", () => {
        expect.assertions(3);

        const unindexed = mapSchema({ schema: irFrom(UNINDEXED) }, { generatedAt: STAMP });
        const indexed = mapSchema({ schema: irFrom(INDEXED) }, { generatedAt: STAMP });

        // The FK finding names no procedure, so it lands in the project bucket.
        expect(unindexed.project.checks.some((check) => check.name === "unindexed_foreign_key")).toBe(true);
        expect(unindexed.score).toBeLessThan(indexed.score);
        expect(indexed.grade).toBe("excellent");
    });

    it("reuses findings a caller already has rather than linting twice", () => {
        expect.assertions(1);

        const options = { schema: irFrom(UNINDEXED) };
        const findings = lintSchema(options);

        expect(mapSchema(options, { findings, generatedAt: STAMP })).toStrictEqual(mapSchema(options, { generatedAt: STAMP }));
    });
});
