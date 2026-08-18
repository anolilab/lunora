import { describe, expect, it } from "vitest";

import { splitStatements } from "../../../src/features/sql/split-statements";

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

    it("carries the gate's refusal per statement instead of sending it", () => {
        expect.assertions(3);

        const statements = splitStatements("SELECT 1; DELETE FROM messages; SELECT 2");

        expect(statements[0]?.rejection).toBeUndefined();
        expect(statements[1]?.rejection).toContain("read-only");
        // A refusal does not swallow the statements after it.
        expect(statements[2]?.sql).toBe("SELECT 2");
    });

    it("reports the gate's OWN pre-existing view of a semicolon in a literal", () => {
        expect.assertions(1);

        // Not this module's behaviour and deliberately not changed here: the shared
        // classifier does a bare `indexOf(";")` with no literal masking, so it has
        // always refused this statement as a batch. It is the server's enforcement
        // rule, so relaxing it is a separate change with its own review — this test
        // exists so the next reader knows the refusal is the gate's, not the split's.
        expect(splitStatements("SELECT ';' AS a")[0]?.rejection).toContain("single statement");
    });
});
