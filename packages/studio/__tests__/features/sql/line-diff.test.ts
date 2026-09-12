import { describe, expect, it } from "vitest";

import { lineDiff } from "../../../src/features/sql/line-diff";

const MARKER = { added: "+", context: " ", removed: "-" } as const;

/** Compact rendering — `-`/`+`/` ` prefixes — so an assertion reads like the diff it describes. */
const render = (before: string, after: string): string =>
    lineDiff(before, after)
        .map((line) => `${MARKER[line.kind]}${line.text}`)
        .join("\n");

describe("lineDiff", () => {
    it("marks every line context when nothing changed", () => {
        expect.assertions(1);

        expect(render("SELECT *\nFROM users", "SELECT *\nFROM users")).toBe(" SELECT *\n FROM users");
    });

    it("keeps the unchanged prefix as context and marks only the appended lines", () => {
        expect.assertions(1);

        expect(render("SELECT *\nFROM users", "SELECT *\nFROM users\nORDER BY created_at\nLIMIT 10")).toBe(
            " SELECT *\n FROM users\n+ORDER BY created_at\n+LIMIT 10",
        );
    });

    it("groups a replaced line as one removal followed by one addition", () => {
        expect.assertions(1);

        expect(render("SELECT *\nFROM users\nLIMIT 5", "SELECT *\nFROM users\nLIMIT 50")).toBe(" SELECT *\n FROM users\n-LIMIT 5\n+LIMIT 50");
    });

    it("groups a multi-line rewrite rather than interleaving it line by line", () => {
        expect.assertions(1);

        // The walk direction is what buys this: interleaved -/+/-/+ rows are
        // technically a correct diff and unreadable as a change.
        expect(render("a\nb\nc\nz", "x\ny\nz")).toBe("-a\n-b\n-c\n+x\n+y\n z");
    });

    it("handles an empty side without inventing a line", () => {
        expect.assertions(2);

        expect(lineDiff("", "SELECT 1")).toStrictEqual([
            { kind: "removed", text: "" },
            { kind: "added", text: "SELECT 1" },
        ]);
        expect(lineDiff("SELECT 1", "SELECT 1")).toHaveLength(1);
    });
});
