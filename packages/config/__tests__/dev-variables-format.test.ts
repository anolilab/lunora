import { describe, expect, it } from "vitest";

import { DEV_VARS_KEY_PATTERN, parseDevVariableEntries, splitDevVariableLine, unquoteDevVariable } from "../src/dev-variables-format";

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

describe("unquoteDevVariable", () => {
    it("strips one layer of matching double quotes", () => {
        expect.assertions(1);

        expect(unquoteDevVariable('"value"')).toBe("value");
    });

    it("strips one layer of matching single quotes", () => {
        expect.assertions(1);

        expect(unquoteDevVariable("'value'")).toBe("value");
    });

    it("leaves an unquoted value untouched", () => {
        expect.assertions(1);

        expect(unquoteDevVariable("value")).toBe("value");
    });

    it("leaves mismatched quotes untouched", () => {
        expect.assertions(2);

        expect(unquoteDevVariable("'value\"")).toBe("'value\"");
        expect(unquoteDevVariable("\"value'")).toBe("\"value'");
    });

    it("unwraps an empty quoted value to an empty string", () => {
        expect.assertions(2);

        expect(unquoteDevVariable('""')).toBe("");
        expect(unquoteDevVariable("''")).toBe("");
    });

    it("does not treat a single quote character as a wrapper", () => {
        expect.assertions(1);

        // length < 2 → no stripping; a lone quote is the literal value.
        expect(unquoteDevVariable('"')).toBe('"');
    });

    it("strips only the outermost layer of nested quotes", () => {
        expect.assertions(1);

        expect(unquoteDevVariable("\"'inner'\"")).toBe("'inner'");
    });
});

describe("splitDevVariableLine", () => {
    it("splits a simple KEY=value line", () => {
        expect.assertions(1);

        expect(splitDevVariableLine("KEY=value")).toStrictEqual({ key: "KEY", value: "value" });
    });

    it("trims surrounding whitespace around the key and value", () => {
        expect.assertions(1);

        expect(splitDevVariableLine("  KEY  =  value  ")).toStrictEqual({ key: "KEY", value: "value" });
    });

    it("keeps the value still-quoted (unquoting is a separate step)", () => {
        expect.assertions(1);

        expect(splitDevVariableLine('KEY="value"')).toStrictEqual({ key: "KEY", value: '"value"' });
    });

    it("splits only on the first equals, preserving = in the value", () => {
        expect.assertions(1);

        expect(splitDevVariableLine("KEY=a=b=c")).toStrictEqual({ key: "KEY", value: "a=b=c" });
    });

    it("returns an empty value for a trailing-equals line", () => {
        expect.assertions(1);

        expect(splitDevVariableLine("KEY=")).toStrictEqual({ key: "KEY", value: "" });
    });

    it.each(["", "   ", "# comment", "  # indented comment", "# KEY=ignored"])("ignores the non-entry line %j", (line) => {
        expect.assertions(1);

        expect(splitDevVariableLine(line)).toBeUndefined();
    });

    it("ignores a line whose left side is not a valid KEY", () => {
        expect.assertions(2);

        expect(splitDevVariableLine("has-dash=value")).toBeUndefined();
        expect(splitDevVariableLine("=value")).toBeUndefined();
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

        const content = ["", "# a comment", "VALID=1", "bad-key=2", "   ", "ALSO_VALID=3"].join("\n");

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

    it("keeps a later duplicate key as a separate entry (de-dup is the caller's job)", () => {
        expect.assertions(1);

        expect(parseDevVariableEntries("K=1\nK=2")).toStrictEqual([
            { key: "K", value: "1" },
            { key: "K", value: "2" },
        ]);
    });
});
