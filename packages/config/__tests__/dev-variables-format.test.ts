import { describe, expect, it } from "vitest";

import { DEV_VARS_KEY_PATTERN, parseDevVariableEntries, parseDevVariableLine } from "../src/dev-variables-format";

// Write-side key validation only (`env set`/`unset`/`generate`, the upsert's
// line targeting) — deliberately stricter than what the dotenv reader accepts.
describe("dEV_VARS_KEY_PATTERN", () => {
    it.each(["KEY", "AUTH_SECRET", "_underscore", "a1", "Mixed_Case_9"])("accepts the valid key %s", (key) => {
        expect.assertions(1);

        expect(DEV_VARS_KEY_PATTERN.test(key)).toBe(true);
    });

    it.each(["1KEY", "has-dash", "has.dot", "has space", "", "with$"])("rejects the invalid key %s", (key) => {
        expect.assertions(1);

        expect(DEV_VARS_KEY_PATTERN.test(key)).toBe(false);
    });
});

describe("parseDevVariableLine", () => {
    it("reads a simple KEY=value line", () => {
        expect.assertions(1);

        expect(parseDevVariableLine("KEY=value")).toStrictEqual({ key: "KEY", value: "value" });
    });

    it("trims surrounding whitespace and strips quotes", () => {
        expect.assertions(3);

        expect(parseDevVariableLine("  KEY  =  value  ")).toStrictEqual({ key: "KEY", value: "value" });
        expect(parseDevVariableLine('KEY="value"')).toStrictEqual({ key: "KEY", value: "value" });
        expect(parseDevVariableLine("KEY='value'")).toStrictEqual({ key: "KEY", value: "value" });
    });

    it("splits only on the first equals, preserving = in the value", () => {
        expect.assertions(1);

        expect(parseDevVariableLine("KEY=a=b=c")).toStrictEqual({ key: "KEY", value: "a=b=c" });
    });

    it("returns an empty value for a trailing-equals line", () => {
        expect.assertions(1);

        expect(parseDevVariableLine("KEY=")).toStrictEqual({ key: "KEY", value: "" });
    });

    it("leaves an unmatched quote as the literal value", () => {
        expect.assertions(2);

        expect(parseDevVariableLine('KEY="')).toStrictEqual({ key: "KEY", value: '"' });
        expect(parseDevVariableLine("KEY='value\"")).toStrictEqual({ key: "KEY", value: "'value\"" });
    });

    it("strips only the outermost layer of nested quotes", () => {
        expect.assertions(1);

        expect(parseDevVariableLine("KEY=\"'inner'\"")).toStrictEqual({ key: "KEY", value: "'inner'" });
    });

    it.each(["", "   ", "# comment", "  # indented comment", "# KEY=ignored"])("ignores the non-entry line %j", (line) => {
        expect.assertions(1);

        expect(parseDevVariableLine(line)).toBeUndefined();
    });

    it("ignores a line with no key", () => {
        expect.assertions(1);

        expect(parseDevVariableLine("=value")).toBeUndefined();
    });

    it("uses the same grammar as the whole-file parse", () => {
        expect.assertions(1);

        // The line reader IS the file reader over one line — the scaffolder's
        // line-oriented rewrite must not develop its own idea of the format.
        expect(parseDevVariableLine("export KEY.SUB=value # note")).toStrictEqual(parseDevVariableEntries("export KEY.SUB=value # note")[0]);
    });
});

describe("parseDevVariableEntries", () => {
    it("parses entries in file order with values unquoted", () => {
        expect.assertions(1);

        const content = ['FIRST="one"', "SECOND=two", "THIRD='three'"].join("\n");

        expect(parseDevVariableEntries(content)).toStrictEqual([
            { key: "FIRST", value: "one" },
            { key: "SECOND", value: "two" },
            { key: "THIRD", value: "three" },
        ]);
    });

    it("drops blank lines, comments, and invalid keys", () => {
        expect.assertions(1);

        // `%bad=2` fails dotenv's `[\w.-]+` key shape; dashed/dotted keys are
        // valid dotenv keys and are covered by the parity table below.
        const content = ["", "# a comment", "VALID=1", "%bad=2", "   ", "ALSO_VALID=3"].join("\n");

        expect(parseDevVariableEntries(content)).toStrictEqual([
            { key: "VALID", value: "1" },
            { key: "ALSO_VALID", value: "3" },
        ]);
    });

    it("handles CRLF line endings", () => {
        expect.assertions(1);

        const content = "A=1\r\nB=2\r\n";

        expect(parseDevVariableEntries(content)).toStrictEqual([
            { key: "A", value: "1" },
            { key: "B", value: "2" },
        ]);
    });

    it("returns an empty array for empty content", () => {
        expect.assertions(1);

        expect(parseDevVariableEntries("")).toStrictEqual([]);
    });

    it("resolves duplicate keys last-wins, like dotenv's object overwrite", () => {
        expect.assertions(1);

        expect(parseDevVariableEntries("K=1\nK=2")).toStrictEqual([{ key: "K", value: "2" }]);
    });

    // wrangler parses `.dev.vars` with dotenv (16.6.1), so the reader must
    // accept exactly what the worker sees. Each row asserts the parse dotenv
    // itself produces for a line shape the old strict split diverged on. If
    // wrangler ever bumps its dotenv major, extend this table first — it is
    // the tripwire for parser drift.
    describe("dotenv parity", () => {
        it.each([
            { expected: [{ key: "FOO", value: "x" }], line: "export FOO=x" },
            { expected: [{ key: "FOO.BAR", value: "x" }], line: "FOO.BAR=x" },
            { expected: [{ key: "FOO-BAR", value: "x" }], line: "FOO-BAR=x" },
            { expected: [{ key: "FOO", value: "x" }], line: "FOO=x # note" },
            { expected: [{ key: "FOO", value: "a\nb" }], line: String.raw`FOO="a\nb"` },
            { expected: [{ key: "FOO", value: "colon" }], line: "FOO: colon" },
            { expected: [{ key: "FOO", value: "tick" }], line: "FOO=`tick`" },
            { expected: [{ key: "FOO", value: "multi\nline" }], line: 'FOO="multi\nline"' },
            { expected: [], line: "# comment=notakey" },
            // Single quotes do NOT expand escapes — the backslash-n stays literal.
            { expected: [{ key: "FOO", value: String.raw`keep\n` }], line: String.raw`FOO='keep\n'` },
        ])("parses $line like dotenv", ({ expected, line }) => {
            expect.assertions(1);

            expect(parseDevVariableEntries(line)).toStrictEqual(expected);
        });
    });
});
