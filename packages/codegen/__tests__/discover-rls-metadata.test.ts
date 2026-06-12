import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverRlsMetadata } from "../src/discover-rls-procedures";

// A self-contained branded builder + RLS DSL. Discovery resolves the
// `__cirrusProcedure` brand off the receiver's *type*, so the builder is
// declared inline (the isolated test project has no workspace module
// resolution). `.use` returns the same builder so the `.use(rls(...)).query(...)`
// chain type-checks and the chain walk finds the `rls(...)` call.
// eslint-disable-next-line no-secrets/no-secrets -- the high-entropy match is a TypeScript type name inside this test source fixture, not a credential
const PREAMBLE = `
    interface Policy { table: string; on: string; when: (context: unknown) => unknown }
    interface Role { name: string; description?: string; permissions?: unknown[] }
    declare const rls: (policies: Policy[], options?: { roles?: Role[] }) => (options: { ctx: unknown }) => unknown;
    declare const defineRole: (name: string, options?: { description?: string; permissions?: unknown[] }) => Role;
    declare const definePermission: (name: string, options?: { description?: string }) => { name: string };
    declare const query: <R>(config: { args: Record<string, unknown>; handler: (ctx: unknown) => R }) => { kind: "query" };

    interface QueryBuilder<Args> {
        readonly __cirrusProcedure: "query";
        use: <C>(middleware: (options: { ctx: unknown }) => C) => QueryBuilder<Args>;
        query: <R>(handler: (options: { args: Args; ctx: unknown }) => R) => { kind: "query" };
    }

    interface MutationBuilder<Args> {
        readonly __cirrusProcedure: "mutation";
        use: <C>(middleware: (options: { ctx: unknown }) => C) => MutationBuilder<Args>;
        mutation: <R>(handler: (options: { args: Args; ctx: unknown }) => R) => { kind: "mutation" };
    }

    declare const c: {
        mutation: MutationBuilder<Record<never, never>>;
        query: QueryBuilder<Record<never, never>>;
    };
`;

// A builder-form query guarded by `.use(rls([...], { roles: [...] }))` with the
// policies + roles spelled out as inline array literals so the static extractor
// can read `table`/`on` and the role names/permissions.
const DOCUMENTS = `${PREAMBLE}
    export const list = c.query
        .use(
            rls(
                [
                    { table: "documents", on: "read", when: ({ auth }) => ({ ownerId: auth.userId }) },
                    { table: "documents", on: "update", when: () => true },
                ],
                {
                    roles: [
                        defineRole("admin", { description: "Full access", permissions: ["documents:delete", definePermission("documents:write")] }),
                        defineRole("viewer"),
                    ],
                },
            ),
        )
        .query(() => null);

    // A bare-factory procedure — no builder chain, so it contributes nothing.
    export const peek = query({ args: {}, handler: () => null });
`;

// A second file re-registering the "admin" role plus a fresh one, to prove
// roles dedupe by name across files (first declaration wins).
const POSTS = `${PREAMBLE}
    export const moderate = c.mutation
        .use(
            rls([{ table: "posts", on: "delete", when: () => true }], {
                roles: [defineRole("admin"), defineRole("editor", { permissions: ["posts:write"] })],
            }),
        )
        .mutation(() => null);
`;

let workdir: string;
let project: Project;

describe("discoverRlsMetadata", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "cirrus-rls-meta-"));
        mkdirSync(join(workdir, "cirrus"), { recursive: true });
        writeFileSync(join(workdir, "cirrus", "documents.ts"), DOCUMENTS, "utf8");
        writeFileSync(join(workdir, "cirrus", "posts.ts"), POSTS, "utf8");
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("extracts each policy's table + operation and the declaring procedure", () => {
        expect.assertions(3);

        const { policies } = discoverRlsMetadata(project, join(workdir, "cirrus"));

        expect(policies).toContainEqual({ file: "documents", on: "read", procedure: "list", table: "documents" });
        expect(policies).toContainEqual({ file: "documents", on: "update", procedure: "list", table: "documents" });
        expect(policies).toContainEqual({ file: "posts", on: "delete", procedure: "moderate", table: "posts" });
    });

    it("captures role names, descriptions, and permission names, deduping by name", () => {
        expect.assertions(3);

        const { roles } = discoverRlsMetadata(project, join(workdir, "cirrus"));

        // The "admin" role appears once (the richer first declaration wins the dedupe).
        expect(roles.filter((role) => role.name === "admin")).toHaveLength(1);
        expect(roles).toContainEqual({ description: "Full access", name: "admin", permissions: ["documents:delete", "documents:write"] });
        expect(roles).toContainEqual({ name: "viewer", permissions: [] });
    });

    it("ignores bare-factory procedures and non-rls chains", () => {
        expect.assertions(1);

        const { policies } = discoverRlsMetadata(project, join(workdir, "cirrus"));

        // `peek` has no builder chain, so it can declare no policy.
        expect(policies.some((policy) => policy.procedure === "peek")).toBe(false);
    });
});
