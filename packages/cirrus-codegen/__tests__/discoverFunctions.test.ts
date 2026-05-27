import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { discoverFunctions } from "../src/discoverFunctions.js";

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
