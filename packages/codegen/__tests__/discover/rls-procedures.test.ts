import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverRlsProcedures from "../../src/discover/rls-procedures";

// The same self-contained branded builder the rls-metadata fixtures use: discovery
// resolves the `__lunoraProcedure` brand off the receiver's type, so the builder is
// declared inline.
 
const PREAMBLE = `
    interface Policy { table: string; on: string; when: (context: unknown) => unknown }
    declare const rls: (policies: unknown) => (options: { ctx: unknown }) => unknown;
    declare const definePolicy: (options: Policy) => Policy;
    declare const definePolicies: (policies: Policy[]) => Policy[];
    declare const loadPolicies: () => Policy[];

    interface QueryBuilder<Args> {
        readonly __lunoraProcedure: "query";
        use: <C>(middleware: (options: { ctx: unknown }) => C) => QueryBuilder<Args>;
        query: <R>(handler: (options: { args: Args; ctx: unknown }) => R) => { kind: "query" };
    }

    declare const c: {
        query: QueryBuilder<Record<never, never>>;
    };
`;

// A `definePolicies` list held in a `const` and handed to `rls` by name, then a
// call-produced policy list that cannot be enumerated statically.
const POLICIES = `${PREAMBLE}
    const policies = definePolicies([
        definePolicy({ on: "read", table: "notes", when: () => true }),
        definePolicy({ on: "insert", table: "posts", when: () => true }),
    ]);
    const r = rls(policies);
    export const aliased = c.query.use(r).query(async () => []);

    export const loaded = c.query.use(rls(loadPolicies())).query(async () => []);
`;

let workdir: string;
let project: Project;

describe("discoverRlsProcedures", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-rls-procedures-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        writeFileSync(join(workdir, "lunora", "policies.ts"), POLICIES, "utf8");
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("reads the tables of policies declared through definePolicies behind a const", () => {
        expect.assertions(2);

        const procedure = discoverRlsProcedures(project, join(workdir, "lunora")).find((candidate) => candidate.exportName === "aliased");

        expect(procedure?.rlsTables).toStrictEqual(["notes", "posts"]);
        expect(procedure?.usesRls).toBe(true);
    });

    it("keeps usesRls but reports no tables when the policies cannot be enumerated", () => {
        expect.assertions(2);

        const procedure = discoverRlsProcedures(project, join(workdir, "lunora")).find((candidate) => candidate.exportName === "loaded");

        expect(procedure?.rlsTables).toStrictEqual([]);
        expect(procedure?.usesRls).toBe(true);
    });
});
