import { describe, expect, it } from "vitest";

import { jsonPath, qualifiedJsonPath } from "../src/do-sql";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * A document holding BOTH a flat `"a.b"` key and a nested `a: { b }` — the pair
 * the unquoted `$.a.b` path conflated.
 */
const DOCUMENT = JSON.stringify({
    a: { b: "nested" },
    "a.b": "flat",
    "back\\slash": "bs",
    "br[k]": "bracket",
    "it's": "apostrophe",
    'q"x': "quote",
    status: "open",
});

/** Read a document key through the path `jsonPath` builds for it, on a real SQLite build. */
const readThroughPath = (field: string): unknown => {
    const { close, raw } = createSqliteExec();

    try {
        return raw(`SELECT ${jsonPath(field).replace("__doc__", "?")} AS value`, DOCUMENT)[0]?.["value"];
    } finally {
        close();
    }
};

describe("jsonPath", () => {
    it("emits the historical bare path for an identifier-safe field, byte for byte", () => {
        expect.assertions(4);

        // These strings are the expression text of the CREATE INDEXes already on
        // disk in every deployed shard. SQLite matches an expression index to a
        // query by comparing that text, so a change here silently unuses them.
        expect(jsonPath("status")).toBe("json_extract(__doc__, '$.status')");
        expect(jsonPath("authorId")).toBe("json_extract(__doc__, '$.authorId')");
        expect(jsonPath("_deletedAt")).toBe("json_extract(__doc__, '$._deletedAt')");
        expect(jsonPath("$ref")).toBe("json_extract(__doc__, '$.$ref')");
    });

    it("keeps mapping the internal columns to their stored columns", () => {
        expect.assertions(3);

        expect(jsonPath("_id")).toBe("id");
        expect(jsonPath("id")).toBe("id");
        expect(jsonPath("_creationTime")).toBe("_creationTime");
    });

    it("quotes a field the bare JSON-path grammar would misparse", () => {
        expect.assertions(4);

        expect(jsonPath("a.b")).toBe(`json_extract(__doc__, '$."a.b"')`);
        expect(jsonPath("br[k]")).toBe(`json_extract(__doc__, '$."br[k]"')`);
        expect(jsonPath("sp ace")).toBe(`json_extract(__doc__, '$."sp ace"')`);
        expect(jsonPath("it's")).toBe(`json_extract(__doc__, '$."it''s"')`);
    });

    it("escapes both JSON-string metacharacters inside the quoted segment", () => {
        expect.assertions(2);

        expect(jsonPath('q"x')).toBe(String.raw`json_extract(__doc__, '$."q\"x"')`);
        expect(jsonPath(String.raw`back\slash`)).toBe(String.raw`json_extract(__doc__, '$."back\\slash"')`);
    });
});

describe("qualifiedJsonPath", () => {
    it("qualifies the bare form without otherwise changing it", () => {
        expect.assertions(2);

        expect(qualifiedJsonPath("messages", "status")).toBe(`json_extract("messages".__doc__, '$.status')`);
        expect(qualifiedJsonPath("messages", "_id")).toBe(`"messages".id`);
    });

    it("quotes the segment on the qualified path too (EXISTS correlation refs)", () => {
        expect.assertions(1);

        expect(qualifiedJsonPath("messages", "a.b")).toBe(`json_extract("messages".__doc__, '$."a.b"')`);
    });
});

describe("jsonPath against a real SQLite build", () => {
    it("addresses the flat key rather than traversing into the nested one", () => {
        expect.assertions(2);

        // The defect: `$.a.b` reads `a` then `b`, so this used to return "nested".
        expect(readThroughPath("a.b")).toBe("flat");
        expect(readThroughPath("a")).toBe(`{"b":"nested"}`);
    });

    it("round-trips every field the bare grammar cannot carry", () => {
        expect.assertions(4);

        expect(readThroughPath("br[k]")).toBe("bracket");
        expect(readThroughPath('q"x')).toBe("quote");
        expect(readThroughPath(String.raw`back\slash`)).toBe("bs");
        expect(readThroughPath("it's")).toBe("apostrophe");
    });

    it("still reads an ordinary field", () => {
        expect.assertions(1);

        expect(readThroughPath("status")).toBe("open");
    });
});
