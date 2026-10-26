import { encodeWire } from "@lunora/wire";

/**
 * One CSV field. `undefined` is an empty unquoted field: the importer leaves that key out of the document so the schema default applies,
 * or stores `null` when the column is nullable and required (see {@link recordDocument}). A quoted empty field (`""`) is an empty string
 * and stays in the document.
 */
type CsvCell = string | undefined;

/** A non-blank record, with its number in the file: the header is record 1, and a blank record still takes a number. */
interface CsvRecord {
    cells: CsvCell[];
    number: number;
}

/** A structural problem in a CSV file. `record` is the record's number in the file, so it names the row a user sees. */
type CsvProblem =
    | { kind: "duplicate-header"; name: string }
    | { column: number; kind: "empty-header" }
    | { expected: number; found: number; kind: "ragged"; record: number }
    | { column: string; expected: CellType; inexact?: true; kind: "cell-type"; record: number; tooLong?: true; value: string }
    | { kind: "text-after-quote"; record: number }
    | { kind: "unterminated-quote"; record: number };

/** The column kinds a CSV cell is coerced into. Every other kind keeps its text. */
type CellType = "bigint" | "boolean" | "date" | "number";

/** A value a CSV cell can take after coercion. */
type CsvValue = bigint | boolean | number | string;

/** A record after coercion, ready to become an import row. */
interface CoercedDocument {
    doc: Record<string, unknown>;
    record: number;
}

class CsvFormatError extends Error {
    public readonly problem: CsvProblem;

    public constructor(problem: CsvProblem) {
        super(problem.kind);
        this.name = "CsvFormatError";
        this.problem = problem;
    }
}

/** A document built from one CSV record, with the record number it came from. `null` is a blank cell in a nullable required column. */
interface CsvDocument {
    doc: Record<string, string | null>;
    record: number;
}

/** The byte-order mark some spreadsheet exports write at the start of a file. */
const BYTE_ORDER_MARK = "\uFEFF";

/**
 * Where the scanner is within a field: `start` before its first character, `unquoted` in a field with no leading quote, `quoted` inside a
 * quoted field, and `closing` just after a quote, which either closes the field or is the first half of a doubled quote.
 */
type ScanState = "closing" | "quoted" | "start" | "unquoted";

/**
 * Splits CSV text into records one character at a time, so the text can arrive in pieces and a file is never held whole. A record may span
 * pieces: a quoted field may hold line breaks, and a quote at the end of a piece waits for the next character. A CR ends a record on its
 * own, and a CRLF ends one record even when the LF starts the next piece.
 *
 * A quote is special only at the start of a field, so a quote inside an unquoted field is text (`5" disk`).
 */
interface CsvScanner {
    /** The records still open at the end of the text. A quoted field that was never closed is a problem. */
    finish: () => CsvRecord[];
    /** The records that `text` completes. Throws a {@link CsvFormatError} at the first structural problem. */
    push: (text: string) => CsvRecord[];
}

const createCsvScanner = (): CsvScanner => {
    let cells: CsvCell[] = [];
    let number = 1;
    let skipLf = false;
    let started = false;
    let state: ScanState = "start";
    let value = "";

    /** Ends the field being read. An unquoted empty field is omitted; a quoted one is an empty string. */
    const endField = (): void => {
        cells.push(state === "closing" || value !== "" ? value : undefined);
        state = "start";
        value = "";
    };

    /** Ends the field and the record being read. A record of only omitted cells is blank: it is left out, but still takes its number. */
    const endRecord = (records: CsvRecord[]): void => {
        endField();

        if (cells.some((cell) => cell !== undefined)) {
            records.push({ cells, number });
        }

        cells = [];
        number += 1;
    };

    const step = (char: string, records: CsvRecord[]): void => {
        const afterCr = skipLf;

        skipLf = false;

        if (afterCr && char === "\n") {
            return;
        }

        if (state === "quoted") {
            if (char === '"') {
                state = "closing";
            } else {
                value += char;
            }

            return;
        }

        if (state === "closing" && char === '"') {
            value += char;
            state = "quoted";

            return;
        }

        if (char === ",") {
            endField();

            return;
        }

        if (char === "\r") {
            endRecord(records);
            skipLf = true;

            return;
        }

        if (char === "\n") {
            endRecord(records);

            return;
        }

        if (state === "closing") {
            throw new CsvFormatError({ kind: "text-after-quote", record: number });
        }

        if (state === "start" && char === '"') {
            state = "quoted";

            return;
        }

        state = "unquoted";
        value += char;
    };

    return {
        finish: () => {
            if (state === "quoted") {
                throw new CsvFormatError({ kind: "unterminated-quote", record: number });
            }

            const records: CsvRecord[] = [];

            endRecord(records);

            return records;
        },
        push: (text) => {
            const records: CsvRecord[] = [];
            let index = 0;

            if (!started && text !== "") {
                started = true;
                index = text.startsWith(BYTE_ORDER_MARK) ? 1 : 0;
            }

            for (; index < text.length; index += 1) {
                step(text.charAt(index), records);
            }

            return records;
        },
    };
};

