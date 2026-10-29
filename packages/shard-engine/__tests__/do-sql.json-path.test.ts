import { describe, expect, it } from "vitest";

import { jsonPath, qualifiedJsonPath } from "../src/do-sql";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * A document holding BOTH a flat `"a.b"` key and a nested `a: { b }`. A dotted field name is a path into
 * an object column (a column name is an identifier, so a dot is never part of one), which means `a.b`
 * reads the nested value and a literal `"a.b"` key is not addressable by name.
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

    it("descends through a dotted name one quoted segment at a time", () => {
        expect.assertions(3);

        expect(jsonPath("a.b")).toBe("json_extract(__doc__, '$.a.b')");
        expect(jsonPath("profile.address.city")).toBe("json_extract(__doc__, '$.profile.address.city')");
        expect(jsonPath("a.sp ace")).toBe(`json_extract(__doc__, '$.a."sp ace"')`);
    });

    it("rejects a path with an empty segment or more than four", () => {
        expect.assertions(2);

        expect(() => jsonPath("a..b")).toThrow("non-empty");
        expect(() => jsonPath("a.b.c.d.e")).toThrow("1 to 4");
    });

    it("quotes a field the bare JSON-path grammar would misparse", () => {
        expect.assertions(3);

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
        expect.assertions(2);

        expect(qualifiedJsonPath("messages", "br[k]")).toBe(`json_extract("messages".__doc__, '$."br[k]"')`);
        expect(qualifiedJsonPath("messages", "a.b")).toBe(`json_extract("messages".__doc__, '$.a.b')`);
    });
});

describe("jsonPath against a real SQLite build", () => {
    it("traverses into the nested object for a dotted name", () => {
        expect.assertions(2);

        expect(readThroughPath("a.b")).toBe("nested");
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
