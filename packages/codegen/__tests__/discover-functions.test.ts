import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverFunctions } from "../src/discover-functions";

const NAMESPACE_COLLISION_RE = /Namespace collision/u;
const CURSOR_DOC_ARRAY_RE = /CursorDoc\[\]/u;

let workdir: string;

describe("discoverFunctions", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-disco-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    const writeFunction = (relative: string, source: string): void => {
        const full = join(workdir, relative);

        mkdirSync(full.slice(0, Math.max(0, full.lastIndexOf("/"))), { recursive: true });
        writeFileSync(full, source);
    };

    const tinyQuery = `
    import { query } from "@lunora/server";
    export const list = query({ args: {}, handler: () => null });
`;

    describe("discoverFunctions namespace collision", () => {
        it("throws LunoraError when two distinct paths sanitize to the same namespace", () => {
            expect.assertions(3);

            // `foo/bar.ts` and `foo-bar.ts` both → `foo_bar`. Without the guard
            // the generated ApiTypes would emit duplicate `foo_bar:` keys.
            writeFunction("foo/bar.ts", tinyQuery);
            writeFunction("foo-bar.ts", tinyQuery);

            const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });

            expect(() => discoverFunctions(project, workdir)).toThrow(NAMESPACE_COLLISION_RE);

            let caught: unknown;

            try {
                discoverFunctions(project, workdir);
            } catch (error: unknown) {
                caught = error;
            }

            expect(caught).toMatchObject({ code: "NAMESPACE_COLLISION", name: "LunoraError", status: 500 });
            expect((caught as { paths: string[] }).paths).toEqual(expect.arrayContaining(["foo-bar", "foo/bar"]));
        });

        it("distinct sanitized namespaces do not trip the collision guard", () => {
            expect.hasAssertions();

            writeFunction("foo.ts", tinyQuery);
            writeFunction("bar.ts", tinyQuery);

            const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });

            const result = discoverFunctions(project, workdir);

            expect(result).toHaveLength(2);
            expect(result.map((f) => f.filePath).toSorted((a, b) => a.localeCompare(b))).toEqual(["bar", "foo"]);
        });

        it("detects aliased imports — `import { query as q }` is treated as a query", () => {
            expect.hasAssertions();

            writeFunction(
                "messages.ts",
                `
            import { query as q, mutation as m } from "@lunora/server";
            export const list = q({ args: {}, handler: () => null });
            export const send = m({ args: {}, handler: () => null });
        `,
            );

            const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
            const result = discoverFunctions(project, workdir);

            const byName = new Map(result.map((f) => [f.exportName, f]));

            expect(byName.get("list")?.kind).toBe("query");
            expect(byName.get("send")?.kind).toBe("mutation");
        });

        it("discovers registrations imported from the generated `_generated/server` re-export", () => {
            expect.hasAssertions();

            // The Convex idiom: user code imports `query`/`mutation` from
            // `./_generated/server` (so `v.id(...)` is table-name typed) rather
            // than straight from `@lunora/server`. Discovery must treat those as
            // real registrations, otherwise every function silently vanishes
            // from the generated `api.ts`.
            writeFunction(
                "messages.ts",
                `
            import { mutation, query } from "./_generated/server.js";
            export const list = query({ args: {}, handler: () => null });
            export const send = mutation({ args: {}, handler: () => null });
        `,
            );

            const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
            const result = discoverFunctions(project, workdir);

            const byName = new Map(result.map((f) => [f.exportName, f]));

            expect(byName.get("list")?.kind).toBe("query");
            expect(byName.get("send")?.kind).toBe("mutation");
        });

        it("ignores a local `const query` shadowing the @lunora/server import", () => {
            expect.assertions(1);

            // A local `query` is NOT the framework helper, even if the name matches.
            writeFunction(
                "messages.ts",
                `
            const query = (definition: { args: Record<string, unknown>; handler: () => unknown }) => definition;
            export const list = query({ args: {}, handler: () => null });
        `,
            );

            const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
            const result = discoverFunctions(project, workdir);

            expect(result).toHaveLength(0);
        });

        it("infers handler return types when the type checker can resolve them", () => {
            expect.hasAssertions();

            // Handler returns a literal object whose type is inferrable from the
            // body alone — no need for `@lunora/server`/`@lunora/values` resolution.
            writeFunction(
                "messages.ts",
                `
            import { query, mutation } from "@lunora/server";
            export const greet = query({
                args: {},
                handler: (): { hello: "world" } => ({ hello: "world" }),
            });
            export const tick = mutation({
                args: {},
                handler: async (): Promise<number> => 42,
            });
        `,
            );

            const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
            const result = discoverFunctions(project, workdir);
            const byName = new Map(result.map((f) => [f.exportName, f]));

            // Annotated literal type passes through directly.
            expect(byName.get("greet")?.returnType).toBe('{ hello: "world"; }');
            // Promise<T> is unwrapped to T.
            expect(byName.get("tick")?.returnType).toBe("number");
        });

        it("falls back to `unknown` when the checker can't resolve enough to be useful", () => {
            expect.assertions(1);

            // Without annotations and without args/context wired to real types,
            // the inferred return is full of `any` — we'd rather emit `unknown`
            // than surface a misleading partial shape.
            writeFunction(
                "messages.ts",
                `
            import { query } from "@lunora/server";
            export const list = query({
                args: {},
                handler: async (_context, args) => ({ ok: true, args }),
            });
        `,
            );

            const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
            const result = discoverFunctions(project, workdir);

            expect(result[0]?.returnType).toBe("unknown");
        });

        it("structurally expands a return type that references a non-exported local type", () => {
            expect.assertions(1);

            // A handler whose return type names an `interface` declared in the
            // same file but never exported would emit `CursorDoc[]` into
            // `_generated/api.ts` — an identifier with no reachable import, which
            // produces TS2304 downstream. Rather than erase to `unknown`, codegen
            // expands the interface to its real shape so callers still get full
            // type inference without having to export the interface.
            writeFunction(
                "cursors.ts",
                `
            import { query } from "@lunora/server";

            interface CursorDoc {
                id: string;
                x: number;
                y: number;
            }

            export const list = query({
                args: {},
                handler: (): CursorDoc[] => [],
            });
        `,
            );

            const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
            const result = discoverFunctions(project, workdir);

            expect(result[0]?.returnType).toBe("{ id: string; x: number; y: number }[]");
        });

        it("expands optional members and unions, keeping reachable `Id` references by name", () => {
            expect.assertions(1);

            // `note?` exercises optional-member rendering (`note?: string`, not
            // `note?: string | undefined`); the `| null` union and the `Id<…>`
            // reference (reachable from dataModel) must survive verbatim.
            writeFunction(
                "cursors.ts",
                `
            import type { Id } from "@lunora/server";
            import { query } from "@lunora/server";

            interface CursorDoc {
                _id: Id<"cursors">;
                note?: string;
            }

            export const get = query({
                args: {},
                handler: (): Promise<CursorDoc | null> => Promise.resolve(null),
            });
        `,
            );

            const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
            const result = discoverFunctions(project, workdir);

            expect(result[0]?.returnType).toBe('null | { _id: Id<"cursors">; note?: string }');
        });

        it("preserves return types that reference exported local types", () => {
            expect.assertions(1);

            // The mirror case: when the same interface IS exported, downstream
            // code can `import { CursorDoc } from "..."` to reach it — emit
            // is still going to need to relocate the path, but the *name* is
            // valid so we shouldn't drop the inferred return type.
            writeFunction(
                "cursors.ts",
                `
            import { query } from "@lunora/server";

            export interface CursorDoc {
                id: string;
            }

            export const list = query({
                args: {},
                handler: (): CursorDoc[] => [],
            });
        `,
            );

            const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
            const result = discoverFunctions(project, workdir);

            expect(result[0]?.returnType).toMatch(CURSOR_DOC_ARRAY_RE);
        });

        it("marks internalQuery/internalMutation/internalAction registrations as internal, mapping each to its kind", () => {
            expect.hasAssertions();

            writeFunction(
                "admin.ts",
                `
            import { internalQuery, internalMutation, internalAction, query } from "@lunora/server";
            export const stats = internalQuery({ args: {}, handler: () => null });
            export const purge = internalMutation({ args: {}, handler: () => null });
            export const sync = internalAction({ args: {}, handler: () => null });
            export const list = query({ args: {}, handler: () => null });
        `,
            );

            const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
            const result = discoverFunctions(project, workdir);
            const byName = new Map(result.map((f) => [f.exportName, f]));

            expect(byName.get("stats")).toMatchObject({ kind: "query", visibility: "internal" });
            expect(byName.get("purge")).toMatchObject({ kind: "mutation", visibility: "internal" });
            expect(byName.get("sync")).toMatchObject({ kind: "action", visibility: "internal" });
            // A plain `query` stays public.
            expect(byName.get("list")).toMatchObject({ kind: "query", visibility: "public" });
        });

        it("same file producing two registrations does not trip the guard", () => {
            expect.hasAssertions();

            // Two functions exported from the same file share a sanitized namespace
            // but that's expected — only *distinct files* should collide.
            writeFunction(
                "messages.ts",
                `
            import { query, mutation } from "@lunora/server";
            export const list = query({ args: {}, handler: () => null });
            export const send = mutation({ args: {}, handler: () => null });
        `,
            );

            const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
            const result = discoverFunctions(project, workdir);

            expect(result).toHaveLength(2);
            expect(result.map((f) => f.exportName).toSorted((a, b) => a.localeCompare(b))).toEqual(["list", "send"]);
        });
    });

    // A self-contained branded builder. The discovery brand-guard resolves the
    // `__lunoraProcedure` property off the receiver's *type*, so the builder is
    // declared inline here rather than imported from `@lunora/server` (the isolated
    // test project has no module resolution for workspace packages).
    // eslint-disable-next-line no-secrets/no-secrets -- inline TS builder fixture (MutationBuilder<Args>, etc.), not a credential
    const BUILDER_PREAMBLE = `
    declare const v: {
        id: (table: string) => { __k: "id" };
        number: () => { __k: "number" };
        string: () => { __k: "string" };
    };

    interface QueryBuilder<Args> {
        readonly __lunoraProcedure: "query";
        expose: (config: { rest?: boolean }) => QueryBuilder<Args>;
        input: <X extends Record<string, unknown>>(validators: X) => QueryBuilder<Args & X>;
        use: <C>(middleware: (options: { ctx: unknown }) => C) => QueryBuilder<Args>;
        query: <R>(handler: (options: { args: Args; ctx: unknown }) => R) => { args: Args; handler: (ctx: unknown, args: Args) => R; kind: "query" };
    }

    interface MutationBuilder<Args> {
        readonly __lunoraProcedure: "mutation";
        expose: (config: { rest?: boolean }) => MutationBuilder<Args>;
        input: <X extends Record<string, unknown>>(validators: X) => MutationBuilder<Args & X>;
        mutation: <R>(handler: (options: { args: Args; ctx: unknown }) => R) => { args: Args; handler: (ctx: unknown, args: Args) => R; kind: "mutation" };
    }

    interface InternalQueryBuilder<Args> {
        readonly __lunoraProcedure: "query";
        readonly __lunoraVisibility: "internal";
        input: <X extends Record<string, unknown>>(validators: X) => InternalQueryBuilder<Args & X>;
        query: <R>(handler: (options: { args: Args; ctx: unknown }) => R) => { args: Args; handler: (ctx: unknown, args: Args) => R; kind: "query"; visibility: "internal" };
    }

    declare const c: {
        mutation: MutationBuilder<Record<never, never>>;
        query: QueryBuilder<Record<never, never>>;
        internalQuery: InternalQueryBuilder<Record<never, never>>;
    };
`;

    // A builder that faithfully models `.output(validator)`: the validator carries a
    // phantom `__t` for its inferred type, and once `.output()` sets `Output`, the
    // terminal types the handler's return as that declared type — exactly as the real
    // `QueryBuilder` does. This lets discovery's handler-return inference exercise the
    // `.output()` path without workspace module resolution.
    const OUTPUT_BUILDER_PREAMBLE = `
    declare const v: {
        number: () => { __k: "number"; __t: number };
        string: () => { __k: "string"; __t: string };
        object: <S extends Record<string, { __t: unknown }>>(shape: S) => { __k: "object"; __t: { [K in keyof S]: S[K]["__t"] } };
    };

    interface QueryBuilder<Args, Output = undefined> {
        readonly __lunoraProcedure: "query";
        input: <X extends Record<string, unknown>>(validators: X) => QueryBuilder<Args & X, Output>;
        output: <V extends { __t: unknown }>(validator: V) => QueryBuilder<Args, V["__t"]>;
        query: [Output] extends [undefined]
            ? <R>(handler: (options: { args: Args; ctx: unknown }) => R) => { args: Args; handler: (ctx: unknown, args: Args) => R; kind: "query" }
            : (handler: (options: { args: Args; ctx: unknown }) => Output) => { args: Args; handler: (ctx: unknown, args: Args) => Output; kind: "query" };
    }

    declare const c: {
        query: QueryBuilder<Record<never, never>>;
    };
`;

    describe("discoverFunctions builder procedures", () => {
        it("discovers a builder terminal, reading the kind from the terminal method name", () => {
            expect.assertions(5);

            writeFunction(
                "messages.ts",
                `${BUILDER_PREAMBLE}
            export const list = c.query
                .input({ channelId: v.id("channels"), limit: v.number() })
                .query((): { hello: "world" } => ({ hello: "world" }));
        `,
            );

            const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
            const result = discoverFunctions(project, workdir);

            expect(result).toHaveLength(1);
            expect(result[0]?.kind).toBe("query");
            expect(result[0]?.returnType).toBe('{ hello: "world"; }');
            expect(result[0]?.args.channelId).toEqual({ kind: "id", tableName: "channels" });
            expect(result[0]?.args.limit).toEqual({ kind: "number" });
        });

        it("discovers `.expose({ rest: true })` into the FunctionIR (plan 167)", () => {
            expect.assertions(4);

            writeFunction(
                "messages.ts",
                `${BUILDER_PREAMBLE}
            export const list = c.query
                .input({ channelId: v.id("channels") })
                .expose({ rest: true })
                .query(() => null);

            export const send = c.mutation
                .expose({ rest: true })
                .mutation(() => null);

            export const secret = c.query
                .query(() => null);
        `,
            );

            const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
            const byName = new Map(discoverFunctions(project, workdir).map((f) => [f.exportName, f]));

            // The exposed procedures carry `expose.rest === true`, regardless of
            // where `.expose()` sits in the chain (before or after `.input()`).
            expect(byName.get("list")?.expose).toEqual({ rest: true });
            expect(byName.get("send")?.expose).toEqual({ rest: true });
            // A procedure without `.expose()` stays RPC-only (default-closed).
            expect(byName.get("secret")?.expose).toBeUndefined();
            expect(byName.get("list")?.args.channelId).toEqual({ kind: "id", tableName: "channels" });
        });

        it("falls back to the import name when the builder brand can't resolve (uninstalled deps)", () => {
            // Simulates a freshly-scaffolded project before `pnpm install`: the
            // builder root is imported from the Lunora surface but its type
            // doesn't resolve, so the `__lunoraProcedure` brand is absent.
            // Discovery must still classify the terminal via the root import name.
            expect.assertions(4);

            writeFunction(
                "messages.ts",
                `import { internalMutation, mutation, query, v } from "./_generated/server";

            export const list = query
                .input({ channelId: v.id("channels") })
                .query(() => null);

            export const send = mutation
                .input({ text: v.string() })
                .mutation(() => null);

            export const purge = internalMutation
                .input({ before: v.number() })
                .mutation(() => null);
        `,
            );

            const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
            const result = discoverFunctions(project, workdir);
            const byName = new Map(result.map((f) => [f.exportName, f]));

            expect(result).toHaveLength(3);
            expect(byName.get("list")).toMatchObject({ kind: "query", visibility: "public" });
            expect(byName.get("send")).toMatchObject({ kind: "mutation", visibility: "public" });
            expect(byName.get("purge")).toMatchObject({ kind: "mutation", visibility: "internal" });
        });

        it("discovers a const-assigned builder — follows the local const one hop to its factory root", () => {
            // Degraded-types fallback: the `__lunoraProcedure` brand can't
            // resolve, AND the builder root is a LOCAL const bound to a
            // partially-applied builder (`const base = mutation.input({...})`).
            // Discovery must follow that const's initializer one hop to the
            // imported `mutation` factory, rather than silently dropping the fn.
            expect.assertions(3);

            writeFunction(
                "messages.ts",
                `import { mutation, query, v } from "./_generated/server";

            const base = mutation.input({ channelId: v.id("channels") });

            export const send = base
                .input({ text: v.string() })
                .mutation(() => null);

            const readBase = query.input({ id: v.string() });

            export const get = readBase.query(() => null);
        `,
            );

            const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
            const result = discoverFunctions(project, workdir);
            const byName = new Map(result.map((f) => [f.exportName, f]));

            expect(result).toHaveLength(2);
            expect(byName.get("send")).toMatchObject({ kind: "mutation", visibility: "public" });
            expect(byName.get("get")).toMatchObject({ kind: "query", visibility: "public" });
        });

        it("merges .input() args across the chain — a later .input() wins on collision", () => {
            expect.assertions(1);

            writeFunction(
                "messages.ts",
                `${BUILDER_PREAMBLE}
            export const list = c.query
                .input({ value: v.number() })
                .input({ value: v.string() })
                .query(() => null);
        `,
            );

            const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
            const result = discoverFunctions(project, workdir);

            expect(result[0]?.args.value).toEqual({ kind: "string" });
        });

        it("intervening .use() links don't disturb detection or arg collection", () => {
            expect.assertions(2);

            writeFunction(
                "messages.ts",
                `${BUILDER_PREAMBLE}
            export const list = c.query
                .input({ a: v.number() })
                .use(({ ctx }) => ctx)
                .query(() => null);
        `,
            );

            const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
            const result = discoverFunctions(project, workdir);

            expect(result).toHaveLength(1);
            expect(Object.keys(result[0]?.args ?? {})).toEqual(["a"]);
        });

        it("detects a mutation builder terminal with its own kind", () => {
            expect.assertions(1);

            writeFunction(
                "messages.ts",
                `${BUILDER_PREAMBLE}
            export const send = c.mutation.input({ text: v.string() }).mutation(() => null);
        `,
            );

            const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
            const result = discoverFunctions(project, workdir);

            expect(result[0]?.kind).toBe("mutation");
        });

        it("ignores a `.query()` method on an object lacking the __lunoraProcedure brand", () => {
            expect.assertions(1);

            writeFunction(
                "messages.ts",
                `
            declare const notBuilder: { query: (handler: () => unknown) => { args: Record<never, never>; handler: () => unknown; kind: "query" } };
            export const list = notBuilder.query(() => null);
        `,
            );

            const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
            const result = discoverFunctions(project, workdir);

            expect(result).toHaveLength(0);
        });

        it("marks a builder carrying the __lunoraVisibility brand as internal, across a chain", () => {
            expect.assertions(3);

            writeFunction(
                "messages.ts",
                `${BUILDER_PREAMBLE}
            export const stats = c.internalQuery
                .input({ channelId: v.id("channels") })
                .query((): { ok: true } => ({ ok: true }));
        `,
            );

            const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
            const result = discoverFunctions(project, workdir);

            expect(result).toHaveLength(1);
            expect(result[0]).toMatchObject({ kind: "query", visibility: "internal" });
            expect(result[0]?.args.channelId).toEqual({ kind: "id", tableName: "channels" });
        });

        it("a public builder terminal stays visibility: public", () => {
            expect.assertions(1);

            writeFunction(
                "messages.ts",
                `${BUILDER_PREAMBLE}
            export const list = c.query.input({ a: v.number() }).query(() => null);
        `,
            );

            const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
            const result = discoverFunctions(project, workdir);

            expect(result[0]?.visibility).toBe("public");
        });

        it("does not register an intermediate .input() assignment that lacks a terminal", () => {
            expect.assertions(1);

            writeFunction(
                "messages.ts",
                `${BUILDER_PREAMBLE}
            export const partial = c.query.input({ a: v.number() });
        `,
            );

            const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
            const result = discoverFunctions(project, workdir);

            expect(result).toHaveLength(0);
        });

        it("derives the return type from .output() — the declared validator shape wins over the handler body", () => {
            expect.assertions(3);

            writeFunction(
                "messages.ts",
                `${OUTPUT_BUILDER_PREAMBLE}
            export const stats = c.query
                .output(v.object({ count: v.number() }))
                .query(() => ({ count: 1 }));
        `,
            );

            const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
            const result = discoverFunctions(project, workdir);

            expect(result).toHaveLength(1);
            expect(result[0]?.kind).toBe("query");
            expect(result[0]?.returnType).toBe("{ count: number; }");
        });

        it(".output() interleaved with .input() leaves arg collection and detection intact", () => {
            expect.assertions(3);

            writeFunction(
                "messages.ts",
                `${OUTPUT_BUILDER_PREAMBLE}
            export const stats = c.query
                .input({ limit: v.number() })
                .output(v.string())
                .query(({ args }) => String(args.limit));
        `,
            );

            const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
            const result = discoverFunctions(project, workdir);

            expect(result).toHaveLength(1);
            expect(Object.keys(result[0]?.args ?? {})).toEqual(["limit"]);
            expect(result[0]?.returnType).toBe("string");
        });
    });

    describe("re-exported plugin/component functions", () => {
        // A component bundles its registered functions under `.functions`; the
        // host app re-exports them so codegen discovers them in the app's
        // namespace. These cover the resolver that chases a re-export back to its
        // originating `query/mutation/action({...})` call.
        const componentModule = `
            import { mutation, query } from "@lunora/server";
            declare const v: { string: () => { __k: "string"; __t: string } };
            const bundle = {
                check: query({ args: { key: v.string() }, handler: () => ({ allowed: true }) }),
                reset: mutation({ args: { key: v.string() }, handler: () => null }),
            };
            export const ratelimit = { functions: bundle };
        `;

        it("discovers a property-access re-export — `export const check = component.functions.check`", () => {
            expect.hasAssertions();

            writeFunction("_components/ratelimit.ts", componentModule);
            writeFunction(
                "ratelimit.ts",
                `
                import { ratelimit } from "./_components/ratelimit.js";
                export const check = ratelimit.functions.check;
                export const reset = ratelimit.functions.reset;
            `,
            );

            const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
            const result = discoverFunctions(project, workdir).filter((f) => f.filePath === "ratelimit");
            const byName = new Map(result.map((f) => [f.exportName, f]));

            expect(byName.get("check")?.kind).toBe("query");
            expect(Object.keys(byName.get("check")?.args ?? {})).toEqual(["key"]);
            expect(byName.get("reset")?.kind).toBe("mutation");
        });

        it("discovers a destructured re-export — `export const { check, reset } = component.functions`", () => {
            expect.hasAssertions();

            writeFunction("_components/ratelimit.ts", componentModule);
            writeFunction(
                "ratelimit.ts",
                `
                import { ratelimit } from "./_components/ratelimit.js";
                export const { check, reset } = ratelimit.functions;
            `,
            );

            const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
            const result = discoverFunctions(project, workdir).filter((f) => f.filePath === "ratelimit");
            const byName = new Map(result.map((f) => [f.exportName, f]));

            expect(result.map((f) => f.exportName).toSorted((a, b) => a.localeCompare(b))).toEqual(["check", "reset"]);
            expect(byName.get("check")?.kind).toBe("query");
            expect(byName.get("reset")?.kind).toBe("mutation");
        });

        it("skips an unresolvable re-export instead of throwing", () => {
            expect.hasAssertions();

            // No local definition for `vendor` — resolution can't reach a call
            // literal (the published-component case), so it's silently skipped.
            writeFunction(
                "ratelimit.ts",
                `
                import { vendor } from "@vendor/ratelimit-component";
                export const check = vendor.functions.check;
            `,
            );

            const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });

            expect(() => discoverFunctions(project, workdir)).not.toThrow();
            expect(discoverFunctions(project, workdir).filter((f) => f.filePath === "ratelimit")).toEqual([]);
        });

        it("bails (no entry, no hang) on a cyclic re-export — exercises the depth bound", () => {
            expect.hasAssertions();

            // `a → b → a` never reaches a call literal; the resolver's depth bound
            // must terminate it instead of looping forever.
            writeFunction(
                "ratelimit.ts",
                `
                export const a = b;
                export const b = a;
            `,
            );

            const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });

            expect(() => discoverFunctions(project, workdir)).not.toThrow();
            expect(discoverFunctions(project, workdir).filter((f) => f.filePath === "ratelimit")).toEqual([]);
        });
    });
});