/**
 * RFC 4180 records, CRLF or LF. A quoted field may hold commas, doubled quotes and newlines. A leading byte-order mark is dropped, since
 * spreadsheet exports write one.
 *
 * A record whose every field is an unquoted empty field is blank and is left out of the result, whatever its column count: a line of
 * commas, or a one-column empty line. A quoted `""` is a value, so it is kept.
 */
const parseCsvRecords = (text: string): CsvRecord[] => {
    const scanner = createCsvScanner();

    return [...scanner.push(text), ...scanner.finish()];
};

const parseCsv = (input: string): CsvCell[][] => parseCsvRecords(input).map((record) => record.cells);

/**
 * The records of CSV text that arrives in pieces, in file order. A piece may end anywhere: mid-field, or between a CR and its LF. Each record
 * is yielded as soon as it is complete, so the caller holds one record at a time and pulls pieces only as far as it needs.
 */
const readCsvRecords = async function* (pieces: AsyncIterable<string> | Iterable<string>): AsyncGenerator<CsvRecord> {
    const scanner = createCsvScanner();

    for await (const piece of pieces) {
        yield* scanner.push(piece);
    }

    yield* scanner.finish();
};

/**
 * Set an own data property. A plain assignment to `__proto__` sets the prototype instead, so a column named that way would be dropped
 * without a word, and the server would never see it.
 */
const setField = (target: Record<string, unknown>, key: string, value: unknown): void => {
    Object.defineProperty(target, key, { configurable: true, enumerable: true, value, writable: true });
};

/** The column names of a header record, in order. A blank or repeated name throws, naming the first bad column. */
const headerColumns = (cells: CsvCell[]): string[] => {
    const columns: string[] = [];
    const seen = new Set<string>();

    cells.forEach((cell, index) => {
        const name = (cell ?? "").trim();

        if (name === "") {
            throw new CsvFormatError({ column: index + 1, kind: "empty-header" });
        }

        if (seen.has(name)) {
            throw new CsvFormatError({ kind: "duplicate-header", name });
        }

        seen.add(name);
        columns.push(name);
    });

    return columns;
};

/**
 * The document a data record makes, keyed by the header names. A record whose cell count differs from the header's throws. An empty unquoted
 * cell is left out, except in a column named in `nullOnEmpty`, where it is `null`: a nullable column that is not optional refuses a missing key,
 * and a CSV has no other way to write null.
 */
const recordDocument = ({ cells, number: record }: CsvRecord, columns: ReadonlyArray<string>, nullOnEmpty: ReadonlySet<string>): CsvDocument => {
    if (cells.length !== columns.length) {
        throw new CsvFormatError({ expected: columns.length, found: cells.length, kind: "ragged", record });
    }

    const fields: Record<string, string | null> = {};

    columns.forEach((name, column) => {
        const cell = cells[column];

        if (cell !== undefined) {
            setField(fields, name, cell);
        } else if (nullOnEmpty.has(name)) {
            // eslint-disable-next-line unicorn/no-null -- a blank cell in a nullable column is null; `undefined` would leave the key out and the server would refuse it
            setField(fields, name, null);
        }
    });

    return { doc: fields, record };
};

/**
 * Turn a CSV text into one document per data record, keyed by the header names. Every record is checked here, before any caller writes:
 * a blank or repeated header name, and a row whose cell count differs from the header, throw a {@link CsvFormatError}.
 *
 * Cells are passed through as strings. The server validator decides what a column accepts, so this does not coerce `"42"` or `"true"`.
 * A header-only file yields no documents.
 */
const parseCsvDocuments = (text: string): CsvDocument[] => {
    const [header, ...records] = parseCsvRecords(text);

    if (header === undefined) {
        return [];
    }

    const columns = headerColumns(header.cells);

    return records.map((record) => recordDocument(record, columns, new Set()));
};

/** A cell's text, read as its column kind. `rejected` names the kind the text failed to be. */
type CoercedCell = { kind: "ok"; value: CsvValue } | { expected: CellType; inexact?: true; kind: "rejected"; tooLong?: true };

