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
    | { column: string; expected: CellType; kind: "cell-type"; record: number; value: string }
    | { kind: "text-after-quote"; record: number }
    | { kind: "unterminated-quote"; record: number };

/** The column kinds a CSV cell is coerced into. Every other kind keeps its text. */
type CellType = "bigint" | "boolean" | "number";

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
 * spreadsheet exports write one. Blank lines are not records.
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
            // A single empty field is the bytes of a blank line, so it is not a record either.
            if (cells.length > 1 || cells[0] !== undefined) {
                records.push(cells);
            }

            cells = [];
        }
    } while (field.end !== "end");

    return records;
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
                fields[name] = cell;
            }
        });

        return { doc: fields, record };
    });
};

/** A cell's text, read as its column kind. `rejected` names the kind the text failed to be. */
type CoercedCell = { kind: "ok"; value: CsvValue } | { expected: CellType; kind: "rejected" };

/** Digits with an optional minus sign: the text a `bigint` column can hold. */
const INTEGER_TEXT = /^-?\d+$/u;

/**
 * A decimal number: an optional sign, digits, an optional fraction and an optional exponent. `Number` reads more than this (hex, binary,
 * octal, and the empty string), so the text is matched against this shape before it is converted.
 */
const DECIMAL_TEXT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu;

/** The text, trimmed of surrounding whitespace, as a finite decimal number, or `undefined`. */
const parseDecimal = (text: string): number | undefined => {
    const trimmed = text.trim();

    if (!DECIMAL_TEXT.test(trimmed)) {
        return undefined;
    }

    const number = Number(trimmed);

    return Number.isFinite(number) ? number : undefined;
};

/**
 * Read one cell's text as its column kind. Numbers, timestamps and dates take a decimal, trimmed of surrounding whitespace. Booleans take
 * `true` or `false` in any case. Bigints take the integer text and keep it exact. Any other kind stays text, and the server validator
 * decides what it accepts.
 */
const coerceCell = (text: string, kind: string | undefined): CoercedCell => {
    if (kind === "bigint") {
        return INTEGER_TEXT.test(text) ? { kind: "ok", value: BigInt(text) } : { expected: "bigint", kind: "rejected" };
    }

    if (kind === "boolean") {
        const lower = text.toLowerCase();

        if (lower === "true" || lower === "false") {
            return { kind: "ok", value: lower === "true" };
        }

        return { expected: "boolean", kind: "rejected" };
    }

    if (kind === "date" || kind === "number" || kind === "timestamp") {
        const number = parseDecimal(text);

        return number === undefined ? { expected: "number", kind: "rejected" } : { kind: "ok", value: number };
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
                throw new CsvFormatError({ column, expected: cell.expected, kind: "cell-type", record, value: text });
            }

            coerced[column] = cell.value;
        }

        return { doc: coerced, record };
    });

export { coerceCsvDocuments, CsvFormatError, parseCsv, parseCsvDocuments };
export type { CellType, CoercedDocument, CsvCell, CsvDocument, CsvProblem, CsvValue };
