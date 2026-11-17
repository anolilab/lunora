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

    it("ignores a fence whose language is not exactly sql", () => {
        expect.assertions(2);

        // Splitting on the ` ```sql ` substring accepted these and offered their
        // contents for insertion into the SQL editor.
        expect(sqlBlocks("```sqlite\nSELECT 1\n```")).toStrictEqual([]);
        expect(sqlBlocks("```sqlx\nSELECT 2\n```")).toStrictEqual([]);
    });

    it("ignores the marker inside prose or inside another block", () => {
        expect.assertions(2);

        expect(sqlBlocks("write it as ```sql and then run it")).toStrictEqual([]);
        expect(sqlBlocks("```text\nhere is a ```sql block\n```")).toStrictEqual([]);
    });

    it("ignores a sql fence line nested inside a block in another language", () => {
        expect.assertions(1);

        // The ```sql line is the js block's own text, so it is not offered for insert.
        // The block closes at its bare fence, and a real sql block after it still reads.
        expect(sqlBlocks("```js\nconst q = 1;\n```sql\nSELECT 1\n```\n\nthen:\n```sql\nSELECT 2\n```")).toStrictEqual(["SELECT 2"]);
    });
});
