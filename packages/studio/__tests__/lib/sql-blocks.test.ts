import { describe, expect, it } from "vitest";

import sqlBlocks from "../../src/lib/sql-blocks";

describe("sqlBlocks", () => {
    it("reads every fenced block in order", () => {
        expect.assertions(1);

        expect(sqlBlocks("first:\n```sql\nSELECT 1\n```\nand:\n```sql\nSELECT 2\n```")).toStrictEqual(["SELECT 1", "SELECT 2"]);
    });

    it("yields nothing for an unterminated block", () => {
        expect.assertions(1);

        // Half a statement is not one, and this is the only path from a model reply
        // into the editor — offering a truncated statement is worse than offering none.
        expect(sqlBlocks("```sql\nSELECT * FROM messages WHERE")).toStrictEqual([]);
    });

    it("ignores prose that merely mentions a read verb", () => {
        expect.assertions(1);

        // A looser reading — "any line starting with SELECT" — would offer this
        // sentence as a statement.
        expect(sqlBlocks("You could SELECT from messages, but check the index first.")).toStrictEqual([]);
    });

    it("drops an empty fence rather than offering a blank statement", () => {
        expect.assertions(1);

        expect(sqlBlocks("```sql\n   \n```")).toStrictEqual([]);
    });
});
