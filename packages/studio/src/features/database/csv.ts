/**
 * One CSV field. `undefined` is an empty unquoted field: the importer leaves that key out of the document so the schema default applies.
 * A quoted empty field (`""`) is an empty string and stays in the document.
 */
type CsvCell = string | undefined;

/** A structural problem in a CSV file. `record` counts the header as record 1 and skips blank lines, so it names the row a user sees. */
type CsvProblem =
    | { kind: "duplicate-header"; name: string }
    | { column: number; kind: "empty-header" }
    | { expected: number; found: number; kind: "ragged"; record: number }
    | { column: string; expected: CellType; inexact?: true; kind: "cell-type"; record: number; value: string }
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

/** A document built from one CSV record, with the record number it came from. */
interface CsvDocument {
    doc: Record<string, string>;
    record: number;
}

/** The characters that end an unquoted field. A quote is only special at the start of a field. */
const DELIMITERS = ",\r\n";

/** How a field is followed: by a comma, by a line break, or by the end of the text. */
interface FieldEnd {
    end: "comma" | "end" | "newline";
    next: number;
}

interface Field extends FieldEnd {
    cell: CsvCell;
}

const fieldEnd = (text: string, at: number): FieldEnd => {
    const char = text.charAt(at);

    if (char === ",") {
        return { end: "comma", next: at + 1 };
    }

    if (char === "\r" && text.charAt(at + 1) === "\n") {
        return { end: "newline", next: at + 2 };
    }

    if (char === "\n" || char === "\r") {
        return { end: "newline", next: at + 1 };
    }

    return { end: "end", next: at };
};

/**
 * A quoted field runs to the closing quote; a doubled quote inside it is one literal quote. Newlines and commas inside it are data.
 * Anything but a delimiter after the closing quote is an error, since it would otherwise be silently glued to the value.
 */
const readQuoted = (text: string, start: number, record: number): Field => {
    let value = "";
    let from = start + 1;
    let quote = text.indexOf('"', from);

    while (quote !== -1 && text.charAt(quote + 1) === '"') {
        value += `${text.slice(from, quote)}"`;
        from = quote + 2;
        quote = text.indexOf('"', from);
    }

    if (quote === -1) {
        throw new CsvFormatError({ kind: "unterminated-quote", record });
    }

    value += text.slice(from, quote);

    const after = text.charAt(quote + 1);

    if (after !== "" && !DELIMITERS.includes(after)) {
        throw new CsvFormatError({ kind: "text-after-quote", record });
    }

    return { cell: value, ...fieldEnd(text, quote + 1) };
};

const readField = (text: string, start: number, record: number): Field => {
    if (text.charAt(start) === '"') {
        return readQuoted(text, start, record);
    }

    let stop = start;

    while (stop < text.length && !DELIMITERS.includes(text.charAt(stop))) {
        stop += 1;
    }

    const raw = text.slice(start, stop);

    return { cell: raw === "" ? undefined : raw, ...fieldEnd(text, stop) };
};

/**
 * RFC 4180 records, CRLF or LF. A quoted field may hold commas, doubled quotes and newlines. A leading byte-order mark is dropped, since
 * spreadsheet exports write one.
 *
 * A record whose every field is an unquoted empty field is blank and is not a record, whatever its column count: a line of commas, or a
 * one-column empty line. A quoted `""` is a value, so it is kept.
 *
 * A quote inside an unquoted field is kept as text rather than rejected: spreadsheets write that for values like `5" disk`, and the
 * server validator is the place that judges the value.
 */
const parseCsv = (input: string): CsvCell[][] => {
    const text = input.startsWith("﻿") ? input.slice(1) : input;
    const records: CsvCell[][] = [];
    let cells: CsvCell[] = [];
    let index = 0;
    let field: Field;

    do {
        field = readField(text, index, records.length + 1);
        cells.push(field.cell);
        index = field.next;

        if (field.end !== "comma") {
            if (cells.some((cell) => cell !== undefined)) {
                records.push(cells);
            }

            cells = [];
        }
    } while (field.end !== "end");

    return records;
};

/**
 * Set an own data property. A plain assignment to `__proto__` sets the prototype instead, so a column named that way would be dropped
 * without a word, and the server would never see it.
 */
const setField = (target: Record<string, unknown>, key: string, value: unknown): void => {
    Object.defineProperty(target, key, { configurable: true, enumerable: true, value, writable: true });
};

