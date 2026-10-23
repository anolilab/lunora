import { describe, expect, it } from "vitest";

import { CsvFormatError, parseCsv, parseCsvDocuments } from "../../../src/features/database/csv";

/** The problem a parse throws, so each test can assert the kind and the record it names. */
const problemOf = (run: () => unknown): unknown => {
    try {
        run();
    } catch (error) {
        return error instanceof CsvFormatError ? error.problem : error;
    }

    return undefined;
};

describe("parseCsv", () => {
    it("splits fields on commas and keeps commas and doubled quotes inside quoted fields", () => {
        expect.assertions(1);

        expect(parseCsv('a,"b,c","say ""hi""",d')).toStrictEqual([["a", "b,c", 'say "hi"', "d"]]);
    });

    it("accepts CRLF line endings as record separators", () => {
        expect.assertions(1);

        expect(parseCsv("id,name\r\n1,ann\r\n2,bob\r\n")).toStrictEqual([
            ["id", "name"],
            ["1", "ann"],
            ["2", "bob"],
        ]);
    });

    it("keeps an embedded newline in a quoted field, LF and CRLF alike", () => {
        expect.assertions(2);

        expect(parseCsv('id,body\n1,"line one\nline two"\n')).toStrictEqual([
            ["id", "body"],
            ["1", "line one\nline two"],
        ]);
        expect(parseCsv('id,body\r\n1,"line one\r\nline two"\r\n')).toStrictEqual([
            ["id", "body"],
            ["1", "line one\r\nline two"],
        ]);
    });

    it("reads an empty unquoted field as an omitted cell and a quoted empty field as an empty string", () => {
        expect.assertions(1);

        expect(parseCsv('a,,"",b')).toStrictEqual([["a", undefined, "", "b"]]);
    });

    it("reads a trailing comma as a trailing empty field, not as a missing record", () => {
        expect.assertions(1);

        expect(parseCsv("a,b,\n")).toStrictEqual([["a", "b", undefined]]);
    });

    it("skips blank lines and drops a leading byte-order mark", () => {
        expect.assertions(1);

        expect(parseCsv("﻿id\n\n1\n\n")).toStrictEqual([["id"], ["1"]]);
    });

    it("keeps a quote inside an unquoted field as text", () => {
        expect.assertions(1);

        expect(parseCsv('size,label\n5" disk,x')).toStrictEqual([
            ["size", "label"],
            ['5" disk', "x"],
        ]);
    });

    it("rejects a quoted field that is never closed, naming the record", () => {
        expect.assertions(1);

        expect(problemOf(() => parseCsv('id,body\n1,"open'))).toStrictEqual({ kind: "unterminated-quote", record: 2 });
    });

    it("rejects text after a closing quote", () => {
        expect.assertions(1);

        expect(problemOf(() => parseCsv('id,body\n1,"ok"oops'))).toStrictEqual({ kind: "text-after-quote", record: 2 });
    });
});

describe("parseCsvDocuments", () => {
    it("builds one document per record, keyed by the header names", () => {
        expect.assertions(1);

        expect(parseCsvDocuments("id,title\n1,hello\n2,world\n")).toStrictEqual([
            { doc: { id: "1", title: "hello" }, record: 2 },
            { doc: { id: "2", title: "world" }, record: 3 },
        ]);
    });

    it("omits a key for an empty unquoted cell so the schema default applies, and keeps a quoted empty string", () => {
        expect.assertions(1);

        expect(parseCsvDocuments('id,title,note\n1,,""\n')).toStrictEqual([{ doc: { id: "1", note: "" }, record: 2 }]);
    });

    it("yields no documents for a header-only file", () => {
        expect.assertions(1);

        expect(parseCsvDocuments("id,title\r\n")).toStrictEqual([]);
    });

    it("yields no documents for an empty file", () => {
        expect.assertions(1);

        expect(parseCsvDocuments("")).toStrictEqual([]);
    });

    it("passes cell text through unchanged, leaving type checks to the server", () => {
        expect.assertions(1);

        expect(parseCsvDocuments("count,active\n42,true\n")).toStrictEqual([{ doc: { active: "true", count: "42" }, record: 2 }]);
    });

    it("rejects a row with fewer cells than the header, naming its record", () => {
        expect.assertions(1);

        expect(problemOf(() => parseCsvDocuments("a,b,c\n1,2,3\n4,5\n"))).toStrictEqual({ expected: 3, found: 2, kind: "ragged", record: 3 });
    });

    it("rejects a row with more cells than the header", () => {
        expect.assertions(1);

        expect(problemOf(() => parseCsvDocuments("a,b\n1,2,3\n"))).toStrictEqual({ expected: 2, found: 3, kind: "ragged", record: 2 });
    });

    it("rejects a duplicate header and names it", () => {
        expect.assertions(1);

        expect(problemOf(() => parseCsvDocuments("id,title,id\n1,x,2\n"))).toStrictEqual({ kind: "duplicate-header", name: "id" });
    });

    it("rejects a blank header cell and names its column", () => {
        expect.assertions(1);

        expect(problemOf(() => parseCsvDocuments("id,,title\n1,2,3\n"))).toStrictEqual({ column: 2, kind: "empty-header" });
    });

    it("trims header names, so a padded header still matches its column", () => {
        expect.assertions(1);

        expect(parseCsvDocuments("id, title \n1,hello\n")).toStrictEqual([{ doc: { id: "1", title: "hello" }, record: 2 }]);
    });
});
