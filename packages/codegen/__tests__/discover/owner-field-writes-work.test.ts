import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { discoverMutators } from "../../src/discover/mutators";
import discoverOwnerFieldWrites from "../../src/discover/owner-field-writes";

// Every symbol lookup the feeder makes goes through `declarationOf`, so counting
// its calls measures the feeder's work without depending on wall-clock time.
const lookups = vi.hoisted(() => {
    return { count: 0 };
});

vi.mock(import("../../src/discover/attribution"), async (importOriginal) => {
    const original = await importOriginal();

    return {
        ...original,
        declarationOf: (...parameters: Parameters<typeof original.declarationOf>) => {
            lookups.count += 1;

            return original.declarationOf(...parameters);
        },
    };
});

let workdir: string;

/** Symbol lookups to discover one mutator whose impl is a chain of `depth` clean helpers, each calling the next twice. */
const lookupsForChain = (depth: number): number => {
    const lines = [`const f0 = (p0) => ctx.db.insert("posts", { userId: p0.userId });`];

    for (let level = 1; level <= depth; level += 1) {
        lines.push(
            `const f${level.toString()} = (p${level.toString()}) => { f${(level - 1).toString()}(p${level.toString()}); f${(level - 1).toString()}(p${level.toString()}); };`,
        );
    }

    lines.push(`f${depth.toString()}({ userId: ctx.auth.userId });`);

    const lunoraDirectory = join(workdir, "lunora");
    const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });

    writeFileSync(
        join(lunoraDirectory, "mutators.ts"),
        `export const createPost = defineMutator({ owner: "userId", server: async (ctx, args) => {\n${lines.join("\n")}\n} });`,
        "utf8",
    );

    const mutators = discoverMutators(project, lunoraDirectory);

    lookups.count = 0;

    expect(discoverOwnerFieldWrites(project, lunoraDirectory, [], mutators)).toHaveLength(0);

    return lookups.count;
};

describe("discoverOwnerFieldWrites work bound", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-owner-work-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    // Each helper's verdict is computed once, so the work grows linearly with the
    // chain; re-deriving it per call site would double it at every level (2^14).
    it("resolves a depth-14 chain of helpers that each call the next twice in linear work", () => {
        expect.assertions(4);

        const shallow = lookupsForChain(7);
        const deep = lookupsForChain(14);

        expect(deep).toBeLessThan(shallow * 4);
        expect(deep).toBeLessThan(2000);
    });
});
