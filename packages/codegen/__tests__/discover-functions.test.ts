import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { discoverFunctions } from "../src/discover-functions.js";

let workdir: string;

beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "cirrus-disco-"));
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
    import { query } from "@cirrus/server";
    export const list = query({ args: {}, handler: () => null });
`;

describe("discoverFunctions namespace collision", () => {
    test("throws CirrusError when two distinct paths sanitize to the same namespace", () => {
        // `foo/bar.ts` and `foo-bar.ts` both → `foo_bar`. Without the guard
        // the generated ApiTypes would emit duplicate `foo_bar:` keys.
        writeFunction("foo/bar.ts", tinyQuery);
        writeFunction("foo-bar.ts", tinyQuery);

        const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });

        expect(() => discoverFunctions(project, workdir)).toThrow(/Namespace collision/u);

        try {
            discoverFunctions(project, workdir);
        } catch (error: unknown) {
            expect(error).toMatchObject({ code: "NAMESPACE_COLLISION", name: "CirrusError", status: 500 });
            expect((error as { paths: string[] }).paths).toEqual(expect.arrayContaining(["foo-bar", "foo/bar"]));
        }
    });

    test("distinct sanitized namespaces do not trip the collision guard", () => {
        writeFunction("foo.ts", tinyQuery);
        writeFunction("bar.ts", tinyQuery);

        const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });

        const result = discoverFunctions(project, workdir);

        expect(result).toHaveLength(2);
        expect(result.map((f) => f.filePath).sort()).toEqual(["bar", "foo"]);
    });

    test("detects aliased imports — `import { query as q }` is treated as a query", () => {
        writeFunction(
            "messages.ts",
            `
            import { query as q, mutation as m } from "@cirrus/server";
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

    test("ignores a local `const query` shadowing the @cirrus/server import", () => {
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

    test("infers handler return types when the type checker can resolve them", () => {
        // Handler returns a literal object whose type is inferrable from the
        // body alone — no need for `@cirrus/server`/`@cirrus/values` resolution.
        writeFunction(
            "messages.ts",
            `
            import { query, mutation } from "@cirrus/server";
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

    test("falls back to `unknown` when the checker can't resolve enough to be useful", () => {
        // Without annotations and without args/context wired to real types,
        // the inferred return is full of `any` — we'd rather emit `unknown`
        // than surface a misleading partial shape.
        writeFunction(
            "messages.ts",
            `
            import { query } from "@cirrus/server";
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

    test("falls back to `unknown` when the return type references a non-exported local type", () => {
        // A handler whose return type names a `interface` declared in the
        // same file but never exported would emit `CursorDoc[]` (or similar)
        // into `_generated/api.ts` — an identifier with no reachable import
        // from anywhere else. That produces TS2304 the moment downstream
        // code compiles against the generated API. We'd rather surface
        // `unknown` than wedge the consumer.
        writeFunction(
            "cursors.ts",
            `
            import { query } from "@cirrus/server";

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

        expect(result[0]?.returnType).toBe("unknown");
    });

    test("preserves return types that reference exported local types", () => {
        // The mirror case: when the same interface IS exported, downstream
        // code can `import { CursorDoc } from "..."` to reach it — emit
        // is still going to need to relocate the path, but the *name* is
        // valid so we shouldn't drop the inferred return type.
        writeFunction(
            "cursors.ts",
            `
            import { query } from "@cirrus/server";

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

        expect(result[0]?.returnType).toMatch(/CursorDoc\[\]/u);
    });

    test("marks internalQuery/internalMutation/internalAction registrations as internal, mapping each to its kind", () => {
        writeFunction(
            "admin.ts",
            `
            import { internalQuery, internalMutation, internalAction, query } from "@cirrus/server";
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

    test("same file producing two registrations does not trip the guard", () => {
        // Two functions exported from the same file share a sanitized namespace
        // but that's expected — only *distinct files* should collide.
        writeFunction(
            "messages.ts",
            `
            import { query, mutation } from "@cirrus/server";
            export const list = query({ args: {}, handler: () => null });
            export const send = mutation({ args: {}, handler: () => null });
        `,
        );

        const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
        const result = discoverFunctions(project, workdir);

        expect(result).toHaveLength(2);
        expect(result.map((f) => f.exportName).sort()).toEqual(["list", "send"]);
    });
});

// A self-contained branded builder. The discovery brand-guard resolves the
// `__cirrusProcedure` property off the receiver's *type*, so the builder is
// declared inline here rather than imported from `@cirrus/server` (the isolated
// test project has no module resolution for workspace packages).
const BUILDER_PREAMBLE = `
    declare const v: {
        id: (table: string) => { __k: "id" };
        number: () => { __k: "number" };
        string: () => { __k: "string" };
    };

    interface QueryBuilder<Args> {
        readonly __cirrusProcedure: "query";
        input: <X extends Record<string, unknown>>(validators: X) => QueryBuilder<Args & X>;
        use: <C>(middleware: (options: { ctx: unknown }) => C) => QueryBuilder<Args>;
        query: <R>(handler: (options: { args: Args; ctx: unknown }) => R) => { args: Args; handler: (ctx: unknown, args: Args) => R; kind: "query" };
    }

    interface MutationBuilder<Args> {
        readonly __cirrusProcedure: "mutation";
        input: <X extends Record<string, unknown>>(validators: X) => MutationBuilder<Args & X>;
        mutation: <R>(handler: (options: { args: Args; ctx: unknown }) => R) => { args: Args; handler: (ctx: unknown, args: Args) => R; kind: "mutation" };
    }

    interface InternalQueryBuilder<Args> {
        readonly __cirrusProcedure: "query";
        readonly __cirrusVisibility: "internal";
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
        readonly __cirrusProcedure: "query";
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
    test("discovers a builder terminal, reading the kind from the terminal method name", () => {
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

    test("merges .input() args across the chain — a later .input() wins on collision", () => {
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

    test("intervening .use() links don't disturb detection or arg collection", () => {
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

    test("detects a mutation builder terminal with its own kind", () => {
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

    test("ignores a `.query()` method on an object lacking the __cirrusProcedure brand", () => {
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

    test("marks a builder carrying the __cirrusVisibility brand as internal, across a chain", () => {
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

    test("a public builder terminal stays visibility: public", () => {
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

    test("does not register an intermediate .input() assignment that lacks a terminal", () => {
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

    test("derives the return type from .output() — the declared validator shape wins over the handler body", () => {
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

    test(".output() interleaved with .input() leaves arg collection and detection intact", () => {
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
