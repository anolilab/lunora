import { describe, expect, it } from "vitest";

import { coerceCsvDocuments, CsvFormatError, parseCsv, parseCsvDocuments } from "../../../src/features/database/csv";

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

describe("coerceCsvDocuments", () => {
    const kinds = new Map([
        ["active", "boolean"],
        ["amount", "bigint"],
        ["count", "number"],
        ["label", "string"],
        ["payload", "object"],
        ["stamp", "timestamp"],
    ]);

    /** The coerced value of the single column `name` in a one-row CSV with that header. */
    const coerced = (name: string, text: string): unknown => {
        const [document] = coerceCsvDocuments(parseCsvDocuments(`${name}\n${text}\n`), kinds);

        return document?.doc[name];
    };

    it("reads a number column with Number, accepting decimal and exponent forms", () => {
        expect.assertions(1);

        expect([coerced("count", "42"), coerced("count", "1.5"), coerced("count", "-3e2")]).toStrictEqual([42, 1.5, -300]);
    });

    it("reads a boolean column as true or false, in any case", () => {
        expect.assertions(1);

        expect([coerced("active", "TRUE"), coerced("active", "False")]).toStrictEqual([true, false]);
    });

    it("keeps a bigint column exact, as a bigint, past the range of a JavaScript number", () => {
        expect.assertions(1);

        expect([coerced("amount", "9007199254740993"), coerced("amount", "-12")]).toStrictEqual([9_007_199_254_740_993n, -12n]);
    });

    it("leaves a string column and a column of an unlisted kind as text", () => {
        expect.assertions(2);

        expect(coerced("label", "007")).toBe("007");
        expect(coerced("payload", "{}")).toBe("{}");
    });

    it("omits an empty unquoted cell from the coerced document, so the schema default applies", () => {
        expect.assertions(1);

        const [document] = coerceCsvDocuments(parseCsvDocuments("count,active\n,true\n"), kinds);

        expect(document?.doc).toStrictEqual({ active: true });
    });

    it("rejects a number cell that is not a finite number, naming the record and column", () => {
        expect.assertions(5);

        for (const text of ["x", "Infinity", "NaN", "1,5"]) {
            expect(problemOf(() => coerceCsvDocuments(parseCsvDocuments(`id,count\nm1,${text.includes(",") ? `"${text}"` : text}\n`), kinds))).toStrictEqual({
                column: "count",
                expected: "number",
                kind: "cell-type",
                record: 2,
                value: text,
            });
        }

        // A blank cell is not a number: Number("  ") is 0, so it must not coerce to one.
        expect(problemOf(() => coerceCsvDocuments(parseCsvDocuments("id,count\nm1,  \n"), kinds))).toMatchObject({ expected: "number", kind: "cell-type" });
    });

    it("rejects a boolean cell that is not true or false", () => {
        expect.assertions(1);

        expect(problemOf(() => coerceCsvDocuments(parseCsvDocuments("id,active\nm1,yes\n"), kinds))).toStrictEqual({
            column: "active",
            expected: "boolean",
            kind: "cell-type",
            record: 2,
            value: "yes",
        });
    });

    it("rejects a bigint cell that is not an integer, including decimals, exponents, hex and padding", () => {
        expect.assertions(5);

        for (const text of ["1.5", "1e3", "0x1F", " 4", "+4"]) {
            expect(problemOf(() => coerceCsvDocuments(parseCsvDocuments(`id,amount\nm1,${text}\n`), kinds))).toMatchObject({
                column: "amount",
                expected: "bigint",
                kind: "cell-type",
            });
        }
    });

    it("reports the first bad cell in file order, so a file with several bad cells names one stable record", () => {
        expect.assertions(1);

        expect(problemOf(() => coerceCsvDocuments(parseCsvDocuments("id,count\nm1,x\nm2,y\n"), kinds))).toMatchObject({ record: 2, value: "x" });
    });
});