/** Digits with an optional minus sign: the text a `bigint` column can hold. */
const INTEGER_TEXT = /^-?\d+$/u;

/**
 * A decimal number: an optional sign, digits, an optional fraction and an optional exponent. `Number` reads more than this (hex, binary,
 * octal, and the empty string), so the text is matched against this shape before it is converted.
 */
const DECIMAL_TEXT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu;

/**
 * Epoch milliseconds as a date cell may hold them: whole digits, at least 11 of them (a date from late April 1970 on). A shorter run is
 * ambiguous with a spreadsheet serial date (`45352`), a compact `YYYYMMDD`, a year, or epoch seconds, and would be stored as a moment in
 * January 1970 with no error.
 */
const EPOCH_MILLIS_TEXT = /^-?\d{11,}$/u;

/** `YYYY-MM-DD`. */
const ISO_DAY_TEXT = /^(\d{4})-(\d{2})-(\d{2})$/u;

/**
 * `hh:mm`, optionally `:ss` with a fraction, then an optional `Z` or `±hh:mm` offset. A time with no offset is read as UTC; see
 * `parseIsoDate`.
 */
const ISO_CLOCK_TEXT = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/u;

/** The fractional-second digits of a clock. */
const CLOCK_FRACTION_TEXT = /\.(\d+)/u;

const NON_ZERO_DIGIT_TEXT = /[1-9]/u;

