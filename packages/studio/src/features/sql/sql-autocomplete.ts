/**
 * Schema-aware autocomplete logic for the read-only SQL editor — pure, so the
 * token extraction and ranking can be unit-tested without a DOM. The editor
 * sources its schema from the admin RPCs it already calls (`listTables` for
 * table names, `readTablePage`'s `columns` for per-table columns); this module
 * turns the current caret position into a ranked suggestion list and the span
 * of text a chosen suggestion should replace.
 */

/** What a single suggestion stands for, so the dropdown can badge it. */
type SuggestionKind = "column" | "keyword" | "table";

/** One ranked completion candidate for the token under the caret. */
interface Suggestion {
    /** A table name for a column suggestion, so the dropdown can hint its origin. */
    readonly detail?: string;
    readonly kind: SuggestionKind;
    readonly label: string;
}

/**
 * The schema the editor knows about: every table name, and the columns probed
 * per table (only the tables the operator has expanded/queried are present, so
 * column coverage grows as they explore — table names are always complete).
 */
interface SqlSchema {
    /** Columns per table, keyed by table name. Missing table ⇒ columns not probed yet. */
    readonly columns: Readonly<Record<string, ReadonlyArray<string>>>;
    readonly tables: ReadonlyArray<string>;
}

/** The token under the caret plus the [start, end) span it occupies in the source. */
interface TokenSpan {
    readonly end: number;
    readonly start: number;
    readonly text: string;
}

/** Max suggestions shown at once — enough to be useful, short enough to scan. */
const MAX_SUGGESTIONS = 8;

/**
 * The SQL keywords offered as completions. Read-only editor, so this is the
 * SELECT/WITH/EXPLAIN vocabulary an operator actually types — not the full
 * dialect. Upper-cased to match the canonical rendering the Format button emits.
 */
const KEYWORDS: ReadonlyArray<string> = [
    "AND",
    "ASC",
    "AS",
    "BY",
    "COUNT",
    "DESC",
    "DISTINCT",
    "EXPLAIN",
    "FROM",
    "GROUP",
    "HAVING",
    "INNER",
    "JOIN",
    "LEFT",
    "LIKE",
    "LIMIT",
    "NOT",
    "NULL",
    "OFFSET",
    "ON",
    "ORDER",
    "OR",
    "QUERY",
    "SELECT",
    "WHERE",
    "WITH",
];

/** The SQL clauses after which a column reference is the likelier completion than a table. */
const COLUMN_CLAUSES = new Set<string>(["AND", "BY", "HAVING", "ON", "OR", "SELECT", "WHERE"]);

/** Matches a single identifier-body character (letters, digits, `_`, `$`). */
const WORD_CHAR = /[\w$]/;

/** A token character: an identifier body. The caret splits the token on anything else. */
const isWordChar = (char: string | undefined): boolean => char !== undefined && WORD_CHAR.test(char);

/** The trailing identifier of `text` (the run of word chars at its end), or `""` when it ends in punctuation/space. */
const trailingWord = (text: string): string => {
    let start = text.length;

    while (start > 0 && isWordChar(text[start - 1])) {
        start -= 1;
    }

    return text.slice(start);
};

/**
 * Find the identifier token the caret sits at the end of. Scans backward from
 * `caret` over word characters; the returned span is the contiguous run ending
 * at the caret, so accepting a suggestion replaces exactly what was typed. An
 * empty token (caret after whitespace/punctuation) yields a zero-width span at
 * the caret — callers treat that as "no active token" and show nothing.
 */
const tokenAt = (value: string, caret: number): TokenSpan => {
    let start = caret;

    while (start > 0 && isWordChar(value[start - 1])) {
        start -= 1;
    }

    return { end: caret, start, text: value.slice(start, caret) };
};

/**
 * Whether the caret is positioned where a column reference is the likelier
 * completion than a table — i.e. immediately after a `.` qualifier
 * (`messages.`) or after a clause that reads columns (`SELECT`, `WHERE`, `BY`,
 * `ON`, `AND`, `OR`, `HAVING`). Best-effort: it only re-orders the ranking, so
 * a miss still surfaces every candidate, just lower down.
 */
