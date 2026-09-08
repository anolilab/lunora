import { describe, expect, it } from "vitest";

import { codeOnly, withoutComments } from "../../../shared/code-only";

/**
 * `shared/code-only.ts` is bundler-inlined into `@lunora/astro` and
 * `@lunora/nuxt`, so it has no package of its own to be tested from. Tested here
 * — the package it was extracted from — following the precedent set by
 * `@lunora/flags`' `stable-key.test.ts`.
 *
 * Both consumers are build-time gates that decide whether a project is wired
 * correctly, so what they need from this file is exact: a marker written in a
 * COMMENT must not satisfy a check, and (for the star-export probe in
 * `@lunora/nuxt`) offsets must survive blanking so a match can be located back
 * in the original source.
 */
describe("codeOnly", () => {
    it("blanks comments and string literals but keeps their length and line structure", () => {
        expect.assertions(3);

        // `starExportsLunoraBarrel` in `@lunora/nuxt` compares
        // `codeOnly(source)[i]` against `source[i]` to decide whether a regex
        // match landed in code or inside a string. That is only sound while
        // blanking is a per-character substitution — the invariant this asserts.
        const source = 'const a = 1; // note\nconst b = "text";\n/* block */\n';
        const code = codeOnly(source);

        expect(code).toHaveLength(source.length);
        expect(code.split("\n")).toHaveLength(source.split("\n").length);

        // Every blanked position is a space, and every surviving position holds
        // the character the source had there — the offset guarantee, stated as
        // the property rather than as a hand-counted literal.
        const misaligned = [...Array.from({ length: source.length }).keys()].filter((index) => code[index] !== " " && code[index] !== source[index]);

        expect(misaligned).toStrictEqual([]);
    });

    it("lets whichever construct opens first win", () => {
        expect.assertions(3);

        // The single-alternation ordering is what a hand-rolled mode machine
        // buys; these are the three cases that distinguish it from running the
        // patterns one after another.
        expect(codeOnly('// a quote " does not open a string\nkeep()')).toContain("keep()");
        expect(codeOnly('const url = "https://example.com"; keep()')).toContain("keep()");
        expect(codeOnly(String.raw`const s = "a \" b"; keep()`)).toContain("keep()");
    });

    it("blanks a plain template literal but leaves an interpolating one alone", () => {
        expect.assertions(2);

        // Blanking an interpolating template would hide real code written inside
        // `${...}` — the documented ceiling, asserted so it stays deliberate.
        expect(codeOnly("const s = `.vectors(x)`;")).not.toContain(".vectors(");
        expect(codeOnly(`const s = \`a \${call()} .vectors(x)\`;`)).toContain(".vectors(");
    });

    it("keeps a marker out of the answer when only a comment names it", () => {
        expect.assertions(2);

        // The defect every consumer of this file exists to catch: delete the
        // load-bearing line, keep the comment explaining it was load-bearing.
        const source = '/** Re-exports ShardDO. */\nexport { default } from "./nitro";\n';

        expect(/\bShardDO\b/u.test(source)).toBe(true);
        expect(/\bShardDO\b/u.test(codeOnly(source))).toBe(false);
    });
});

describe("withoutComments", () => {
    it("blanks comments and keeps string literals, at the same offsets", () => {
        expect.assertions(2);

        const source = '// drop me\nexport * from "./lunora/server";\n';
        const kept = withoutComments(source);

        expect(kept).toHaveLength(source.length);
        expect(kept).toContain('export * from "./lunora/server";');
    });

    it("does not treat a `//` inside a string as a comment", () => {
        expect.assertions(1);

        expect(withoutComments('const u = "https://lunora.sh"; keep()')).toContain("keep()");
    });
});
