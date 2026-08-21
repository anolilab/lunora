import { describe, expect, it } from "vitest";

import { DEV_VARS_KEY_PATTERN, parseDevVariableEntries, parseDevVariableLine, removeDevVariableLine, upsertDevVariableLine } from "../src/dev-variables-format";

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

    // wrangler parses `.dev.vars` with dotenv, so the reader must accept
    // exactly what the worker sees. We now call dotenv directly, but wrangler
    // bundles its OWN copy (4.120.1 ships 16.3.1 against our 16.6.1), so the
    // two can still drift apart on a future release. Each row asserts the
    // parse for a line shape the old strict split got wrong; if either side
    // bumps its dotenv, extend this table first — it is the tripwire.
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

// The line-oriented writers must be able to edit every line shape the reader
// can see. They used to target lines with their own `^[ \t]*KEY[ \t]*=` regex,
// so a widened reader left `env unset` reporting success on an
// `export KEY=…` line it had not touched — the key still loaded in dev.
describe("removeDevVariableLine", () => {
    it.each([
        { content: "export AUTH_SECRET=xyz\n", label: "export-prefixed" },
        { content: "AUTH_SECRET: xyz\n", label: "colon-separated" },
        { content: 'export AUTH_SECRET="xyz" # note\n', label: "export-prefixed, quoted, commented" },
        { content: "AUTH_SECRET=xyz\n", label: "plain" },
    ])("removes a $label line so the reader no longer sees the key", ({ content }) => {
        expect.assertions(2);

        const remaining = removeDevVariableLine(content, "AUTH_SECRET");

        expect(remaining).toBe("");
        expect(parseDevVariableEntries(remaining)).toStrictEqual([]);
    });

    it("removes a dotted key (valid to dotenv, so it must be removable)", () => {
        expect.assertions(1);

        expect(removeDevVariableLine("MY.KEY=1\nOTHER=2\n", "MY.KEY")).toBe("OTHER=2\n");
    });

    it("preserves comments, other entries, and CRLF terminators", () => {
        expect.assertions(1);

        expect(removeDevVariableLine("# keep\r\nKEEP=1\r\nexport GONE=2\r\nALSO=3\r\n", "GONE")).toBe("# keep\r\nKEEP=1\r\nALSO=3\r\n");
    });

    it("removes every duplicate line for the key", () => {
        expect.assertions(1);

        expect(removeDevVariableLine("A=1\nexport A=2\nB=3\n", "A")).toBe("B=3\n");
    });

    it("leaves content untouched when the key is genuinely absent", () => {
        expect.assertions(1);

        expect(removeDevVariableLine("A=1\n# A=commented\n", "MISSING")).toBe("A=1\n# A=commented\n");
    });

    it("does not remove a lookalike key sharing the prefix", () => {
        expect.assertions(1);

        expect(removeDevVariableLine("FOO=1\nFOO_BAR=2\n", "FOO")).toBe("FOO_BAR=2\n");
    });
});

describe("upsertDevVariableLine", () => {
    it("edits an export-prefixed line in place rather than appending a duplicate", () => {
        expect.assertions(2);

        const updated = upsertDevVariableLine("# doc\nexport AUTH_SECRET=old\nB=2\n", "AUTH_SECRET", "new");

        expect(updated).toBe('# doc\nAUTH_SECRET="new"\nB=2\n');
        expect(parseDevVariableEntries(updated)).toStrictEqual([
            { key: "AUTH_SECRET", value: "new" },
            { key: "B", value: "2" },
        ]);
    });

    it("collapses duplicate lines for the key down to one", () => {
        expect.assertions(1);

        expect(upsertDevVariableLine("A=1\nexport A=2\n", "A", "new")).toBe('A="new"\n');
    });

    it("appends when the key has no line yet", () => {
        expect.assertions(1);

        expect(upsertDevVariableLine("B=2\n", "A", "new")).toBe('B=2\nA="new"\n');
    });

    it("appends a trailing newline when the file does not end with one", () => {
        expect.assertions(1);

        expect(upsertDevVariableLine("B=2", "A", "new")).toBe('B=2\nA="new"\n');
    });

    it("writes into empty content", () => {
        expect.assertions(1);

        expect(upsertDevVariableLine("", "A", "new")).toBe('A="new"\n');
    });
});
