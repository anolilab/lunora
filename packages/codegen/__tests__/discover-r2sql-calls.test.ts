import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverR2sqlCalls from "../src/discover-r2sql-calls";

/** A query handler that reads R2 SQL via `ctx.r2sql.from(...)`. */
const QUERY_R2SQL_FROM = `
    import { query } from "@lunora/server";

    export const topRegions = query({
        args: {},
        handler: async (ctx) => ctx.r2sql.from("s.orders").select("id").run(),
    });
`;

/** A mutation handler that reads R2 SQL via `ctx.r2sql.query(...)`. */
const MUTATION_R2SQL_QUERY = `
    import { mutation } from "@lunora/server";

    export const syncReport = mutation({
        args: {},
        handler: async (ctx) => {
            await ctx.r2sql.query("SELECT 1");
        },
    });
`;

/** The same `ctx.r2sql` access, but inside an action — must NOT be recorded. */
const ACTION_R2SQL = `
    import { action } from "@lunora/server";

    export const report = action({
        args: {},
        handler: async (ctx) => ctx.r2sql.query("SELECT 1"),
    });
`;

/** A deterministic query — no `ctx.r2sql` access to record. */
const CLEAN_QUERY = `
    import { query } from "@lunora/server";

    export const listUsers = query({
        args: {},
        handler: async (ctx) => ctx.db.query("users").collect(),
    });
`;

let workdir: string;
let project: Project;

describe("discoverR2sqlCalls", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-r2sql-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("records a ctx.r2sql.from() access inside a query handler with its method label", () => {
        expect.assertions(2);

        writeFileSync(join(workdir, "lunora", "analytics.ts"), QUERY_R2SQL_FROM, "utf8");

        const calls = discoverR2sqlCalls(project, join(workdir, "lunora"));

        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ callee: "ctx.r2sql.from", exportName: "topRegions", file: "analytics", kind: "query" });
    });

    it("records a ctx.r2sql.query() access inside a mutation handler", () => {
        expect.assertions(2);

        writeFileSync(join(workdir, "lunora", "reports.ts"), MUTATION_R2SQL_QUERY, "utf8");

        const calls = discoverR2sqlCalls(project, join(workdir, "lunora"));

        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ callee: "ctx.r2sql.query", exportName: "syncReport", file: "reports", kind: "mutation" });
    });

    it("does NOT record a ctx.r2sql access inside an action handler", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "report.ts"), ACTION_R2SQL, "utf8");

        expect(discoverR2sqlCalls(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("records nothing for a query that never touches ctx.r2sql", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "users.ts"), CLEAN_QUERY, "utf8");

        expect(discoverR2sqlCalls(project, join(workdir, "lunora"))).toHaveLength(0);
    });
});
