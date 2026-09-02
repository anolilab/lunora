import { describe, expect, it } from "vitest";

import { splitStatements } from "../../../../../shared/sql-split-statements";

describe("splitStatements", () => {
    it("splits a script into its statements, dropping the empty trailing one", () => {
        expect.assertions(1);

        expect(splitStatements("SELECT 1; SELECT 2;").map((statement) => statement.sql)).toStrictEqual(["SELECT 1", "SELECT 2"]);
    });

    it("leaves a single statement alone", () => {
        expect.assertions(1);

        expect(splitStatements("SELECT 1").map((statement) => statement.sql)).toStrictEqual(["SELECT 1"]);
    });

    it("does not treat a semicolon inside a string literal or a comment as a boundary", () => {
        expect.assertions(2);

        // Splitting on the raw text would tear each of these in half and send both
        // halves; the split runs on the comment/literal-masked copy.
        expect(splitStatements("SELECT ';' AS a").map((statement) => statement.sql)).toStrictEqual(["SELECT ';' AS a"]);
        expect(splitStatements("SELECT 1 -- and; here").map((statement) => statement.sql)).toStrictEqual(["SELECT 1 -- and; here"]);
    });

    it.each([
        ['a "quoted" identifier', 'SELECT "a;b" FROM t'],
        ["a backtick identifier", "SELECT `a;b` FROM t"],
        ["a bracket identifier", "SELECT [a;b] FROM t"],
    ])("does not split inside %s", (_label, query) => {
        expect.assertions(2);

        // The splitter and the gate must answer "is this `;` a boundary"
        // identically. When the splitter used the studio's own `maskNonCode`
        // — which leaves `"…"` as CODE because it resolves identifiers — this
        // tore into `SELECT "a`, which passes the gate and WAS SENT, plus a
        // `b" FROM t` that came back as a bogus not-readonly.
        const statements = splitStatements(query);

        expect(statements).toHaveLength(1);
        expect(statements[0]).toStrictEqual({ offset: 0, sql: query });
    });

    it("finds the boundary when a literal holds an astral character", () => {
        expect.assertions(2);

        // Same code-unit/code-point defect as the gate's: an emoji shifted the
        // mask, so the splitter saw one statement where there are two and handed
        // the whole thing to a single runSql.
        const statements = splitStatements("SELECT '😀';SELECT 2");

        expect(statements.map((statement) => statement.sql)).toStrictEqual(["SELECT '😀'", "SELECT 2"]);
        expect(statements.every((statement) => statement.rejection === undefined)).toBe(true);
    });

    it("leaves a draft it cannot read whole rather than inventing boundaries in it", () => {
        expect.assertions(2);

        // An unterminated quote masks to `undefined`. Splitting anyway would send
        // fragments; leaving it whole hands the gate one statement to refuse.
        const statements = splitStatements("SELECT 'a; DROP TABLE x");

        expect(statements).toHaveLength(1);
        expect(statements[0]?.rejection?.message).toContain("single statement");
    });

    it("carries the gate's refusal per statement instead of sending it", () => {
        expect.assertions(3);

        const statements = splitStatements("SELECT 1; DELETE FROM messages; SELECT 2");

        expect(statements[0]?.rejection).toBeUndefined();
        expect(statements[1]?.rejection?.message).toContain("read-only");
        // A refusal does not swallow the statements after it.
        expect(statements[2]?.sql).toBe("SELECT 2");
    });

    it("passes a semicolon in a literal through to a runnable statement", () => {
        expect.assertions(2);

        // The split and the gate now agree. They did not: the classifier scanned
        // raw text for `;`, so this legal read-only query reached the server as a
        // single statement and was refused there as a batch.
        const [statement] = splitStatements("SELECT ';' AS a");

        expect(statement?.sql).toBe("SELECT ';' AS a");
        expect(statement?.rejection).toBeUndefined();
    });
});
