import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runAdvisor, scoreAdvisor } from "@lunora/advisor";
import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { formatAdvisories, lintSchema, toAdvisorContext } from "../src/advisor";
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

    it("reads observability facts off real handler bodies", () => {
        expect.assertions(4);

        writeFileSync(
            join(workdir, "lunora", "ops.ts"),
            `import { action, mutation } from "@lunora/server";
export const quiet = mutation({ args: {}, handler: async (ctx) => { throw new Error("boom"); } });
export const loud = mutation({ args: {}, handler: async (ctx) => { ctx.log.info("did it"); } });
export const risky = action({ args: {}, handler: async (ctx) => { await ctx.fetch("https://example.com"); } });
export const careful = action({ args: {}, handler: async (ctx) => { try { await ctx.fetch("https://example.com"); } catch { /* degraded */ } } });
`,
            "utf8",
        );

        const names = new Set(runCodegen({ projectRoot: workdir }).advisories.map((advisory) => `${advisory.name}:${String(advisory.metadata.exportName)}`));

        expect(names).toContain("error_without_catalog:quiet");
        expect(names).toContain("procedure_without_structured_event:quiet");
        expect(names).not.toContain("procedure_without_structured_event:loud");
        // `risky` has no catch; `careful` does.
        expect([...names].filter((name) => name.startsWith("action_without_error_handling:"))).toStrictEqual(["action_without_error_handling:risky"]);
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

describe("toAdvisorContext (codegen → advisor coverage map)", () => {
    const STAMP = "2026-07-30T00:00:00.000Z";

    /** The documented two-line call site: one context, feeding both the lint run and the score. */
    const mapOf = (source: string) => {
        const context = toAdvisorContext({ schema: irFrom(source) });

        return scoreAdvisor(context, runAdvisor(context, { source: "static" }), { generatedAt: STAMP });
    };

    it("scores the same evidence lintSchema lints, penalising the unindexed schema", () => {
        expect.assertions(3);

        const unindexed = mapOf(UNINDEXED);
        const indexed = mapOf(INDEXED);

        // The FK finding names no procedure, so it lands in the project bucket.
        expect(unindexed.project.checks.some((check) => check.name === "unindexed_foreign_key")).toBe(true);
        expect(unindexed.score).toBeLessThan(indexed.score);
        expect(indexed.grade).toBe("excellent");
    });

    it("attributes a filter-without-index read to the procedure that performs it", () => {
        expect.assertions(3);

        const schemaSource = `
            import { defineSchema, defineTable, v } from "@lunora/server";
            export const schema = defineSchema({ posts: defineTable({ published: v.boolean() }) });
        `;
        const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: true });

        project.createSourceFile("/virtual/lunora/schema.ts", schemaSource);

        // The read sits inside the exported `list` query, so the finding belongs on
        // that procedure's row rather than in the catch-all project bucket.
        const reads = [{ exportName: "list", file: "posts", hasFilter: true, hasIndex: false, line: 2, table: "posts" }];
        const procedures = [
            {
                callsMail: false,
                exportName: "list",
                fanOut: false,
                file: "posts",
                kind: "query" as const,
                unboundedAiGeneration: false,
                usesCaptcha: false,
                usesEmailGate: false,
                usesInsertManyUnsafe: false,
                usesMask: false,
                usesRateLimit: false,
                usesRls: false,
                visibility: "public" as const,
                writesUserTable: false,
            },
        ];

        const context = toAdvisorContext({ procedureProtections: procedures, queries: reads, schema: discoverSchema(project, "/virtual/lunora/schema.ts") });
        const map = scoreAdvisor(context, runAdvisor(context, { source: "static" }), { generatedAt: STAMP });
        const row = map.procedures.find((entry) => entry.id === "posts#list");

        expect(row?.checks.map((check) => check.name)).toContain("filter_without_index");
        expect(map.project.checks.map((check) => check.name)).not.toContain("filter_without_index");
        expect(row?.coverage).not.toBe("clean");
    });

    it("builds a context equivalent to the one lintSchema lints", () => {
        expect.assertions(1);

        const options = { schema: irFrom(UNINDEXED) };

        expect(runAdvisor(toAdvisorContext(options), { source: "static" })).toStrictEqual(lintSchema(options));
    });
});