/** The sign, digits and exponent of decimal text; `Number#toExponential` output matches too. */
const DECIMAL_PARTS = /^[+-]?(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/iu;

/**
 * A decimal's value as digits with no leading or trailing zero and the power of ten they are scaled by, so two spellings of one value
 * (`1.50`, `15e-1`) compare equal. Zero has no digits.
 */
const decimalKey = (text: string): { digits: string; exponent: number } => {
    const [, whole = "", fraction = "", exponent = "0"] = DECIMAL_PARTS.exec(text) ?? [];
    const all = `${whole}${fraction}`;
    let start = 0;
    let end = all.length;

    while (start < end && all.charAt(start) === "0") {
        start += 1;
    }

    while (end > start && all.charAt(end - 1) === "0") {
        end -= 1;
    }

    return start === end ? { digits: "", exponent: 0 } : { digits: all.slice(start, end), exponent: Number(exponent) - fraction.length + (all.length - end) };
};

/**
 * Whether `number` holds exactly the value `text` writes. A double keeps about 16 significant digits, so a longer digit string is read
 * back as a different value (`9007199254740993` becomes `9007199254740992`) and the stored cell would differ from the file with no error.
 * `0.1` is accepted: it round-trips through its shortest spelling, which is what a double is. A whole number past 2^53 is accepted only
 * when the double is that integer exactly, as 2^60 is.
 */
const isExactDecimal = (text: string, number: number): boolean => {
    const written = decimalKey(text);
    const stored = decimalKey(number.toExponential());

    if (written.digits === stored.digits && written.exponent === stored.exponent) {
        return true;
    }

    // `number` is finite here, so an integer's exponent is at most 308 and the BigInt below is small.
    return (
        written.digits !== "" &&
        written.exponent >= 0 &&
        Number.isInteger(number) &&
        BigInt(written.digits) * 10n ** BigInt(written.exponent) === BigInt(Math.abs(number))
    );
};

/** The text as a finite decimal number that keeps every digit written, or `undefined`. */
const parseDecimal = (text: string): { number: number } | { inexact: true } | undefined => {
    const trimmed = text.trim();

    if (!DECIMAL_TEXT.test(trimmed)) {
        return undefined;
    }

    const number = Number(trimmed);

    if (!Number.isFinite(number)) {
        return undefined;
    }

    return isExactDecimal(trimmed, number) ? { number } : { inexact: true };
};

/** Whether `year-month-day` names a day the calendar has. `Date.parse` would roll `2026-02-30` over into March instead. */
const isRealDay = (year: number, month: number, day: number): boolean => {
    const calendar = new Date(0);

    calendar.setUTCFullYear(year, month - 1, day);

    return calendar.getUTCMonth() === month - 1 && calendar.getUTCDate() === day;
};

/** Whether the clock fields are in range, and the offset (when there is one) names a real UTC offset. */
const isRealClock = (hour: string, minute: string, second: string, offset: string): boolean =>
    Number(hour) <= 23 &&
    Number(minute) <= 59 &&
    Number(second) <= 59 &&
    (offset === "Z" || (Number(offset.slice(1, 3)) <= 23 && Number(offset.slice(4, 6)) <= 59));

/**
 * The epoch milliseconds of an ISO-8601 date or date-time, or `undefined` when the text is not one. A date with no time is midnight UTC,
 * and so is a time with no offset: `Date.parse` would read it in the machine's zone, so `Z` is added. The text is split on its `T` and each
 * half is matched on its own, so `Date.parse` only ever reads text whose fields have been checked.
 */
const parseIsoDate = (text: string): number | undefined => {
    const [dayText = "", clockText, ...rest] = text.split("T");
    const day = ISO_DAY_TEXT.exec(dayText);
    const clock = clockText === undefined ? undefined : ISO_CLOCK_TEXT.exec(clockText);

    if (day === null || rest.length > 0 || (clockText !== undefined && clock === null)) {
        return undefined;
    }

    const [, year = "", month = "", dayOfMonth = ""] = day;

    if (!isRealDay(Number(year), Number(month), Number(dayOfMonth))) {
        return undefined;
    }

    const [, hour = "0", minute = "0", second = "0", offset] = clock ?? [];

    if (!isRealClock(hour, minute, second, offset ?? "Z")) {
        return undefined;
    }

    // A Date holds whole milliseconds, so digits past the third would be dropped without a word. Trailing zeros lose nothing.
    const fraction = CLOCK_FRACTION_TEXT.exec(clockText ?? "")?.[1] ?? "";

    if (NON_ZERO_DIGIT_TEXT.test(fraction.slice(3))) {
        return undefined;
    }

    const millis = Date.parse(clock !== undefined && offset === undefined ? `${text}Z` : text);

    return Number.isFinite(millis) ? millis : undefined;
};

/** A number cell: refused when it is not a decimal, and refused as `inexact` when the double would not hold every digit. */
const coerceNumber = (text: string): CoercedCell => {
    const parsed = parseDecimal(text);

    if (parsed === undefined) {
        return { expected: "number", kind: "rejected" };
    }

    return "number" in parsed ? { kind: "ok", value: parsed.number } : { expected: "number", inexact: true, kind: "rejected" };
};

/** A date or timestamp cell: an ISO-8601 date or date-time (UTC when it names no offset), or whole-number epoch milliseconds. */
const coerceDate = (text: string): CoercedCell => {
    const trimmed = text.trim();
    let millis = parseIsoDate(trimmed);

    if (millis === undefined && EPOCH_MILLIS_TEXT.test(trimmed)) {
        millis = Number(trimmed);
    }

    // `Date` holds ±8.64e15 ms; a finite number beyond that is stored but cannot be shown as a date in the row editor.
    return millis === undefined || !Number.isFinite(new Date(millis).getTime()) ? { expected: "date", kind: "rejected" } : { kind: "ok", value: millis };
};

/** Whether the wire codec can carry `value`, which it cannot once its digits pass the codec's bound. */
const carriedByWire = (value: bigint): boolean => {
    try {
        encodeWire(value);

        return true;
    } catch {
        return false;
    }
};

/**
 * Read one cell's text as its column kind. A number takes a decimal, and a timestamp or date takes whole-number epoch milliseconds or an
 * ISO-8601 date or date-time, read as UTC when it names no offset. Every kind but text is trimmed of surrounding whitespace first.
 * Booleans take `true` or `false` in any case. Bigints take the integer text and keep it exact. Any other kind stays text, and the
 * server validator decides what it accepts.
 */
const coerceCell = (text: string, kind: string | undefined): CoercedCell => {
    if (kind === "bigint") {
        const trimmed = text.trim();

        if (!INTEGER_TEXT.test(trimmed)) {
            return { expected: "bigint", kind: "rejected" };
        }

        const value = BigInt(trimmed);

        // The wire codec refuses a digit string past its bound. Refused here, the cell's record and column can be named; left to the
        // wire-size check, the error would name neither.
        return carriedByWire(value) ? { kind: "ok", value } : { expected: "bigint", kind: "rejected", tooLong: true };
    }

    if (kind === "boolean") {
        const lower = text.trim().toLowerCase();

        if (lower === "true" || lower === "false") {
            return { kind: "ok", value: lower === "true" };
        }

        return { expected: "boolean", kind: "rejected" };
    }

    if (kind === "number") {
        return coerceNumber(text);
    }

    if (kind === "date" || kind === "timestamp") {
        return coerceDate(text);
    }

    return { kind: "ok", value: text };
};

/**
 * Coerce a document's cells to the type of their columns, from the table's declared kinds (`kinds` maps a column name to its validator
 * kind). A cell that does not fit its kind throws a {@link CsvFormatError} naming the record and column. An omitted cell stays omitted, and
 * a column the table does not declare is passed through as text for the server to reject.
 */
const coerceCsvDocument = ({ doc, record }: CsvDocument, kinds: ReadonlyMap<string, string>): CoercedDocument => {
    const coerced: Record<string, unknown> = {};

    for (const [column, text] of Object.entries(doc)) {
        if (text === null) {
            // eslint-disable-next-line unicorn/no-null -- the null a blank nullable cell was given by recordDocument, passed through unchanged
            setField(coerced, column, null);

            continue;
        }

        const cell = coerceCell(text, kinds.get(column));

        if (cell.kind === "rejected") {
            throw new CsvFormatError({
                column,
                expected: cell.expected,
                ...(cell.inexact === true && { inexact: true as const }),
                kind: "cell-type",
                record,
                ...(cell.tooLong === true && { tooLong: true as const }),
                value: text,
            });
        }

        setField(coerced, column, cell.value);
    }

    return { doc: coerced, record };
};

/** Coerce every document, as {@link coerceCsvDocument} does for one. The first bad cell throws, in file order. */
const coerceCsvDocuments = (documents: CsvDocument[], kinds: ReadonlyMap<string, string>): CoercedDocument[] =>
    documents.map((document) => coerceCsvDocument(document, kinds));

/**
 * The coerced documents of CSV text that arrives in pieces, in file order. The first problem throws at its record, so a caller that
 * writes as it reads must check the file first: {@link checkCsvDocuments} throws the same problem for the same file.
 */
const readCsvDocuments = async function* (
    pieces: AsyncIterable<string> | Iterable<string>,
    kinds: ReadonlyMap<string, string>,
    nullOnEmpty: ReadonlySet<string>,
): AsyncGenerator<CoercedDocument> {
    let columns: string[] | undefined;

    for await (const record of readCsvRecords(pieces)) {
        if (columns === undefined) {
            columns = headerColumns(record.cells);
        } else {
            yield coerceCsvDocument(recordDocument(record, columns, nullOnEmpty), kinds);
        }
    }
};

/**
 * The columns whose blank cell is stored as null: nullable and not optional. An optional column is left out instead, so the server applies its
 * default.
 */
const nullOnEmptyColumns = (columns: ReadonlyArray<{ name: string; nullable?: boolean; optional: boolean }>): Set<string> =>
    new Set(columns.filter((column) => column.nullable === true && !column.optional).map((column) => column.name));

/** The problem a check threw. Anything else is a bug in the check, not a problem with the file, so it is rethrown. */
const asFormatError = (error: unknown): CsvFormatError => {
    if (error instanceof CsvFormatError) {
        return error;
    }

    throw error;
};

/**
 * Check CSV text that arrives in pieces, and throw the problem {@link readCsvDocuments} throws first. A quote error stops the read at once.
 * Otherwise a bad header is thrown first, then the first record in file order that has the wrong width or a cell that does not fit its
 * column. The check keeps only that first record problem and reads on, so the file is not held. `onDocument` receives every document that
 * passes its checks, in file order.
 */
const checkCsvDocuments = async (
    pieces: AsyncIterable<string> | Iterable<string>,
    kinds: ReadonlyMap<string, string>,
    nullOnEmpty: ReadonlySet<string>,
    onDocument: (document: CoercedDocument) => void,
): Promise<void> => {
    let columns: string[] | undefined;
    let headerProblem: CsvFormatError | undefined;
    let recordProblem: CsvFormatError | undefined;

    for await (const record of readCsvRecords(pieces)) {
        if (columns === undefined) {
            try {
                columns = headerColumns(record.cells);
            } catch (error) {
                headerProblem = asFormatError(error);
                // No header to check rows against, so every later row is read for a quote error alone.
                columns = [];
            }

            continue;
        }

        let coerced: CoercedDocument;

        try {
            coerced = coerceCsvDocument(recordDocument(record, columns, nullOnEmpty), kinds);
        } catch (error) {
            // Records arrive in file order, so the first one to fail is the earliest problem in the file.
            recordProblem ??= asFormatError(error);

            continue;
        }

        onDocument(coerced);
    }

    const problem = headerProblem ?? recordProblem;

    if (problem !== undefined) {
        throw problem;
    }
};

export {
    checkCsvDocuments,
    coerceCsvDocuments,
    CsvFormatError,
    nullOnEmptyColumns,
    parseCsv,
    parseCsvDocuments,
    parseCsvRecords,
    readCsvDocuments,
    readCsvRecords,
};
export type { CsvProblem, CsvRecord };