/**
 * Turn a CSV file into one document per data record, keyed by the header names. Every record is checked here, before any caller writes:
 * a blank or repeated header name, and a row whose cell count differs from the header, throw a {@link CsvFormatError}.
 *
 * Cells are passed through as strings. The server validator decides what a column accepts, so this does not coerce `"42"` or `"true"`.
 * A header-only file yields no documents.
 */
const parseCsvDocuments = (text: string): CsvDocument[] => {
    const [header = [], ...records] = parseCsv(text);
    const columns: string[] = [];
    const seen = new Set<string>();

    header.forEach((cell, index) => {
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

    return records.map((cells, index) => {
        const record = index + 2;

        if (cells.length !== columns.length) {
            throw new CsvFormatError({ expected: columns.length, found: cells.length, kind: "ragged", record });
        }

        const fields: Record<string, string> = {};

        columns.forEach((name, column) => {
            const cell = cells[column];

            if (cell !== undefined) {
                setField(fields, name, cell);
            }
        });

        return { doc: fields, record };
    });
};

/** A cell's text, read as its column kind. `rejected` names the kind the text failed to be. */
type CoercedCell = { kind: "ok"; value: CsvValue } | { expected: CellType; inexact?: true; kind: "rejected" };

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
 * `hh:mm`, optionally `:ss` with a fraction, then an optional `Z` or `±hh:mm` offset. A time with no offset is read as UTC; see `parseIsoDate`.
 */
const ISO_CLOCK_TEXT = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/u;

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
 * and a date-time with no offset is UTC too, which is what a `date` column stores. The text is split on its `T` and each half is matched on its own,
 * so `Date.parse` only ever reads text whose fields have been checked.
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

    // A time with no offset would be read in the machine's own zone, so it is marked UTC before Date.parse sees it. Date-only text is
    // already midnight UTC and is passed through unchanged.
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

/**
 * Read one cell's text as its column kind. A number takes a decimal, and a timestamp or date takes whole-number epoch milliseconds or an
 * ISO-8601 date. Every kind but text is trimmed of surrounding whitespace first. Booleans take `true` or `false` in any case. Bigints take
 * the integer text and keep it exact. Any other kind stays text, and the server validator decides what it accepts.
 */
const coerceCell = (text: string, kind: string | undefined): CoercedCell => {
    if (kind === "bigint") {
        const trimmed = text.trim();

        return INTEGER_TEXT.test(trimmed) ? { kind: "ok", value: BigInt(trimmed) } : { expected: "bigint", kind: "rejected" };
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
        const trimmed = text.trim();
        const millis = parseIsoDate(trimmed) ?? (EPOCH_MILLIS_TEXT.test(trimmed) ? Number(trimmed) : undefined);

        // `Date` holds ±8.64e15 ms; a finite number beyond that is stored but cannot be shown as a date in the row editor.
        return millis === undefined || !Number.isFinite(new Date(millis).getTime()) ? { expected: "date", kind: "rejected" } : { kind: "ok", value: millis };
    }

    return { kind: "ok", value: text };
};

/**
 * Coerce every cell of parsed documents to the type of its column, from the table's declared kinds (`kinds` maps a column name to its
 * validator kind). A cell that does not fit its kind throws a {@link CsvFormatError} naming the record and column, so a file with one bad
 * cell is refused before anything is written. An omitted cell stays omitted, and a column the table does not declare is passed through as
 * text for the server to reject.
 */
const coerceCsvDocuments = (documents: CsvDocument[], kinds: ReadonlyMap<string, string>): CoercedDocument[] =>
    documents.map(({ doc, record }) => {
        const coerced: Record<string, unknown> = {};

        for (const [column, text] of Object.entries(doc)) {
            const cell = coerceCell(text, kinds.get(column));

            if (cell.kind === "rejected") {
                throw new CsvFormatError({
                    column,
                    expected: cell.expected,
                    ...(cell.inexact === true && { inexact: true as const }),
                    kind: "cell-type",
                    record,
                    value: text,
                });
            }

            setField(coerced, column, cell.value);
        }

        return { doc: coerced, record };
    });

export { coerceCsvDocuments, CsvFormatError, parseCsv, parseCsvDocuments };
export type { CellType, CoercedDocument, CsvCell, CsvDocument, CsvProblem, CsvValue };
