import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverHyperdriveCalls from "../../src/discover/hyperdrive-calls";

/** A query handler that reaches the external database via `ctx.sql.query(...)`. */
const QUERY_CTX_SQL = `
    import { query } from "@lunora/server";

    export const listCustomers = query({
        args: {},
        handler: async (ctx) => ctx.sql.query("SELECT * FROM customers"),
    });
`;

/** A mutation handler that reaches `ctx.sql` bare (aliased, not method-called). */
const MUTATION_CTX_SQL = `
    import { mutation } from "@lunora/server";

    export const syncCustomers = mutation({
        args: {},
        handler: async (ctx) => {
            const sql = ctx.sql;

            return sql;
        },
    });
`;

/** The same access inside an action — the only context where `ctx.sql` is typed. */
const ACTION_CTX_SQL = `
    import { action } from "@lunora/server";

    export const importCustomers = action({
        args: {},
        handler: async (ctx) => ctx.sql.query("SELECT 1"),
    });
`;

/** A query touching only Lunora's own tables. */
const CLEAN_QUERY = `
    import { query } from "@lunora/server";

    export const listUsers = query({
        args: {},
        handler: async (ctx) => ctx.db.query("users").collect(),
    });
`;

let workdir: string;
let project: Project;

/**
 * The feeder behind `hyperdrive_outside_action`. The lint shipped with none:
 * it returns `[]` unless `context.hyperdriveCalls` is set and nothing set it, so
 * the only guardrail against non-deterministic external SQL inside a reactive
 * handler was inert.
 */
describe("discoverHyperdriveCalls", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-hyperdrive-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("records a ctx.sql.query() access inside a query handler with its method label", () => {
        expect.assertions(2);

        writeFileSync(join(workdir, "lunora", "customers.ts"), QUERY_CTX_SQL, "utf8");

        const calls = discoverHyperdriveCalls(project, join(workdir, "lunora"));

        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ callee: "ctx.sql.query", exportName: "listCustomers", file: "customers", kind: "query" });
    });

    it("records a bare ctx.sql read inside a mutation handler", () => {
        expect.assertions(2);

        writeFileSync(join(workdir, "lunora", "sync.ts"), MUTATION_CTX_SQL, "utf8");

        const calls = discoverHyperdriveCalls(project, join(workdir, "lunora"));

        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ callee: "ctx.sql", exportName: "syncCustomers", kind: "mutation" });
    });

    it("does NOT record a ctx.sql access inside an action handler", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "import.ts"), ACTION_CTX_SQL, "utf8");

        expect(discoverHyperdriveCalls(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("records nothing for a query that never touches ctx.sql", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "users.ts"), CLEAN_QUERY, "utf8");

        expect(discoverHyperdriveCalls(project, join(workdir, "lunora"))).toHaveLength(0);
    });
});
