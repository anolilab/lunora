/**
 * Guards the module specifiers discovery accepts for each authoring factory.
 *
 * These tests stand up a **resolvable** `lunorash` / `@lunora/server` in the
 * fixture's own `node_modules`, because that is the only configuration in which
 * the bug they cover reproduces: with no resolvable package the type checker has
 * no symbol for the callee, every discoverer falls back to matching the
 * identifier text, and an unrecognized specifier is never consulted. A real app
 * (which has node_modules) resolves the symbol, reaches the specifier gate, and —
 * before this guard existed — silently dropped every umbrella-imported
 * declaration while codegen still exited `ok`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverCrons from "../src/discover-crons";
import { discoverFunctions } from "../src/discover-functions";
import discoverMigrations from "../src/discover-migrations";
import { discoverMutators } from "../src/discover-mutators";
import { discoverShapes } from "../src/discover-shapes";

let workdir: string;

/** The factories a stub package must expose for the callee symbol to resolve. */
const STUB_DECLARATIONS = `
export declare const query: (definition: unknown) => unknown;
export declare const mutation: (definition: unknown) => unknown;
export declare const cronJobs: () => {
    interval: (name: string, schedule: unknown, target: unknown, args?: unknown) => void;
};
export declare const defineMigration: (definition: unknown) => unknown;
export declare const defineMutator: (definition: unknown) => unknown;
export declare const defineShape: (definition: unknown) => unknown;
`;

/**
 * Install a resolvable stub package into the fixture's `node_modules` so a named
 * import from it produces a real import-specifier symbol.
 */
const installStub = (name: string): void => {
    const directory = join(workdir, "node_modules", ...name.split("/"));

    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "package.json"), JSON.stringify({ name, types: "index.d.ts", version: "0.0.0" }), "utf8");
    writeFileSync(join(directory, "index.d.ts"), STUB_DECLARATIONS, "utf8");
};

/** A ts-morph project rooted at the fixture, resolving imports through its `node_modules`. */
const resolvingProject = (): Project =>
    new Project({
        compilerOptions: { baseUrl: workdir, module: 99, moduleResolution: 100, target: 99 },
        skipAddingFilesFromTsConfig: true,
        useInMemoryFileSystem: false,
    });

const writeLunoraFile = (name: string, source: string): void => {
    writeFileSync(join(workdir, "lunora", name), source, "utf8");
};

/** Asserts the stub really resolved — otherwise the test would pass on the text fallback. */
const expectResolvedSymbol = (project: Project, name: string, specifier: string): void => {
    const source = project.getSourceFile(join(workdir, "lunora", name)) ?? project.addSourceFileAtPath(join(workdir, "lunora", name));
    const declaration = source.getImportDeclarations().find((candidate) => candidate.getModuleSpecifierValue() === specifier);

    expect(declaration?.getNamedImports()[0]?.getNameNode().getSymbol()).toBeDefined();
};

describe("discovery module specifiers", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-specifiers-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        installStub("lunorash");
        installStub("@lunora/server");
        installStub("@lunora/scheduler");
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    describe.each([
        ["the umbrella subpath", "lunorash/server"],
        ["the granular package", "@lunora/server"],
    ])("%s (%s)", (_label, specifier) => {
        it("discovers query/mutation registrations", () => {
            expect.assertions(3);

            writeLunoraFile(
                "notes.ts",
                `
                import { mutation, query } from "${specifier}";

                export const list = query({ args: {}, handler: () => null });
                export const add = mutation({ args: {}, handler: () => null });
            `,
            );

            const project = resolvingProject();

            expectResolvedSymbol(project, "notes.ts", specifier);

            const byName = new Map(discoverFunctions(project, join(workdir, "lunora")).map((definition) => [definition.exportName, definition]));

            // A dropped function is absent from BOTH `api.ts` and the
            // `LUNORA_FUNCTIONS` dispatch table, so every call 404s at runtime.
            expect(byName.get("list")?.kind).toBe("query");
            expect(byName.get("add")?.kind).toBe("mutation");
        });

        it("discovers a cronJobs() schedule", () => {
            expect.assertions(2);

            writeLunoraFile(
                "crons.ts",
                `
                import { cronJobs } from "${specifier}";

                import { internal } from "./_generated/api.js";

                const crons = cronJobs();

                crons.interval("sweep", { minutes: 30 }, internal.cleanup.sweep, {});

                export default crons;
            `,
            );

            const project = resolvingProject();

            expectResolvedSymbol(project, "crons.ts", specifier);

            // An unrecognized specifier emits no `_generated/crons.ts` at all —
            // the schedule simply never fires.
            expect(discoverCrons(project, join(workdir, "lunora"), [], []).map((job) => job.name)).toStrictEqual(["sweep"]);
        });

        it("discovers a defineMigration declaration", () => {
            expect.assertions(2);

            writeLunoraFile(
                "migrations.ts",
                `
                import { defineMigration } from "${specifier}";

                export const backfill = defineMigration({ id: "backfill", table: "notes", up: (document) => document });
            `,
            );

            const project = resolvingProject();

            expectResolvedSymbol(project, "migrations.ts", specifier);

            // A dropped migration leaves `LUNORA_MIGRATIONS` empty, so
            // `lunora migrate up` reports nothing to run.
            expect(discoverMigrations(project, join(workdir, "lunora")).map((migration) => migration.id)).toStrictEqual(["backfill"]);
        });

        it("discovers a defineMutator declaration", () => {
            expect.assertions(2);

            writeLunoraFile(
                "mutators.ts",
                `
                import { defineMutator } from "${specifier}";

                export const sendMessage = defineMutator({ server: async () => {} });
            `,
            );

            const project = resolvingProject();

            expectResolvedSymbol(project, "mutators.ts", specifier);

            expect(discoverMutators(project, join(workdir, "lunora")).map((mutator) => mutator.exportName)).toStrictEqual(["sendMessage"]);
        });

        it("discovers a defineShape declaration", () => {
            expect.assertions(2);

            writeLunoraFile(
                "shapes.ts",
                `
                import { defineShape } from "${specifier}";

                export const wholeOutline = defineShape({ owner: true, table: "nodes" });
            `,
            );

            const project = resolvingProject();

            expectResolvedSymbol(project, "shapes.ts", specifier);

            expect(discoverShapes(project, join(workdir, "lunora")).map((shape) => shape.exportName)).toStrictEqual(["wholeOutline"]);
        });
    });

    it("still ignores a same-named factory imported from a foreign package", () => {
        expect.assertions(1);

        installStub("other-pkg");
        writeLunoraFile(
            "notes.ts",
            `
            import { query } from "other-pkg";

            export const list = query({ args: {}, handler: () => null });
        `,
        );

        expect(discoverFunctions(resolvingProject(), join(workdir, "lunora"))).toStrictEqual([]);
    });
});
