import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createOwnerFieldFixture, expectReported, ownerMutator } from "./owner-field-writes-fixture";

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

const fixture = createOwnerFieldFixture();

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

/** The owner-field rows of one mutator whose impl body is `body`, and the symbol lookups discovering them took. */
const discoverCounting = (body: string): { lookups: number; rows: ReturnType<typeof fixture.discover> } => {
    lookups.count = 0;

    const rows = fixture.discover(ownerMutator(body));

    return { lookups: lookups.count, rows };
};

describe("discoverOwnerFieldWrites work bound", () => {
    beforeEach(() => {
        fixture.setUp();
    });

    afterEach(() => {
        fixture.tearDown();
    });

    // Each helper's verdict is computed once, so the work grows linearly with the
    // chain; re-deriving it per call site would double it at every level, a
    // factor of 128 between these two depths.
    it("resolves a chain of helpers that each call the next twice in linear work", () => {
        expect.assertions(3);

        const shallow = discoverCounting(chain(7, false));
        const deep = discoverCounting(chain(14, false));

        // Clean all the way down: nothing recorded, so nothing ran out of budget.
        expect(shallow.rows).toHaveLength(0);
        expect(deep.rows).toHaveLength(0);
        expect(deep.lookups).toBeLessThan(shallow.lookups * 4);
    });

    // Recursion makes the verdicts on a cycle uncachable, so this shape doubles
    // per level. The work budget is a backstop, not a tuning knob: a shallow
    // recursive chain resolves inside it; one deep enough to exhaust any budget
    // is reported (fail closed), and the work stops growing with the depth.
    it("resolves a shallow recursive chain and fails closed, in bounded work, on a very deep one", () => {
        expect.assertions(5);

        const shallow = discoverCounting(chain(6, true));
        const deep = discoverCounting(chain(24, true));
        const deeper = discoverCounting(chain(30, true));

        expect(shallow.rows).toHaveLength(0);
        expect(deep.rows).toHaveLength(1);

        expectReported(deep.rows[0]);

        // Six more doubling levels would cost 64 times the work were it not capped.
        expect(deeper.lookups).toBeLessThan(deep.lookups * 2);
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
        const source = ownerMutator(
            ["const me = { userId: ctx.auth.userId };", ...helpers, ...calls, ...locals, `await ctx.db.insert("posts", { userId: args.userId });`].join("\n"),
        );
        const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
        const first = fixture.discover(source, "mutators.ts", project);
        let drifted = 0;

        for (let run = 0; run < 2000; run += 1) {
            if (JSON.stringify(fixture.discover(source, "mutators.ts", project)) !== JSON.stringify(first)) {
                drifted += 1;
            }
        }

        expect(first).toStrictEqual([expect.objectContaining({ ownerScoped: true })]);
        expect(drifted).toBe(0);
    });
});
