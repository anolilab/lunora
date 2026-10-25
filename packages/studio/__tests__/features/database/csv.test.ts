import { describe, expect, it } from "vitest";

import type { CsvRecord } from "../../../src/features/database/csv";
import {
    checkCsvDocuments,
    coerceCsvDocuments,
    CsvFormatError,
    parseCsv,
    parseCsvDocuments,
    parseCsvRecords,
    readCsvDocuments,
    readCsvRecords,
} from "../../../src/features/database/csv";

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

    it("skips a record of unquoted empty fields, whatever its column count", () => {
        expect.assertions(2);

        expect(parseCsv(",,,\na,b,c\n")).toStrictEqual([["a", "b", "c"]]);
        expect(parseCsv(",\na\n")).toStrictEqual([["a"]]);
    });

    it("skips a one-column empty line", () => {
        expect.assertions(1);

        expect(parseCsv("a\n\n\nb\n")).toStrictEqual([["a"], ["b"]]);
    });

    it("keeps a quoted empty field as a value, even alone on its line", () => {
        expect.assertions(1);

        expect(parseCsv('""\n"",""\n')).toStrictEqual([[""], ["", ""]]);
    });

    it("keeps a record with a value among its empty unquoted fields", () => {
        expect.assertions(1);

        expect(parseCsv(",x,\n")).toStrictEqual([[undefined, "x", undefined]]);
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

    it("numbers a row after a blank line by its place in the file, so the number names the row a user sees", () => {
        expect.assertions(2);

        // The blank line is left out of the documents, but it is still a line of the file.
        expect(parseCsvDocuments("id,n\n\nm1,1\n")).toStrictEqual([{ doc: { id: "m1", n: "1" }, record: 3 }]);
        expect(problemOf(() => parseCsvDocuments("a,b\n\n1,2,3\n"))).toStrictEqual({ expected: 2, found: 3, kind: "ragged", record: 3 });
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

describe("parseCsvDocuments own properties", () => {
    it("keeps a column named __proto__ as an own property rather than setting the prototype", () => {
        expect.assertions(3);

        const [document] = parseCsvDocuments("kind,__proto__\na,surprise\n");

        expect(Object.keys(document?.doc ?? {})).toStrictEqual(["kind", "__proto__"]);
        expect(Object.getOwnPropertyDescriptor(document?.doc, "__proto__")?.value).toBe("surprise");
        expect(Object.getPrototypeOf(document?.doc)).toBe(Object.prototype);
    });
});

describe("coerceCsvDocuments", () => {
    const kinds = new Map([
        ["active", "boolean"],
        ["amount", "bigint"],
        ["count", "number"],
        ["day", "date"],
        ["label", "string"],
        ["payload", "object"],
        ["stamp", "timestamp"],
    ]);

    /** The coerced value of the single column `name` in a one-row CSV with that header. */
    const coerced = (name: string, text: string): unknown => {
        const [document] = coerceCsvDocuments(parseCsvDocuments(`${name}\n${text}\n`), kinds);

        return document?.doc[name];
    };

    it("reads a number column as a decimal, accepting a sign, a fraction, an exponent and surrounding spaces", () => {
        expect.assertions(1);

        expect([coerced("count", "42"), coerced("count", "1.5"), coerced("count", "-3e2"), coerced("count", "  42 ")]).toStrictEqual([42, 1.5, -300, 42]);
    });

    it("rejects number text that is not a decimal, though Number would read it: hex, binary, digit separators and trailing text", () => {
        expect.assertions(4);

        for (const text of ["0x1F", "0b11", "1_000", "12abc"]) {
            expect(problemOf(() => coerceCsvDocuments(parseCsvDocuments(`id,count\nm1,${text}\n`), kinds))).toStrictEqual({
                column: "count",
                expected: "number",
                kind: "cell-type",
                record: 2,
                value: text,
            });
        }
    });

    it("refuses a number cell whose digits a double cannot keep, instead of storing a rounded value", () => {
        expect.assertions(5);

        for (const text of ["9007199254740993", "-9007199254740993", "12345678901234567890", "0.10000000000000000001", "1e-400"]) {
            expect(problemOf(() => coerceCsvDocuments(parseCsvDocuments(`id,count\nm1,${text}\n`), kinds))).toStrictEqual({
                column: "count",
                expected: "number",
                inexact: true,
                kind: "cell-type",
                record: 2,
                value: text,
            });
        }
    });

    it("keeps a number cell that a double holds exactly, however it is spelled", () => {
        expect.assertions(1);

        expect(
            [
                "0.1",
                "1.50",
                "15e-1",
                "-0",
                "9007199254740991",
                "9007199254740992",
                "1152921504606846976",
                "1e21",
                "123456789012345680000",
                "0.30000000000000004",
                "0e99",
            ].map((text) => coerced("count", text)),
        ).toStrictEqual([
            0.1,
            1.5,
            1.5,
            -0,
            9_007_199_254_740_991,
            9_007_199_254_740_992,
            2 ** 60,
            1e21,
            123_456_789_012_345_680_000,
            0.300_000_000_000_000_04,
            0,
        ]);
    });

    it("reads an ISO-8601 date as midnight UTC, and an ISO date-time as the instant its offset names", () => {
        expect.assertions(3);

        expect(coerced("day", "2026-10-23")).toBe(Date.UTC(2026, 9, 23));
        expect(coerced("day", "2026-10-23T08:00:00Z")).toBe(Date.UTC(2026, 9, 23, 8));
        expect(coerced("day", "2026-10-23T08:00:00+02:00")).toBe(Date.UTC(2026, 9, 23, 6));
    });

    it("refuses an ISO date-time with no offset by name, since any zone it were read in could store another instant than the writer meant", () => {
        expect.assertions(3);

        for (const text of ["2026-10-23T08:00:00", "2026-10-23T08:30", "2026-10-23T08:00:00.5"]) {
            expect(problemOf(() => coerceCsvDocuments(parseCsvDocuments(`id,day\nm1,${text}\n`), kinds))).toStrictEqual({
                column: "day",
                expected: "date",
                kind: "cell-type",
                record: 2,
                value: text,
                zoneless: true,
            });
        }
    });

    it("does not call a malformed date-time zoneless", () => {
        expect.assertions(2);

        for (const text of ["2026-02-30T08:00", "2026-10-23T25:00"]) {
            expect(problemOf(() => coerceCsvDocuments(parseCsvDocuments(`id,day\nm1,${text}\n`), kinds))).not.toHaveProperty("zoneless");
        }
    });

    it("refuses a timestamp with digits finer than a millisecond, and keeps one whose extra digits are zeros", () => {
        expect.assertions(2);

        // A Date holds whole milliseconds, so the micro digits of this value could only be dropped.
        expect(coerced("day", "2026-10-23T08:00:00.123000Z")).toBe(Date.UTC(2026, 9, 23, 8) + 123);
        expect(problemOf(() => coerceCsvDocuments(parseCsvDocuments("id,day\nm1,2026-10-23T08:00:00.123456Z\n"), kinds))).toStrictEqual({
            column: "day",
            expected: "date",
            kind: "cell-type",
            record: 2,
            value: "2026-10-23T08:00:00.123456Z",
        });
    });

    it("reads whole-number epoch milliseconds into a date or timestamp column, with surrounding spaces", () => {
        expect.assertions(2);

        expect(coerced("stamp", "1761206400000")).toBe(1_761_206_400_000);
        expect(coerced("stamp", " -12345678901234 ")).toBe(-12_345_678_901_234);
    });

    it("rejects epoch milliseconds beyond the range a Date can hold, and keeps the range edge", () => {
        expect.assertions(3);

        expect(coerced("stamp", "8640000000000000")).toBe(8_640_000_000_000_000);

        for (const text of ["8640000000000001", "-8640000000000001"]) {
            expect(problemOf(() => coerceCsvDocuments(parseCsvDocuments(`id,stamp\nm1,${text}\n`), kinds))).toMatchObject({
                column: "stamp",
                expected: "date",
                kind: "cell-type",
                value: text,
            });
        }
    });

    it("rejects a date cell that is neither ISO-8601 nor epoch milliseconds, including a date that does not exist", () => {
        expect.assertions(4);

        for (const text of ["23/10/2026", "2026-02-30", "2026-13-01", "next tuesday"]) {
            expect(problemOf(() => coerceCsvDocuments(parseCsvDocuments(`id,day\nm1,${text}\n`), kinds))).toStrictEqual({
                column: "day",
                expected: "date",
                kind: "cell-type",
                record: 2,
                value: text,
            });
        }
    });

    it("rejects bare numbers in a date column that are not epoch milliseconds: a serial date, a compact date, a year, epoch seconds, a fraction", () => {
        expect.assertions(6);

        for (const text of ["45352", "20260301", "2026", "1761206400", "1.5", "-3e2"]) {
            expect(problemOf(() => coerceCsvDocuments(parseCsvDocuments(`id,day\nm1,${text}\n`), kinds))).toStrictEqual({
                column: "day",
                expected: "date",
                kind: "cell-type",
                record: 2,
                value: text,
            });
        }
    });

    it("trims the spaces after a comma from boolean and bigint cells, as it does for number and date cells", () => {
        expect.assertions(1);

        const [document] = coerceCsvDocuments(parseCsvDocuments("amount, active\n 42, true\n"), kinds);

        expect(document?.doc).toStrictEqual({ active: true, amount: 42n });
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

    it("rejects a bigint cell that is not an integer, including decimals, exponents, hex and a plus sign", () => {
        expect.assertions(4);

        for (const text of ["1.5", "1e3", "0x1F", "+4"]) {
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

/** The text cut into pieces three ways: whole, at each line break, and one character at a time. */
const cuttings = (text: string): string[][] => [[text], text.split(/(?<=\n)/u), Array.from(text, (character) => character)];

/** Every item of an async source, in order. */
const collect = async <T>(source: AsyncIterable<T>): Promise<T[]> => {
    const items: T[] = [];

    for await (const item of source) {
        items.push(item);
    }

    return items;
};

/** The records a stream of pieces yields, in order. */
const streamedRecords = (pieces: Iterable<string>): Promise<CsvRecord[]> => collect(readCsvRecords(pieces));

/** The problem an async run throws, as {@link problemOf} gives it for a sync run. */
const asyncProblemOf = async (run: () => Promise<unknown>): Promise<unknown> => {
    try {
        await run();
    } catch (error) {
        return error instanceof CsvFormatError ? error.problem : error;
    }

    return undefined;
};

describe("streamed parsing", () => {
    const shapes = [
        'id,body\r\n1,"two\r\nlines"\r\n',
        'id,body\n1,"say ""hi"""\n2,x',
        "id,body\r1,a\r2,b\r",
        "﻿id,body\n\n1,a\n\n",
        'id,body\n1,"ends with a CR\r"\n',
        'a,b\n5" disk,x\n',
        'id,body\n1,""\n2,\n',
    ];

    it("reads the same records however the text is cut into pieces, including a CR or a closing quote at a piece's end", async () => {
        expect.assertions(21);

        const results = await Promise.all(shapes.map((text) => Promise.all(cuttings(text).map((pieces) => streamedRecords(pieces)))));

        for (const [index, text] of shapes.entries()) {
            for (const records of results[index] ?? []) {
                expect(records).toStrictEqual(parseCsvRecords(text));
            }
        }
    });

    it("reports the same problem however the text is cut into pieces", async () => {
        expect.assertions(9);

        const texts = ['id,body\n1,"open', 'id,body\n1,"ok"oops\n', 'id,body\n1,"a""'];
        const problems = await Promise.all(texts.map((text) => Promise.all(cuttings(text).map((pieces) => asyncProblemOf(() => streamedRecords(pieces))))));

        for (const [index, text] of texts.entries()) {
            for (const problem of problems[index] ?? []) {
                expect(problem).toStrictEqual(problemOf(() => parseCsvRecords(text)));
            }
        }
    });

    it("counts a CRLF as one record break, however its CR and LF are split across pieces", async () => {
        expect.assertions(3);

        const results = await Promise.all(cuttings("a,b\r\n1,2\r\n3,4\r\n").map((pieces) => streamedRecords(pieces)));

        for (const records of results) {
            expect(records.map((record) => record.number)).toStrictEqual([1, 2, 3]);
        }
    });

    it("ends a record at a lone CR, numbering the records after it by their place", () => {
        expect.assertions(1);

        expect(parseCsvRecords("a,b\r1,2\r\r3,4")).toStrictEqual([
            { cells: ["a", "b"], number: 1 },
            { cells: ["1", "2"], number: 2 },
            { cells: ["3", "4"], number: 4 },
        ]);
    });

    it("pulls only the pieces it needs for the first record", async () => {
        expect.assertions(2);

        let pulled = 0;

        const pieces = function* (): Generator<string> {
            for (const piece of ["id,body\n", "1,a\n", "2,b\n"]) {
                pulled += 1;

                yield piece;
            }
        };

        const first = await readCsvRecords(pieces()).next();

        expect(first.value).toStrictEqual({ cells: ["id", "body"], number: 1 });
        expect(pulled).toBe(1);
    });

    it("reads a multi-chunk CSV to the documents of the eager parse, and refuses the same row", async () => {
        expect.assertions(4);

        const kinds = new Map([["count", "number"]]);
        const rows = Array.from({ length: 1200 }, (_, index) => `m${index.toString()},${index.toString()}`);
        const text = `\nid,count\n${rows.join("\r\n")}\n`;

        // One character per piece: the hardest cut, since every quote and CR lands at a piece's end.
        const documents = await collect(
            readCsvDocuments(
                Array.from(text, (character) => character),
                kinds,
            ),
        );

        expect(documents).toStrictEqual(coerceCsvDocuments(parseCsvDocuments(text), kinds));

        const refused = text.replace("m699,699", "m699,x");
        const seen: number[] = [];
        const problem = await asyncProblemOf(() =>
            checkCsvDocuments(
                Array.from(refused, (character) => character),
                kinds,
                () => seen.push(1),
            ),
        );

        expect(problem).toStrictEqual(problemOf(() => coerceCsvDocuments(parseCsvDocuments(refused), kinds)));
        // Every row but the refused one is a valid document, and the check keeps reading past the refused row to find the first problem.
        expect(seen).toHaveLength(1199);

        const whole = await asyncProblemOf(() => checkCsvDocuments([text], kinds, () => undefined));

        expect(whole).toBeUndefined();
    });

    it("reports the same two-problem file as the eager check, however the text is cut", async () => {
        expect.assertions(9);

        const cases: [string, Map<string, string>][] = [
            ['a,b\n1\n2,"open', new Map()],
            ["a,a\n1", new Map()],
            ["id,count\nm1,x\nm2\n", new Map([["count", "number"]])],
        ];
        const problems = await Promise.all(
            cases.map(([text, kinds]) => Promise.all(cuttings(text).map((pieces) => asyncProblemOf(() => checkCsvDocuments(pieces, kinds, () => undefined))))),
        );

        for (const [index, [text, kinds]] of cases.entries()) {
            const eager = problemOf(() => coerceCsvDocuments(parseCsvDocuments(text), kinds));

            for (const problem of problems[index] ?? []) {
                expect(problem).toStrictEqual(eager);
            }
        }
    });
});

describe("problem precedence", () => {
    // A file with two problems reports the earlier stage: a quote error, then the header, then a row of the wrong width, then a cell.
    it("reports a quote error after a row of the wrong width, since a quote error is found first", () => {
        expect.assertions(1);

        expect(problemOf(() => parseCsvDocuments('a,b\n1\n2,"open'))).toStrictEqual({ kind: "unterminated-quote", record: 3 });
    });

    it("reports a duplicate header before a row of the wrong width", () => {
        expect.assertions(1);

        expect(problemOf(() => parseCsvDocuments("a,a\n1"))).toStrictEqual({ kind: "duplicate-header", name: "a" });
    });

    it("reports a row of the wrong width before a cell that does not fit its column", () => {
        expect.assertions(1);

        expect(problemOf(() => coerceCsvDocuments(parseCsvDocuments("id,count\nm1,x\nm2\n"), new Map([["count", "number"]])))).toStrictEqual({
            expected: 2,
            found: 1,
            kind: "ragged",
            record: 3,
        });
    });
});