const prefersColumns = (value: string, start: number): boolean => {
    const before = value.slice(0, start).trimEnd();

    return before.endsWith(".") || COLUMN_CLAUSES.has(trailingWord(before).toUpperCase());
};

/**
 * The table named just before a `.` qualifier (`messages.| ` ⇒ `messages`), so
 * `tbl.` completes only that table's columns. Returns `undefined` when the caret
 * isn't qualified by a dotted prefix.
 */
const qualifierTable = (value: string, start: number): string | undefined => {
    const before = value.slice(0, start);

    if (!before.endsWith(".")) {
        return undefined;
    }

    const name = trailingWord(before.slice(0, -1));

    return name === "" ? undefined : name;
};

/** Case-insensitive prefix match; an empty needle matches everything (so a bare clause still offers candidates). */
const matches = (candidate: string, needle: string): boolean => candidate.toLowerCase().startsWith(needle.toLowerCase());

/**
 * Rank completions for the token under `caret` against `schema`. Tables, the
 * probed columns, and the keyword vocabulary are each prefix-filtered by the
 * typed token, then ordered: a `tbl.` qualifier restricts to that table's
 * columns; otherwise columns lead when the clause reads columns (and tables
 * lead when it reads tables), with keywords last. Exact-token matches and the
 * empty-token case are suppressed for keywords so typing a complete word
 * doesn't pop a one-item menu of itself. Capped at {@link MAX_SUGGESTIONS}.
 */
const suggestionsFor = (value: string, caret: number, schema: SqlSchema): Suggestion[] => {
    const span = tokenAt(value, caret);
    const qualifier = qualifierTable(value, span.start);

    // A dotted `tbl.` qualifier completes only that table's columns.
    if (qualifier !== undefined) {
        const owned = schema.columns[qualifier] ?? schema.columns[qualifier.toLowerCase()] ?? [];

        return owned
            .filter((column) => matches(column, span.text))
            .slice(0, MAX_SUGGESTIONS)
            .map((column) => {
                return { detail: qualifier, kind: "column" as const, label: column };
            });
    }

    // An empty, unqualified token only completes after a column-reading clause —
    // otherwise every keystroke at a blank caret would pop the whole vocabulary.
    if (span.text === "" && !prefersColumns(value, span.start)) {
        return [];
    }

    const tableHits: Suggestion[] = schema.tables
        .filter((table) => matches(table, span.text))
        .map((table) => {
            return { kind: "table" as const, label: table };
        });

    // De-dupe columns that appear in several tables; keep the first table as the detail hint.
    const seenColumns = new Map<string, string>();

    for (const [table, columns] of Object.entries(schema.columns)) {
        for (const column of columns) {
            if (matches(column, span.text) && !seenColumns.has(column)) {
                seenColumns.set(column, table);
            }
        }
    }

    const columnHits: Suggestion[] = [...seenColumns].map(([column, table]) => {
        return { detail: table, kind: "column" as const, label: column };
    });

    const keywordHits: Suggestion[] = KEYWORDS.filter(
        (keyword) => span.text !== "" && matches(keyword, span.text) && keyword.toLowerCase() !== span.text.toLowerCase(),
    ).map((keyword) => {
        return { kind: "keyword" as const, label: keyword };
    });

    const ordered = prefersColumns(value, span.start) ? [...columnHits, ...tableHits, ...keywordHits] : [...tableHits, ...columnHits, ...keywordHits];

    return ordered.slice(0, MAX_SUGGESTIONS);
};

/**
 * Splice an accepted `suggestion` into `value` over the caret's token span,
 * returning the new text and the caret offset that should follow it (just past
 * the inserted label). Pure, so the editor's accept handler stays a one-liner.
 */
const acceptSuggestion = (value: string, caret: number, suggestion: Suggestion): { caret: number; value: string } => {
    const span = tokenAt(value, caret);
    const next = value.slice(0, span.start) + suggestion.label + value.slice(span.end);

    return { caret: span.start + suggestion.label.length, value: next };
};

export { acceptSuggestion, MAX_SUGGESTIONS, suggestionsFor, tokenAt };
export type { SqlSchema, Suggestion, SuggestionKind, TokenSpan };
