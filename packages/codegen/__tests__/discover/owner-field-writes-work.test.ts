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

/**
 * A clean chain of `depth` helpers: `f0` writes its parameter's `userId`, and
 * each `f<k>` calls `f<k-1>` twice. With `recursive`, every helper also calls
 * itself, which puts each verdict on a cycle so none of them can be cached.
 */
const chain = (depth: number, recursive: boolean): string => {
    const self = (level: number): string => (recursive ? ` f${level.toString()}(p${level.toString()}.next);` : "");
    const lines = [`const f0 = (p0) => { ctx.db.insert("posts", { userId: p0.userId });${self(0)} };`];

    for (let level = 1; level <= depth; level += 1) {
        const previous = `f${(level - 1).toString()}(p${level.toString()});`;

        lines.push(`const f${level.toString()} = (p${level.toString()}) => { ${previous} ${previous}${self(level)} };`);
    }

    lines.push(`f${depth.toString()}({ userId: ctx.auth.userId });`);

    return lines.join("\n");
};

/** The owner-field rows of one mutator whose impl body is `body`, and the symbol lookups it took. */
const discoverCounting = (body: string): { lookups: number; rows: ReturnType<typeof discoverOwnerFieldWrites> } => {
    const lunoraDirectory = join(workdir, "lunora");
    const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });

    writeFileSync(
        join(lunoraDirectory, "mutators.ts"),
        `export const createPost = defineMutator({ owner: "userId", server: async (ctx, args) => {\n${body}\n} });`,
        "utf8",
    );

    const mutators = discoverMutators(project, lunoraDirectory);

    lookups.count = 0;

    const rows = discoverOwnerFieldWrites(project, lunoraDirectory, [], mutators);

    return { lookups: lookups.count, rows };
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

        const shallow = discoverCounting(chain(7, false));
        const deep = discoverCounting(chain(14, false));

        // Clean all the way down: nothing recorded, and the budget never ran out.
        expect(shallow.rows).toHaveLength(0);
        expect(deep.rows).toHaveLength(0);
        expect(deep.lookups).toBeLessThan(shallow.lookups * 4);
        expect(deep.lookups).toBeLessThan(2000);
    });

    // Recursion makes the verdicts on a cycle uncachable, so this shape doubles
    // per level. The per-impl work budget caps it and fails closed: past the
    // budget the write is reported rather than cleared.
    it("caps a recursive chain at the work budget and fails closed", () => {
        expect.assertions(3);

        const capped = discoverCounting(chain(20, true));

        expect(capped.rows).toHaveLength(1);
        expect(capped.rows[0]).not.toHaveProperty("ownerScoped");
        expect(capped.lookups).toBeLessThan(500_000);
    });

    // The 50,000-verdict budget is a backstop, not a tuning knob: a shallow
    // recursive chain resolves well inside it, a very deep one runs out and is
    // reported (fail closed), and the work stays bounded either way.
    it("resolves a shallow recursive chain and fails closed, in bounded work, on a very deep one", () => {
        expect.assertions(4);

        const shallow = discoverCounting(chain(6, true));
        const deep = discoverCounting(chain(24, true));

        expect(shallow.rows).toHaveLength(0);
        expect(deep.rows).toHaveLength(1);
        expect(deep.rows[0]).not.toHaveProperty("ownerScoped");
        expect(deep.lookups).toBeLessThan(500_000);
    });

    // The Vite dev loop reuses one Project, so an unchanged impl keeps its cached
    // taint model across runs. Its budget is per query and spends nothing on cache
    // hits, so repeated runs never drift into spurious findings.
    it("gives the same verdicts on every run over a reused project", () => {
        expect.assertions(2);

        const helpers = Array.from({ length: 6 }, (_, index) => `const h${index.toString()} = async (p) => ctx.db.insert("posts", { userId: p.userId });`);
        const calls = Array.from({ length: 6 }, (_, index) => `await h${index.toString()}({ userId: ctx.auth.userId });`);
        // Clean writes through a local: every run re-asks for their (cached) verdicts.
        const locals = Array.from(
            { length: 20 },
            (_, index) => `const v${index.toString()} = me.userId; await ctx.db.insert("posts", { userId: v${index.toString()} });`,
        );
        const lunoraDirectory = join(workdir, "lunora");
        const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });

        writeFileSync(
            join(lunoraDirectory, "mutators.ts"),
            `export const createPost = defineMutator({ owner: "userId", server: async (ctx, args) => {\nconst me = { userId: ctx.auth.userId };\n${[...helpers, ...calls, ...locals].join("\n")}\nawait ctx.db.insert("posts", { userId: args.userId });\n} });`,
            "utf8",
        );

        const mutators = discoverMutators(project, lunoraDirectory);
        const first = discoverOwnerFieldWrites(project, lunoraDirectory, [], mutators);
        let drifted = 0;

        for (let run = 0; run < 2000; run += 1) {
            const rows = discoverOwnerFieldWrites(project, lunoraDirectory, [], mutators);

            if (JSON.stringify(rows) !== JSON.stringify(first)) {
                drifted += 1;
            }
        }

        expect(first).toStrictEqual([expect.objectContaining({ ownerScoped: true })]);
        expect(drifted).toBe(0);
    });
});
